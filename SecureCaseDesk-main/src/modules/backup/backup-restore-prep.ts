// SECURECASEDESK_PHASE10_S5
// المرحلة 10 / القسم 10.5 — تجهيز الاستعادة وإنشاء نسخة الأمان. منطق صرف بالحقن الكامل (يعمل في Node وفي التطبيق).
//
// ما يفعله هذا القسم (ولا يستبدل أي بيانات حية — الاستبدال في 10.6):
//   1) يفك ملف .scdbak إلى مجلد تجهيز مؤقت (قاعدة + مرفقات) ويحتفظ بالأسرار في الذاكرة فقط (لا تُكتب على القرص).
//   2) يتحقق من محتواه تحققاً مستقلاً (ترتيب السجلات، الأسماء، البصمات، تطابق البيان مع ما فُكّ فعلاً).
//   3) يفتح نسخة من القاعدة المجهّزة بمفتاحها ويفحص سلامتها وبنيتها (عبر دالة محقونة) ويبني تقرير الأثر.
//   4) إن لم توجد موانع: ينشئ نسخة أمان مشفّرة للحالة الحية الحالية، ويتحقق منها بقراءة كاملة، ويثبّت اسمها.
//   5) يسجّل خطة استعادة في الذاكرة بصلاحية قصيرة؛ 10.6 يستهلكها بعد تأكيد المدير.
//
// قرارات 10.1 التي تُحسم هنا (تُنفَّذ فعلياً في 10.6):
//   - securecase_audit_checkpoint_last: لا يُستعاد أبداً من النسخة. هو شاهد الجهاز على آخر حالة للسلسلة؛ إن كانت النسخة أقدم
//     منه فهذا تراجع (rollback) يتطلب قبولاً صريحاً من المدير يُسجَّل في السلسلة، ثم يُكتب Checkpoint جديد (allowLower).
//   - audit_sync_state.device_id: يُعاد توليده دائماً بعد الاستعادة (منع استنساخ هوية الجهاز وتفرّع السلسلة قبل المرحلة 13).
//   - الجلسة: تُبطل بعد الاستعادة؛ وأسرار الجلسة وAPI لا تدخل النسخة أصلاً.
//   - الأسرار المستعادة: فقط المعروفة (مفتاح القاعدة، مفتاح المرفقات، إصدار التدقيق النشط، مفاتيح HMAC، مفتاح نقاط التحقق).
//     أسرار الجهاز الأحدث غير الموجودة في النسخة (مثل إصدار HMAC أحدث) لا تُحذف.

import {
  ATTACHMENT_STORAGE_NAME, BACKUP_FORMAT_VERSION, BackupError, DATABASE_FILE_NAME,
  REQUIRED_TABLES, SECRET_NAMES, auditHmacKeyName,
} from './backup-types';
import {
  PackageReader, RECORD_KIND, assertPassphraseAcceptable, toHex,
  type BackupCryptoProvider, type ByteSource,
} from './backup-format';
import type { BackupPackageResult, PackageFs, PackageManifest } from './backup-package';

// ===== الثوابت =====
export const RESTORE_STAGING_DIR_NAME = 'restore-staging';
export const RESTORE_DB_STAGED_NAME = 'database.restore';
export const RESTORE_ATTACHMENTS_STAGED_DIR = 'attachments';
export const RESTORE_PLAN_TTL_MS = 15 * 60 * 1000;
export const SAFETY_BACKUP_PREFIX = 'PreRestore-';
export const OLD_BACKUP_WARNING_DAYS = 30;
export const COUNTED_TABLES = [
  'users', 'departments', 'cases', 'memos', 'detainees', 'detainee_movements',
  'correction_history', 'attachments', 'audit_logs',
] as const;

const MAX_SECRETS_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENT_STAGED_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 100_000;
const DB_KEY_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ACTIVE_VERSION_PATTERN = /^[1-9][0-9]{0,5}$/;
const HMAC_NAME_PATTERN = /^securecase_audit_hmac_key_v([1-9][0-9]{0,5})$/;
const GENERIC_SECRET_PATTERN = /^[\x20-\x7E]{1,512}$/;
const PLAN_ID_PATTERN = /^[0-9a-zA-Z-]{8,64}$/;
const READ_CHUNK = 256 * 1024;

// SECURECASEDESK_PHASE11_S5: أسرار الذكاء الاصطناعي مستبعدة كذلك (نسخة تحملها تُرفض كما تُرفض الجلسة والرموز).
const EXCLUDED_NAMES: readonly string[] = [
  SECRET_NAMES.sessionUser, SECRET_NAMES.apiUrl, SECRET_NAMES.apiToken, SECRET_NAMES.aiSettings, SECRET_NAMES.aiCloudKey,
];

// ===== الأخطاء =====
export type RestorePrepErrorCode =
  | 'RESTORE_IN_PROGRESS' | 'INVALID_INPUT' | 'SOURCE_NOT_FOUND' | 'CONTENT_INVALID'
  | 'SAFETY_BACKUP_FAILED' | 'PLAN_NOT_FOUND' | 'PLAN_EXPIRED' | 'SAFETY_BACKUP_STALE'
  | 'STAGING_TAMPERED' | 'PREP_FAILED';

