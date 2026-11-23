// SECURECASEDESK_PHASE10_S1
// جرد مصادر النسخ الاحتياطي وتقييم الجاهزية. للقراءة فقط: لا كتابة ولا حذف ولا تعديل.
// بالحقن الكامل للاعتماديات ليعمل في التطبيق وفي اختبارات Node بالشيفرة نفسها.

import {
  ATTACHMENT_STORAGE_NAME, ATTACHMENT_TMP_SUFFIX, OPTIONAL_TABLES, REQUIRED_TABLES, SECRET_NAMES,
  auditHmacKeyName,
  type AttachmentInventory, type BackupInventory, type BlockerCode, type DatabaseFileInfo,
  type ReadinessIssue, type SecretInventory, type SecretSpec, type TableInventory, type WarningCode,
} from './backup-types';

// واجهة قراءة فقط (متوافقة مع expo-sqlite و NodeDb في الاختبارات). لا معاملات: كل الاستعلامات ثابتة.
export interface InventoryDb {
  getFirstAsync<T>(sql: string): Promise<T | null>;
  getAllAsync<T>(sql: string): Promise<T[]>;
}

export interface InventoryDeps {
  db: InventoryDb;
  // أسماء الملفات في مجلد المرفقات دون أي تعديل (لا حذف لبقايا .tmp).
  listAttachmentFiles(): Promise<string[]>;
  getDatabaseFile(): Promise<DatabaseFileInfo>;
  // وجود السر فقط؛ لا تُعاد القيمة ولا تُسجَّل.
  hasSecret(name: string): Promise<boolean>;
  now(): number;
}

// يحدد الأسرار المطلوبة بحسب حالة القاعدة (إصدارات مفاتيح التدقيق، وجود مرفقات).
export function buildSecretSpecs(auditVersions: number[], hasAttachmentRows: boolean): SecretSpec[] {
  const specs: SecretSpec[] = [
    { name: SECRET_NAMES.dbKey, cls: 'required',
      reason: 'مفتاح SQLCipher: بدونه لا تُفتح القاعدة المستعادة.' },
    { name: SECRET_NAMES.auditActiveVersion, cls: 'required',
      reason: 'إصدار مفتاح HMAC النشط: يمنع التراجع بالإصدار بعد الاستعادة.' },
    { name: SECRET_NAMES.attachmentMasterKey, cls: hasAttachmentRows ? 'required' : 'recommended',
      reason: 'المفتاح الرئيسي لتشفير المرفقات: بدونه لا تُفك المرفقات المستعادة.' },
    { name: SECRET_NAMES.auditCheckpointKey, cls: 'recommended',
      reason: 'مفتاح نقاط التحقق للتدقيق.' },
    { name: SECRET_NAMES.auditCheckpointLast, cls: 'review',
      reason: 'آخر نقطة تحقق محلية: يُحسم تضمينها في 10.5 بعد مراجعة audit-integrity-guard.' },
    { name: SECRET_NAMES.sessionUser, cls: 'excluded',
      reason: 'جلسة المستخدم الحالية: لا تُنقل بين الأجهزة أو الحالات.' },
    { name: SECRET_NAMES.apiUrl, cls: 'excluded',
      reason: 'إعداد مزامنة خاص بالجهاز.' },
    { name: SECRET_NAMES.aiSettings, cls: 'excluded',
      reason: 'إعداد الذكاء الاصطناعي خاص بالجهاز: يعود معطّلاً بعد الاستعادة.' },
    { name: SECRET_NAMES.aiCloudKey, cls: 'excluded',
      reason: 'مفتاح خدمة الذكاء الاصطناعي السحابية: سرّ لا يدخل أي نسخة احتياطية.' },
    { name: SECRET_NAMES.apiToken, cls: 'excluded',
      reason: 'رمز وصول للخادم: لا يدخل أي نسخة احتياطية.' },
  ];
  for (const v of auditVersions) {
    specs.push({
      name: auditHmacKeyName(v), cls: 'required',
      reason: 'مفتاح HMAC لإصدار ' + v + ': بدونه تفشل مطابقة سلسلة التدقيق بعد الاستعادة.',
    });
  }
  return specs;
}

async function tableInfo(db: InventoryDb, name: string, existing: Set<string>): Promise<TableInventory> {
  if (!existing.has(name)) return { name, exists: false, rowCount: 0 };
  // الاسم من قائمة ثابتة داخل الشيفرة (لا مدخلات خارجية).
  const row = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM "' + name + '"');
  return { name, exists: true, rowCount: Number(row?.count ?? 0) };
}

export function analyzeAttachmentFiles(
  rows: { id: string; storage_name: string; status: string }[],
  files: string[]
): AttachmentInventory {
  const tmpFiles = files.filter((f) => f.endsWith(ATTACHMENT_TMP_SUFFIX)).sort();
  const blobs = files.filter((f) => ATTACHMENT_STORAGE_NAME.test(f));
  const unexpectedFiles = files
    .filter((f) => !f.endsWith(ATTACHMENT_TMP_SUFFIX) && !ATTACHMENT_STORAGE_NAME.test(f))
    .sort();

  const onDisk = new Set(blobs);
  const rowByName = new Map(rows.map((r) => [r.storage_name, r]));
  const active = rows.filter((r) => r.status === 'active');
  const deleted = rows.filter((r) => r.status === 'deleted');

  return {
    activeRows: active.length,
    deletedRows: deleted.length,
    filesOnDisk: blobs.length,
    missingFiles: active.filter((r) => !onDisk.has(r.storage_name)).map((r) => r.id).sort(),
    orphanFiles: blobs.filter((n) => !rowByName.has(n)).sort(),
    deletedRowFiles: blobs.filter((n) => rowByName.get(n)?.status === 'deleted').length,
    tmpFiles,
    unexpectedFiles,
  };
}

