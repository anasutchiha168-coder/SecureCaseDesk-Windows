// SECURECASEDESK_PHASE16_STAGE_B
// جاهزية المزامنة المستقبلية (القسم 16.2). لا خادم ولا اتصال شبكي هنا، ولا يدّعي شيئاً عن المزامنة.
// الجداول الأصلية لا تُعدَّل (حتى لا تتأثر مشغلات التدقيق والنسخ الاحتياطي)؛ البيانات الوصفية في جدول جانبي:
//   sync_record_meta : رقم إصدار السجل، آخر مستخدم عدّل، وقت التعديل، الأرشفة الناعمة.
//   sync_operations  : طابور عمليات محلي دائم (UUID للعملية، مفتاح idempotency، حالة، إعادة محاولة، بيانات التعارض).
// الطابور يخزّن مرجع السجل فقط (لا نسخة من محتواه)؛ المحتوى يُقرأ من السجل عند الإرسال في المرحلة 13.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SyncDb {
  execAsync(sql: string): Promise<void>;
  getAllAsync<T>(sql: string, params?: any): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: any): Promise<T | null>;
  runAsync(sql: string, params?: any): Promise<unknown>;
}

// جداول قابلة للمزامنة. mutable = تُعدَّل (create/update)، وإلا للإلحاق فقط (create).
export const SYNCABLE_TABLES: readonly { table: string; mutable: boolean }[] = [
  { table: 'departments', mutable: true },
  { table: 'cases', mutable: true },
  { table: 'memos', mutable: true },
  { table: 'persons', mutable: true },
  { table: 'detainees', mutable: true },
  { table: 'detainee_movements', mutable: false },
  { table: 'correction_history', mutable: false },
  { table: 'case_history', mutable: false },
  { table: 'attachments', mutable: true },
];

export const SYNC_OP_STATUSES = ['pending', 'in_flight', 'acknowledged', 'failed', 'conflict'] as const;
export type SyncOpStatus = (typeof SYNC_OP_STATUSES)[number];

const UUID_V4 = `lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))`;
const NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
const ACTOR = `COALESCE((SELECT actor_user_id FROM audit_context WHERE id = 1), 'SYSTEM')`;

function metaUpsert(table: string): string {
  return `INSERT INTO sync_record_meta (entity, record_id, row_version, last_modified_by, updated_at)
    VALUES ('${table}', NEW.id, 1, ${ACTOR}, ${NOW_MS})
    ON CONFLICT(entity, record_id) DO UPDATE SET
      row_version = row_version + 1, last_modified_by = excluded.last_modified_by, updated_at = excluded.updated_at;`;
}

function enqueue(table: string, opType: 'create' | 'update'): string {
  return `INSERT INTO sync_operations (operation_id, idempotency_key, entity, record_id, op_type, base_version, status, created_by, created_at)
    SELECT ${UUID_V4}, m.entity || ':' || m.record_id || ':' || m.row_version, m.entity, m.record_id, '${opType}',
      m.row_version - 1, 'pending', m.last_modified_by, m.updated_at
    FROM sync_record_meta m WHERE m.entity = '${table}' AND m.record_id = NEW.id;`;
}