export const RESTORE_PREP_MESSAGES: Record<RestorePrepErrorCode, string> = {
  RESTORE_IN_PROGRESS: 'عملية تجهيز استعادة أخرى قيد التنفيذ.',
  INVALID_INPUT: 'مدخلات التجهيز غير صالحة: اختر ملف نسخة (.scdbak) وأدخل كلمة مرور النسخة وكلمة مرور نسخة الأمان مع تأكيدها.',
  SOURCE_NOT_FOUND: 'ملف النسخة الاحتياطية غير موجود أو لا يمكن قراءته.',
  CONTENT_INVALID: 'محتوى النسخة الاحتياطية غير متسق أو مخالف لبنية النسخ المعتمدة. لم تُمسّ البيانات الحالية.',
  SAFETY_BACKUP_FAILED: 'تعذر إنشاء نسخة الأمان أو التحقق منها. لم تُمسّ البيانات الحالية ولن تُسمح الاستعادة.',
  PLAN_NOT_FOUND: 'لا توجد خطة استعادة جاهزة بهذا المعرّف. أعد التجهيز.',
  PLAN_EXPIRED: 'انتهت صلاحية خطة الاستعادة. أعد التجهيز.',
  SAFETY_BACKUP_STALE: 'تغيّرت بيانات النظام بعد إنشاء نسخة الأمان. أعد التجهيز لإنشاء نسخة أمان جديدة.',
  STAGING_TAMPERED: 'ملفات التجهيز المؤقتة تغيّرت أو فُقدت. أعد التجهيز.',
  PREP_FAILED: 'فشل تجهيز الاستعادة. لم تُمسّ البيانات الحالية.',
};

