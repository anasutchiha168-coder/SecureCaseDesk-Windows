#!/usr/bin/env bash
# SecureCaseDesk — المرحلة 10 / القسم 10.6: تنفيذ استعادة البيانات
# التشغيل من جذر المشروع:  bash apply-10.6.sh
set -euo pipefail

[ -f package.json ] && grep -q '"name": "securecasedesk"' package.json || { echo "✗ شغّل السكربت من جذر مشروع securecasedesk"; exit 1; }
for f in src/modules/backup/backup-types.ts src/modules/backup/backup-package.ts src/modules/backup/backup-format.ts src/database/db.ts; do
  [ -f "$f" ] || { echo "✗ ملف مطلوب مفقود: $f (أكمل 10.1–10.3 أولاً)"; exit 1; }
done
if [ -f src/modules/backup/backup-restore.ts ] && grep -q PHASE10_S6 src/database/db.ts; then
  echo "ℹ 10.6 مطبّق سابقاً؛ سيُعاد كتابة ملفات 10.6 فقط (نسخ احتياطية .bak تُنشأ)."
fi
command -v node >/dev/null || { echo "✗ node غير موجود"; exit 1; }

TS=$(date +%Y%m%d_%H%M%S)
bak() { [ -f "$1" ] && cp "$1" "$1.bak_$TS" || true; }

