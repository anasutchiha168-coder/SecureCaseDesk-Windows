#!/usr/bin/env bash
# SecureCaseDesk — المرحلة 10 / القسم 10.5 — تجهيز الاستعادة وإنشاء نسخة الأمان
# شغّله من جذر المشروع:  bash phase10-5.sh   (أو الصق محتواه في الطرفية)
set -euo pipefail

if ! grep -q '"name": "securecasedesk"' package.json 2>/dev/null; then
  echo "❌ شغّل السكربت من جذر مشروع SecureCaseDesk (حيث package.json)."; exit 1
fi

need() { # ملف + نص يجب أن يوجد فيه
  if ! grep -q "$2" "$1" 2>/dev/null; then echo "❌ غير متوافق مع هذا المشروع: لم أجد «$2» في $1"; exit 1; fi
}
need src/modules/backup/backup-types.ts "PACKAGE_AUTH_FAILED"
need src/modules/backup/backup-format.ts "export class PackageReader"
need src/modules/backup/backup-package.ts "export async function createBackupPackage"
need src/modules/backup/backup-package-runtime.ts "export async function createEncryptedBackup"
need src/security/audit-integrity-guard.ts "export async function readExternalCheckpoint"
need src/modules/audit/audit-integration.ts "recordSystemEvent"
need src/services/audit.service.ts "export function flushAuditQueue"

python3 - <<'PYEOF'
import json, os, sys

