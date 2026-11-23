// SECURECASEDESK_PHASE10_S6
// تنفيذ استعادة النسخة الاحتياطية (.scdbak). بالحقن الكامل (قابل للاختبار في Node).
//
// المبدأ: لا يُمسّ أي شيء حي قبل اكتمال التحقق الكامل من النسخة في منطقة تجهيز (staging).
//   1) قراءة وفك تشفير كل السجلات إلى staging (AEAD + SHA-256 لكل سجل) ومطابقتها لبيان النسخة.
//   2) فتح قاعدة البيانات المجهّزة بمفتاحها وفحص سلامتها وجداولها.
//   3) نسخة أمان فيزيائية: نقل القاعدة والمرفقات الحالية إلى restore-safety وحفظ الأسرار الحالية في SecureStore.
//   4) تركيب: القاعدة + المرفقات + الأسرار، ثم إعادة فتح القاعدة والتحقق.
//   5) أي فشل بعد (3) → تراجع تلقائي كامل. سجل (journal) يُكتب قبل كل مرحلة لإكمال التراجع بعد انقطاع مفاجئ.
// الأسرار المصنّفة excluded لا تُقرأ من النسخة ولا تُمسّ أبداً.
// التراجع اليدوي بعد نجاح الاستعادة وحذف نسخة الأمان = القسم 10.7.

import {
  ATTACHMENT_STORAGE_NAME, BACKUP_FORMAT_VERSION, BackupError, DATABASE_FILE_NAME, REQUIRED_TABLES,
  RESTORE_STASH_PREFIX, SECRET_NAMES, auditHmacKeyName, type SecretSpec,
} from './backup-types';
import { PackageReader, RECORD_KIND, type BackupCryptoProvider } from './backup-format';
import type { PackageFs, PackageManifest } from './backup-package';

export interface RestoreFs extends PackageFs {
  list(dir: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
}

export interface DatabaseReport { cipherVersion: string; integrity: string; tables: string[] }

export interface RestoreProgress {
  stage: 'reading' | 'verifying' | 'safety' | 'installing' | 'verifying-live' | 'done';
  current: number;
  total: number;
}

export interface RestoreDeps {
  crypto: BackupCryptoProvider;
  fs: RestoreFs;
  stagingRoot: string;
  safetyRoot: string;
  journalPath: string;
  dbPath: string;
  attachmentsDir: string;
  secretSpecs: SecretSpec[];                       // التصنيف الحالي؛ excluded لا يُمسّ
  readSecret(name: string): Promise<string | null>;
  writeSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  validateStagedDatabase(path: string, dbKey: string): Promise<DatabaseReport>;
  closeDatabase(): Promise<void>;
  reopenAndVerify(): Promise<DatabaseReport>;      // بعد التركيب: يفتح بالمفتاح المستعاد
  flushPending?(): Promise<void>;                  // تصريف طابور التدقيق قبل لمس القاعدة
  preRestoreSafetyBackup?(): Promise<void>;        // خطّاف اختياري (نسخة 10.5)؛ فشله يوقف الاستعادة
  newId(): string;
  now(): number;
  yieldTick?(): Promise<void>;
  onProgress?(p: RestoreProgress): void;
}

export type RestoreState = 'prepared' | 'swapping' | 'committed' | 'rolled-back' | 'rollback-failed';

export interface RestoreJournal {
  version: 1;
  restoreId: string;
  state: RestoreState;
  startedAt: number;
  updatedAt: number;
  backupId: string;
  safetyDir: string;
  dbPath: string;
  attachmentsDir: string;
  hadDb: boolean;
  hadAttachmentsDir: boolean;
  touchedSecrets: string[];     // أسماء فقط
  stashedSecrets: string[];     // التي كانت موجودة وحُفظت في المخزن الآمن
}

export interface RestoreWarning { code: 'ATTACHMENT_FILE_MISSING' | 'ATTACHMENT_HASH_MISMATCH'; ids: string[]; message: string }

export interface RestoreResult {
  restoreId: string;
  backupId: string;
  backupCreatedAt: number;
  safetyDir: string;
  attachmentsRestored: number;
  secretsRestored: string[];
  warnings: RestoreWarning[];
  requiresRelogin: true;        // جدول المستخدمين استُبدل: يجب إنهاء الجلسة الحالية
}

export interface RestoreOptions { filePath: string; passphrase: string; confirmed: boolean }

const DB_SUFFIXES = ['-wal', '-shm', '-journal'];
const MAX_SMALL_RECORD = 1024 * 1024;
const ALWAYS_EXCLUDED = new Set<string>([SECRET_NAMES.sessionUser, SECRET_NAMES.apiUrl, SECRET_NAMES.apiToken]);
const HMAC_NAME = /^securecase_audit_hmac_key_v\d+$/;
const dec = new TextDecoder();
const join = (a: string, b: string) => a.replace(/\/+$/, '') + '/' + b;
let inFlight = false;

const stashKey = (restoreId: string, name: string) =>
  RESTORE_STASH_PREFIX + restoreId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 12) + '_' + name;