write_file() { # $1 المسار ؛ المحتوى من stdin
  mkdir -p "$(dirname "$1")"; bak "$1"; cat > "$1"; echo "✓ كُتب $1"
}
write_file 'src/modules/backup/backup-restore.ts' <<'SCD_EOF_0'
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
SCD_EOF_0
write_file 'src/modules/backup/backup-restore-runtime.ts' <<'SCD_EOF_1'
// SECURECASEDESK_PHASE10_S6
// محوّل Expo لاستعادة النسخة الاحتياطية.
// ⚠️ لم يُشغَّل على جهاز: يحتاج فحص tsc وتجربة فعلية لـ:
//    Directory.move / File.move على مجلدات، Directory.list، File.text()، وفتح قاعدة من مجلد مخصص
//    عبر SQLite.openDatabaseAsync(name, options, directory).
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { closeDb, getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import { flushAuditQueue, recordAuditEvent } from '@/services/audit.service';
import { inspectBackupReadiness } from './backup-runtime';
import type { BackupCryptoProvider } from './backup-format';
import {
  restoreBackupPackage, recoverInterruptedRestore,
  type DatabaseReport, type RestoreDeps, type RestoreFs, type RestoreProgress, type RestoreResult,
} from './backup-restore';
import {
  ATTACHMENTS_DIR_NAME, BACKUP_PERMISSION,
  RESTORE_JOURNAL_FILE_NAME, RESTORE_SAFETY_DIR_NAME, RESTORE_STAGING_DIR_NAME,
} from './backup-types';

const cryptoProvider: BackupCryptoProvider = {
  randomBytes: (n) => Crypto.getRandomBytes(n),
  sha256: () => sha256.create(),
  scrypt: (pw, salt, { N, r, p }, len) => scryptAsync(pw, salt, { N, r, p, dkLen: len, asyncTick: 10 }),
  hkdfSha256: (master, salt, info, len) => hkdf(sha256, master, salt, info, len),
  aeadEncrypt: (key, nonce, aad, plain) => chacha20poly1305(key, nonce, aad).encrypt(plain),
  aeadDecrypt: (key, nonce, aad, ct) => chacha20poly1305(key, nonce, aad).decrypt(ct),
};

function removeIfExists(path: string) {
  const f = new File(path);
  if (f.exists) { f.delete(); return; }
  const d = new Directory(path);
  if (d.exists) d.delete();
}

const stripScheme = (uri: string) => uri.replace(/^file:\/\//, '').replace(/\/+$/, '');

const expoRestoreFs: RestoreFs = {
  async ensureDir(path) { new Directory(path).create({ intermediates: true, idempotent: true }); },
  async exists(path) { return new File(path).exists || new Directory(path).exists; },
  async size(path) { const f = new File(path); return f.exists ? f.size : 0; },
  async remove(path) { removeIfExists(path); },
  async move(from, to) {
    removeIfExists(to);
    const f = new File(from);
    if (f.exists) { f.move(new File(to)); return; }
    const d = new Directory(from);
    if (d.exists) { d.move(new Directory(to)); return; }
    throw new Error('MOVE_SOURCE_MISSING');
  },
  async openRead(path) {
    const h = new File(path).open(FileMode.ReadOnly);
    return { async read(max) { return h.readBytesSync(max); }, async close() { h.close(); } };
  },
  async openWrite(path) {
    removeIfExists(path);
    const f = new File(path);
    f.create();
    const h = f.open(FileMode.WriteOnly);
    return { async write(bytes) { h.writeBytes(bytes); }, async close() { h.close(); } };
  },
  async list(dir) {
    const d = new Directory(dir);
    return d.exists ? d.list().map((x) => x.name) : [];
  },
  async readText(path) { return await new File(path).text(); },
  async writeText(path, text) {
    const f = new File(path);
    if (f.exists) f.delete();
    f.create();
    f.write(text);
  },
};

async function inspectOpenDatabase(db: SQLite.SQLiteDatabase): Promise<DatabaseReport> {
  const c = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version;');
  const q = await db.getFirstAsync<{ quick_check: string }>('PRAGMA quick_check;');
  const t = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  return { cipherVersion: c?.cipher_version ?? '', integrity: q?.quick_check ?? 'unknown', tables: t.map((x) => x.name) };
}

function buildDeps(): RestoreDeps {
  const documentDir = stripScheme(Paths.document.uri);
  const cacheDir = stripScheme(Paths.cache.uri);
  return {
    crypto: cryptoProvider,
    fs: expoRestoreFs,
    stagingRoot: cacheDir + '/' + RESTORE_STAGING_DIR_NAME,
    // نسخة الأمان في document (نفس وحدة التخزين → النقل إعادة تسمية سريعة وذرّية).
    safetyRoot: documentDir + '/' + RESTORE_SAFETY_DIR_NAME,
    journalPath: documentDir + '/' + RESTORE_JOURNAL_FILE_NAME,
    dbPath: '', // يُضبط في التنفيذ من مسار قاعدة البيانات الحالية
    attachmentsDir: documentDir + '/' + ATTACHMENTS_DIR_NAME,
    secretSpecs: [],
    readSecret: (n) => SecureStore.getItemAsync(n),
    writeSecret: (n, v) => SecureStore.setItemAsync(n, v),
    deleteSecret: (n) => SecureStore.deleteItemAsync(n),
    validateStagedDatabase: async (path, dbKey) => {
      const slash = path.lastIndexOf('/');
      const dir = path.slice(0, slash);
      const name = path.slice(slash + 1);
      const sdb = await SQLite.openDatabaseAsync(name, undefined, dir);
      try {
        await sdb.execAsync(`PRAGMA key = '${dbKey.replace(/'/g, "''")}';`);
        return await inspectOpenDatabase(sdb);
      } finally { await sdb.closeAsync(); }
    },
    closeDatabase: () => closeDb(),
    reopenAndVerify: async () => inspectOpenDatabase(await getDb()),
    flushPending: () => flushAuditQueue(),
    newId: () => Crypto.randomUUID(),
    now: () => Date.now(),
    yieldTick: () => new Promise((r) => setTimeout(r, 0)),
  };
}

// صلاحية مزدوجة + تأكيد صريح + استعادة. بعد النجاح يجب على الواجهة إنهاء الجلسة (requiresRelogin).
export async function restoreEncryptedBackup(
  session: Session | null | undefined,
  filePath: string,
  passphrase: string,
  confirmed: boolean,
  onProgress?: (p: RestoreProgress) => void,
  preRestoreSafetyBackup?: () => Promise<void>
): Promise<RestoreResult & { auditLogged: boolean }> {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);

  // التصنيف الحالي للأسرار (الأسماء فقط) + اسم المستخدم قبل استبدال جدول المستخدمين.
  const inventory = await inspectBackupReadiness(s);
  const actorRow = await db.getFirstAsync<{ username: string }>('SELECT username FROM users WHERE id = ?', [s.userId]);

  const deps = buildDeps();
  deps.dbPath = db.databasePath;
  deps.secretSpecs = inventory.secrets;
  deps.onProgress = onProgress;
  deps.preRestoreSafetyBackup = preRestoreSafetyBackup;

  const result = await restoreBackupPackage(deps, { filePath, passphrase, confirmed });

  // التسجيل في سلسلة التدقيق المستعادة (حدث جديد يُلحق؛ لا تعديل لسجلات قديمة). فشله لا يُبطل الاستعادة.
  let auditLogged = true;
  try {
    await recordAuditEvent({
      operationType: 'backup_restore', entityType: 'backup', entityId: result.backupId,
      actor: { id: s.userId, username: actorRow?.username ?? null },
      newValues: {
        restoreId: result.restoreId, backupCreatedAt: result.backupCreatedAt,
        attachmentsRestored: result.attachmentsRestored, warnings: result.warnings.map((w) => w.code),
      },
      eventKey: 'backup_restore:' + result.restoreId,
    });
    await flushAuditQueue();
  } catch { auditLogged = false; }
  return { ...result, auditLogged };
}

// يُستدعى مرة عند إقلاع التطبيق قبل initDatabase(): يكمل التراجع إن انقطعت استعادة سابقة.
export async function recoverRestoreOnStartup(): Promise<{ action: 'none' | 'rolled-back'; restoreId?: string }> {
  // المسارات تُؤخذ من سجل الاستعادة نفسه (كُتب بمسار القاعدة الفعلي وقت الاستعادة).
  return recoverInterruptedRestore(buildDeps());
}
SCD_EOF_1
write_file 'tests/backup-restore.test.ts' <<'SCD_EOF_2'
// SECURECASEDESK_PHASE10_S6
// اختبارات المرحلة 10 / القسم 10.6 — تنفيذ الاستعادة. تشغَّل بـ: npm run test:backup-restore
// ملفات حقيقية على القرص + تشفير حقيقي (node:crypto). قاعدة SQLCipher وSecureStore محاكاة (غير متاحتين في Node).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackupPackage, type AttachmentRow, type PackageDeps } from '../src/modules/backup/backup-package';
import type { BackupCryptoProvider } from '../src/modules/backup/backup-format';
import {
  recoverInterruptedRestore, restoreBackupPackage, type DatabaseReport, type RestoreDeps, type RestoreFs, type RestoreJournal,
} from '../src/modules/backup/backup-restore';
import { BackupError, REQUIRED_TABLES, type BackupErrorCode, type DatabaseSnapshot, type SecretSpec } from '../src/modules/backup/backup-types';

const KDF = { logN: 10, r: 8, p: 1 };
const CHUNK = 4096;
const PASS = 'كلمة-مرور-قوية-للنسخة-123';

const nodeCrypto: BackupCryptoProvider = {
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
  sha256: () => { const h = createHash('sha256'); return { update: (b) => { h.update(b); }, digest: () => new Uint8Array(h.digest()) }; },
  scrypt: async (pw, salt, { N, r, p }, len) => new Uint8Array(scryptSync(pw, salt, len, { N, r, p, maxmem: 256 * 1024 * 1024 })),
  hkdfSha256: (m, s, i, l) => new Uint8Array(hkdfSync('sha256', m, s, i, l)),
  aeadEncrypt(key, nonce, aad, plain) {
    const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    c.setAAD(aad);
    return new Uint8Array(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]));
  },
  aeadDecrypt(key, nonce, aad, sealed) {
    const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    d.setAAD(aad);
    d.setAuthTag(sealed.slice(sealed.length - 16));
    return new Uint8Array(Buffer.concat([d.update(sealed.slice(0, sealed.length - 16)), d.final()]));
  },
};