export class RestorePrepError extends Error {
  constructor(public readonly code: RestorePrepErrorCode) {
    super(RESTORE_PREP_MESSAGES[code]);
    this.name = 'RestorePrepError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ===== الأنواع =====
export interface RestoreIssue { code: string; message: string; items?: string[] }

export interface StagedDbSummary {
  cipherVersion: string;
  integrityOk: boolean;
  tablesPresent: string[];
  counts: Record<string, number>;
  activeAdmins: number;
  auditMaxSeq: number;
  auditKeyVersions: number[];
  deviceId: string | null;
  attachmentRows: { id: string; storage_name: string; status: string; sha256_cipher: string }[];
}

export interface LiveSummary {
  counts: Record<string, number>;
  auditMaxSeq: number;
  externalCheckpointSeq: number | null;   // null = لا يوجد Checkpoint خارجي سليم
  deviceId: string | null;
}

export interface StagedAttachment { id: string; name: string; size: number; sha256: string; status: string }

export interface StagedBackup {
  planId: string;
  dir: string;
  databasePath: string;
  attachmentsDir: string;
  backupId: string;
  createdAt: number;
  manifest: PackageManifest;
  databaseSize: number;
  databaseSha256: string;
  attachments: StagedAttachment[];
  restorableSecrets: Map<string, string>;   // في الذاكرة فقط
  ignoredSecrets: string[];                 // معروفة لكن لا تُستعاد (checkpoint_last)
  unknownSecrets: string[];
  excludedPresent: string[];                // أسرار مستبعدة وُجدت في النسخة (مخالفة)
}

export type SecretStatus = 'new' | 'same' | 'different';

export interface RestoreImpactReport {
  generatedAt: number;
  backup: {
    backupId: string; createdAt: number; ageDays: number; databaseBytes: number;
    attachmentsCount: number; attachmentsBytes: number; cipherVersion: string | null;
  };
  counts: { backup: Record<string, number> | null; live: Record<string, number> };
  secrets: { name: string; status: SecretStatus }[];
  audit: {
    liveMaxSeq: number; backupMaxSeq: number | null; entriesLostIfRestored: number;
    externalCheckpointSeq: number | null; requiresRollbackAcceptance: boolean;
  };
  decisions: {
    checkpointLast: 'not-restored-reset-on-accept';
    deviceId: 'regenerate-always';
    session: 'invalidate-after-restore';
    secretsToRestore: string[];
    secretsIgnored: string[];
  };
  blockers: RestoreIssue[];
  warnings: RestoreIssue[];
  canProceed: boolean;
}

export interface SafetyBackupInfo {
  backupId: string; filePath: string; fileName: string; sizeBytes: number; sha256: string; createdAt: number;
}

export interface RestorePlanSummary {
  planId: string;
  createdAt: number;
  expiresAt: number;
  report: RestoreImpactReport;
  safetyBackup: Omit<SafetyBackupInfo, 'filePath'>;
  stagedDatabaseSha256: string;
  requiresRollbackAcceptance: boolean;
}

export interface StoredRestorePlan extends RestorePlanSummary {
  userId: string;
  staged: StagedBackup;
  safety: SafetyBackupInfo;
  liveAuditSeqAtPlan: number;
}

export type RestorePrepStage = 'reading' | 'inspecting' | 'safety-backup' | 'verifying-safety' | 'done';
export interface RestorePrepProgress { stage: RestorePrepStage; current: number; total: number }

export interface RestoreAuditEvent {
  operationType: 'restore_prepare' | 'restore_prepare_blocked' | 'backup_safety_create';
  entityType: 'backup';
  entityId: string;
  newValues: Record<string, unknown>;
  reason?: string;
}

export interface RestorePrepDeps {
  crypto: BackupCryptoProvider;
  fs: PackageFs & { listDirs(path: string): Promise<string[]> };
  stagingRoot: string;                                   // مثل <cache>
  newId(): string;
  now(): number;
  yieldTick?(): Promise<void>;
  onProgress?(p: RestorePrepProgress): void;
  readSecret(name: string): Promise<string | null>;
  inspectStagedDatabase(databasePath: string, dbKey: string): Promise<StagedDbSummary>;
  readLiveSummary(): Promise<LiveSummary>;
  createSafetyBackup(passphrase: string, confirmation: string): Promise<BackupPackageResult>;
  flushAudit(): Promise<void>;
  getLiveAuditSeq(): Promise<number>;
  logEvent(event: RestoreAuditEvent): Promise<void>;     // غير صارم: فشل التسجيل لا يوقف التجهيز
}

export interface PrepareRestoreInput {
  userId: string;
  sourcePath: string;
  passphrase: string;
  safetyPassphrase: string;
  safetyPassphraseConfirmation: string;
}

export type PrepareRestoreResult =
  | { status: 'blocked'; report: RestoreImpactReport }
  | { status: 'ready'; plan: RestorePlanSummary };

// ===== أدوات =====
const dec = new TextDecoder();
const join = (a: string, b: string) => a.replace(/\/+$/, '') + '/' + b;

function bad(): never { throw new RestorePrepError('CONTENT_INVALID'); }

// مصدر بايتات محدود بحجم الملف: لا يعتمد على سلوك القراءة عند نهاية الملف.
export function boundedSource(fs: PackageFs, path: string, size: number, tee?: (b: Uint8Array) => void) {
  let left = size;
  let handle: Awaited<ReturnType<PackageFs['openRead']>> | null = null;
  const source: ByteSource = {
    async read(max) {
      if (left <= 0) return new Uint8Array(0);
      if (!handle) handle = await fs.openRead(path);
      const part = await handle.read(Math.min(max, left, READ_CHUNK));
      if (part.length === 0) throw new RestorePrepError('SOURCE_NOT_FOUND'); // الملف أقصر مما أُعلن
      left -= part.length;
      tee?.(part);
      return part;
    },
  };
  return { source, close: async () => { await handle?.close(); handle = null; }, remaining: () => left };
}

export async function hashFile(crypto: BackupCryptoProvider, fs: PackageFs, path: string): Promise<string> {
  const size = await fs.size(path);
  const h = crypto.sha256();
  const b = boundedSource(fs, path, size, (p) => h.update(p));
  try {
    while ((await b.source.read(READ_CHUNK)).length > 0) { /* التيار يغذّي الـ hash */ }
  } finally { await b.close(); }
  return toHex(h.digest());
}

function isPrintableSecret(v: string): boolean { return GENERIC_SECRET_PATTERN.test(v); }

// ===== 1) فك النسخة إلى مجلد التجهيز والتحقق من اتساقها =====
interface SeenRecord { kind: number; name: string; size: number; sha256: string }

export async function stageBackup(
  deps: RestorePrepDeps, sourcePath: string, passphrase: string, planId: string
): Promise<StagedBackup> {
  const { fs, crypto } = deps;
  if (!PLAN_ID_PATTERN.test(planId)) throw new RestorePrepError('PREP_FAILED');
  if (!(await fs.exists(sourcePath))) throw new RestorePrepError('SOURCE_NOT_FOUND');
  const sourceSize = await fs.size(sourcePath);
  if (sourceSize <= 0) throw new BackupError('PACKAGE_FORMAT_INVALID');

  const dir = join(deps.stagingRoot, RESTORE_STAGING_DIR_NAME + '/' + planId);
  const attachmentsDir = join(dir, RESTORE_ATTACHMENTS_STAGED_DIR);
  const databasePath = join(dir, RESTORE_DB_STAGED_NAME);
  await fs.ensureDir(attachmentsDir);

  const src = boundedSource(fs, sourcePath, sourceSize);
  let reader: PackageReader | null = null;
  try {
    reader = await PackageReader.open(crypto, passphrase, src.source);

    const seen: SeenRecord[] = [];
    const attachments: StagedAttachment[] = [];
    const attachmentNames = new Set<string>();
    const restorable = new Map<string, string>();
    const ignored: string[] = [];
    const unknown: string[] = [];
    const excluded: string[] = [];
    let manifest: PackageManifest | null = null;
    let dbSha = '', dbSize = 0;
    let hasDb = false, hasSecrets = false, rank = -1, chunks = 0;
    const RANK: Record<number, number> = {
      [RECORD_KIND.database]: 0, [RECORD_KIND.secrets]: 1, [RECORD_KIND.attachment]: 2, [RECORD_KIND.manifest]: 3,
    };

    for (let head = await reader.nextRecord(); head; head = await reader.nextRecord()) {
      const { kind, meta } = head;
      const r = RANK[kind];
      if (r === undefined || r < rank || manifest) bad();                       // نوع مجهول أو ترتيب مخالف أو سجل بعد البيان
      if (kind !== RECORD_KIND.attachment && r === rank) bad();                  // تكرار سجل مفرد
      rank = r;
      deps.onProgress?.({ stage: 'reading', current: seen.length + 1, total: 0 });

      if (kind === RECORD_KIND.database) {
        if (meta.name !== DATABASE_FILE_NAME || meta.size <= 0) bad();
        const h = await fs.openWrite(databasePath);
        try {
          dbSha = await reader.readData(async (b) => { await h.write(b); if (++chunks % 16 === 0) await deps.yieldTick?.(); });
        } finally { await h.close(); }
        dbSize = meta.size;
        hasDb = true;
        seen.push({ kind, name: meta.name, size: meta.size, sha256: dbSha });

      } else if (kind === RECORD_KIND.secrets) {
        if (meta.name !== 'secrets.json' || meta.size > MAX_SECRETS_BYTES) bad();
        const buf = new Uint8Array(meta.size);
        let off = 0;
        const sha = await reader.readData((b) => { buf.set(b, off); off += b.length; });
        let parsed: unknown;
        try { parsed = JSON.parse(dec.decode(buf)); } catch { buf.fill(0); bad(); }
        buf.fill(0);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) bad();
        for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value !== 'string' || value.length === 0 || value.length > 4096) bad();
          if (EXCLUDED_NAMES.includes(name)) excluded.push(name);
          else if (name === SECRET_NAMES.auditCheckpointLast) ignored.push(name);
          else if (isRestorableSecretName(name)) restorable.set(name, value);
          else unknown.push(name);
        }
        hasSecrets = true;
        seen.push({ kind, name: meta.name, size: meta.size, sha256: sha });

      } else if (kind === RECORD_KIND.attachment) {
        if (!ATTACHMENT_STORAGE_NAME.test(meta.name) || attachmentNames.has(meta.name)) bad();   // يمنع اجتياز المسار والتكرار
        if (typeof meta.id !== 'string' || meta.id.length === 0 || meta.id.length > 64) bad();
        if (meta.status !== 'active' && meta.status !== 'deleted') bad();
        if (meta.size > MAX_ATTACHMENT_STAGED_BYTES || attachments.length >= MAX_ATTACHMENT_COUNT) bad();
        attachmentNames.add(meta.name);
        const h = await fs.openWrite(join(attachmentsDir, meta.name));
        let sha: string;
        try {
          sha = await reader.readData(async (b) => { await h.write(b); if (++chunks % 16 === 0) await deps.yieldTick?.(); });
        } finally { await h.close(); }
        attachments.push({ id: meta.id as string, name: meta.name, size: meta.size, sha256: sha, status: meta.status as string });
        seen.push({ kind, name: meta.name, size: meta.size, sha256: sha });

      } else {
        if (meta.name !== 'manifest.json' || meta.size > MAX_MANIFEST_BYTES) bad();
        const buf = new Uint8Array(meta.size);
        let off = 0;
        await reader.readData((b) => { buf.set(b, off); off += b.length; });
        try { manifest = JSON.parse(dec.decode(buf)) as PackageManifest; } catch { bad(); }
      }
    }

