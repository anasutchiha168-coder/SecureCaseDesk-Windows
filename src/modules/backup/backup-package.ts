// SECURECASEDESK_PHASE10_S3
// تجميع ملف النسخة النهائي: لقطة القاعدة (10.2) + المرفقات المشفّرة + الأسرار، كلها داخل تيار مشفّر بكلمة مرور.
// بالحقن الكامل (قابل للاختبار في Node). لا تحقق عميق ولا استعادة هنا (10.4 / 10.5+).
//
// الترتيب داخل الملف: قاعدة البيانات → الأسرار → المرفقات → البيان (manifest) أخيراً.
// الأسرار المصنّفة excluded لا تُقرأ ولا تُكتب أبداً. النقص (مرفق بلا ملف أو ببصمة مخالفة) يُسجَّل ولا يُخفى.

import {
  ATTACHMENT_STORAGE_NAME, BACKUP_FILE_EXTENSION, BACKUP_FORMAT_VERSION, BACKUP_PARTIAL_SUFFIX,
  BackupError, DATABASE_FILE_NAME,
  type DatabaseSnapshot, type SecretClass, type SecretSpec,
} from './backup-types';
import {
  RECORD_KIND, SALT_LENGTH, SealedWriter, assertPassphraseAcceptable, assertWritableKdf, toHex,
  type BackupCryptoProvider, type KdfParams,
} from './backup-format';

export interface PackageReadHandle { read(max: number): Promise<Uint8Array>; close(): Promise<void> }
export interface PackageWriteHandle { write(bytes: Uint8Array): Promise<void>; close(): Promise<void> }

export interface PackageFs {
  ensureDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  size(path: string): Promise<number>;
  remove(path: string): Promise<void>;                 // ملف أو مجلد؛ لا خطأ إن غاب
  move(from: string, to: string): Promise<void>;
  openRead(path: string): Promise<PackageReadHandle>;
  openWrite(path: string): Promise<PackageWriteHandle>; // ينشئ ملفاً جديداً فارغاً
}

export interface AttachmentRow {
  id: string;
  storage_name: string;
  status: 'active' | 'deleted';
  sha256_cipher: string;
  size_bytes: number;
}

export interface PackageProgress {
  stage: 'database' | 'secrets' | 'attachments' | 'finalizing';
  current: number;
  total: number;
}

export interface PackageDeps {
  crypto: BackupCryptoProvider;
  fs: PackageFs;
  kdf: KdfParams;
  chunkSize: number;
  outputDir: string;
  takeSnapshot(): Promise<DatabaseSnapshot>;
  discardSnapshot(snapshot: DatabaseSnapshot): Promise<void>;
  readAttachmentRows(): Promise<AttachmentRow[]>;
  attachmentPath(storageName: string): string;          // يُستدعى فقط بأسماء مطابقة للنمط
  secretSpecs: SecretSpec[];
  readSecret(name: string): Promise<string | null>;
  newId(): string;
  now(): number;
  yieldTick?(): Promise<void>;
  onProgress?(p: PackageProgress): void;
}

export type PackageWarningCode = 'ATTACHMENT_FILE_MISSING' | 'ATTACHMENT_HASH_MISMATCH' | 'ATTACHMENT_NAME_INVALID';
export interface PackageWarning { code: PackageWarningCode; message: string; ids: string[] }

export interface PackageManifest {
  formatVersion: number;
  kind: 'backup-package';
  backupId: string;
  createdAt: number;
  appName: 'SecureCaseDesk';
  database: {
    databaseFileName: string; size: number; sha256: string;
    journalMode: string; cipherVersion: string; snapshotId: string;
  };
  secrets: { name: string; cls: SecretClass }[];        // أسماء فقط
  attachments: {
    count: number; totalBytes: number;
    entries: { id: string; name: string; size: number; sha256: string; status: string; matchesRecorded: boolean }[];
    missing: { id: string; storageName: string; status: string; reason: 'file-missing' | 'name-invalid' }[];
  };
  records: { kind: number; name: string; size: number; sha256: string }[];
}

export interface BackupPackageResult {
  backupId: string;
  filePath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;                 // بصمة الملف النهائي كما كُتب
  createdAt: number;
  attachmentsIncluded: number;
  attachmentsBytes: number;
  secretsIncluded: string[];
  warnings: PackageWarning[];
  snapshotAttempts: number;
}

const enc = new TextEncoder();
const READ_CHUNK = 256 * 1024;
const MAX_STABILITY_ATTEMPTS = 3;
const join = (a: string, b: string) => a.replace(/\/+$/, '') + '/' + b;
let inFlight = false;

function fingerprint(p: BackupCryptoProvider, rows: AttachmentRow[]): string {
  const lines = rows.map((r) => [r.id, r.status, r.storage_name, r.sha256_cipher].join('|')).sort().join('\n');
  const h = p.sha256();
  h.update(enc.encode(lines));
  return toHex(h.digest());
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const z = (n: number, w = 2) => String(n).padStart(w, '0');
  return d.getUTCFullYear() + z(d.getUTCMonth() + 1) + z(d.getUTCDate()) + '-' +
    z(d.getUTCHours()) + z(d.getUTCMinutes()) + z(d.getUTCSeconds());
}