const nodeFs: RestoreFs = {
  async ensureDir(p) { fs.mkdirSync(p, { recursive: true }); },
  async exists(p) { return fs.existsSync(p); },
  async size(p) { return fs.existsSync(p) ? fs.statSync(p).size : 0; },
  async remove(p) { fs.rmSync(p, { recursive: true, force: true }); },
  async move(a, b) { fs.rmSync(b, { recursive: true, force: true }); fs.renameSync(a, b); },
  async openRead(p) {
    const fd = fs.openSync(p, 'r');
    return {
      async read(max) { const b = Buffer.alloc(max); const n = fs.readSync(fd, b, 0, max, null); return new Uint8Array(b.subarray(0, n)); },
      async close() { fs.closeSync(fd); },
    };
  },
  async openWrite(p) {
    const fd = fs.openSync(p, 'w');
    return { async write(bytes) { fs.writeSync(fd, bytes); }, async close() { fs.closeSync(fd); } };
  },
  async list(p) { return fs.existsSync(p) ? fs.readdirSync(p) : []; },
  async readText(p) { return fs.readFileSync(p, 'utf8'); },
  async writeText(p, t) { fs.writeFileSync(p, t, 'utf8'); },
};

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const OK_REPORT: DatabaseReport = { cipherVersion: '4.5.7 community', integrity: 'ok', tables: [...REQUIRED_TABLES] };

const SPECS: SecretSpec[] = [
  { name: 'db_encryption_key', cls: 'required', reason: '' },
  { name: 'securecase_audit_active_version', cls: 'required', reason: '' },
  { name: 'securecase_audit_hmac_key_v1', cls: 'required', reason: '' },
  { name: 'attachment_master_key_v1', cls: 'required', reason: '' },
  { name: 'securecase_audit_checkpoint_key_v1', cls: 'recommended', reason: '' },
  { name: 'securecase_audit_checkpoint_last', cls: 'review', reason: '' },
  { name: 'securecase_session_uid', cls: 'excluded', reason: '' },
  { name: 'securecase_api_token', cls: 'excluded', reason: '' },
];

let root: string, liveDir: string, dbPath: string, attDir: string, stagingRoot: string, safetyRoot: string, journalPath: string, outDir: string;
let store: Map<string, string>;
let ids = 0;
let closes = 0;

// ---- "النظام الحي" الحالي ----
const LIVE_DB = Buffer.from('LIVE-DATABASE-BYTES-' + 'x'.repeat(5000));
const LIVE_ATT_NAME = '11111111-1111-1111-1111-111111111111.enc';
const LIVE_ATT = Buffer.from('live-attachment-data');

// ---- محتوى النسخة ----
let bakDb: Buffer;
let bakAtts: { name: string; data: Buffer; row: AttachmentRow }[];
let bakSecrets: Record<string, string>;

function liveSetup() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, LIVE_DB);
  fs.writeFileSync(dbPath + '-wal', 'live-wal');
  fs.mkdirSync(attDir, { recursive: true });
  fs.writeFileSync(path.join(attDir, LIVE_ATT_NAME), LIVE_ATT);
  store = new Map([
    ['db_encryption_key', 'LIVE-KEY'],
    ['securecase_audit_active_version', '1'],
    ['securecase_audit_hmac_key_v1', 'LIVE-HMAC'],
    ['attachment_master_key_v1', 'LIVE-ATT-KEY'],
    ['securecase_audit_checkpoint_last', 'LIVE-CKPT'],   // غير موجود في النسخة → يجب حذفه ثم إعادته عند التراجع
    ['securecase_session_uid', 'SESSION-LIVE'],
    ['securecase_api_token', 'TOKEN-LIVE'],
  ]);
}