MARK = 'SECURECASEDESK_PHASE10_S5'
FILES = {
    'src/modules/backup/backup-restore-prep.ts': r'''// SECURECASEDESK_PHASE10_S5
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

const EXCLUDED_NAMES: readonly string[] = [SECRET_NAMES.sessionUser, SECRET_NAMES.apiUrl, SECRET_NAMES.apiToken];

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
''',
    'src/modules/backup/backup-restore-prep-runtime.ts': r'''// SECURECASEDESK_PHASE10_S5
// محوّل Expo لتجهيز الاستعادة (10.5). ⚠️ لم يُشغَّل على جهاز: يحتاج فحص tsc وتجربة على Android حقيقي (انظر docs/phase10/10.5-restore-preparation.md).
// لا يستبدل أي بيانات حية: يفك النسخة في Paths.cache ويفحصها وينشئ نسخة أمان فقط.
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import { readExternalCheckpoint } from '@/security/audit-integrity-guard';
import { flushAuditQueue } from '@/services/audit.service';
import { recordSystemEvent } from '@/modules/audit/audit-integration';
import { createEncryptedBackup } from './backup-package-runtime';
import type { PackageFs } from './backup-package';
import type { BackupCryptoProvider } from './backup-format';
import { BACKUP_PERMISSION, OPTIONAL_TABLES, REQUIRED_TABLES } from './backup-types';
import {
  COUNTED_TABLES, RESTORE_STAGING_DIR_NAME, RestorePrepError,
  activeRestorePlanIds, assertRestorePlanFresh, cleanupStaleRestoreStaging, discardRestorePlan, getRestorePlan, prepareRestore,
  type LiveSummary, type PrepareRestoreResult, type RestorePlanSummary, type RestorePrepDeps,
  type RestorePrepProgress, type StagedDbSummary, type StoredRestorePlan,
} from './backup-restore-prep';

// ملاحظة: المزوّد والمحوّل أدناه نسخة من backup-package-runtime.ts (غير مصدَّرَين هناك) ويجب أن يبقيا مطابقين له.
const noblePackageCrypto: BackupCryptoProvider = {
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

const expoRestoreFs: PackageFs & { listDirs(path: string): Promise<string[]> } = {
  async ensureDir(path) { new Directory(path).create({ intermediates: true, idempotent: true }); },
  async exists(path) { return new File(path).exists; },
  async size(path) { const f = new File(path); return f.exists ? f.size : 0; },
  async remove(path) { removeIfExists(path); },
  async move(from, to) { removeIfExists(to); new File(from).move(new File(to)); },
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
  async listDirs(path) {
    const d = new Directory(path);
    if (!d.exists) return [];
    const names: string[] = [];
    for (const item of d.list()) if (item instanceof Directory) names.push(item.name);
    return names;
  },
};

// أسماء الجداول من ثوابت المشروع فقط (لا تُبنى من مدخلات).
const KNOWN_TABLES: readonly string[] = [...REQUIRED_TABLES, ...OPTIONAL_TABLES];
const quote = (n: string) => '"' + n + '"';

interface Queryable {
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

async function tableSet(db: Queryable): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
  return new Set(rows.map((r) => r.name));
}

async function countTables(db: Queryable, existing: Set<string>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    if (!existing.has(t)) continue;
    const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM ' + quote(t));
    counts[t] = Number(row?.c ?? 0);
  }
  return counts;
}

async function readAuditMax(db: Queryable, existing: Set<string>): Promise<number> {
  if (!existing.has('audit_logs')) return 0;
  const row = await db.getFirstAsync<{ m: number | null }>('SELECT MAX(sequence_no) AS m FROM audit_logs');
  return Number(row?.m ?? 0);
}

async function readDeviceId(db: Queryable, existing: Set<string>): Promise<string | null> {
  if (!existing.has('audit_sync_state')) return null;
  const row = await db.getFirstAsync<{ device_id: string }>('SELECT device_id FROM audit_sync_state WHERE id = 1');
  return row?.device_id ?? null;
}

// يفحص نسخة مؤقتة من القاعدة المجهّزة (الملف المجهّز نفسه لا يُفتح كي لا تتغير بصمته).
// مفتاح القاعدة مُتحقَّق من صيغته (UUID) في الطبقة الصرفة قبل الوصول إلى هنا؛ يُهرَّب الاقتباس احتياطاً.
async function inspectStagedDatabase(databasePath: string, dbKey: string): Promise<StagedDbSummary> {
  const slash = databasePath.lastIndexOf('/');
  const dir = databasePath.slice(0, slash);
  const copyName = 'inspect.db';
  const copyPath = dir + '/' + copyName;
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) { try { removeIfExists(copyPath + suffix); } catch { /* تنظيف فقط */ } }
  };
  cleanup();
  new File(databasePath).copy(new File(copyPath));
  let db: SQLite.SQLiteDatabase | null = null;
  try {
    db = await SQLite.openDatabaseAsync(copyName, { useNewConnection: true }, dir);
    await db.execAsync("PRAGMA key = '" + dbKey.replace(/'/g, "''") + "';");
    const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version;');
    // أول قراءة فعلية للمخطط: تفشل إن كان المفتاح خاطئاً أو الملف تالفاً.
    const existing = await tableSet(db);

    const integrity = await db.getAllAsync<{ integrity_check: string }>('PRAGMA integrity_check;');
    let integrityOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
    try {
      const pages = await db.getAllAsync<Record<string, unknown>>('PRAGMA cipher_integrity_check;');
      if (pages.length > 0) integrityOk = false;
    } catch { /* الأمر مساعد؛ فشل تنفيذه لا يُعدّ فشل سلامة */ }

    const counts = await countTables(db, existing);
    let activeAdmins = 0;
    if (existing.has('users')) {
      const a = await db.getFirstAsync<{ c: number }>(
        `SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND COALESCE(is_active, 1) = 1`
      );
      activeAdmins = Number(a?.c ?? 0);
    }
    let auditKeyVersions: number[] = [];
    if (existing.has('audit_key_registry')) {
      const rows = await db.getAllAsync<{ version: number }>('SELECT version FROM audit_key_registry ORDER BY version');
      auditKeyVersions = rows.map((r) => Number(r.version)).filter((v) => Number.isInteger(v) && v > 0);
    }
    const attachmentRows = existing.has('attachments')
      ? await db.getAllAsync<{ id: string; storage_name: string; status: string; sha256_cipher: string }>(
          'SELECT id, storage_name, status, sha256_cipher FROM attachments')
      : [];
    return {
      cipherVersion: cipher?.cipher_version ?? '',
      integrityOk,
      tablesPresent: KNOWN_TABLES.filter((t) => existing.has(t)),
      counts, activeAdmins,
      auditMaxSeq: await readAuditMax(db, existing),
      auditKeyVersions,
      deviceId: await readDeviceId(db, existing),
      attachmentRows,
    };
  } finally {
    try { await db?.closeAsync(); } catch { /* تنظيف فقط */ }
    cleanup();
  }
}

async function readLiveSummary(): Promise<LiveSummary> {
  const db = await getDb();
  const existing = await tableSet(db);
  const ext = await readExternalCheckpoint();
  return {
    counts: await countTables(db, existing),
    auditMaxSeq: await readAuditMax(db, existing),
    externalCheckpointSeq: ext.state === 'present' && ext.record ? ext.record.sequence_no : null,
    deviceId: await readDeviceId(db, existing),
  };
}

async function getLiveAuditSeq(): Promise<number> {
  const db = await getDb();
  return readAuditMax(db, await tableSet(db));
}

function buildDeps(
  s: Session, onProgress?: (p: RestorePrepProgress) => void
): RestorePrepDeps {
  return {
    crypto: noblePackageCrypto,
    fs: expoRestoreFs,
    stagingRoot: stripScheme(Paths.cache.uri),
    newId: () => Crypto.randomUUID(),
    now: () => Date.now(),
    yieldTick: () => new Promise((r) => setTimeout(r, 0)),
    onProgress,
    readSecret: (name) => SecureStore.getItemAsync(name),
    inspectStagedDatabase,
    readLiveSummary,
    createSafetyBackup: (pass, confirm) => createEncryptedBackup(s, pass, confirm),
    flushAudit: () => flushAuditQueue(),
    getLiveAuditSeq,
    // غير صارم عمداً: التجهيز غير مدمّر، وقد تكون السلسلة نفسها هي سبب الاستعادة. التسجيل الصارم في 10.6.
    logEvent: (e) => recordSystemEvent(s, BACKUP_PERMISSION, {
      operationType: e.operationType, entityType: e.entityType, entityId: e.entityId, newValues: e.newValues, reason: e.reason ?? null,
    }, false),
  };
}

async function authorize(session: Session | null | undefined): Promise<Session> {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);
  return s;
}

// المسار الذي يختاره المدير (محدد ملفات) يُحوَّل إلى مسار نظام ملفات بلا مخطط.
export async function prepareRestoreFromBackup(
  session: Session | null | undefined,
  input: { sourceUri: string; passphrase: string; safetyPassphrase: string; safetyPassphraseConfirmation: string },
  onProgress?: (p: RestorePrepProgress) => void
): Promise<PrepareRestoreResult> {
  const s = await authorize(session);
  return prepareRestore(buildDeps(s, onProgress), {
    userId: s.userId,
    sourcePath: stripScheme(decodeURI(input.sourceUri)),
    passphrase: input.passphrase,
    safetyPassphrase: input.safetyPassphrase,
    safetyPassphraseConfirmation: input.safetyPassphraseConfirmation,
  });
}

export async function getPreparedRestore(session: Session | null | undefined, planId: string): Promise<RestorePlanSummary> {
  const s = await authorize(session);
  const p = getRestorePlan(planId, s.userId, Date.now());
  return summaryOf(p);
}

function summaryOf(p: StoredRestorePlan): RestorePlanSummary {
  const { userId: _u, staged: _s, safety: _f, liveAuditSeqAtPlan: _l, ...summary } = p;
  void _u; void _s; void _f; void _l;
  return summary;
}

// تستدعيها 10.6 قبل الاستبدال مباشرة.
export async function assertPreparedRestoreFresh(session: Session | null | undefined, planId: string): Promise<StoredRestorePlan> {
  const s = await authorize(session);
  return assertRestorePlanFresh(buildDeps(s), planId, s.userId);
}

export async function discardPreparedRestore(session: Session | null | undefined, planId: string): Promise<void> {
  const s = await authorize(session);
  await discardRestorePlan(buildDeps(s), planId, s.userId);
}

// عند بدء التطبيق: الخطط في الذاكرة فقط، فأي مجلد تجهيز متبقٍ هو بقايا تشغيل سابق (الخطط النشطة تُستثنى). لا تتطلب جلسة ولا تمس بيانات حية.
export async function cleanupRestoreStagingOnStartup(): Promise<number> {
  try {
    return await cleanupStaleRestoreStaging(
      { fs: expoRestoreFs, stagingRoot: stripScheme(Paths.cache.uri), now: () => Date.now() }, activeRestorePlanIds()
    );
  } catch {
    return 0;
  }
}

export { RestorePrepError, RESTORE_STAGING_DIR_NAME };
''',
    'tests/backup-restore-prep.test.ts': r'''// SECURECASEDESK_PHASE10_S5
// اختبارات المرحلة 10 / القسم 10.5 — تجهيز الاستعادة ونسخة الأمان. تشغَّل بـ: npm run test:backup-restore-prep
// ملفات حقيقية على القرص + تشفير حقيقي (node:crypto). قاعدة البيانات مزيفة (SQLCipher غير متاح في Node) عبر دالة الفحص المحقونة.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createBackupPackage, type AttachmentRow, type BackupPackageResult, type PackageFs, type PackageManifest,
} from '../src/modules/backup/backup-package';
import { createDatabaseSnapshot, discardDatabaseSnapshot, type SnapshotFs } from '../src/modules/backup/backup-snapshot';
import {
  RECORD_KIND, SealedWriter, type BackupCryptoProvider,
} from '../src/modules/backup/backup-format';
import { BackupError, REQUIRED_TABLES, type SecretSpec } from '../src/modules/backup/backup-types';
import {
  RESTORE_PLAN_TTL_MS, RestorePrepError, _resetRestorePlansForTests, assertRestorePlanFresh,
  cleanupStaleRestoreStaging, discardRestorePlan, getRestorePlan, hashFile, prepareRestore, verifyBackupFileFully,
  type LiveSummary, type RestoreAuditEvent, type RestorePrepDeps, type StagedDbSummary,
} from '../src/modules/backup/backup-restore-prep';

const CHUNK = 4096;
const KDF = { logN: 10, r: 8, p: 1 };
const PASS = 'كلمة-مرور-النسخة-المصدر-123';
const SAFETY_PASS = 'كلمة-مرور-نسخة-الأمان-456';
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);

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

const snapFs: SnapshotFs = {
  async ensureDir(p) { fs.mkdirSync(p, { recursive: true }); },
  async exists(p) { return fs.existsSync(p); },
  async size(p) { return fs.existsSync(p) ? fs.statSync(p).size : 0; },
  async copy(a, b) { fs.copyFileSync(a, b); },
  async move(a, b) { fs.renameSync(a, b); },
  async remove(p) { fs.rmSync(p, { recursive: true, force: true }); },
  async writeText(p, t) { fs.writeFileSync(p, t, 'utf8'); },
  async sha256File(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); },
};

const nodeFs: PackageFs & { listDirs(p: string): Promise<string[]> } = {
  ...snapFs,
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
  async listDirs(p) {
    if (!fs.existsSync(p)) return [];
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  },
};

class FakeDb {
  async execAsync(_s: string) {}
  async getFirstAsync<T>(sql: string): Promise<T | null> {
    if (sql.includes('journal_mode')) return { journal_mode: 'delete' } as T;
    if (sql.includes('cipher_version')) return { cipher_version: '4.5.7 community' } as T;
    if (sql.includes('wal_autocheckpoint')) return { wal_autocheckpoint: 1000 } as T;
    return null;
  }
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const uuidName = () => crypto.randomUUID() + '.enc';

const DB_KEY = '3f2b8a40-6c1d-4e0f-9a7b-1d2c3e4f5a6b';
const GOOD_SECRETS: Record<string, string> = {
  db_encryption_key: DB_KEY,
  securecase_audit_active_version: '1',
  securecase_audit_hmac_key_v1: 'a1'.repeat(32),
  attachment_master_key_v1: 'b2'.repeat(32),
  securecase_audit_checkpoint_key_v1: 'c3'.repeat(32),
  securecase_audit_checkpoint_last: '{"sequence_no":5,"record_hash":"zz"}',
};
const SPECS: SecretSpec[] = [
  { name: 'db_encryption_key', cls: 'required', reason: '' },
  { name: 'securecase_audit_active_version', cls: 'required', reason: '' },
  { name: 'securecase_audit_hmac_key_v1', cls: 'required', reason: '' },
  { name: 'attachment_master_key_v1', cls: 'required', reason: '' },
  { name: 'securecase_audit_checkpoint_key_v1', cls: 'recommended', reason: '' },
  { name: 'securecase_audit_checkpoint_last', cls: 'review', reason: '' },
  { name: 'securecase_session_uid', cls: 'excluded', reason: '' },
];

// ===== بيئة الاختبار =====
let root: string, cacheDir: string, docsDir: string, backupsDir: string, liveDb: string, liveAttDir: string, srcDir: string;
let liveSeq: number;
let events: RestoreAuditEvent[];
let safetyCalls: number;
let ids = 0;
let sourceDb: Buffer;
let sourceAtts: { id: string; name: string; data: Buffer; status: 'active' | 'deleted' }[];
let liveSecrets: Record<string, string | null>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-restore-'));
  cacheDir = path.join(root, 'cache');
  docsDir = path.join(root, 'documents');
  backupsDir = path.join(docsDir, 'backups');
  liveAttDir = path.join(docsDir, 'attachments');
  srcDir = path.join(root, 'source');
  for (const d of [cacheDir, backupsDir, liveAttDir, srcDir]) fs.mkdirSync(d, { recursive: true });
  liveDb = path.join(docsDir, 'securecase.db');
  fs.writeFileSync(liveDb, randomBytes(9000));
  sourceDb = randomBytes(CHUNK * 3 + 123);
  sourceAtts = [
    { id: crypto.randomUUID(), name: uuidName(), data: randomBytes(5000), status: 'active' },
    { id: crypto.randomUUID(), name: uuidName(), data: randomBytes(CHUNK + 7), status: 'deleted' },
  ];
  liveSeq = 12;
  events = [];
  safetyCalls = 0;
  liveSecrets = { ...GOOD_SECRETS, db_encryption_key: '99999999-aaaa-4bbb-8ccc-dddddddddddd' };
  _resetRestorePlansForTests();
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

// ===== بناء ملفات النسخة =====
interface Rec { kind: number; name: string; data: Uint8Array; meta?: Record<string, unknown> }

async function writePackage(file: string, pass: string, recs: Rec[], opts: { backupId?: string; createdAt?: number } = {}) {
  const header = {
    backupId: opts.backupId ?? 'bk-' + randomBytes(5).toString('hex'), createdAt: opts.createdAt ?? NOW - 86_400_000,
    kdf: KDF, salt: new Uint8Array(randomBytes(16)), chunkSize: CHUNK,
  };
  const w = await SealedWriter.create(nodeCrypto, pass, header, async (b) => { fs.appendFileSync(file, b); });
  for (const r of recs) {
    const meta = new TextEncoder().encode(JSON.stringify({ name: r.name, size: r.data.length, ...(r.meta ?? {}) }));
    const head = new Uint8Array(5 + meta.length);
    head[0] = r.kind;
    new DataView(head.buffer).setUint32(1, meta.length);
    head.set(meta, 5);
    await w.write(head);
    await w.write(r.data);
    await w.write(new Uint8Array(createHash('sha256').update(r.data).digest()));
  }
  await w.finish();
  return header;
}

function stdRecords(over: {
  secrets?: Record<string, unknown>; db?: Buffer; atts?: typeof sourceAtts; backupId?: string; createdAt?: number;
  mutateManifest?: (m: PackageManifest) => void; attachmentName?: string;
} = {}): { recs: Rec[]; backupId: string; createdAt: number } {
  const backupId = over.backupId ?? 'bk-' + randomBytes(5).toString('hex');
  const createdAt = over.createdAt ?? NOW - 86_400_000;
  const db = over.db ?? sourceDb;
  const atts = over.atts ?? sourceAtts;
  const secretsBytes = Buffer.from(JSON.stringify(over.secrets ?? GOOD_SECRETS));
  const recs: Rec[] = [
    { kind: RECORD_KIND.database, name: 'securecase.db', data: db },
    { kind: RECORD_KIND.secrets, name: 'secrets.json', data: secretsBytes },
    ...atts.map((a) => ({
      kind: RECORD_KIND.attachment, name: over.attachmentName ?? a.name, data: a.data, meta: { id: a.id, status: a.status },
    })),
  ];
  const manifest: PackageManifest = {
    formatVersion: 1, kind: 'backup-package', backupId, createdAt, appName: 'SecureCaseDesk',
    database: { databaseFileName: 'securecase.db', size: db.length, sha256: sha(db), journalMode: 'delete', cipherVersion: '4.5.7', snapshotId: 's1' },
    secrets: [],
    attachments: {
      count: atts.length, totalBytes: atts.reduce((s, a) => s + a.data.length, 0),
      entries: atts.map((a) => ({ id: a.id, name: over.attachmentName ?? a.name, size: a.data.length, sha256: sha(a.data), status: a.status, matchesRecorded: true })),
      missing: [],
    },
    records: recs.map((r) => ({ kind: r.kind, name: r.name, size: r.data.length, sha256: sha(r.data) })),
  };
  over.mutateManifest?.(manifest);
  recs.push({ kind: RECORD_KIND.manifest, name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  return { recs, backupId, createdAt };
}

async function makeSource(over: Parameters<typeof stdRecords>[0] = {}, pass = PASS): Promise<string> {
  const file = path.join(srcDir, 'source-' + ++ids + '.scdbak');
  const { recs, backupId, createdAt } = stdRecords(over);
  await writePackage(file, pass, recs, { backupId, createdAt });
  return file;
}

// نسخة أمان حقيقية بواسطة createBackupPackage (نفس مسار 10.3).
async function realSafetyBackup(pass: string, confirm: string): Promise<BackupPackageResult> {
  safetyCalls++;
  const rows: AttachmentRow[] = [];
  const blobs: string[] = [];
  const d = createBackupPackageDeps(rows, blobs);
  return createBackupPackage(d, pass, confirm);
}

function createBackupPackageDeps(rows: AttachmentRow[], _b: string[]) {
  const stagingRoot = path.join(root, 'safety-staging');
  return {
    crypto: nodeCrypto, fs: nodeFs, kdf: KDF, chunkSize: CHUNK, outputDir: backupsDir,
    takeSnapshot: () => createDatabaseSnapshot({
      db: new FakeDb(), fs: snapFs, databasePath: liveDb, stagingRoot, newId: () => 'snap-' + ++ids, now: () => NOW,
    }),
    discardSnapshot: async (s: Parameters<typeof discardDatabaseSnapshot>[1]) => { await discardDatabaseSnapshot({ fs: snapFs, stagingRoot }, s); },
    readAttachmentRows: async () => rows.map((r) => ({ ...r })),
    attachmentPath: (n: string) => path.join(liveAttDir, n),
    secretSpecs: SPECS,
    readSecret: async (n: string) => liveSecrets[n] ?? null,
    newId: () => 'safety-' + randomBytes(6).toString('hex'),
    now: () => NOW,
  };
}

function goodSummary(over: Partial<StagedDbSummary> = {}): StagedDbSummary {
  return {
    cipherVersion: '4.5.7 community', integrityOk: true, tablesPresent: [...REQUIRED_TABLES],
    counts: { users: 2, cases: 40, memos: 11, detainees: 7, audit_logs: 10, attachments: 2 },
    activeAdmins: 1, auditMaxSeq: 10, auditKeyVersions: [1], deviceId: 'dev-backup',
    attachmentRows: sourceAtts.map((a) => ({ id: a.id, storage_name: a.name, status: a.status, sha256_cipher: sha(a.data) })),
    ...over,
  };
}

function mkDeps(over: Partial<RestorePrepDeps> & { summary?: () => Promise<StagedDbSummary>; live?: Partial<LiveSummary> } = {}): RestorePrepDeps {
  const { summary, live, ...rest } = over;
  return {
    crypto: nodeCrypto, fs: nodeFs, stagingRoot: cacheDir,
    newId: () => 'plan-' + randomBytes(6).toString('hex'),
    now: () => NOW,
    readSecret: async (n) => liveSecrets[n] ?? null,
    inspectStagedDatabase: summary ? async () => summary() : async () => goodSummary(),
    readLiveSummary: async () => ({
      counts: { users: 3, cases: 55, memos: 20, detainees: 9, audit_logs: 12 }, auditMaxSeq: liveSeq,
      externalCheckpointSeq: 12, deviceId: 'dev-live', ...(live ?? {}),
    }),
    createSafetyBackup: realSafetyBackup,
    flushAudit: async () => {},
    getLiveAuditSeq: async () => liveSeq,
    logEvent: async (e) => { events.push(e); liveSeq++; },
    ...rest,
  };
}

const input = (src: string, over: Record<string, unknown> = {}) => ({
  userId: 'admin-1', sourcePath: src, passphrase: PASS, safetyPassphrase: SAFETY_PASS, safetyPassphraseConfirmation: SAFETY_PASS, ...over,
});

const stagingDirs = () => (fs.existsSync(path.join(cacheDir, 'restore-staging')) ? fs.readdirSync(path.join(cacheDir, 'restore-staging')) : []);

async function rejectsWith(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (e: unknown) => (e as { code?: string }).code === code, 'متوقع الرمز ' + code);
}

// ===== الاختبارات =====
describe('10.5 — التجهيز الناجح', () => {
  test('نسخة 10.3 الحقيقية: تُفك بنفس البايتات وتُبنى خطة جاهزة', async () => {
    // مصدر حقيقي من createBackupPackage (وليس من كاتب الاختبار) لضمان توافق المحلّل مع مخرجات 10.3.
    const att = { id: crypto.randomUUID(), storage_name: uuidName(), status: 'active' as const };
    const attData = randomBytes(6000);
    fs.writeFileSync(path.join(liveAttDir, att.storage_name), attData);
    const rows: AttachmentRow[] = [{ ...att, sha256_cipher: sha(attData), size_bytes: attData.length }];
    const d = createBackupPackageDeps(rows, []);
    const outDir = path.join(srcDir, 'real');
    const made = await createBackupPackage({ ...d, outputDir: outDir }, PASS, PASS);

    const staged: string[] = [];
    const res = await prepareRestore(mkDeps({
      summary: async () => goodSummary({ attachmentRows: [{ id: att.id, storage_name: att.storage_name, status: 'active', sha256_cipher: sha(attData) }] }),
    }), input(made.filePath));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    const plan = getRestorePlan(res.plan.planId, 'admin-1', NOW);
    assert.equal(sha(fs.readFileSync(plan.staged.databasePath)), sha(fs.readFileSync(liveDb)));
    assert.deepEqual(fs.readFileSync(path.join(plan.staged.attachmentsDir, att.storage_name)), attData);
    staged.push(plan.staged.dir);
    assert.equal(res.plan.report.canProceed, true);
  });

  test('نسخة اختبارية: بايتات القاعدة والمرفقات مطابقة، والخطة والتقرير سليمان', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    const plan = getRestorePlan(res.plan.planId, 'admin-1', NOW);
    assert.deepEqual(fs.readFileSync(plan.staged.databasePath), sourceDb);
    for (const a of sourceAtts) assert.deepEqual(fs.readFileSync(path.join(plan.staged.attachmentsDir, a.name)), a.data);
    assert.equal(res.plan.stagedDatabaseSha256, sha(sourceDb));
    assert.equal(res.plan.expiresAt, NOW + RESTORE_PLAN_TTL_MS);
    assert.equal(res.plan.report.blockers.length, 0);
    assert.equal(res.plan.report.backup.attachmentsCount, 2);
    // checkpoint_last لا يُستعاد أبداً، والباقي معروف.
    assert.ok(!res.plan.report.decisions.secretsToRestore.includes('securecase_audit_checkpoint_last'));
    assert.deepEqual(res.plan.report.decisions.secretsIgnored, ['securecase_audit_checkpoint_last']);
    assert.equal(res.plan.report.decisions.deviceId, 'regenerate-always');
    assert.equal(res.plan.report.secrets.find((s) => s.name === 'db_encryption_key')?.status, 'different');
    assert.equal(res.plan.report.secrets.find((s) => s.name === 'securecase_audit_hmac_key_v1')?.status, 'same');
    assert.ok(res.plan.report.warnings.some((w) => w.code === 'DB_KEY_WILL_CHANGE'));
    assert.ok(res.plan.report.warnings.some((w) => w.code === 'BACKUP_FROM_OTHER_DEVICE'));
  });

  test('نسخة الأمان: ملف PreRestore-* يمرّ التحقق الكامل ويحوي الحالة الحية', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    assert.match(res.plan.safetyBackup.fileName, /^PreRestore-\d{8}-\d{6}-[0-9a-z]{8}\.scdbak$/);
    const plan = getRestorePlan(res.plan.planId, 'admin-1', NOW);
    assert.ok(fs.existsSync(plan.safety.filePath));
    assert.ok(!fs.readdirSync(backupsDir).some((n) => n.startsWith('SecureCaseDesk-')), 'لا يبقى الاسم القديم');
    await verifyBackupFileFully({ crypto: nodeCrypto, fs: nodeFs }, plan.safety.filePath, SAFETY_PASS,
      { backupId: plan.safety.backupId, sizeBytes: plan.safety.sizeBytes, sha256: plan.safety.sha256 });
    // الاستعادة لم تمسّ القاعدة الحية.
    assert.equal(fs.readFileSync(liveDb).length, 9000);
    assert.equal(safetyCalls, 1);
  });

  test('تسجيل التدقيق: أحداث بالترتيب، بلا قيم أسرار ولا كلمات مرور', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    assert.deepEqual(events.map((e) => e.operationType), ['backup_safety_create', 'restore_prepare']);
    const blob = JSON.stringify([events, res]);
    for (const secret of [DB_KEY, GOOD_SECRETS.securecase_audit_hmac_key_v1, GOOD_SECRETS.attachment_master_key_v1, PASS, SAFETY_PASS]) {
      assert.ok(!blob.includes(secret), 'تسرّب قيمة سرية');
    }
  });

  test('خطة جديدة تُلغي السابقة وتنظّف مجلدها', async () => {
    const src = await makeSource();
    const a = await prepareRestore(mkDeps(), input(src));
    const b = await prepareRestore(mkDeps(), input(src));
    assert.equal(a.status, 'ready'); assert.equal(b.status, 'ready');
    if (a.status !== 'ready' || b.status !== 'ready') return;
    assert.throws(() => getRestorePlan(a.plan.planId, 'admin-1', NOW), (e: unknown) => (e as RestorePrepError).code === 'PLAN_NOT_FOUND');
    assert.deepEqual(stagingDirs(), [b.plan.planId]);
  });
});

describe('10.5 — الإخفاق والتنظيف', () => {
  test('كلمة مرور خاطئة: خطأ مصادقة، لا مجلد تجهيز، ولا نسخة أمان', async () => {
    const src = await makeSource();
    await rejectsWith(() => prepareRestore(mkDeps(), input(src, { passphrase: 'كلمة-خاطئة-تماماً-999' })), 'PACKAGE_AUTH_FAILED');
    assert.deepEqual(stagingDirs(), []);
    assert.equal(safetyCalls, 0);
  });

  test('بايت مقلوب في النسخة أو ملف مبتور: يفشل وينظَّف', async () => {
    const src = await makeSource();
    const buf = fs.readFileSync(src);
    const flipped = Buffer.from(buf); flipped[buf.length - 40] ^= 0xff;
    const f1 = path.join(srcDir, 'flip.scdbak'); fs.writeFileSync(f1, flipped);
    const f2 = path.join(srcDir, 'cut.scdbak'); fs.writeFileSync(f2, buf.subarray(0, buf.length - 500));
    for (const f of [f1, f2]) {
      await assert.rejects(() => prepareRestore(mkDeps(), input(f)), (e: unknown) => e instanceof BackupError);
    }
    assert.deepEqual(stagingDirs(), []);
    assert.equal(safetyCalls, 0);
  });

  test('مدخلات غير صالحة: امتداد خاطئ/.partial/كلمة أمان ضعيفة أو غير مطابقة', async () => {
    const src = await makeSource();
    await rejectsWith(() => prepareRestore(mkDeps(), input(path.join(srcDir, 'x.zip'))), 'INVALID_INPUT');
    await rejectsWith(() => prepareRestore(mkDeps(), input(src + '.partial')), 'INVALID_INPUT');
    await rejectsWith(() => prepareRestore(mkDeps(), input(src, { safetyPassphrase: 'قصيرة', safetyPassphraseConfirmation: 'قصيرة' })), 'INVALID_PASSPHRASE');
    await rejectsWith(() => prepareRestore(mkDeps(), input(src, { safetyPassphraseConfirmation: SAFETY_PASS + 'x' })), 'INVALID_PASSPHRASE');
    await rejectsWith(() => prepareRestore(mkDeps(), input(path.join(srcDir, 'missing.scdbak'))), 'SOURCE_NOT_FOUND');
    assert.deepEqual(stagingDirs(), []);
  });

  test('فشل إنشاء نسخة الأمان: لا خطة ولا بقايا، والرمز SAFETY_BACKUP_FAILED', async () => {
    const src = await makeSource();
    await rejectsWith(() => prepareRestore(mkDeps({ createSafetyBackup: async () => { throw new Error('disk full'); } }), input(src)), 'SAFETY_BACKUP_FAILED');
    assert.deepEqual(stagingDirs(), []);
    assert.deepEqual(events, []);
  });

  test('نسخة أمان بصمتها لا تطابق ما كُتب: تُحذف ويُرفض', async () => {
    const src = await makeSource();
    let produced = '';
    const lying = async (p: string, c: string) => { const r = await realSafetyBackup(p, c); produced = r.filePath; return { ...r, sha256: '0'.repeat(64) }; };
    await rejectsWith(() => prepareRestore(mkDeps({ createSafetyBackup: lying }), input(src)), 'SAFETY_BACKUP_FAILED');
    assert.ok(produced && !fs.existsSync(produced), 'الملف غير الموثوق يجب أن يُحذف');
    assert.deepEqual(stagingDirs(), []);
  });

  test('نسخة أمان بها بايتات زائدة بعد النهاية: يرفضها التحقق الكامل', async () => {
    const r = await realSafetyBackup(SAFETY_PASS, SAFETY_PASS);
    fs.appendFileSync(r.filePath, Buffer.from([1, 2, 3]));
    await rejectsWith(() => verifyBackupFileFully({ crypto: nodeCrypto, fs: nodeFs }, r.filePath, SAFETY_PASS,
      { backupId: r.backupId, sizeBytes: r.sizeBytes + 3, sha256: r.sha256 }), 'SAFETY_BACKUP_FAILED');
  });

  test('تزامن: تجهيزان معاً → الثاني RESTORE_IN_PROGRESS والأول يكتمل', async () => {
    const src = await makeSource();
    const first = prepareRestore(mkDeps(), input(src));
    await rejectsWith(() => prepareRestore(mkDeps(), input(src)), 'RESTORE_IN_PROGRESS');
    assert.equal((await first).status, 'ready');
  });
});

describe('10.5 — الموانع (لا تُنشأ نسخة أمان ولا تبقى بقايا)', () => {
  async function blockedWith(over: Parameters<typeof stdRecords>[0], dep: Parameters<typeof mkDeps>[0] = {}) {
    events.length = 0; _resetRestorePlansForTests();
    const src = await makeSource(over);
    const res = await prepareRestore(mkDeps(dep), input(src));
    assert.equal(res.status, 'blocked');
    assert.equal(safetyCalls, 0, 'لا نسخة أمان عند وجود مانع');
    assert.deepEqual(stagingDirs(), []);
    assert.deepEqual(events.map((e) => e.operationType), ['restore_prepare_blocked']);
    return res.status === 'blocked' ? res.report.blockers.map((b) => b.code) : [];
  }

  test('لا مدير نشط في قاعدة النسخة', async () => {
    assert.ok((await blockedWith({}, { summary: async () => goodSummary({ activeAdmins: 0 }) })).includes('NO_ACTIVE_ADMIN'));
  });
  test('مفتاح HMAC لإصدار مسجّل غير موجود', async () => {
    const { securecase_audit_hmac_key_v1: _x, ...rest } = GOOD_SECRETS; void _x;
    assert.ok((await blockedWith({ secrets: rest })).includes('AUDIT_KEY_MISSING'));
  });
  test('إصدار HMAC ثانٍ مسجّل في القاعدة ومفتاحه غائب', async () => {
    assert.ok((await blockedWith({}, { summary: async () => goodSummary({ auditKeyVersions: [1, 2] }) })).includes('AUDIT_KEY_MISSING'));
  });
  test('مفتاح القاعدة غائب', async () => {
    const { db_encryption_key: _x, ...rest } = GOOD_SECRETS; void _x;
    assert.ok((await blockedWith({ secrets: rest })).includes('DB_KEY_MISSING_IN_BACKUP'));
  });
  test('مفتاح قاعدة بصيغة حقن SQL: يُرفض ولا تُستدعى دالة الفحص أصلاً', async () => {
    let inspected = 0;
    const evil = { ...GOOD_SECRETS, db_encryption_key: "x'; DROP TABLE users; --" };
    const codes = await blockedWith({ secrets: evil }, { summary: async () => { inspected++; return goodSummary(); } });
    assert.ok(codes.includes('SECRET_VALUE_INVALID') || codes.includes('DB_KEY_INVALID'));
    assert.equal(inspected, 0);
  });
  test('مفتاح المرفقات غائب مع وجود مرفقات', async () => {
    const { attachment_master_key_v1: _x, ...rest } = GOOD_SECRETS; void _x;
    assert.ok((await blockedWith({ secrets: rest })).includes('ATTACHMENT_KEY_MISSING'));
  });
  test('القاعدة المجهّزة لا تُفتح / سلامتها فاشلة / جداول ناقصة', async () => {
    assert.ok((await blockedWith({}, { summary: async () => { throw new Error('file is not a database'); } })).includes('STAGED_DB_UNREADABLE'));
    assert.ok((await blockedWith({}, { summary: async () => goodSummary({ integrityOk: false }) })).includes('STAGED_DB_INTEGRITY_FAILED'));
    assert.ok((await blockedWith({}, { summary: async () => goodSummary({ tablesPresent: ['users'] }) })).includes('MISSING_TABLES'));
  });
  test('نسخة تحوي سرّ جلسة/API (مستبعداً): مرفوضة', async () => {
    assert.ok((await blockedWith({ secrets: { ...GOOD_SECRETS, securecase_session_uid: 'u-1' } })).includes('EXCLUDED_SECRET_IN_BACKUP'));
  });
});

describe('10.5 — حماية البنية (نسخة خبيثة أو مشوّهة)', () => {
  const mustBeInvalid = async (src: string) => {
    await rejectsWith(() => prepareRestore(mkDeps(), input(src)), 'CONTENT_INVALID');
    assert.deepEqual(stagingDirs(), []);
    assert.equal(safetyCalls, 0);
  };

  test('اسم مرفق باجتياز مسار لا يكتب خارج مجلد التجهيز', async () => {
    const src = await makeSource({ attachmentName: '../../evil.enc' });
    await mustBeInvalid(src);
    assert.ok(!fs.existsSync(path.join(root, 'evil.enc')) && !fs.existsSync(path.join(cacheDir, 'evil.enc')));
  });
  test('بصمة قاعدة في البيان تخالف المفكوكة', async () => {
    await mustBeInvalid(await makeSource({ mutateManifest: (m) => { m.database.sha256 = '0'.repeat(64); } }));
  });
  test('بيان يصف مرفقاً غير الموجود', async () => {
    await mustBeInvalid(await makeSource({ mutateManifest: (m) => { m.attachments.entries[0].sha256 = 'f'.repeat(64); } }));
  });
  test('معرّف نسخة في البيان يخالف الترويسة', async () => {
    await mustBeInvalid(await makeSource({ mutateManifest: (m) => { m.backupId = 'other'; } }));
  });
  test('سجلات البيان لا تطابق ما فُكّ (حذف سجل)', async () => {
    await mustBeInvalid(await makeSource({ mutateManifest: (m) => { m.records.pop(); } }));
  });
  test('ترتيب مخالف: الأسرار قبل القاعدة', async () => {
    const { recs, backupId, createdAt } = stdRecords();
    [recs[0], recs[1]] = [recs[1], recs[0]];
    const f = path.join(srcDir, 'order.scdbak');
    await writePackage(f, PASS, recs, { backupId, createdAt });
    await mustBeInvalid(f);
  });
  test('بلا بيان في النهاية', async () => {
    const { recs, backupId, createdAt } = stdRecords();
    recs.pop();
    const f = path.join(srcDir, 'nomanifest.scdbak');
    await writePackage(f, PASS, recs, { backupId, createdAt });
    await mustBeInvalid(f);
  });
  test('مرفق مكرر الاسم', async () => {
    const dup = [sourceAtts[0], { ...sourceAtts[0], id: crypto.randomUUID() }];
    await mustBeInvalid(await makeSource({ atts: dup }));
  });
  test('أسرار بقيم غير نصية أو بنية غير كائن', async () => {
    await mustBeInvalid(await makeSource({ secrets: { ...GOOD_SECRETS, x: 5 } }));
    await mustBeInvalid(await makeSource({ secrets: ['a'] as unknown as Record<string, unknown> }));
  });
  test('سر غير معروف: يُتجاهل بتحذير ولا يُستعاد', async () => {
    const src = await makeSource({ secrets: { ...GOOD_SECRETS, future_feature_key: 'abc' } });
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    assert.ok(res.plan.report.warnings.some((w) => w.code === 'UNKNOWN_SECRET_IGNORED'));
    assert.ok(!res.plan.report.decisions.secretsToRestore.includes('future_feature_key'));
  });
});

describe('10.5 — التراجع في سلسلة التدقيق', () => {
  test('نسخة أقدم من الحالة الحية: تتطلب قبول التراجع وتُظهر عدد السجلات المفقودة', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    assert.equal(res.plan.requiresRollbackAcceptance, true);
    assert.ok(res.plan.report.audit.entriesLostIfRestored >= 2);
    assert.ok(res.plan.report.warnings.some((w) => w.code === 'AUDIT_ROLLBACK'));
    assert.ok(res.plan.report.warnings.some((w) => w.code === 'CHECKPOINT_ROLLBACK'));
  });
  test('نسخة أحدث من الحالة الحية ولا checkpoint أعلى: لا تراجع', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps({ summary: async () => goodSummary({ auditMaxSeq: 500 }), live: { externalCheckpointSeq: null } }), input(src));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    assert.equal(res.plan.requiresRollbackAcceptance, false);
    assert.equal(res.plan.report.audit.entriesLostIfRestored, 0);
  });
  test('نسخة عمرها فوق 30 يوماً: تحذير BACKUP_OLD فقط', async () => {
    const src = await makeSource({ createdAt: NOW - 45 * 86_400_000 });
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    if (res.status === 'ready') assert.ok(res.plan.report.warnings.some((w) => w.code === 'BACKUP_OLD'));
  });
});

describe('10.5 — دورة حياة الخطة', () => {
  test('خطة مستخدم آخر أو منتهية الصلاحية أو ملغاة', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps(), input(src));
    if (res.status !== 'ready') throw new Error('expected ready');
    const id = res.plan.planId;
    assert.throws(() => getRestorePlan(id, 'someone-else', NOW), (e: unknown) => (e as RestorePrepError).code === 'PLAN_NOT_FOUND');
    assert.throws(() => getRestorePlan(id, 'admin-1', NOW + RESTORE_PLAN_TTL_MS + 1), (e: unknown) => (e as RestorePrepError).code === 'PLAN_EXPIRED');
    await discardRestorePlan({ fs: nodeFs, stagingRoot: cacheDir }, id, 'someone-else');
    assert.ok(getRestorePlan(id, 'admin-1', NOW));
    await discardRestorePlan({ fs: nodeFs, stagingRoot: cacheDir }, id, 'admin-1');
    assert.throws(() => getRestorePlan(id, 'admin-1', NOW), (e: unknown) => (e as RestorePrepError).code === 'PLAN_NOT_FOUND');
    assert.deepEqual(stagingDirs(), []);
  });

  test('الطزاجة: سليمة فور التجهيز، وتفشل إن تغيّرت البيانات الحية', async () => {
    const src = await makeSource();
    const deps = mkDeps();
    const res = await prepareRestore(deps, input(src));
    if (res.status !== 'ready') throw new Error('expected ready');
    const ok = await assertRestorePlanFresh(deps, res.plan.planId, 'admin-1');
    assert.equal(ok.planId, res.plan.planId);
    liveSeq += 1; // عملية جديدة بعد نسخة الأمان
    await rejectsWith(() => assertRestorePlanFresh(deps, res.plan.planId, 'admin-1'), 'SAFETY_BACKUP_STALE');
  });

  test('الطزاجة: العبث بقاعدة التجهيز أو حذف نسخة الأمان يُكشف', async () => {
    const src = await makeSource();
    const deps = mkDeps();
    const res = await prepareRestore(deps, input(src));
    if (res.status !== 'ready') throw new Error('expected ready');
    const plan = getRestorePlan(res.plan.planId, 'admin-1', NOW);
    const bytes = fs.readFileSync(plan.staged.databasePath); bytes[10] ^= 1;
    fs.writeFileSync(plan.staged.databasePath, bytes);
    await rejectsWith(() => assertRestorePlanFresh(deps, res.plan.planId, 'admin-1'), 'STAGING_TAMPERED');
    fs.writeFileSync(plan.staged.databasePath, sourceDb);
    fs.rmSync(plan.safety.filePath);
    await rejectsWith(() => assertRestorePlanFresh(deps, res.plan.planId, 'admin-1'), 'STAGING_TAMPERED');
  });

  test('تنظيف البقايا: يحذف المجلدات اليتيمة ويستثني الخطط النشطة', async () => {
    const orphan = path.join(cacheDir, 'restore-staging', 'orphan-plan-1');
    fs.mkdirSync(orphan, { recursive: true }); fs.writeFileSync(path.join(orphan, 'database.restore'), 'x');
    const keep = path.join(cacheDir, 'restore-staging', 'keep-plan-22');
    fs.mkdirSync(keep, { recursive: true });
    const n = await cleanupStaleRestoreStaging({ fs: nodeFs, stagingRoot: cacheDir, now: () => NOW }, ['keep-plan-22']);
    assert.equal(n, 1);
    assert.ok(!fs.existsSync(orphan) && fs.existsSync(keep));
  });

  test('hashFile: يطابق sha256 الحقيقي لملف أكبر من قطعة القراءة', async () => {
    const f = path.join(root, 'big.bin'); const data = randomBytes(700_000); fs.writeFileSync(f, data);
    assert.equal(await hashFile(nodeCrypto, nodeFs, f), sha(data));
  });
});
''',
    'docs/phase10/10.5-restore-preparation.md': r'''<!-- SECURECASEDESK_PHASE10_S5 -->
# المرحلة 10 / القسم 10.5 — تجهيز الاستعادة وإنشاء نسخة الأمان

> نطاق هذا القسم: فك النسخة في مجلد مؤقت والتحقق منها وبناء تقرير الأثر وإنشاء نسخة أمان للحالة الحالية. **لا يستبدل أي بيانات حية** (الاستبدال في 10.6).

## التدفق (`prepareRestoreFromBackup`)
1. فحص الصلاحية `backup.manage` (الجلسة ثم الدور من الجدول) + فحص كلمة مرور نسخة الأمان (≥12، ≥4 مختلفة، تأكيد مطابق) **قبل لمس أي شيء**.
2. فك `.scdbak` إلى `<cache>/restore-staging/<planId>/`: `database.restore` + `attachments/<uuid>.enc`. الأسرار تبقى **في الذاكرة فقط**.
3. تحقق مستقل: الترتيب (قاعدة ← أسرار ← مرفقات ← بيان)، لا تكرار، أسماء المرفقات مطابقة للنمط (يمنع اجتياز المسار)، البيان يطابق ما فُكّ فعلاً (بصمات، أحجام، معرّف، سجلات)، وأحجام الملفات على القرص.
4. فحص نسخة من القاعدة المجهّزة بمفتاحها (`PRAGMA key` + `integrity_check`) وبناء التقرير. الملف المجهّز نفسه لا يُفتح فتبقى بصمته ثابتة.
5. عند وجود **مانع**: تسجيل `restore_prepare_blocked`، حذف المجهّز، إرجاع `status: 'blocked'` — **ولا تُنشأ نسخة أمان**.
6. وإلا: نسخة أمان مشفّرة للحالة الحية ← تحقق كامل بقراءتها (مصادقة كل الإطارات + بصمات السجلات + بصمة الملف + لا بايتات زائدة) ← إعادة تسميتها `PreRestore-*.scdbak` (في `<document>/backups`).
7. تسجيل `backup_safety_create` و`restore_prepare` (غير صارم)، تثبيت رقم آخر سجل تدقيق حي، وتسجيل الخطة في الذاكرة بصلاحية **15 دقيقة** لصاحبها فقط. خطة واحدة نشطة: الجديدة تُلغي السابقة.

## القرارات المحسومة من 10.1 (تُنفَّذ في 10.6)
| البند | القرار | السبب |
|---|---|---|
| `securecase_audit_checkpoint_last` | **لا يُستعاد أبداً** | شاهد الجهاز على آخر حالة للسلسلة. نسخة أقدم منه = تراجع يتطلب قبولاً صريحاً يُسجَّل، ثم `writeCheckpoint({allowLower:true, force:true})` داخل `withCheckpointGuardSuspended` (موجودان من المرحلة 8) |
| `audit_sync_state.device_id` | **يُعاد توليده دائماً** | منع استنساخ هوية الجهاز وتفرّع السلسلة قبل المرحلة 13 |
| الجلسة | تُبطل بعد الاستعادة | أسرار الجلسة وAPI لا تدخل النسخة أصلاً؛ وجودها في نسخة = مانع |
| أسرار الجهاز غير الموجودة في النسخة | لا تُحذف | مثل إصدار HMAC أحدث؛ الاستعادة تضيف/تستبدل فقط |
| أسرار غير معروفة في النسخة | تُتجاهل مع تحذير | قد تكون من إصدار أحدث |

## الموانع (تمنع التجهيز)
`EXCLUDED_SECRET_IN_BACKUP`, `DB_KEY_MISSING_IN_BACKUP`, `SECRET_VALUE_INVALID` (مفتاح القاعدة يجب أن يكون UUID — يمنع حقن SQL في `PRAGMA key`), `AUDIT_ACTIVE_VERSION_MISSING`, `AUDIT_KEY_MISSING` (لكل إصدار مسجّل), `ATTACHMENT_KEY_MISSING`, `STAGED_DB_UNREADABLE`, `STAGED_DB_NOT_ENCRYPTED`, `STAGED_DB_INTEGRITY_FAILED`, `MISSING_TABLES`, **`NO_ACTIVE_ADMIN`** (استعادة قاعدة بلا مدير نشط تقفل النظام).

## التحذيرات (لا تمنع ولا تُخفى)
`AUDIT_ROLLBACK`, `CHECKPOINT_ROLLBACK`, `BACKUP_OLD` (>30 يوماً), `DB_KEY_WILL_CHANGE`, `BACKUP_FROM_OTHER_DEVICE`, `ATTACHMENT_FILES_MISSING_IN_BACKUP`, `ATTACHMENT_HASH_MISMATCH`, `CHECKPOINT_KEY_MISSING`, `UNKNOWN_SECRET_IGNORED`.
التقارير تحمل **أسماء الأسرار وحالتها (new/same/different) فقط، لا قيمها**.

## الملفات
| الملف | الغرض |
|---|---|
| `src/modules/backup/backup-restore-prep.ts` | المنطق الصرف بالحقن الكامل (قابل للاختبار في Node) |
| `src/modules/backup/backup-restore-prep-runtime.ts` | محوّل Expo: `prepareRestoreFromBackup`, `getPreparedRestore`, `assertPreparedRestoreFresh`, `discardPreparedRestore`, `cleanupRestoreStagingOnStartup` |
| `tests/backup-restore-prep.test.ts` | 38 اختباراً بملفات وتشفير حقيقيين |

## ما تستهلكه 10.6
`assertPreparedRestoreFresh(session, planId)` مباشرة قبل الاستبدال. تفشل بـ `SAFETY_BACKUP_STALE` إن تغيّر أي سجل تدقيق حي بعد نسخة الأمان، وبـ `STAGING_TAMPERED` إن تغيرت بصمة القاعدة المجهّزة أو أحجام المرفقات أو فُقدت نسخة الأمان. تعيد الخطة الكاملة (المجلد المجهّز + الأسرار في الذاكرة + مسار نسخة الأمان).

## ما اختُبر فعلاً (Node)
نسخة 10.3 حقيقية بنفس البايتات، كلمة خاطئة، قلب بايت، بتر، اجتياز مسار، بيان مخالف (بصمة/مرفق/معرّف/سجل محذوف)، ترتيب مخالف، بلا بيان، مرفق مكرر، أسرار مشوهة، مفتاح بصيغة حقن SQL (لا تُستدعى دالة الفحص أصلاً)، كل الموانع، نسخة أمان كاذبة البصمة (تُحذف)، بايتات زائدة، تزامن، التراجع، دورة حياة الخطة (مستخدم آخر/انتهاء/إلغاء/طزاجة/عبث)، وتنظيف البقايا.

## لم يُختبر بعد (معلّق — يحتاج Android حقيقي)
- `expo-sqlite`: `openDatabaseAsync(name, {useNewConnection:true}, dir)` + `PRAGMA key` + `integrity_check` على نسخة SQLCipher حقيقية (الأسماء موافقة لتوثيق SDK 58 لكن لم تُشغَّل).
- `expo-file-system` (`File.copy/move`, `Directory.list`, المقابض) و`@noble/*` على الجهاز، وزمن scrypt للنسخة الكبيرة.
- مسار الاختيار: محدد الملفات يجب أن يعيد `file://` (`copyToCacheDirectory: true`)؛ روابط `content://` لا تقرؤها واجهة الملفات مباشرة.
- لا واجهة مستخدم بعد (تُبنى مع 10.6 مع شاشة التأكيد).

## حدود معروفة
- الخطة في الذاكرة فقط: إغلاق التطبيق يُبطلها ويُحذف المجلد المجهّز عند الإقلاع التالي (`cleanupRestoreStagingOnStartup` يجب استدعاؤها مرة عند البدء).
- الأسرار نصوص JS لا يمكن مسحها من الذاكرة بالتأكيد (تُمسح المخازن الثنائية فقط).
- التجهيز يحتاج مساحة تقارب حجم النسخة مرتين (المجهّز + نسخة الفحص) ومثلها للأمان؛ لا فحص مسبق للمساحة (فشل القرص الممتلئ يُنظَّف ويُبلَّغ).
- استعادة على جهاز بلا أي مستخدم (تثبيت جديد) غير مغطاة هنا: التجهيز يتطلب جلسة مدير؛ يُحسم في 10.6.
- تحميل نسخة من مصدر غير موثوق يتطلب كلمة مرورها؛ لكن من يملكها قد يصنع نسخة صالحة البنية بمحتوى مختلف — لذلك تُعرض أعداد السجلات وتُطلب قبول صريح قبل الاستبدال.
''',
}