export async function collectBackupInventory(deps: InventoryDeps): Promise<BackupInventory> {
  const { db } = deps;

  const master = await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
  const existing = new Set(master.map((r) => r.name));

  const tables: TableInventory[] = [];
  for (const name of REQUIRED_TABLES) tables.push(await tableInfo(db, name, existing));
  const optionalTables: TableInventory[] = [];
  for (const name of OPTIONAL_TABLES) optionalTables.push(await tableInfo(db, name, existing));

  // إصدارات مفاتيح HMAC: من سجل المفاتيح، مع إصدار 1 إلزامي إن وُجدت سجلات تدقيق.
  let auditKeyVersions: number[] = [];
  if (existing.has('audit_key_registry')) {
    const rows = await db.getAllAsync<{ version: number }>('SELECT version FROM audit_key_registry ORDER BY version');
    auditKeyVersions = rows.map((r) => Number(r.version)).filter((v) => Number.isInteger(v) && v > 0);
  }
  const auditRows = tables.find((t) => t.name === 'audit_logs')?.rowCount ?? 0;
  if (auditRows > 0 && !auditKeyVersions.includes(1)) auditKeyVersions = [1, ...auditKeyVersions];

  let attachmentRows: { id: string; storage_name: string; status: string }[] = [];
  if (existing.has('attachments')) {
    attachmentRows = await db.getAllAsync<{ id: string; storage_name: string; status: string }>(
      'SELECT id, storage_name, status FROM attachments'
    );
  }
  const attachments = analyzeAttachmentFiles(attachmentRows, await deps.listAttachmentFiles());

  const specs = buildSecretSpecs(auditKeyVersions, attachmentRows.length > 0);
  const secrets: SecretInventory[] = [];
  for (const s of specs) secrets.push({ ...s, present: await deps.hasSecret(s.name) });

  const databaseFile = await deps.getDatabaseFile();

  const blockers: ReadinessIssue<BlockerCode>[] = [];
  const warnings: ReadinessIssue<WarningCode>[] = [];

  if (!databaseFile.exists) {
    blockers.push({ code: 'DATABASE_FILE_MISSING', message: 'ملف قاعدة البيانات غير موجود.' });
  }

  const missingTables = tables.filter((t) => !t.exists).map((t) => t.name);
  if (missingTables.length > 0) {
    blockers.push({
      code: 'MISSING_TABLE', message: 'جداول أساسية مفقودة من قاعدة البيانات.', items: missingTables,
    });
  }

  const missing = (name: string) => secrets.find((s) => s.name === name && !s.present);
  if (missing(SECRET_NAMES.dbKey)) {
    blockers.push({ code: 'DB_KEY_MISSING', message: 'مفتاح تشفير قاعدة البيانات غير متوفر على الجهاز.' });
  }
  if (missing(SECRET_NAMES.auditActiveVersion)) {
    blockers.push({ code: 'AUDIT_ACTIVE_VERSION_MISSING', message: 'إصدار مفتاح التدقيق النشط غير متوفر.' });
  }
  const missingAuditKeys = auditKeyVersions
    .map(auditHmacKeyName).filter((n) => missing(n));
  if (missingAuditKeys.length > 0) {
    blockers.push({
      code: 'AUDIT_KEY_MISSING', message: 'مفاتيح HMAC لسجل التدقيق ناقصة.', items: missingAuditKeys,
    });
  }
  if (attachmentRows.length > 0 && missing(SECRET_NAMES.attachmentMasterKey)) {
    blockers.push({
      code: 'ATTACHMENT_KEY_MISSING',
      message: 'يوجد مرفقات مشفرة لكن مفتاحها الرئيسي غير متوفر.',
    });
  }

  if (attachments.missingFiles.length > 0) {
    warnings.push({
      code: 'ATTACHMENT_FILES_MISSING',
      message: 'مرفقات نشطة بلا ملفات على الجهاز. ستُنسخ الحالة كما هي دون إخفاء النقص.',
      items: attachments.missingFiles,
    });
  }
  if (attachments.orphanFiles.length > 0) {
    warnings.push({
      code: 'ORPHAN_ATTACHMENT_FILES', message: 'ملفات مرفقات بلا سجل في القاعدة.',
      items: attachments.orphanFiles,
    });
  }
  if (attachments.tmpFiles.length > 0) {
    warnings.push({
      code: 'TMP_ATTACHMENT_FILES', message: 'بقايا كتابة منقطعة في مجلد المرفقات.',
      items: attachments.tmpFiles,
    });
  }
  if (attachments.unexpectedFiles.length > 0) {
    warnings.push({
      code: 'UNEXPECTED_FILES', message: 'ملفات بأسماء غير متوقعة في مجلد المرفقات.',
      items: attachments.unexpectedFiles,
    });
  }
  if (missing(SECRET_NAMES.auditCheckpointKey)) {
    warnings.push({ code: 'CHECKPOINT_KEY_MISSING', message: 'مفتاح نقاط التحقق للتدقيق غير موجود.' });
  }
  if (databaseFile.walBytes > 0) {
    warnings.push({
      code: 'WAL_PENDING',
      message: 'يوجد ملف WAL غير مدمج؛ يجب دمجه (checkpoint) قبل نسخ ملف القاعدة في 10.2.',
    });
  }

  return {
    generatedAt: deps.now(),
    databaseFile, tables, optionalTables, auditKeyVersions, attachments, secrets,
    blockers, warnings, ready: blockers.length === 0,
  };
}