    if (!hasDb || !hasSecrets || !manifest) bad();
    const m = manifest as PackageManifest;
    const header = reader.header;

    // مطابقة البيان مع ما فُكّ فعلاً (البيان يُكتب أخيراً ويصف ما سبقه).
    if (m.kind !== 'backup-package' || m.formatVersion !== BACKUP_FORMAT_VERSION || m.appName !== 'SecureCaseDesk') bad();
    if (m.backupId !== header.backupId || m.createdAt !== header.createdAt) bad();
    if (!Array.isArray(m.records) || m.records.length !== seen.length) bad();
    for (let i = 0; i < seen.length; i++) {
      const a = m.records[i], b = seen[i];
      if (!a || a.kind !== b.kind || a.name !== b.name || a.size !== b.size || a.sha256 !== b.sha256) bad();
    }
    if (!m.database || m.database.sha256 !== dbSha || m.database.size !== dbSize) bad();
    const entries = m.attachments?.entries;
    if (!Array.isArray(entries) || entries.length !== attachments.length || m.attachments.count !== attachments.length) bad();
    const byName = new Map(attachments.map((a) => [a.name, a]));
    for (const e of entries) {
      const a = byName.get(e.name);
      if (!a || a.id !== e.id || a.size !== e.size || a.sha256 !== e.sha256 || a.status !== e.status) bad();
    }

    // مطابقة الملفات المكتوبة على القرص.
    if ((await fs.size(databasePath)) !== dbSize) bad();
    for (const a of attachments) if ((await fs.size(join(attachmentsDir, a.name))) !== a.size) bad();

    return {
      planId, dir, databasePath, attachmentsDir,
      backupId: header.backupId, createdAt: header.createdAt, manifest: m,
      databaseSize: dbSize, databaseSha256: dbSha, attachments,
      restorableSecrets: restorable, ignoredSecrets: ignored.sort(), unknownSecrets: unknown.sort(), excludedPresent: excluded.sort(),
    };
  } finally {
    reader?.close();
    await src.close();
  }
}

export function isRestorableSecretName(name: string): boolean {
  return name === SECRET_NAMES.dbKey || name === SECRET_NAMES.attachmentMasterKey ||
    name === SECRET_NAMES.auditActiveVersion || name === SECRET_NAMES.auditCheckpointKey ||
    HMAC_NAME_PATTERN.test(name);
}

// ===== 2) تقييم الأثر والموانع =====
function evaluateAudit(live: number, backup: number | null, ext: number | null) {
  const lost = backup === null ? 0 : Math.max(0, live - backup);
  const behindCheckpoint = backup !== null && ext !== null && backup < ext;
  return {
    liveMaxSeq: live, backupMaxSeq: backup, entriesLostIfRestored: lost, externalCheckpointSeq: ext,
    requiresRollbackAcceptance: lost > 0 || behindCheckpoint,
  };
}

export interface ReportInput {
  staged: StagedBackup;
  summary: StagedDbSummary | null;      // null = تعذر فتح القاعدة المجهّزة
  summaryError?: 'unreadable' | 'key-invalid' | null;
  live: LiveSummary;
  currentSecrets: Map<string, string | null>;
  now: number;
}