async function makePackage(over: { atts?: number; secrets?: Record<string, string>; specs?: SecretSpec[]; missingActive?: boolean } = {}): Promise<string> {
  const n = over.atts ?? 2;
  bakDb = Buffer.concat([Buffer.from('BACKUP-DATABASE-'), randomBytes(9000)]);
  bakAtts = [];
  const rows: AttachmentRow[] = [];
  const srcAtt = path.join(root, 'bak-src-att');
  fs.mkdirSync(srcAtt, { recursive: true });
  for (let i = 0; i < n; i++) {
    const name = crypto.randomUUID() + '.enc';
    const data = randomBytes(3000 + i * 1000);
    const row: AttachmentRow = { id: crypto.randomUUID(), storage_name: name, status: 'active', sha256_cipher: sha(data), size_bytes: data.length };
    if (!(over.missingActive && i === 0)) fs.writeFileSync(path.join(srcAtt, name), data);
    rows.push(row);
    if (!(over.missingActive && i === 0)) bakAtts.push({ name, data, row });
  }
  bakSecrets = over.secrets ?? {
    db_encryption_key: 'BAK-KEY', securecase_audit_active_version: '1', securecase_audit_hmac_key_v1: 'BAK-HMAC',
    attachment_master_key_v1: 'BAK-ATT-KEY', securecase_audit_checkpoint_key_v1: 'BAK-CKPT-KEY',
  };
  const snapDir = path.join(root, 'snap-' + (++ids));
  fs.mkdirSync(snapDir, { recursive: true });
  const snapDb = path.join(snapDir, 'database.snapshot');
  fs.writeFileSync(snapDb, bakDb);
  const snapshot: DatabaseSnapshot = {
    snapshotId: 'snap' + ids, directory: snapDir, databasePath: snapDb, manifestPath: '', attempts: 1,
    manifest: { formatVersion: 1, kind: 'database-snapshot', snapshotId: 'snap' + ids, createdAt: 1, databaseFileName: 'securecase.db',
      sizeBytes: bakDb.length, sha256: sha(bakDb), journalMode: 'delete', cipherVersion: '4.5.7' },
  };
  const pdeps: PackageDeps = {
    crypto: nodeCrypto, fs: nodeFs, kdf: KDF, chunkSize: CHUNK, outputDir: outDir,
    takeSnapshot: async () => snapshot, discardSnapshot: async () => {},
    readAttachmentRows: async () => rows,
    attachmentPath: (name) => path.join(srcAtt, name),
    secretSpecs: over.specs ?? SPECS,
    readSecret: async (name) => bakSecrets[name] ?? null,
    newId: () => 'bk-' + (++ids), now: () => 1_700_000_000_000 + ids,
  };
  const r = await createBackupPackage(pdeps, PASS, PASS);
  return r.filePath;
}

interface Hooks {
  validate?: (p: string, key: string) => Promise<DatabaseReport>;
  reopen?: () => Promise<DatabaseReport>;
  moveFailAfter?: number;          // بعد N عمليات move تفشل كل الباقي (يحاكي موت العملية)
  flush?: () => Promise<void>;
}

let moves = 0;
let moveBroken = false;
function rdeps(h: Hooks = {}): RestoreDeps {
  moves = 0;
  moveBroken = false;
  const faultyFs: RestoreFs = {
    ...nodeFs,
    async move(a, b) {
      if (moveBroken || (h.moveFailAfter !== undefined && ++moves > h.moveFailAfter)) { moveBroken = true; throw new Error('io error'); }
      return nodeFs.move(a, b);
    },
  };
  return {
    crypto: nodeCrypto, fs: faultyFs, stagingRoot, safetyRoot, journalPath, dbPath, attachmentsDir: attDir,
    secretSpecs: SPECS,
    readSecret: async (n) => store.get(n) ?? null,
    writeSecret: async (n, v) => { store.set(n, v); },
    deleteSecret: async (n) => { store.delete(n); },
    validateStagedDatabase: h.validate ?? (async (p) => {
      assert.ok(fs.readFileSync(p).equals(bakDb), 'staged db must equal backup db');
      return OK_REPORT;
    }),
    closeDatabase: async () => { closes++; },
    reopenAndVerify: h.reopen ?? (async () => OK_REPORT),
    flushPending: h.flush,
    newId: () => 'rs-' + (++ids), now: () => 1_800_000_000_000 + ids,
  };
}

const run = (d: RestoreDeps, file: string, pass = PASS, confirmed = true) =>
  restoreBackupPackage(d, { filePath: file, passphrase: pass, confirmed });

async function code(p: Promise<unknown>): Promise<BackupErrorCode> {
  try { await p; } catch (e) { if (e instanceof BackupError) return e.code; throw e; }
  throw new Error('expected BackupError');
}