function excludedNames(specs: SecretSpec[]): Set<string> {
  const s = new Set(ALWAYS_EXCLUDED);
  for (const x of specs) if (x.cls === 'excluded') s.add(x.name);
  return s;
}

function isRestorable(name: string, specs: SecretSpec[]): boolean {
  if (excludedNames(specs).has(name)) return false;
  return HMAC_NAME.test(name) || specs.some((s) => s.name === name && s.cls !== 'excluded');
}

function reportOk(r: DatabaseReport): boolean {
  return typeof r.cipherVersion === 'string' && r.cipherVersion.length > 0 && r.integrity === 'ok' &&
    REQUIRED_TABLES.every((t) => r.tables.includes(t));
}

async function writeJournal(deps: RestoreDeps, j: RestoreJournal): Promise<void> {
  j.updatedAt = deps.now();
  const tmp = deps.journalPath + '.tmp';
  await deps.fs.writeText(tmp, JSON.stringify(j));
  await deps.fs.move(tmp, deps.journalPath);
}

async function readJournal(deps: RestoreDeps): Promise<RestoreJournal | null> {
  if (!(await deps.fs.exists(deps.journalPath))) return null;
  let o: Partial<RestoreJournal>;
  try { o = JSON.parse(await deps.fs.readText(deps.journalPath)); } catch { throw new BackupError('RESTORE_PENDING_RECOVERY'); }
  if (!o || o.version !== 1 || typeof o.restoreId !== 'string' || typeof o.state !== 'string' ||
      typeof o.safetyDir !== 'string' || !Array.isArray(o.touchedSecrets) || !Array.isArray(o.stashedSecrets)) {
    throw new BackupError('RESTORE_PENDING_RECOVERY');
  }
  return o as RestoreJournal;
}

const isPending = (j: RestoreJournal) => j.state === 'prepared' || j.state === 'swapping' || j.state === 'rollback-failed';

// تراجع مثالي التكرار (idempotent): يمكن استدعاؤه بعد انقطاع في أي نقطة.
async function rollback(deps: RestoreDeps, j: RestoreJournal): Promise<void> {
  const { fs } = deps;
  // لا نثق بمسارات من ملف على القرص إلا إن طابقت الإعداد الحالي.
  if (j.dbPath !== deps.dbPath || j.attachmentsDir !== deps.attachmentsDir) throw new BackupError('RESTORE_ROLLBACK_FAILED');
  await deps.closeDatabase();

  const savedDb = join(j.safetyDir, DATABASE_FILE_NAME);
  if (await fs.exists(savedDb)) {
    // اكتمل نقل القاعدة الأصلية: نعيدها كاملة ونزيل أي ملفات مصاحبة للقاعدة الجديدة.
    await fs.remove(deps.dbPath);
    for (const s of DB_SUFFIXES) await fs.remove(deps.dbPath + s);
    await fs.move(savedDb, deps.dbPath);
    for (const s of DB_SUFFIXES) {
      if (await fs.exists(savedDb + s)) await fs.move(savedDb + s, deps.dbPath + s);
    }
  } else {
    // انقطاع قبل نقل الملف الرئيسي: أعد المصاحبات التي نُقلت فقط.
    for (const s of DB_SUFFIXES) {
      if (await fs.exists(savedDb + s)) { await fs.remove(deps.dbPath + s); await fs.move(savedDb + s, deps.dbPath + s); }
    }
  }

  const savedAtt = join(j.safetyDir, 'attachments');
  if (await fs.exists(savedAtt)) {
    await fs.remove(deps.attachmentsDir);
    await fs.move(savedAtt, deps.attachmentsDir);
  } else if (!j.hadAttachmentsDir) {
    await fs.remove(deps.attachmentsDir);
  }

  for (const name of j.touchedSecrets) {
    if (j.stashedSecrets.includes(name)) {
      const v = await deps.readSecret(stashKey(j.restoreId, name));
      if (typeof v !== 'string' || v.length === 0) throw new BackupError('RESTORE_ROLLBACK_FAILED');
      await deps.writeSecret(name, v);
    } else {
      await deps.deleteSecret(name);
    }
  }

  j.state = 'rolled-back';
  await writeJournal(deps, j);
  for (const name of j.stashedSecrets) { try { await deps.deleteSecret(stashKey(j.restoreId, name)); } catch { /* تنظيف */ } }
  try { await fs.remove(j.safetyDir); } catch { /* الملفات عادت إلى أماكنها؛ المجلد فارغ */ }
}