export function buildRestoreReport(input: ReportInput): RestoreImpactReport {
  const { staged, summary, live, now } = input;
  const blockers: RestoreIssue[] = [];
  const warnings: RestoreIssue[] = [];
  const secrets = staged.restorableSecrets;

  // الأسرار
  if (staged.excludedPresent.length > 0) {
    blockers.push({ code: 'EXCLUDED_SECRET_IN_BACKUP', message: 'النسخة تحوي أسراراً يُفترض ألا تدخل أي نسخة (جلسة/API). النسخة مرفوضة.', items: staged.excludedPresent });
  }
  const invalidValues: string[] = [];
  const dbKey = secrets.get(SECRET_NAMES.dbKey);
  if (!dbKey) blockers.push({ code: 'DB_KEY_MISSING_IN_BACKUP', message: 'مفتاح قاعدة البيانات غير موجود في النسخة؛ لا يمكن فتح القاعدة.' });
  else if (!DB_KEY_PATTERN.test(dbKey)) invalidValues.push(SECRET_NAMES.dbKey);
  const active = secrets.get(SECRET_NAMES.auditActiveVersion);
  if (!active) blockers.push({ code: 'AUDIT_ACTIVE_VERSION_MISSING', message: 'إصدار مفتاح التدقيق النشط غير موجود في النسخة.' });
  else if (!ACTIVE_VERSION_PATTERN.test(active)) invalidValues.push(SECRET_NAMES.auditActiveVersion);
  for (const [name, value] of secrets) {
    if (name !== SECRET_NAMES.dbKey && name !== SECRET_NAMES.auditActiveVersion && !isPrintableSecret(value)) invalidValues.push(name);
  }
  if (invalidValues.length) blockers.push({ code: 'SECRET_VALUE_INVALID', message: 'قيم أسرار بصيغة غير صالحة.', items: [...new Set(invalidValues)].sort() });

  // القاعدة المجهّزة
  if (summary === null) {
    blockers.push({
      code: input.summaryError === 'key-invalid' ? 'DB_KEY_INVALID' : 'STAGED_DB_UNREADABLE',
      message: 'تعذر فتح قاعدة النسخة بمفتاحها؛ النسخة تالفة أو المفتاح لا يطابقها.',
    });
  } else {
    if (!summary.cipherVersion) blockers.push({ code: 'STAGED_DB_NOT_ENCRYPTED', message: 'قاعدة النسخة لا تُفتح عبر SQLCipher.' });
    if (!summary.integrityOk) blockers.push({ code: 'STAGED_DB_INTEGRITY_FAILED', message: 'فحص سلامة قاعدة النسخة فشل.' });
    const present = new Set(summary.tablesPresent);
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length) blockers.push({ code: 'MISSING_TABLES', message: 'جداول أساسية مفقودة من قاعدة النسخة.', items: [...missing] });
    if (summary.activeAdmins < 1) {
      blockers.push({ code: 'NO_ACTIVE_ADMIN', message: 'قاعدة النسخة لا تحوي أي مدير نشط؛ الاستعادة ستُقفل النظام بالكامل.' });
    }

    // مفاتيح HMAC لكل إصدار مسجّل (مع الإصدار 1 إن وُجدت سجلات تدقيق).
    let versions = [...summary.auditKeyVersions];
    if ((summary.counts['audit_logs'] ?? 0) > 0 && !versions.includes(1)) versions = [1, ...versions];
    const activeNum = active && ACTIVE_VERSION_PATTERN.test(active) ? Number(active) : null;
    if (activeNum !== null && !versions.includes(activeNum)) versions.push(activeNum);
    const missingKeys = [...new Set(versions)].sort((a, b) => a - b)
      .filter((v) => !secrets.has(auditHmacKeyName(v))).map(auditHmacKeyName);
    if (missingKeys.length) blockers.push({ code: 'AUDIT_KEY_MISSING', message: 'مفاتيح HMAC لإصدارات مسجّلة غير موجودة في النسخة؛ لن يمكن التحقق من سلسلة التدقيق.', items: missingKeys });

    const needsAttachmentKey = staged.attachments.length > 0 || summary.attachmentRows.length > 0;
    if (needsAttachmentKey && !secrets.has(SECRET_NAMES.attachmentMasterKey)) {
      blockers.push({ code: 'ATTACHMENT_KEY_MISSING', message: 'المفتاح الرئيسي للمرفقات غير موجود في النسخة؛ لن تُفك المرفقات.' });
    }

    // المرفقات: صف نشط بلا ملف في النسخة / بصمة تخالف سجل القاعدة.
    const stagedByName = new Map(staged.attachments.map((a) => [a.name, a]));
    const missingFiles: string[] = [];
    const mismatched: string[] = [];
    for (const row of summary.attachmentRows) {
      if (row.status !== 'active') continue;
      const f = stagedByName.get(row.storage_name);
      if (!f) missingFiles.push(row.id);
      else if (f.sha256 !== row.sha256_cipher) mismatched.push(row.id);
    }
    if (missingFiles.length) warnings.push({ code: 'ATTACHMENT_FILES_MISSING_IN_BACKUP', message: 'مرفقات نشطة في القاعدة لا ملفات لها داخل النسخة (النقص كان موجوداً وقت النسخ).', items: missingFiles.sort() });
    if (mismatched.length) warnings.push({ code: 'ATTACHMENT_HASH_MISMATCH', message: 'ملفات مرفقات بصمتها تخالف المسجّلة في القاعدة (كانت كذلك وقت النسخ).', items: mismatched.sort() });
  }

  if (!secrets.has(SECRET_NAMES.auditCheckpointKey)) {
    warnings.push({ code: 'CHECKPOINT_KEY_MISSING', message: 'مفتاح نقاط التحقق غير موجود في النسخة؛ سيُنشأ مفتاح جديد عند الحاجة.' });
  }
  if (staged.unknownSecrets.length) {
    warnings.push({ code: 'UNKNOWN_SECRET_IGNORED', message: 'أسرار غير معروفة في النسخة لن تُستعاد (قد تكون من إصدار أحدث).', items: staged.unknownSecrets });
  }

  // أثر الاستعادة على سلسلة التدقيق.
  const audit = evaluateAudit(live.auditMaxSeq, summary ? summary.auditMaxSeq : null, live.externalCheckpointSeq);
  if (audit.entriesLostIfRestored > 0) {
    warnings.push({ code: 'AUDIT_ROLLBACK', message: 'النسخة أقدم من الحالة الحالية: ستُفقد سجلات تدقيق أحدث، وتتطلب الاستعادة قبولاً صريحاً من المدير.', items: [String(audit.entriesLostIfRestored)] });
  }
  if (audit.backupMaxSeq !== null && audit.externalCheckpointSeq !== null && audit.backupMaxSeq < audit.externalCheckpointSeq) {
    warnings.push({ code: 'CHECKPOINT_ROLLBACK', message: 'سلسلة النسخة أقصر من نقطة التحقق المحفوظة على هذا الجهاز؛ سيُعدّ ذلك تراجعاً ويُسجَّل.' });
  }
  const ageDays = Math.max(0, Math.floor((now - staged.createdAt) / 86_400_000));
  if (ageDays > OLD_BACKUP_WARNING_DAYS) warnings.push({ code: 'BACKUP_OLD', message: 'النسخة قديمة: عمرها ' + ageDays + ' يوماً.' });
  if (summary && summary.deviceId && live.deviceId && summary.deviceId !== live.deviceId) {
    warnings.push({ code: 'BACKUP_FROM_OTHER_DEVICE', message: 'النسخة من جهاز آخر؛ سيُولَّد معرّف جهاز جديد بعد الاستعادة.' });
  }

  // أثر الأسرار (أسماء وحالة فقط، لا قيم).
  const statuses: { name: string; status: SecretStatus }[] = [];
  for (const [name, value] of [...secrets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const cur = input.currentSecrets.get(name) ?? null;
    statuses.push({ name, status: cur === null ? 'new' : cur === value ? 'same' : 'different' });
  }
  if (statuses.some((s) => s.name === SECRET_NAMES.dbKey && s.status === 'different')) {
    warnings.push({ code: 'DB_KEY_WILL_CHANGE', message: 'مفتاح قاعدة البيانات في النسخة يختلف عن مفتاح هذا الجهاز؛ سيُستبدل مع القاعدة (نسخة الأمان تحمل المفتاح الحالي).' });
  }

  const m = staged.manifest;
  return {
    generatedAt: now,
    backup: {
      backupId: staged.backupId, createdAt: staged.createdAt, ageDays, databaseBytes: staged.databaseSize,
      attachmentsCount: staged.attachments.length,
      attachmentsBytes: staged.attachments.reduce((s, a) => s + a.size, 0),
      cipherVersion: m.database?.cipherVersion ?? null,
    },
    counts: { backup: summary ? summary.counts : null, live: live.counts },
    secrets: statuses,
    audit,
    decisions: {
      checkpointLast: 'not-restored-reset-on-accept',
      deviceId: 'regenerate-always',
      session: 'invalidate-after-restore',
      secretsToRestore: statuses.map((s) => s.name),
      secretsIgnored: [...staged.ignoredSecrets, ...staged.unknownSecrets],
    },
    blockers, warnings, canProceed: blockers.length === 0,
  };
}