export async function createBackupPackage(
  deps: PackageDeps, passphrase: string, passphraseConfirmation?: string
): Promise<BackupPackageResult> {
  if (inFlight) throw new BackupError('BACKUP_IN_PROGRESS');
  inFlight = true;

  const { fs, crypto } = deps;
  let snapshot: DatabaseSnapshot | null = null;
  let writer: SealedWriter | null = null;
  let handle: PackageWriteHandle | null = null;
  let partialPath: string | null = null;
  let succeeded = false;

  try {
    // 1) قبل لمس أي شيء.
    const pass = assertPassphraseAcceptable(passphrase, passphraseConfirmation);
    assertWritableKdf(deps.kdf, deps.chunkSize);

    // 2) أسرار مطلوبة (الاستبعاد مطلق: excluded لا يُقرأ).
    const secrets: Record<string, string> = {};
    const secretList: { name: string; cls: SecretClass }[] = [];
    for (const spec of deps.secretSpecs) {
      if (spec.cls === 'excluded') continue;
      const v = await deps.readSecret(spec.name);
      if (typeof v === 'string' && v.length > 0) {
        secrets[spec.name] = v;
        secretList.push({ name: spec.name, cls: spec.cls });
      } else if (spec.cls === 'required') {
        throw new BackupError('NOT_READY');
      }
    }

    // 3) لقطة القاعدة مع التحقق من ثبات سجل المرفقات حولها.
    let rows: AttachmentRow[] = [];
    for (let attempt = 1; ; attempt++) {
      const before = await deps.readAttachmentRows();
      snapshot = await deps.takeSnapshot();
      const after = await deps.readAttachmentRows();
      if (fingerprint(crypto, before) === fingerprint(crypto, after)) { rows = before; break; }
      await deps.discardSnapshot(snapshot);
      snapshot = null;
      if (attempt >= MAX_STABILITY_ATTEMPTS) throw new BackupError('ATTACHMENTS_CHANGED');
    }
    const snap = snapshot!;

    // 4) فتح الملف النهائي المؤقت وكتابة الترويسة.
    await fs.ensureDir(deps.outputDir);
    const backupId = deps.newId();
    const createdAt = deps.now();
    const fileName = 'SecureCaseDesk-' + stamp(createdAt) + '-' + backupId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8) +
      '.' + BACKUP_FILE_EXTENSION;
    const finalPath = join(deps.outputDir, fileName);
    partialPath = finalPath + BACKUP_PARTIAL_SUFFIX;
    await fs.remove(partialPath);
    handle = await fs.openWrite(partialPath);
    const h = handle;
    writer = await SealedWriter.create(
      crypto, pass,
      { backupId, createdAt, kdf: deps.kdf, salt: crypto.randomBytes(SALT_LENGTH), chunkSize: deps.chunkSize },
      (b) => h.write(b)
    );
    const w = writer;
    const records: PackageManifest['records'] = [];

    const putRecord = async (
      kind: number, meta: Record<string, unknown> & { name: string; size: number },
      feed: (emit: (b: Uint8Array) => Promise<void>) => Promise<void>
    ): Promise<string> => {
      const metaBytes = enc.encode(JSON.stringify(meta));
      const head = new Uint8Array(5 + metaBytes.length);
      head[0] = kind;
      new DataView(head.buffer).setUint32(1, metaBytes.length);
      head.set(metaBytes, 5);
      await w.write(head);
      const hash = crypto.sha256();
      let total = 0;
      await feed(async (b) => { hash.update(b); total += b.length; await w.write(b); });
      if (total !== meta.size) throw new BackupError('PACKAGE_FAILED');
      const digest = hash.digest();
      await w.write(digest);
      const hex = toHex(digest);
      records.push({ kind, name: meta.name, size: meta.size, sha256: hex });
      return hex;
    };

    const fromFile = async (path: string, size: number, emit: (b: Uint8Array) => Promise<void>) => {
      const r = await fs.openRead(path);
      try {
        let left = size, n = 0;
        while (left > 0) {
          const part = await r.read(Math.min(READ_CHUNK, left));
          if (part.length === 0) throw new BackupError('PACKAGE_FAILED'); // الملف أقصر مما أُعلن
          await emit(part);
          left -= part.length;
          if (++n % 4 === 0 && deps.yieldTick) await deps.yieldTick();
        }
      } finally { await r.close(); }
    };

    // 5) قاعدة البيانات.
    deps.onProgress?.({ stage: 'database', current: 0, total: 1 });
    const dbSize = await fs.size(snap.databasePath);
    if (dbSize !== snap.manifest.sizeBytes) throw new BackupError('PACKAGE_FAILED');
    const dbHash = await putRecord(RECORD_KIND.database, { name: DATABASE_FILE_NAME, size: dbSize },
      (emit) => fromFile(snap.databasePath, dbSize, emit));
    if (dbHash !== snap.manifest.sha256) throw new BackupError('PACKAGE_FAILED'); // اللقطة تغيّرت بعد إنشائها
    deps.onProgress?.({ stage: 'database', current: 1, total: 1 });

    // 6) الأسرار.
    const secretBytes = enc.encode(JSON.stringify(secrets));
    await putRecord(RECORD_KIND.secrets, { name: 'secrets.json', size: secretBytes.length },
      async (emit) => { await emit(secretBytes); });
    secretBytes.fill(0);
    deps.onProgress?.({ stage: 'secrets', current: 1, total: 1 });

    // 7) المرفقات (الصفوف المثبتة قبل اللقطة وبعدها).
    const entries: PackageManifest['attachments']['entries'] = [];
    const missing: PackageManifest['attachments']['missing'] = [];
    const mismatch: string[] = [];
    const invalid: string[] = [];
    const missingActive: string[] = [];
    let attBytes = 0;
    const ordered = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let idx = 0;
    for (const row of ordered) {
      deps.onProgress?.({ stage: 'attachments', current: idx++, total: ordered.length });
      if (!ATTACHMENT_STORAGE_NAME.test(row.storage_name)) {   // لا نبني مساراً من اسم مشبوه
        missing.push({ id: row.id, storageName: '', status: row.status, reason: 'name-invalid' });
        invalid.push(row.id);
        continue;
      }
      const path = deps.attachmentPath(row.storage_name);
      if (!(await fs.exists(path))) {
        missing.push({ id: row.id, storageName: row.storage_name, status: row.status, reason: 'file-missing' });
        if (row.status === 'active') missingActive.push(row.id); // المحذوفة منطقياً غياب ملفها طبيعي
        continue;
      }
      const size = await fs.size(path);
      const hex = await putRecord(RECORD_KIND.attachment,
        { name: row.storage_name, size, id: row.id, status: row.status },
        (emit) => fromFile(path, size, emit));
      const ok = hex === row.sha256_cipher;
      if (!ok) mismatch.push(row.id);
      entries.push({ id: row.id, name: row.storage_name, size, sha256: hex, status: row.status, matchesRecorded: ok });
      attBytes += size;
    }

    // 8) البيان أخيراً ثم إنهاء التيار.
    deps.onProgress?.({ stage: 'finalizing', current: 0, total: 1 });
    const manifest: PackageManifest = {
      formatVersion: BACKUP_FORMAT_VERSION, kind: 'backup-package', backupId, createdAt, appName: 'SecureCaseDesk',
      database: {
        databaseFileName: DATABASE_FILE_NAME, size: dbSize, sha256: dbHash,
        journalMode: snap.manifest.journalMode, cipherVersion: snap.manifest.cipherVersion, snapshotId: snap.snapshotId,
      },
      secrets: secretList,
      attachments: { count: entries.length, totalBytes: attBytes, entries, missing },
      records: [...records],
    };
    const mBytes = enc.encode(JSON.stringify(manifest));
    await putRecord(RECORD_KIND.manifest, { name: 'manifest.json', size: mBytes.length },
      async (emit) => { await emit(mBytes); });
    const done = await w.finish();
    writer = null;
    await h.close();
    handle = null;

    // 9) مطابقة الحجم على القرص ثم تثبيت الاسم النهائي.
    if ((await fs.size(partialPath)) !== done.bytesWritten) throw new BackupError('PACKAGE_FAILED');
    await fs.move(partialPath, finalPath);
    succeeded = true;

    const warnings: PackageWarning[] = [];
    if (missingActive.length) warnings.push({ code: 'ATTACHMENT_FILE_MISSING', ids: missingActive,
      message: 'مرفقات نشطة بلا ملفات على الجهاز؛ سُجّل النقص في النسخة ولم يُخفَ.' });
    if (mismatch.length) warnings.push({ code: 'ATTACHMENT_HASH_MISMATCH', ids: mismatch,
      message: 'ملفات مرفقات بصمتها تخالف المسجّلة في القاعدة؛ نُسخت كما هي وسُجّل ذلك.' });
    if (invalid.length) warnings.push({ code: 'ATTACHMENT_NAME_INVALID', ids: invalid,
      message: 'مرفقات باسم تخزين غير صالح؛ لم تُنسخ.' });

    deps.onProgress?.({ stage: 'finalizing', current: 1, total: 1 });
    return {
      backupId, filePath: finalPath, fileName, sizeBytes: done.bytesWritten, sha256: done.sha256, createdAt,
      attachmentsIncluded: entries.length, attachmentsBytes: attBytes,
      secretsIncluded: secretList.map((s) => s.name), warnings, snapshotAttempts: snap.attempts,
    };
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError('PACKAGE_FAILED');
  } finally {
    try { writer?.abort(); } catch { /* تنظيف فقط */ }
    try { await handle?.close(); } catch { /* تنظيف فقط */ }
    if (!succeeded && partialPath) { try { await fs.remove(partialPath); } catch { /* تنظيف فقط */ } }
    if (snapshot) { try { await deps.discardSnapshot(snapshot); } catch { /* تنظيف فقط */ } }
    inFlight = false;
  }
}