function assertLiveUntouched() {
  assert.ok(fs.readFileSync(dbPath).equals(LIVE_DB));
  assert.equal(fs.readFileSync(dbPath + '-wal', 'utf8'), 'live-wal');
  assert.deepEqual(fs.readdirSync(attDir), [LIVE_ATT_NAME]);
  assert.ok(fs.readFileSync(path.join(attDir, LIVE_ATT_NAME)).equals(LIVE_ATT));
  assert.equal(store.get('db_encryption_key'), 'LIVE-KEY');
  assert.equal(store.get('securecase_audit_hmac_key_v1'), 'LIVE-HMAC');
  assert.equal(store.get('securecase_audit_checkpoint_last'), 'LIVE-CKPT');
  assert.equal(store.get('securecase_session_uid'), 'SESSION-LIVE');
  assert.equal(store.get('securecase_api_token'), 'TOKEN-LIVE');
  assert.equal([...store.keys()].filter((k) => k.startsWith('restore_safety_')).length, 0, 'no stash leftovers');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-restore-'));
  liveDir = path.join(root, 'live');
  dbPath = path.join(liveDir, 'SQLite', 'securecase.db');
  attDir = path.join(liveDir, 'attachments');
  stagingRoot = path.join(root, 'cache', 'restore-staging');
  safetyRoot = path.join(liveDir, 'restore-safety');
  journalPath = path.join(liveDir, 'restore-journal.json');
  outDir = path.join(root, 'backups');
  closes = 0;
  liveSetup();
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('10.6 الاستعادة — المسار الناجح', () => {
  test('استبدال كامل: القاعدة والمرفقات والأسرار، وبقاء excluded', async () => {
    const file = await makePackage();
    const res = await run(rdeps(), file);

    assert.ok(fs.readFileSync(dbPath).equals(bakDb));
    assert.equal(fs.existsSync(dbPath + '-wal'), false, 'لا مصاحبات قاعدة قديمة');
    const names = fs.readdirSync(attDir).sort();
    assert.deepEqual(names, bakAtts.map((a) => a.name).sort());
    for (const a of bakAtts) assert.ok(fs.readFileSync(path.join(attDir, a.name)).equals(a.data));

    assert.equal(store.get('db_encryption_key'), 'BAK-KEY');
    assert.equal(store.get('securecase_audit_hmac_key_v1'), 'BAK-HMAC');
    assert.equal(store.get('attachment_master_key_v1'), 'BAK-ATT-KEY');
    assert.equal(store.has('securecase_audit_checkpoint_last'), false, 'سر القاعدة القديمة غير الموجود في النسخة يُحذف');
    assert.equal(store.get('securecase_session_uid'), 'SESSION-LIVE');
    assert.equal(store.get('securecase_api_token'), 'TOKEN-LIVE');

    assert.equal(res.requiresRelogin, true);
    assert.equal(res.attachmentsRestored, 2);
    assert.equal(res.warnings.length, 0);
    assert.ok(closes >= 1);
  });

  test('نسخة الأمان تحوي القاعدة والمرفقات والأسرار الأصلية، والسجل committed، والتجهيز محذوف', async () => {
    const file = await makePackage();
    const res = await run(rdeps(), file);
    assert.ok(fs.readFileSync(path.join(res.safetyDir, 'securecase.db')).equals(LIVE_DB));
    assert.equal(fs.readFileSync(path.join(res.safetyDir, 'securecase.db-wal'), 'utf8'), 'live-wal');
    assert.ok(fs.readFileSync(path.join(res.safetyDir, 'attachments', LIVE_ATT_NAME)).equals(LIVE_ATT));
    const j = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as RestoreJournal;
    assert.equal(j.state, 'committed');
    assert.ok(j.stashedSecrets.includes('db_encryption_key'));
    assert.equal(JSON.stringify(j).includes('LIVE-KEY'), false, 'السجل لا يحوي قيم أسرار');
    const stash = [...store.entries()].filter(([k]) => k.startsWith('restore_safety_'));
    assert.ok(stash.some(([, v]) => v === 'LIVE-KEY'));
    assert.equal(fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).length : 0, 0);
  });

  test('نسخة بلا مرفقات', async () => {
    const file = await makePackage({ atts: 0 });
    await run(rdeps(), file);
    assert.deepEqual(fs.readdirSync(attDir), []);
    assert.ok(fs.readFileSync(dbPath).equals(bakDb));
  });

  test('مرفق نشط ناقص وقت النسخ: تنجح الاستعادة مع تحذير', async () => {
    const file = await makePackage({ atts: 2, missingActive: true });
    const res = await run(rdeps(), file);
    assert.equal(res.attachmentsRestored, 1);
    assert.equal(res.warnings[0].code, 'ATTACHMENT_FILE_MISSING');
  });

  test('يستدعي flushPending قبل لمس البيانات', async () => {
    const file = await makePackage();
    let flushed = false;
    await run(rdeps({ flush: async () => { flushed = true; assert.ok(fs.readFileSync(dbPath).equals(LIVE_DB)); } }), file);
    assert.equal(flushed, true);
  });
});

describe('10.6 الاستعادة — رفض قبل أي تعديل', () => {
  test('بلا تأكيد صريح', async () => {
    const file = await makePackage();
    assert.equal(await code(run(rdeps(), file, PASS, false)), 'RESTORE_NOT_CONFIRMED');
    assertLiveUntouched();
  });

  test('كلمة مرور خاطئة', async () => {
    const file = await makePackage();
    assert.equal(await code(run(rdeps(), file, 'كلمة-خاطئة-تماماً-999')), 'PACKAGE_AUTH_FAILED');
    assertLiveUntouched();
  });

  test('كلمة مرور فارغة', async () => {
    const file = await makePackage();
    assert.equal(await code(run(rdeps(), file, '')), 'INVALID_PASSPHRASE');
    assertLiveUntouched();
  });

  test('ملف غير موجود', async () => {
    assert.equal(await code(run(rdeps(), path.join(root, 'nope.scdbak'))), 'PACKAGE_FORMAT_INVALID');
    assertLiveUntouched();
  });

  test('قلب بايت داخل الملف', async () => {
    const file = await makePackage();
    const buf = fs.readFileSync(file);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    fs.writeFileSync(file, buf);
    const c = await code(run(rdeps(), file));
    assert.ok(c === 'PACKAGE_AUTH_FAILED' || c === 'PACKAGE_FORMAT_INVALID');
    assertLiveUntouched();
  });

  test('ملف مبتور', async () => {
    const file = await makePackage();
    const buf = fs.readFileSync(file);
    fs.writeFileSync(file, buf.subarray(0, buf.length - 100));
    const c = await code(run(rdeps(), file));
    assert.ok(c === 'PACKAGE_AUTH_FAILED' || c === 'PACKAGE_FORMAT_INVALID');
    assertLiveUntouched();
  });

  test('ملف ليس نسخة أصلاً', async () => {
    const file = path.join(root, 'junk.scdbak');
    fs.writeFileSync(file, randomBytes(500));
    assert.equal(await code(run(rdeps(), file)), 'PACKAGE_FORMAT_INVALID');
    assertLiveUntouched();
  });

  test('قاعدة مجهّزة لا تُفتح', async () => {
    const file = await makePackage();
    const c = await code(run(rdeps({ validate: async () => { throw new Error('file is not a database'); } }), file));
    assert.equal(c, 'RESTORE_DATABASE_INVALID');
    assertLiveUntouched();
  });

  test('قاعدة مجهّزة فشل فحص سلامتها أو ينقصها جدول', async () => {
    const file = await makePackage();
    assert.equal(await code(run(rdeps({ validate: async () => ({ ...OK_REPORT, integrity: 'row 3 missing' }) }), file)), 'RESTORE_DATABASE_INVALID');
    assert.equal(await code(run(rdeps({ validate: async () => ({ ...OK_REPORT, tables: ['users'] }) }), file)), 'RESTORE_DATABASE_INVALID');
    assert.equal(await code(run(rdeps({ validate: async () => ({ ...OK_REPORT, cipherVersion: '' }) }), file)), 'RESTORE_DATABASE_INVALID');
    assertLiveUntouched();
  });

  test('نسخة تنقصها أسرار إلزامية', async () => {
    // المُنشئ نفسه يرفض غياب السر الإلزامي، فنخفّض تصنيفه وقت الإنشاء فقط لنحاكي نسخة ناقصة.
    const specs = SPECS.map((s) => (s.name === 'attachment_master_key_v1' ? { ...s, cls: 'recommended' as const } : s));
    const file = await makePackage({ specs, secrets: { db_encryption_key: 'K', securecase_audit_active_version: '1', securecase_audit_hmac_key_v1: 'H' } });
    assert.equal(await code(run(rdeps(), file)), 'RESTORE_SECRETS_INCOMPLETE');
    assertLiveUntouched();
  });

  test('نسخة تحمل سراً مستبعداً (excluded) تُرفض', async () => {
    const specs = SPECS.map((s) => (s.name === 'securecase_session_uid' ? { ...s, cls: 'recommended' as const } : s));
    const file = await makePackage({ specs, secrets: {
      db_encryption_key: 'K', securecase_audit_active_version: '1', securecase_audit_hmac_key_v1: 'H',
      attachment_master_key_v1: 'A', securecase_session_uid: 'EVIL-SESSION' } });
    assert.equal(await code(run(rdeps(), file)), 'RESTORE_PACKAGE_INVALID');
    assertLiveUntouched();
  });

  test('فشل flushPending يوقف الاستعادة قبل اللمس', async () => {
    const file = await makePackage();
    assert.equal(await code(run(rdeps({ flush: async () => { throw new Error('x'); } }), file)), 'RESTORE_FAILED');
    assertLiveUntouched();
  });

  test('استعادتان متزامنتان: الثانية تُرفض', async () => {
    const file = await makePackage();
    const [a, b] = await Promise.allSettled([run(rdeps(), file), run(rdeps(), file)]);
    const codes = [a, b].map((r) => (r.status === 'rejected' ? (r.reason as BackupError).code : 'ok'));
    assert.ok(codes.includes('ok'));
    assert.ok(codes.includes('RESTORE_IN_PROGRESS'));
  });
});