// ===== 3) التحقق من ملف نسخة بقراءة كاملة (تستعمله نسخة الأمان) =====
export async function verifyBackupFileFully(
  deps: Pick<RestorePrepDeps, 'crypto' | 'fs'>, filePath: string, passphrase: string,
  expected: { backupId: string; sizeBytes: number; sha256: string }
): Promise<void> {
  const { crypto, fs } = deps;
  if (!(await fs.exists(filePath))) throw new RestorePrepError('SAFETY_BACKUP_FAILED');
  const size = await fs.size(filePath);
  if (size !== expected.sizeBytes) throw new RestorePrepError('SAFETY_BACKUP_FAILED');
  const fileHash = crypto.sha256();
  const src = boundedSource(fs, filePath, size, (b) => fileHash.update(b));
  let reader: PackageReader | null = null;
  try {
    reader = await PackageReader.open(crypto, passphrase, src.source);
    if (reader.header.backupId !== expected.backupId) throw new RestorePrepError('SAFETY_BACKUP_FAILED');
    let first = true, last = -1;
    for (let head = await reader.nextRecord(); head; head = await reader.nextRecord()) {
      if (first && head.kind !== RECORD_KIND.database) throw new RestorePrepError('SAFETY_BACKUP_FAILED');
      first = false;
      last = head.kind;
      await reader.readData(() => { /* التحقق من البصمة المدمجة يتم داخل القارئ */ });
    }
    if (last !== RECORD_KIND.manifest) throw new RestorePrepError('SAFETY_BACKUP_FAILED');
    if (src.remaining() !== 0) throw new RestorePrepError('SAFETY_BACKUP_FAILED');
    if (toHex(fileHash.digest()) !== expected.sha256) throw new RestorePrepError('SAFETY_BACKUP_FAILED');
  } catch (e) {
    if (e instanceof RestorePrepError) throw e;
    throw new RestorePrepError('SAFETY_BACKUP_FAILED');
  } finally {
    reader?.close();
    await src.close();
  }
}