for path, content in FILES.items():
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            old = f.read()
        if MARK not in old:
            sys.exit('❌ تعارض: الملف موجود وليس من هذا القسم، لن أكتب فوقه: ' + path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print('✅ كُتب:', path)

with open('package.json', encoding='utf-8') as f:
    pkg = json.load(f)
pkg.setdefault('scripts', {})['test:backup-restore-prep'] = (
    'tsx --tsconfig tests/tsconfig.json --test tests/backup-restore-prep.test.ts')
with open('package.json', 'w', encoding='utf-8') as f:
    json.dump(pkg, f, ensure_ascii=False, indent=2)
    f.write('\n')
print('✅ package.json: أُضيف test:backup-restore-prep')
PYEOF

echo
echo "── اختبارات 10.5 ──"
npm run test:backup-restore-prep 2>&1 | grep -E "^# (tests|pass|fail)|not ok" || true

echo
echo "── اختبارات الأقسام السابقة (يجب ألا تتأثر) ──"
for t in backup-foundation backup-snapshot backup-package; do
  printf "%s: " "$t"; npm run "test:$t" 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' '; echo
done

if [ "${SKIP_TSC:-0}" != "1" ]; then
  echo
  echo "── فحص الأنواع: npx tsc --noEmit ──"
  if npx tsc --noEmit; then echo "✅ tsc نظيف"; else echo "⚠️ أخطاء tsc أعلاه — أرسلها لي كما هي"; fi
fi
echo
echo "تم القسم 10.5. التوثيق: docs/phase10/10.5-restore-preparation.md"