describe('10.6 الاستعادة — التراجع التلقائي', () => {
  test('فشل التحقق بعد إعادة الفتح → عودة كاملة للحالة الأصلية', async () => {
    const file = await makePackage();
    let calls = 0;
    const c = await code(run(rdeps({ reopen: async () => {
      calls++;
      if (calls === 1) return { ...OK_REPORT, integrity: 'corrupt' };
      return OK_REPORT;
    } }), file));
    assert.equal(c, 'RESTORE_ROLLED_BACK');
    assertLiveUntouched();
    const j = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as RestoreJournal;
    assert.equal(j.state, 'rolled-back');
    assert.equal(fs.existsSync(safetyRoot) ? fs.readdirSync(safetyRoot).length : 0, 0);
  });

  test('فشل أثناء نقل المرفقات الجديدة → تراجع', async () => {
    const file = await makePackage();
    // حركات: wal، قاعدة، مرفقات حالية (3)، ثم قاعدة جديدة (4)، مرفقات جديدة (5 ← تفشل)
    const d = rdeps();
    let n = 0;
    const origMove = d.fs.move;
    d.fs = { ...d.fs, move: async (a, b) => {
      if (a.endsWith(path.join('restore-staging').slice(0)) ) return origMove(a, b);
      if (path.basename(b) === 'attachments' && a.includes('restore-')) { n++; throw new Error('io error at install attachments'); }
      return origMove(a, b);
    } };
    assert.equal(await code(run(d, file)), 'RESTORE_ROLLED_BACK');
    assert.ok(n >= 1);
    assertLiveUntouched();
  });

  test('انقطاع دائم أثناء التبديل: RESTORE_ROLLBACK_FAILED ثم recoverInterruptedRestore يكمل التراجع', async () => {
    const file = await makePackage();
    // 1: journal.tmp، 2: journal.tmp، 3: wal إلى الأمان، 4: القاعدة، ثم تموت كل العمليات.
    const c = await code(run(rdeps({ moveFailAfter: 4 }), file));
    assert.equal(c, 'RESTORE_ROLLBACK_FAILED');
    const j = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as RestoreJournal;
    assert.ok(j.state === 'swapping' || j.state === 'rollback-failed');
    assert.equal(fs.existsSync(path.join(j.safetyDir, 'securecase.db')), true, 'القاعدة الأصلية آمنة في نسخة الأمان');

    // استعادة جديدة محجوبة حتى يكتمل التراجع
    assert.equal(await code(run(rdeps(), file)), 'RESTORE_PENDING_RECOVERY');

    // إعادة التشغيل: IO سليم
    const out = await recoverInterruptedRestore(rdeps());
    assert.equal(out.action, 'rolled-back');
    assertLiveUntouched();

    // التعافي مثالي التكرار
    assert.equal((await recoverInterruptedRestore(rdeps())).action, 'none');
    // والاستعادة تعمل بعده
    await run(rdeps(), file);
    assert.ok(fs.readFileSync(dbPath).equals(bakDb));
  });

  test('لا شيء للتعافي عند عدم وجود سجل', async () => {
    assert.equal((await recoverInterruptedRestore(rdeps())).action, 'none');
  });

  test('سجل تالف يحجب الاستعادة', async () => {
    fs.writeFileSync(journalPath, '{not json');
    const file = await makePackage();
    assert.equal(await code(run(rdeps(), file)), 'RESTORE_PENDING_RECOVERY');
    assertLiveUntouched();
  });

  test('الاستعادة بعد استعادة ناجحة سابقة (committed) مسموحة', async () => {
    const f1 = await makePackage();
    await run(rdeps(), f1);
    const f2 = await makePackage();
    const r = await run(rdeps(), f2);
    assert.ok(fs.readFileSync(dbPath).equals(bakDb));
    assert.ok(r.restoreId);
  });
});
SCD_EOF_2
write_file 'docs/phase10/10.6-restore.md' <<'SCD_EOF_3'
<!-- SECURECASEDESK_PHASE10_S6 -->
# المرحلة 10 / القسم 10.6 — تنفيذ استعادة البيانات