export async function recoverInterruptedRestore(base: RestoreDeps): Promise<{ action: 'none' | 'rolled-back'; restoreId?: string }> {
  const j = await readJournal(base);
  if (!j || !isPending(j)) return { action: 'none' };
  if (typeof j.dbPath !== 'string' || !j.dbPath || typeof j.attachmentsDir !== 'string' || !j.attachmentsDir) {
    throw new BackupError('RESTORE_ROLLBACK_FAILED');
  }
  const deps: RestoreDeps = { ...base, dbPath: j.dbPath, attachmentsDir: j.attachmentsDir };
  try { await rollback(deps, j); } catch {
    j.state = 'rollback-failed';
    try { await writeJournal(deps, j); } catch { /* آخر محاولة */ }
    throw new BackupError('RESTORE_ROLLBACK_FAILED');
  }
  try { await deps.reopenAndVerify(); } catch { /* لا يغيّر نتيجة التراجع */ }
  return { action: 'rolled-back', restoreId: j.restoreId };
}

interface Seen { kind: number; name: string; size: number; sha256: string }

export async function restoreBackupPackage(deps: RestoreDeps, opts: RestoreOptions): Promise<RestoreResult> {
  if (opts.confirmed !== true) throw new BackupError('RESTORE_NOT_CONFIRMED');
  if (typeof opts.passphrase !== 'string' || opts.passphrase.length === 0) throw new BackupError('INVALID_PASSPHRASE');
  if (inFlight) throw new BackupError('RESTORE_IN_PROGRESS');
  inFlight = true;

  const { fs, crypto } = deps;
  const restoreId = deps.newId();
  const stagingDir = join(deps.stagingRoot, 'restore-' + restoreId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 12));
  const stagedDb = join(stagingDir, DATABASE_FILE_NAME);
  const stagedAtt = join(stagingDir, 'attachments');
  let touchedLive = false;

  try {
    // ---- 0) رفض أي استعادة سابقة غير مكتملة ----
    const prior = await readJournal(deps);
    if (prior && isPending(prior)) throw new BackupError('RESTORE_PENDING_RECOVERY');
    if (!(await fs.exists(opts.filePath))) throw new BackupError('PACKAGE_FORMAT_INVALID');

    // ---- 1) فك التشفير إلى staging والتحقق من كل سجل ----
    try { await fs.remove(stagingDir); await fs.ensureDir(stagedAtt); } catch { throw new BackupError('RESTORE_FAILED'); }

    const seen: Seen[] = [];
    const attachmentMeta = new Map<string, { id: string; status: string }>();
    let dbSeen = false;
    let secrets: Record<string, string> | null = null;
    let manifest: PackageManifest | null = null;

    const handle = await fs.openRead(opts.filePath);
    let reader: PackageReader | null = null;
    try {
      reader = await PackageReader.open(crypto, opts.passphrase, { read: (m) => handle.read(m) });
      let n = 0;
      for (;;) {
        const head = await reader.nextRecord();
        if (!head) break;
        if (manifest) throw new BackupError('RESTORE_PACKAGE_INVALID');   // لا شيء بعد البيان
        deps.onProgress?.({ stage: 'reading', current: ++n, total: 0 });

        if (head.kind === RECORD_KIND.database) {
          if (dbSeen || head.meta.name !== DATABASE_FILE_NAME) throw new BackupError('RESTORE_PACKAGE_INVALID');
          dbSeen = true;
          const w = await fs.openWrite(stagedDb);
          let sha: string;
          try { sha = await reader.readData((b) => w.write(b)); } finally { await w.close(); }
          seen.push({ kind: head.kind, name: head.meta.name, size: head.meta.size, sha256: sha });
        } else if (head.kind === RECORD_KIND.attachment) {
          const name = head.meta.name;
          if (!ATTACHMENT_STORAGE_NAME.test(name) || attachmentMeta.has(name)) throw new BackupError('RESTORE_PACKAGE_INVALID');
          attachmentMeta.set(name, { id: String(head.meta.id ?? ''), status: String(head.meta.status ?? '') });
          const w = await fs.openWrite(join(stagedAtt, name));
          let sha: string;
          try { sha = await reader.readData((b) => w.write(b)); } finally { await w.close(); }
          seen.push({ kind: head.kind, name, size: head.meta.size, sha256: sha });
          if (n % 8 === 0 && deps.yieldTick) await deps.yieldTick();
        } else if (head.kind === RECORD_KIND.secrets || head.kind === RECORD_KIND.manifest) {
          if (head.meta.size > MAX_SMALL_RECORD) throw new BackupError('RESTORE_PACKAGE_INVALID');
          if (head.kind === RECORD_KIND.secrets && secrets) throw new BackupError('RESTORE_PACKAGE_INVALID');
          const parts: Uint8Array[] = [];
          const sha = await reader.readData((b) => { parts.push(b.slice()); });
          const all = new Uint8Array(head.meta.size);
          let off = 0;
          for (const p of parts) { all.set(p, off); off += p.length; }
          let parsed: unknown;
          try { parsed = JSON.parse(dec.decode(all)); } catch { throw new BackupError('RESTORE_PACKAGE_INVALID'); }
          all.fill(0); parts.forEach((p) => p.fill(0));
          if (head.kind === RECORD_KIND.secrets) {
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BackupError('RESTORE_PACKAGE_INVALID');
            secrets = parsed as Record<string, string>;
            seen.push({ kind: head.kind, name: head.meta.name, size: head.meta.size, sha256: sha });
          } else {
            manifest = parsed as PackageManifest;
          }
        } else {
          throw new BackupError('RESTORE_PACKAGE_INVALID');
        }
      }
    } finally {
      reader?.close();
      try { await handle.close(); } catch { /* تنظيف */ }
    }
    if (!dbSeen || !secrets || !manifest) throw new BackupError('RESTORE_PACKAGE_INVALID');

    // ---- 2) مطابقة المحتوى للبيان ----
    deps.onProgress?.({ stage: 'verifying', current: 0, total: 1 });
    const m = manifest as PackageManifest;
    const sec = secrets as Record<string, string>;
    if (m.kind !== 'backup-package' || m.formatVersion !== BACKUP_FORMAT_VERSION || !Array.isArray(m.records) ||
        !m.database || !m.attachments || !Array.isArray(m.attachments.entries) || !Array.isArray(m.secrets)) {
      throw new BackupError('RESTORE_PACKAGE_INVALID');
    }
    if (m.records.length !== seen.length) throw new BackupError('RESTORE_PACKAGE_INVALID');
    for (let i = 0; i < seen.length; i++) {
      const a = seen[i], b = m.records[i];
      if (!b || a.kind !== b.kind || a.name !== b.name || a.size !== b.size || a.sha256 !== b.sha256) {
        throw new BackupError('RESTORE_PACKAGE_INVALID');
      }
    }
    const dbRec = seen.find((r) => r.kind === RECORD_KIND.database)!;
    if (m.database.sha256 !== dbRec.sha256 || m.database.size !== dbRec.size) throw new BackupError('RESTORE_PACKAGE_INVALID');

    const attRecs = seen.filter((r) => r.kind === RECORD_KIND.attachment);
    if (m.attachments.entries.length !== attRecs.length) throw new BackupError('RESTORE_PACKAGE_INVALID');
    const hashMismatch: string[] = [];
    for (const e of m.attachments.entries) {
      const r = attRecs.find((x) => x.name === e.name);
      const meta = attachmentMeta.get(e.name);
      if (!r || !meta || r.size !== e.size || r.sha256 !== e.sha256 || meta.id !== e.id) throw new BackupError('RESTORE_PACKAGE_INVALID');
      if (!e.matchesRecorded) hashMismatch.push(e.id);
    }
    const missingActive = (m.attachments.missing ?? []).filter((x) => x.status === 'active').map((x) => x.id);

    // الأسرار: لا excluded ولا أسماء مجهولة، وتطابق قائمة البيان، وكل قيمة نص غير فارغ.
    const secretNames = Object.keys(sec);
    for (const name of secretNames) {
      if (!isRestorable(name, deps.secretSpecs) || typeof sec[name] !== 'string' || sec[name].length === 0) {
        throw new BackupError('RESTORE_PACKAGE_INVALID');
      }
    }
    const listed = m.secrets.map((s) => s.name).sort().join('|');
    if (listed !== [...secretNames].sort().join('|')) throw new BackupError('RESTORE_PACKAGE_INVALID');

    const activeVersion = sec[SECRET_NAMES.auditActiveVersion];
    const required: string[] = [SECRET_NAMES.dbKey, SECRET_NAMES.auditActiveVersion];
    if (/^\d+$/.test(activeVersion ?? '')) required.push(auditHmacKeyName(Number(activeVersion)));
    if (m.attachments.entries.length > 0) required.push(SECRET_NAMES.attachmentMasterKey);
    if (required.some((r) => !sec[r]) || !/^\d+$/.test(activeVersion ?? '')) throw new BackupError('RESTORE_SECRETS_INCOMPLETE');

    // ---- 3) فحص القاعدة المجهّزة بمفتاحها ----
    let staged: DatabaseReport;
    try { staged = await deps.validateStagedDatabase(stagedDb, sec[SECRET_NAMES.dbKey]); } catch { throw new BackupError('RESTORE_DATABASE_INVALID'); }
    if (!reportOk(staged)) throw new BackupError('RESTORE_DATABASE_INVALID');
    for (const s of DB_SUFFIXES) await fs.remove(stagedDb + s);   // مصاحبات فتح الفحص
    deps.onProgress?.({ stage: 'verifying', current: 1, total: 1 });

    // ---- 4) تهيئة نسخة الأمان (لم يُمسّ شيء حي حتى الآن) ----
    try {
      if (deps.flushPending) await deps.flushPending();
      if (deps.preRestoreSafetyBackup) await deps.preRestoreSafetyBackup();
    } catch { throw new BackupError('RESTORE_FAILED'); }

    deps.onProgress?.({ stage: 'safety', current: 0, total: 1 });
    const safetyDir = join(deps.safetyRoot, restoreId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 12));
    const touched = [...new Set([...secretNames, ...deps.secretSpecs.filter((s) => s.cls !== 'excluded').map((s) => s.name)])]
      .filter((n) => isRestorable(n, deps.secretSpecs));
    const stashed: string[] = [];
    const stashWritten: string[] = [];
    try {
      await fs.remove(safetyDir);
      await fs.ensureDir(safetyDir);
      for (const name of touched) {
        const v = await deps.readSecret(name);
        if (typeof v === 'string' && v.length > 0) {
          await deps.writeSecret(stashKey(restoreId, name), v);
          stashWritten.push(name);
          stashed.push(name);
        }
      }
    } catch {
      for (const name of stashWritten) { try { await deps.deleteSecret(stashKey(restoreId, name)); } catch { /* تنظيف */ } }
      try { await fs.remove(safetyDir); } catch { /* تنظيف */ }
      throw new BackupError('RESTORE_FAILED');
    }

    const journal: RestoreJournal = {
      version: 1, restoreId, state: 'prepared', startedAt: deps.now(), updatedAt: deps.now(),
      backupId: m.backupId, safetyDir, dbPath: deps.dbPath, attachmentsDir: deps.attachmentsDir,
      hadDb: await fs.exists(deps.dbPath), hadAttachmentsDir: await fs.exists(deps.attachmentsDir),
      touchedSecrets: touched, stashedSecrets: stashed,
    };
    try { await writeJournal(deps, journal); } catch {
      for (const name of stashed) { try { await deps.deleteSecret(stashKey(restoreId, name)); } catch { /* تنظيف */ } }
      try { await fs.remove(safetyDir); } catch { /* تنظيف */ }
      throw new BackupError('RESTORE_FAILED');
    }
    deps.onProgress?.({ stage: 'safety', current: 1, total: 1 });

    // ---- 5) التبديل ----
    journal.state = 'swapping';
    touchedLive = true;
    try {
      await writeJournal(deps, journal);
      await deps.closeDatabase();

      // نقل الحالي إلى نسخة الأمان: المصاحبات أولاً ثم الملف الرئيسي.
      const savedDb = join(safetyDir, DATABASE_FILE_NAME);
      for (const s of DB_SUFFIXES) if (await fs.exists(deps.dbPath + s)) await fs.move(deps.dbPath + s, savedDb + s);
      if (await fs.exists(deps.dbPath)) await fs.move(deps.dbPath, savedDb);
      if (await fs.exists(deps.attachmentsDir)) await fs.move(deps.attachmentsDir, join(safetyDir, 'attachments'));

      deps.onProgress?.({ stage: 'installing', current: 0, total: 3 });
      await fs.move(stagedDb, deps.dbPath);
      await fs.move(stagedAtt, deps.attachmentsDir);
      deps.onProgress?.({ stage: 'installing', current: 1, total: 3 });
      for (const name of secretNames) await deps.writeSecret(name, sec[name]);
      for (const name of touched) if (!(name in sec)) await deps.deleteSecret(name);   // أسرار القاعدة القديمة التي لا تخص النسخة
      deps.onProgress?.({ stage: 'installing', current: 3, total: 3 });

      // ---- 6) التحقق الحي ----
      deps.onProgress?.({ stage: 'verifying-live', current: 0, total: 1 });
      const live = await deps.reopenAndVerify();
      if (!reportOk(live)) throw new Error('LIVE_DB_INVALID');
      for (const e of m.attachments.entries) {
        const p = join(deps.attachmentsDir, e.name);
        if (!(await fs.exists(p)) || (await fs.size(p)) !== e.size) throw new Error('LIVE_ATTACHMENT_MISMATCH');
      }
      deps.onProgress?.({ stage: 'verifying-live', current: 1, total: 1 });

      journal.state = 'committed';
      await writeJournal(deps, journal);
    } catch (e) {
      try { await rollback(deps, journal); } catch {
        journal.state = 'rollback-failed';
        try { await writeJournal(deps, journal); } catch { /* آخر محاولة */ }
        throw new BackupError('RESTORE_ROLLBACK_FAILED');
      }
      try { await deps.reopenAndVerify(); } catch { /* القاعدة الأصلية أُعيدت؛ الفتح يتكرر عند أول استعمال */ }
      throw new BackupError('RESTORE_ROLLED_BACK');
    }

    deps.onProgress?.({ stage: 'done', current: 1, total: 1 });
    const warnings: RestoreWarning[] = [];
    if (missingActive.length) warnings.push({ code: 'ATTACHMENT_FILE_MISSING', ids: missingActive,
      message: 'مرفقات نشطة كانت بلا ملفات وقت إنشاء النسخة؛ تبقى ناقصة بعد الاستعادة.' });
    if (hashMismatch.length) warnings.push({ code: 'ATTACHMENT_HASH_MISMATCH', ids: hashMismatch,
      message: 'مرفقات بصمتها كانت مخالفة للمسجّلة وقت إنشاء النسخة؛ استُعيدت كما هي.' });
    return {
      restoreId, backupId: m.backupId, backupCreatedAt: m.createdAt, safetyDir,
      attachmentsRestored: attRecs.length, secretsRestored: secretNames, warnings, requiresRelogin: true,
    };
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError(touchedLive ? 'RESTORE_ROLLED_BACK' : 'RESTORE_FAILED');
  } finally {
    try { await fs.remove(stagingDir); } catch { /* تنظيف */ }
    inFlight = false;
  }
}
