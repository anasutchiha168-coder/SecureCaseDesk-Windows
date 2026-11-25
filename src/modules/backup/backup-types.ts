// SECURECASEDESK_PHASE10_S1
// أنواع وثوابت نظام النسخ الاحتياطي. لا اعتماد على Expo هنا كي يمكن اختبارها في Node.
// القسم 10.1 بنية فقط: لا ينشئ نسخاً ولا يستعيدها.

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_FILE_EXTENSION = 'scdbak';
export const BACKUP_FILE_MAGIC = 'SCDBAK';

// اسم ملف قاعدة البيانات كما يفتحه db.ts عبر expo-sqlite.
export const DATABASE_FILE_NAME = 'securecase.db';
// مجلد المرفقات المشفرة داخل Paths.document (انظر attachments-storage.ts).
export const ATTACHMENTS_DIR_NAME = 'attachments';
export const ATTACHMENT_STORAGE_NAME = /^[0-9a-f-]{36}\.enc$/;
export const ATTACHMENT_TMP_SUFFIX = '.tmp';

// كلمة مرور تشفير النسخة (تُستخدم في 10.3).
export const MIN_BACKUP_PASSPHRASE_LENGTH = 12;

export const BACKUP_PERMISSION = 'backup.manage' as const;

// ===== الجداول =====

// جداول يجب أن تكون موجودة في أي قاعدة سليمة بعد initDatabase().
export const REQUIRED_TABLES = [
  'users', 'departments', 'cases',
  'memo_types', 'memos',
  'detainee_categories', 'detainees', 'detainee_movements', 'correction_history',
  'attachments',
  'audit_logs', 'audit_event_queue', 'audit_context',
  'audit_key_registry', 'audit_checkpoints', 'audit_integrity_alerts',
] as const;

// جداول تُنشأ عند الحاجة فقط (audit-outbox.ts). تُجرد إن وُجدت ولا يُعدّ غيابها خللاً.
export const OPTIONAL_TABLES = ['audit_sync_outbox', 'audit_sync_state', 'persons', 'crime_classifications'] as const;

// ===== أسرار SecureStore =====
// لا تُحفظ القيم في أي تقرير: الاسم والوجود فقط.

export type SecretClass =
  | 'required'     // بدونه تصبح النسخة غير قابلة للاستعمال → يمنع النسخ
  | 'recommended'  // غيابه يُسجَّل كتحذير
  | 'review'       // يُحسم في 10.5 بعد مراجعة منطق المستهلك
  | 'excluded';    // لا يدخل النسخة أبداً

export interface SecretSpec {
  name: string;
  cls: SecretClass;
  reason: string;
}

export const SECRET_NAMES = {
  dbKey: 'db_encryption_key',
  attachmentMasterKey: 'attachment_master_key_v1',
  auditActiveVersion: 'securecase_audit_active_version',
  auditCheckpointKey: 'securecase_audit_checkpoint_key_v1',
  auditCheckpointLast: 'securecase_audit_checkpoint_last',
  sessionUser: 'securecase_session_uid',
  apiUrl: 'securecase_api_url',
  apiToken: 'securecase_api_token',
  aiSettings: 'securecase_ai_settings_v1', // SECURECASEDESK_PHASE11_S1
  aiCloudKey: 'securecase_ai_cloud_key_v1',
} as const;

export function auditHmacKeyName(version: number): string {
  return 'securecase_audit_hmac_key_v' + version;
}

// ===== تقرير الجرد =====

export interface TableInventory {
  name: string;
  exists: boolean;
  rowCount: number;
}

export interface DatabaseFileInfo {
  exists: boolean;
  sizeBytes: number;
  walBytes: number;
}

export interface AttachmentInventory {
  activeRows: number;
  deletedRows: number;
  filesOnDisk: number;            // ملفات .enc بأسماء صحيحة
  missingFiles: string[];         // معرّفات مرفقات نشطة لا ملف لها
  orphanFiles: string[];          // ملفات بلا صف في الجدول
  deletedRowFiles: number;        // ملفات ما زالت موجودة لصفوف محذوفة منطقياً
  tmpFiles: string[];             // بقايا كتابة منقطعة
  unexpectedFiles: string[];      // أسماء لا تطابق نمط التخزين
}

export interface SecretInventory extends SecretSpec {
  present: boolean;
}

export type BlockerCode =
  | 'DATABASE_FILE_MISSING'
  | 'MISSING_TABLE'
  | 'DB_KEY_MISSING'
  | 'AUDIT_KEY_MISSING'
  | 'AUDIT_ACTIVE_VERSION_MISSING'
  | 'ATTACHMENT_KEY_MISSING';

export type WarningCode =
  | 'ATTACHMENT_FILES_MISSING'
  | 'ORPHAN_ATTACHMENT_FILES'
  | 'TMP_ATTACHMENT_FILES'
  | 'UNEXPECTED_FILES'
  | 'CHECKPOINT_KEY_MISSING'
  | 'WAL_PENDING';

export interface ReadinessIssue<C extends string> {
  code: C;
  message: string;      // عربي، قابل للعرض
  items?: string[];     // أسماء أو معرّفات متأثرة (لا قيم أسرار)
}