> نطاق هذا القسم: استعادة ملف `.scdbak` (قاعدة + مرفقات + أسرار) مع تراجع تلقائي عند أي فشل. التراجع اليدوي بعد النجاح وتنظيف نسخة الأمان وترحيل القواعد القديمة = 10.7.

## المراحل (لا يُمسّ شيء حي قبل نهاية 1–4)
1. فك تشفير الملف إلى منطقة تجهيز في `cache` (AEAD + SHA-256 لكل سجل). كلمة خاطئة/ملف معدّل/مبتور ← رفض.
2. مطابقة السجلات للبيان (manifest): العدد، الأسماء، الأحجام، البصمات، والمرفقات، وقائمة الأسرار.
3. الأسرار: المستبعدة (الجلسة، رابط/رمز API) أو المجهولة ← رفض. الإلزامي: مفتاح القاعدة، نسخة التدقيق الفعّالة ومفتاح HMAC لها، ومفتاح المرفقات إن وُجدت مرفقات.
4. فتح القاعدة المجهّزة بمفتاحها وفحص `cipher_version` و`quick_check` والجداول المطلوبة.
5. نسخة أمان فيزيائية: نقل القاعدة (+wal/shm) والمرفقات الحالية إلى `document/restore-safety/<id>`، وحفظ الأسرار الحالية في SecureStore بأسماء `restore_safety_<id>_<name>`.
6. تركيب القاعدة والمرفقات والأسرار، ثم إعادة فتح القاعدة والتحقق منها ومن ملفات المرفقات.
7. أي فشل بعد 5 ← تراجع كامل تلقائي (ملفات + أسرار).

## سجل الاستعادة (journal)
`document/restore-journal.json`: حالات `prepared → swapping → committed | rolled-back | rollback-failed`، يُكتب ذرّياً قبل كل مرحلة، **أسماء أسرار فقط بلا قيم**. أي حالة غير نهائية تحجب أي استعادة جديدة (`RESTORE_PENDING_RECOVERY`) حتى يكتمل التراجع.
`recoverRestoreOnStartup()` تُستدعى عند الإقلاع **قبل** `initDatabase()` لإكمال التراجع بعد انقطاع مفاجئ (مثالية التكرار).

## بعد النجاح
- `requiresRelogin: true`: جدول المستخدمين استُبدل ← يجب إنهاء الجلسة الحالية والعودة لشاشة الدخول.
- يُسجَّل حدث `backup_restore` في سلسلة التدقيق المستعادة (إلحاق فقط). فشل التسجيل لا يُبطل الاستعادة ويُعاد `auditLogged:false`.
- نسخة الأمان وأسرارها المحفوظة تبقى (لـ10.7).

## الملفات
| الملف | الغرض |
|---|---|
| `backup-restore.ts` | منطق الاستعادة والتراجع والتعافي (صرف، بالحقن) |
| `backup-restore-runtime.ts` | محوّل Expo: `restoreEncryptedBackup(session, filePath, pass, confirmed, onProgress?, preRestoreSafetyBackup?)` و`recoverRestoreOnStartup()` |
| `backup-types.ts` | + رموز أخطاء وثوابت الاستعادة |
| `db.ts` | + `closeDb()` |
| `tests/backup-restore.test.ts` | 24 اختباراً |

## ما اختُبر فعلاً (Node، ملفات وتشفير حقيقيان)
استبدال كامل، بقاء الأسرار المستبعدة، محتوى نسخة الأمان، السجل بلا قيم أسرار، نسخة بلا مرفقات، مرفق ناقص مع تحذير، رفض (بلا تأكيد، كلمة خاطئة/فارغة، ملف مفقود/تالف/مبتور/غير نسخة، قاعدة لا تُفتح/فاشلة الفحص/ينقصها جدول، أسرار ناقصة، سر مستبعد، فشل flush)، استعادتان متزامنتان، تراجع بعد فشل التحقق الحي، تراجع بعد فشل نقل المرفقات، انقطاع دائم ثم تعافٍ وإعادة استعادة، سجل تالف.

## لم يُختبر (معلّق — يحتاج جهازاً)
- `Directory.move/list`، `File.text()`، `openDatabaseAsync(name, options, directory)` لفتح القاعدة المجهّزة، وفحص `tsc` للمحوّل.
- سلوك `closeAsync()` مع اتصالات/مستمعين نشطين (يجب منع أي استعمال للقاعدة من الواجهة أثناء الاستعادة).
- SQLCipher الحقيقي: الاختبار استعمل قاعدة محاكاة؛ فتح القاعدة المستعادة بالمفتاح المستعاد لم يُجرَّب على Android.
- ربط `recoverRestoreOnStartup()` بالإقلاع وربط الواجهة (لم يُنفَّذ هنا).