// ===== 4) سجل الخطط (ذاكرة فقط) =====
const plans = new Map<string, StoredRestorePlan>();
let inFlight = false;

export function _resetRestorePlansForTests(): void { plans.clear(); inFlight = false; }

export function activeRestorePlanIds(): string[] { return [...plans.keys()]; }

async function discardStaging(deps: Pick<RestorePrepDeps, 'fs' | 'stagingRoot'>, planId: string): Promise<void> {
  if (!PLAN_ID_PATTERN.test(planId)) return;
  try { await deps.fs.remove(join(deps.stagingRoot, RESTORE_STAGING_DIR_NAME + '/' + planId)); } catch { /* تنظيف فقط */ }
}

export async function discardRestorePlan(
  deps: Pick<RestorePrepDeps, 'fs' | 'stagingRoot'>, planId: string, userId: string
): Promise<void> {
  const p = plans.get(planId);
  if (!p || p.userId !== userId) return;
  plans.delete(planId);
  await discardStaging(deps, planId);
}

// يحذف كل مجلدات التجهيز المتبقية (من تشغيل سابق أو خطط منتهية). يُستدعى عند بدء التطبيق وقبل كل تجهيز.
export async function cleanupStaleRestoreStaging(
  deps: Pick<RestorePrepDeps, 'fs' | 'stagingRoot' | 'now'>, keepPlanIds: string[] = []
): Promise<number> {
  const root = join(deps.stagingRoot, RESTORE_STAGING_DIR_NAME);
  let removed = 0;
  let names: string[] = [];
  try { names = await deps.fs.listDirs(root); } catch { return 0; }
  for (const n of names) {
    if (keepPlanIds.includes(n) || !PLAN_ID_PATTERN.test(n)) continue;
    await discardStaging(deps, n);
    removed++;
  }
  return removed;
}

// يعيد الخطة لصاحبها فقط وقبل انتهاء صلاحيتها. لا يتحقق من الطزاجة (انظر assertRestorePlanFresh).
export function getRestorePlan(planId: string, userId: string, now: number): StoredRestorePlan {
  const p = plans.get(planId);
  if (!p || p.userId !== userId) throw new RestorePrepError('PLAN_NOT_FOUND');
  if (now > p.expiresAt) throw new RestorePrepError('PLAN_EXPIRED');
  return p;
}

// تستدعيها 10.6 مباشرة قبل الاستبدال: لا تغيّر في بيانات النظام منذ نسخة الأمان، وملفات التجهيز سليمة.
export async function assertRestorePlanFresh(
  deps: Pick<RestorePrepDeps, 'crypto' | 'fs' | 'now' | 'getLiveAuditSeq' | 'flushAudit'>, planId: string, userId: string
): Promise<StoredRestorePlan> {
  const p = getRestorePlan(planId, userId, deps.now());
  await deps.flushAudit();
  if ((await deps.getLiveAuditSeq()) !== p.liveAuditSeqAtPlan) throw new RestorePrepError('SAFETY_BACKUP_STALE');
  try {
    if ((await hashFile(deps.crypto, deps.fs, p.staged.databasePath)) !== p.staged.databaseSha256) throw new Error('x');
    for (const a of p.staged.attachments) {
      if ((await deps.fs.size(join(p.staged.attachmentsDir, a.name))) !== a.size) throw new Error('x');
    }
    if (!(await deps.fs.exists(p.safety.filePath))) throw new Error('x');
  } catch { throw new RestorePrepError('STAGING_TAMPERED'); }
  return p;
}

// ===== 5) المنسّق =====
function ensureInput(i: PrepareRestoreInput): void {
  const okPath = typeof i.sourcePath === 'string' && /\.scdbak$/i.test(i.sourcePath) && !/\.partial$/i.test(i.sourcePath);
  if (!i.userId || !okPath || typeof i.passphrase !== 'string' || i.passphrase.length === 0) {
    throw new RestorePrepError('INVALID_INPUT');
  }
}