export async function initSyncSchema(db: SyncDb): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS sync_record_meta (
      entity TEXT NOT NULL,
      record_id TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
      last_modified_by TEXT,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      archived_by TEXT,
      PRIMARY KEY (entity, record_id)
    );
    CREATE TABLE IF NOT EXISTS sync_operations (
      operation_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      entity TEXT NOT NULL,
      record_id TEXT NOT NULL,
      op_type TEXT NOT NULL CHECK (op_type IN ('create','update','archive')),
      base_version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','acknowledged','failed','conflict')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      next_retry_at INTEGER,
      last_error TEXT,
      conflict_detected_at INTEGER,
      conflict_info TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_ops_status ON sync_operations(status, next_retry_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_ops_record ON sync_operations(entity, record_id);
  `);

  for (const { table, mutable } of SYNCABLE_TABLES) {
    const exists = await db.getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
    if (!exists) continue;
    // سجلات موجودة قبل التفعيل: إصدار 1 بلا عمليات (المزامنة الأولية الكاملة تُبنى من هذا الجدول في المرحلة 13).
    await db.execAsync(`INSERT OR IGNORE INTO sync_record_meta (entity, record_id, row_version, last_modified_by, updated_at)
      SELECT '${table}', id, 1, NULL, ${NOW_MS} FROM "${table}";`);
    await db.execAsync(`
      CREATE TRIGGER IF NOT EXISTS trg_sync_${table}_ai AFTER INSERT ON "${table}"
      BEGIN ${metaUpsert(table)} ${enqueue(table, 'create')} END;
    `);
    if (mutable) {
      await db.execAsync(`
        CREATE TRIGGER IF NOT EXISTS trg_sync_${table}_au AFTER UPDATE ON "${table}"
        BEGIN ${metaUpsert(table)} ${enqueue(table, 'update')} END;
      `);
    }
  }
}

// ===== مساعدات الطابور (محلية بحتة) =====

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 6 * 3600_000;
export function nextRetryDelayMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export async function listDueOperations(db: SyncDb, now: number, limit = 50) {
  return db.getAllAsync<{ operation_id: string; entity: string; record_id: string; op_type: string; base_version: number; idempotency_key: string }>(
    `SELECT operation_id, entity, record_id, op_type, base_version, idempotency_key FROM sync_operations
     WHERE status IN ('pending','failed') AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY created_at, rowid LIMIT ?`, [now, limit]);
}

export async function markOperationFailed(db: SyncDb, operationId: string, error: string, now: number): Promise<void> {
  const row = await db.getFirstAsync<{ attempt_count: number }>('SELECT attempt_count FROM sync_operations WHERE operation_id = ?', [operationId]);
  if (!row) return;
  const attempts = row.attempt_count + 1;
  await db.runAsync(
    `UPDATE sync_operations SET status = 'failed', attempt_count = ?, last_attempt_at = ?, next_retry_at = ?, last_error = ?
     WHERE operation_id = ? AND status <> 'acknowledged'`,
    [attempts, now, now + nextRetryDelayMs(attempts), error.slice(0, 500), operationId]);
}

// الأرشفة الناعمة: لا حذف؛ تُسجَّل في البيانات الوصفية وتُدرج عملية archive في الطابور.
export async function markRecordArchived(db: SyncDb, entity: string, recordId: string, userId: string, now: number): Promise<void> {
  const m = await db.getFirstAsync<{ row_version: number }>('SELECT row_version FROM sync_record_meta WHERE entity = ? AND record_id = ?', [entity, recordId]);
  if (!m) throw new Error('سجل غير معروف للمزامنة');
  const v = m.row_version + 1;
  await db.runAsync(
    'UPDATE sync_record_meta SET row_version = ?, archived_at = ?, archived_by = ?, last_modified_by = ?, updated_at = ? WHERE entity = ? AND record_id = ?',
    [v, now, userId, userId, now, entity, recordId]);
  await db.runAsync(
    `INSERT INTO sync_operations (operation_id, idempotency_key, entity, record_id, op_type, base_version, status, created_by, created_at)
     VALUES (${UUID_V4}, ?, ?, ?, 'archive', ?, 'pending', ?, ?)`,
    [entity + ':' + recordId + ':' + v, entity, recordId, m.row_version, userId, now]);
}

// فك الأرشفة: يُلغي علامة الأرشفة ويُدرج عملية update (الإصدار الأساس هو الحالي).
export async function markRecordUnarchived(db: SyncDb, entity: string, recordId: string, userId: string, now: number): Promise<void> {
  const m = await db.getFirstAsync<{ row_version: number }>('SELECT row_version FROM sync_record_meta WHERE entity = ? AND record_id = ?', [entity, recordId]);
  if (!m) throw new Error('سجل غير معروف للمزامنة');
  const v = m.row_version + 1;
  await db.runAsync(
    'UPDATE sync_record_meta SET row_version = ?, archived_at = NULL, archived_by = NULL, last_modified_by = ?, updated_at = ? WHERE entity = ? AND record_id = ?',
    [v, userId, now, entity, recordId]);
  await db.runAsync(
    `INSERT INTO sync_operations (operation_id, idempotency_key, entity, record_id, op_type, base_version, status, created_by, created_at)
     VALUES (${UUID_V4}, ?, ?, ?, 'update', ?, 'pending', ?, ?)`,
    [entity + ':' + recordId + ':' + v, entity, recordId, m.row_version, userId, now]);
}