## حدود معروفة
- انقطاع أثناء حفظ الأسرار الحالية (قبل كتابة السجل) قد يترك مفاتيح `restore_safety_*` يتيمة (لا أثر وظيفي).
- لا يوجد حذف تلقائي لنسخة الأمان بعد النجاح (10.7).
- قاعدة أقدم مخططاً من التطبيق الحالي لا تُرحَّل هنا (10.7).
SCD_EOF_3

# ---- ترقيع الملفات الموجودة (آمن للتكرار) ----
bak src/modules/backup/backup-types.ts; bak src/database/db.ts; bak package.json
node - <<'SCD_PATCH'
const fs = require('fs');
function patch(file, fn) { const s = fs.readFileSync(file, 'utf8'); const r = fn(s); if (r === null) { console.log('• بلا تغيير (مطبّق سابقاً): ' + file); return; } fs.writeFileSync(file, r); console.log('✓ رُقّع ' + file); }
function must(s, needle) { if (!s.includes(needle)) { console.error('✗ لم أجد موضع الترقيع في الملف: ' + needle.slice(0, 50)); process.exit(1); } }

patch('src/modules/backup/backup-types.ts', (s) => {
  if (s.includes('RESTORE_NOT_CONFIRMED')) return null;
  const a = "  | 'PACKAGE_FORMAT_INVALID' | 'PACKAGE_AUTH_FAILED';";
  const b = "  PACKAGE_AUTH_FAILED: 'كلمة المرور غير صحيحة أو أن ملف النسخة تالف أو معدَّل.',\n};";
  must(s, a); must(s, b);
  s = s.replace(a, "  | 'PACKAGE_FORMAT_INVALID' | 'PACKAGE_AUTH_FAILED'\n  // SECURECASEDESK_PHASE10_S6\n  | 'RESTORE_NOT_CONFIRMED' | 'RESTORE_IN_PROGRESS' | 'RESTORE_PENDING_RECOVERY' | 'RESTORE_PACKAGE_INVALID'\n  | 'RESTORE_SECRETS_INCOMPLETE' | 'RESTORE_DATABASE_INVALID' | 'RESTORE_FAILED'\n  | 'RESTORE_ROLLED_BACK' | 'RESTORE_ROLLBACK_FAILED';");
  s = s.replace(b, `  PACKAGE_AUTH_FAILED: 'كلمة المرور غير صحيحة أو أن ملف النسخة تالف أو معدَّل.',
  // SECURECASEDESK_PHASE10_S6
  RESTORE_NOT_CONFIRMED: 'لم يتم تأكيد الاستعادة صراحةً. لم تُمسّ البيانات.',
  RESTORE_IN_PROGRESS: 'عملية استعادة أخرى قيد التنفيذ.',
  RESTORE_PENDING_RECOVERY: 'توجد عملية استعادة سابقة غير مكتملة. يجب إكمال التراجع عنها أولاً قبل أي استعادة جديدة.',
  RESTORE_PACKAGE_INVALID: 'محتوى النسخة الاحتياطية غير متسق مع بيانها (manifest). لم تُمسّ البيانات.',
  RESTORE_SECRETS_INCOMPLETE: 'النسخة لا تحتوي على الأسرار الإلزامية اللازمة لفتح البيانات. لم تُمسّ البيانات.',
  RESTORE_DATABASE_INVALID: 'قاعدة البيانات داخل النسخة لا تُفتح أو لا تجتاز فحص السلامة. لم تُمسّ البيانات.',
  RESTORE_FAILED: 'فشلت الاستعادة قبل أي تعديل على البيانات الحالية. لم تُمسّ البيانات.',
  RESTORE_ROLLED_BACK: 'فشلت الاستعادة وأُعيدت البيانات الحالية كما كانت.',
  RESTORE_ROLLBACK_FAILED: 'فشلت الاستعادة وتعذّر التراجع التلقائي. نسخة الأمان محفوظة؛ لا تحذف أي ملفات وراجع الدعم الفني.',
};

// ===== القسم 10.6: الاستعادة =====
export const RESTORE_STAGING_DIR_NAME = 'restore-staging';
export const RESTORE_SAFETY_DIR_NAME = 'restore-safety';
export const RESTORE_JOURNAL_FILE_NAME = 'restore-journal.json';
export const RESTORE_STASH_PREFIX = 'restore_safety_';`);
  return s;
});

patch('src/database/db.ts', (s) => {
  if (s.includes('export async function closeDb')) return null;
  const a = 'export interface DatabaseEncryptionCheck {';
  must(s, a);
  return s.replace(a, `// SECURECASEDESK_PHASE10_S6: إغلاق الاتصال وتصفير الكاش (تحتاجه الاستعادة قبل استبدال الملف).
export async function closeDb(): Promise<void> {
  if (!db) return;
  const current = db;
  db = null;
  await current.closeAsync();
}

` + a);
});

patch('package.json', (s) => {
  if (s.includes('test:backup-restore')) return null;
  const a = '"test:backup-package": "tsx --tsconfig tests/tsconfig.json --test tests/backup-package.test.ts"';
  must(s, a);
  return s.replace(a, a + ',\n    "test:backup-restore": "tsx --tsconfig tests/tsconfig.json --test tests/backup-restore.test.ts"');
});
SCD_PATCH

echo
echo "── تشغيل الاختبارات ──"
if [ ! -d node_modules ]; then echo "⚠ node_modules غير موجود: شغّل npm install ثم npm run test:backup-restore"; exit 0; fi
npm run test:backup-restore
echo
echo "── اختبارات 10.1–10.3 (تأكد من عدم الكسر) ──"
npm run test:backup-foundation && npm run test:backup-snapshot && npm run test:backup-package
echo
echo "✅ اكتمل تطبيق 10.6. الخطوة التالية: npx tsc --noEmit  (فحص محوّل Expo)"