export async function prepareRestore(deps: RestorePrepDeps, input: PrepareRestoreInput): Promise<PrepareRestoreResult> {
  if (inFlight) throw new RestorePrepError('RESTORE_IN_PROGRESS');
  inFlight = true;
  const { fs } = deps;
  let planId: string | null = null;
  let registered = false;
  try {
    ensureInput(input);
    // سياسة كلمة مرور نسخة الأمان تُفحص قبل لمس أي شيء.
    const safetyPass = assertPassphraseAcceptable(input.safetyPassphrase, input.safetyPassphraseConfirmation);

    // خطة واحدة نشطة فقط: تُلغى السابقة وتُنظَّف بقايا المجلدات.
    for (const old of [...plans.values()]) { plans.delete(old.planId); }
    await cleanupStaleRestoreStaging(deps);

    planId = deps.newId();
    const staged = await stageBackup(deps, input.sourcePath, input.passphrase, planId);

    // فحص القاعدة المجهّزة (نسخة منها يفحصها المحوّل؛ الملف المجهّز نفسه لا يُفتح).
    deps.onProgress?.({ stage: 'inspecting', current: 0, total: 1 });
    let summary: StagedDbSummary | null = null;
    let summaryError: ReportInput['summaryError'] = null;
    const dbKey = staged.restorableSecrets.get(SECRET_NAMES.dbKey);
    if (dbKey && DB_KEY_PATTERN.test(dbKey)) {
      try { summary = await deps.inspectStagedDatabase(staged.databasePath, dbKey); }
      catch { summary = null; summaryError = 'unreadable'; }
    } else if (dbKey) {
      summaryError = 'key-invalid';
    }
    const live = await deps.readLiveSummary();
    const current = new Map<string, string | null>();
    for (const name of staged.restorableSecrets.keys()) current.set(name, await deps.readSecret(name));
    let report = buildRestoreReport({ staged, summary, summaryError, live, currentSecrets: current, now: deps.now() });
    current.clear();
    deps.onProgress?.({ stage: 'inspecting', current: 1, total: 1 });

    if (!report.canProceed) {
      await deps.logEvent({
        operationType: 'restore_prepare_blocked', entityType: 'backup', entityId: staged.backupId,
        newValues: { blockerCodes: report.blockers.map((b) => b.code) },
      }).catch(() => undefined);
      await discardStaging(deps, planId);
      return { status: 'blocked', report };
    }

    // نسخة الأمان للحالة الحالية: بعد نجاح كل الفحوص وقبل أي استبدال.
    deps.onProgress?.({ stage: 'safety-backup', current: 0, total: 1 });
    await deps.flushAudit();
    let result: BackupPackageResult;
    try {
      result = await deps.createSafetyBackup(safetyPass, input.safetyPassphraseConfirmation);
    } catch (e) {
      if (e instanceof BackupError && e.code === 'INVALID_PASSPHRASE') throw e;
      throw new RestorePrepError('SAFETY_BACKUP_FAILED');
    }
    deps.onProgress?.({ stage: 'verifying-safety', current: 0, total: 1 });
    try {
      await verifyBackupFileFully(deps, result.filePath, safetyPass,
        { backupId: result.backupId, sizeBytes: result.sizeBytes, sha256: result.sha256 });
    } catch (e) {
      try { await fs.remove(result.filePath); } catch { /* ملف غير صالح */ }
      throw e;
    }

    // تثبيت الاسم: PreRestore-... (فشل إعادة التسمية لا يُبطل نسخة أمان سليمة).
    let finalPath = result.filePath, finalName = result.fileName;
    const slash = result.filePath.lastIndexOf('/');
    const renamed = SAFETY_BACKUP_PREFIX + result.fileName.replace(/^SecureCaseDesk-/, '');
    if (slash >= 0 && renamed !== result.fileName) {
      const target = result.filePath.slice(0, slash + 1) + renamed;
      try { await fs.move(result.filePath, target); finalPath = target; finalName = renamed; } catch { /* يبقى الاسم الأصلي */ }
    }
    const safety: SafetyBackupInfo = {
      backupId: result.backupId, filePath: finalPath, fileName: finalName,
      sizeBytes: result.sizeBytes, sha256: result.sha256, createdAt: result.createdAt,
    };
    await deps.logEvent({
      operationType: 'backup_safety_create', entityType: 'backup', entityId: result.backupId,
      newValues: { fileName: finalName, sizeBytes: result.sizeBytes, sha256: result.sha256, attachments: result.attachmentsIncluded },
      reason: 'pre-restore',
    }).catch(() => undefined);

    // سجل الحدث ثم تثبيت رقم آخر سجل تدقيق حي (أساس فحص الطزاجة في 10.6).
    const createdAt = deps.now();
    report = { ...report, generatedAt: createdAt };
    await deps.logEvent({
      operationType: 'restore_prepare', entityType: 'backup', entityId: staged.backupId,
      newValues: {
        planId, sourceBackupId: staged.backupId, sourceCreatedAt: staged.createdAt,
        safetyBackupId: safety.backupId, countsLive: report.counts.live, countsBackup: report.counts.backup,
        auditEntriesLostIfRestored: report.audit.entriesLostIfRestored,
        requiresRollbackAcceptance: report.audit.requiresRollbackAcceptance,
        secretsToRestore: report.decisions.secretsToRestore, warningCodes: report.warnings.map((w) => w.code),
      },
    }).catch(() => undefined);
    await deps.flushAudit();
    const liveSeq = await deps.getLiveAuditSeq();
    report = { ...report, audit: evaluateAudit(liveSeq, report.audit.backupMaxSeq, report.audit.externalCheckpointSeq) };

    const summaryOut: RestorePlanSummary = {
      planId, createdAt, expiresAt: createdAt + RESTORE_PLAN_TTL_MS, report,
      safetyBackup: { backupId: safety.backupId, fileName: safety.fileName, sizeBytes: safety.sizeBytes, sha256: safety.sha256, createdAt: safety.createdAt },
      stagedDatabaseSha256: staged.databaseSha256,
      requiresRollbackAcceptance: report.audit.requiresRollbackAcceptance,
    };
    plans.set(planId, { ...summaryOut, userId: input.userId, staged, safety, liveAuditSeqAtPlan: liveSeq });
    registered = true;
    deps.onProgress?.({ stage: 'done', current: 1, total: 1 });
    return { status: 'ready', plan: summaryOut };
  } catch (e) {
    if (e instanceof RestorePrepError || e instanceof BackupError) throw e;
    throw new RestorePrepError('PREP_FAILED');
  } finally {
    if (!registered && planId) await discardStaging(deps, planId);
    inFlight = false;
  }
}