export interface BackupInventory {
  generatedAt: number;
  databaseFile: DatabaseFileInfo;
  tables: TableInventory[];
  optionalTables: TableInventory[];
  auditKeyVersions: number[];
  attachments: AttachmentInventory;
  secrets: SecretInventory[];
  blockers: ReadinessIssue<BlockerCode>[];
  warnings: ReadinessIssue<WarningCode>[];
  ready: boolean;
}

// ===== الأخطاء =====

export type BackupErrorCode =
  | 'NOT_READY' | 'INVENTORY_FAILED'
  // SECURECASEDESK_PHASE10_S2
  | 'SNAPSHOT_IN_PROGRESS' | 'CHECKPOINT_FAILED' | 'SNAPSHOT_UNSTABLE' | 'SNAPSHOT_FAILED'
  // SECURECASEDESK_PHASE10_S3
  | 'INVALID_PASSPHRASE' | 'BACKUP_IN_PROGRESS' | 'ATTACHMENTS_CHANGED' | 'PACKAGE_FAILED'
  | 'PACKAGE_FORMAT_INVALID' | 'PACKAGE_AUTH_FAILED'
  // SECURECASEDESK_PHASE10_S6
  | 'RESTORE_NOT_CONFIRMED' | 'RESTORE_IN_PROGRESS' | 'RESTORE_PENDING_RECOVERY' | 'RESTORE_PACKAGE_INVALID'
  | 'RESTORE_SECRETS_INCOMPLETE' | 'RESTORE_DATABASE_INVALID' | 'RESTORE_FAILED'
  | 'RESTORE_ROLLED_BACK' | 'RESTORE_ROLLBACK_FAILED';

export const BACKUP_ERROR_MESSAGES: Record<BackupErrorCode, string> = {
  NOT_READY: 'النظام غير جاهز لإنشاء نسخة احتياطية. راجع تقرير الجاهزية.',
  INVENTORY_FAILED: 'تعذر فحص مصادر النسخ الاحتياطي.',
  SNAPSHOT_IN_PROGRESS: 'عملية نسخ أخرى لقاعدة البيانات قيد التنفيذ.',
  CHECKPOINT_FAILED: 'تعذر دمج سجل الكتابة (WAL) قبل النسخ. أعد المحاولة بعد انتهاء العمليات الجارية.',
  SNAPSHOT_UNSTABLE: 'تغيّرت قاعدة البيانات أثناء النسخ ولم يُحصل على نسخة متسقة. أعد المحاولة.',
  SNAPSHOT_FAILED: 'فشل إنشاء نسخة قاعدة البيانات. لم تُمسّ البيانات الأصلية.',
  // SECURECASEDESK_PHASE10_S3
  INVALID_PASSPHRASE: 'كلمة مرور النسخة غير مقبولة: 12 حرفاً على الأقل، 4 أحرف مختلفة على الأقل، ويجب أن يتطابق التأكيد.',
  BACKUP_IN_PROGRESS: 'عملية إنشاء نسخة احتياطية أخرى قيد التنفيذ.',
  ATTACHMENTS_CHANGED: 'تغيّرت المرفقات أثناء النسخ ولم يُحصل على نسخة متسقة. أعد المحاولة بعد انتهاء عمليات المرفقات.',
  PACKAGE_FAILED: 'فشل إنشاء ملف النسخة الاحتياطية. لم تُمسّ البيانات الأصلية ولم يُترك ملف ناقص.',
  PACKAGE_FORMAT_INVALID: 'ملف النسخة الاحتياطية تالف أو بصيغة غير مدعومة.',
  PACKAGE_AUTH_FAILED: 'كلمة المرور غير صحيحة أو أن ملف النسخة تالف أو معدَّل.',
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
export const RESTORE_STASH_PREFIX = 'restore_safety_';

// ===== القسم 10.2: لقطة قاعدة البيانات =====
export const SNAPSHOT_STAGING_DIR_NAME = 'backup-staging';
export const SNAPSHOT_DB_FILE_NAME = 'database.snapshot';
export const SNAPSHOT_MANIFEST_FILE_NAME = 'snapshot.json';
export const SNAPSHOT_PARTIAL_SUFFIX = '.partial';
export const SNAPSHOT_MAX_ATTEMPTS = 3;

export interface SnapshotManifest {
  formatVersion: number;       // BACKUP_FORMAT_VERSION
  kind: 'database-snapshot';
  snapshotId: string;
  createdAt: number;
  databaseFileName: string;    // DATABASE_FILE_NAME وقت النسخ
  sizeBytes: number;
  sha256: string;              // SHA-256 لملف اللقطة (مشفّر SQLCipher أصلاً)
  journalMode: string;
  cipherVersion: string;
}

export interface DatabaseSnapshot {
  snapshotId: string;
  directory: string;
  databasePath: string;
  manifestPath: string;
  manifest: SnapshotManifest;
  attempts: number;
}

export class BackupError extends Error {
  constructor(public readonly code: BackupErrorCode) {
    super(BACKUP_ERROR_MESSAGES[code]);
    this.name = 'BackupError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ===== القسم 10.3: ملف النسخة النهائي (قاعدة + مرفقات + أسرار، مشفّر بكلمة مرور) =====
export const BACKUP_OUTPUT_DIR_NAME = 'backups';
export const BACKUP_PARTIAL_SUFFIX = '.partial';
