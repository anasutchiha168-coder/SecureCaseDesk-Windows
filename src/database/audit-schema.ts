
// SECURECASEDESK_PHASE8
// إنشاء سجل التدقيق ومشغلات تسجيل التغييرات.

import type { SQLiteDatabase } from 'expo-sqlite';
import { initAuditSchemaV2 } from './audit-schema-v2';

const AUDIT_TABLE_FIELDS: Record<string, string[]> = {
  users: [
    'username', 'role', 'created_at',
    'department_id', 'is_active', 'last_login'
  ],
  departments: [
    'name', 'description', 'is_active', 'created_at'
  ],
  cases: [
    'case_number', 'title', 'complainant', 'suspects',
    'case_type', 'department_id', 'officer_id',
    'registration_date', 'incident_location',
    'incident_details', 'status', 'created_by'
  ],
  memos: [
    'memo_number', 'memo_type_id', 'memo_date',
    'recipient_organization', 'subject', 'body',
    'linked_case_id', 'status', 'created_by'
  ],
  detainees: [
    'reference_number', 'full_name', 'category_id',
    'admission_date', 'release_date', 'alleged_offense',
    'offense_details', 'detaining_authority',
    'officer_id', 'status', 'notes', 'created_by',
    'person_id', 'period_no', 'age_at_admission', 'case_role', 'report_number',
    'legal_status', 'prosecution_referral_date', 'exit_type', 'exit_procedure',
    'exit_directive_source', 'legacy_serial', 'classification_id'
  ],
  persons: [
    'full_name', 'id_type', 'id_number', 'phone', 'governorate', 'district',
    'sub_district', 'current_residence', 'occupation', 'notes', 'created_by'
  ],
  detainee_movements: [
    'movement_number', 'detainee_id', 'movement_type',
    'movement_date', 'previous_authority', 'new_authority',
    'executed_by', 'reason', 'source', 'related_movement_id'
  ],
  correction_history: [
    'detainee_id', 'field_name', 'previous_value',
    'new_value', 'reason', 'executed_by',
    'related_movement_id'
  ],
  attachments: [
    'entity_type', 'entity_id', 'original_name', 'extension', 'mime_type',
    'size_bytes', 'sha256_plain', 'sha256_cipher', 'enc_version', 'status',
    'created_by', 'deleted_by', 'deleted_at', 'reason'
  ],
  memo_types: [
    'name', 'is_active', 'created_at'
  ],
  detainee_categories: [
    'name', 'is_active', 'created_at'
  ],
  crime_classifications: [
    'name', 'severity', 'sub_category', 'main_category', 'legal_basis', 'is_active', 'sort_order', 'created_at'
  ],
};

function quoted(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

function jsonExpression(columns: string[], prefix: string): string {
  if (columns.length === 0) return "'{}'";

  return 'json_object(' +
    columns.map((c) => "'" + c + "', " + prefix + '.' + quoted(c)).join(', ') +
    ')';
}

async function createTableTriggers(
  db: SQLiteDatabase,
  table: string,
  configuredFields: string[]
) {
  const actual = await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(' + quoted(table) + ')'
  );

  const names = new Set(actual.map((x) => x.name));

  if (!names.has('id')) return;

  const fields = configuredFields.filter((f) => names.has(f));
  const oldJson = jsonExpression(fields, 'OLD');
  const newJson = jsonExpression(fields, 'NEW');
  const oldId = 'CAST(OLD."id" AS TEXT)';
  const newId = 'CAST(NEW."id" AS TEXT)';

  const actorId = `COALESCE(
    (SELECT actor_user_id FROM audit_context WHERE id = 1),
    'SYSTEM'
  )`;

  const actorName = `COALESCE(
    (SELECT actor_username FROM audit_context WHERE id = 1),
    'النظام'
  )`;

  const timestamp = `CAST(
    (julianday('now') - 2440587.5) * 86400000 AS INTEGER
  )`;

  const reasonNew = names.has('reason') ? 'NEW."reason"' : 'NULL';
  const reasonOld = names.has('reason') ? 'OLD."reason"' : 'NULL';

  const definitions = [
    {
      suffix: 'insert',
      event: 'create',
      id: newId,
      previous: 'NULL',
      next: newJson,
      reason: reasonNew,
      timing: 'AFTER INSERT',
    },
    {
      suffix: 'update',
      event: 'update',
      id: newId,
      previous: oldJson,
      next: newJson,
      reason: reasonNew,
      timing: 'AFTER UPDATE',
    },
    {
      suffix: 'delete',
      event: 'delete',
      id: oldId,
      previous: oldJson,
      next: 'NULL',
      reason: reasonOld,
      timing: 'AFTER DELETE',
    },
  ];

  for (const d of definitions) {
    const triggerName = 'audit_' + table + '_' + d.suffix;

    await db.execAsync(`
      CREATE TRIGGER IF NOT EXISTS ${quoted(triggerName)}
      ${d.timing} ON ${quoted(table)}
      BEGIN
        INSERT INTO audit_event_queue (
          event_key,
          actor_user_id,
          actor_username,
          operation_type,
          entity_type,
          entity_id,
          previous_values,
          new_values,
          correction_reason,
          created_at
        )
        VALUES (
          lower(hex(randomblob(16))),
          ${actorId},
          ${actorName},
          '${d.event}',
          '${table}',
          ${d.id},
          ${d.previous},
          ${d.next},
          ${d.reason},
          ${timestamp}
        );
      END;
    `);
  }
}

export async function initAuditSchema(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS audit_context (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      actor_user_id TEXT,
      actor_username TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_event_queue (
      queue_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      actor_user_id TEXT,
      actor_username TEXT,
      operation_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      previous_values TEXT,
      new_values TEXT,
      correction_reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      sequence_no INTEGER PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      source_event_id TEXT NOT NULL UNIQUE,
      user_id TEXT,
      username TEXT,
      operation_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      previous_values TEXT,
      new_values TEXT,
      correction_reason TEXT,
      created_at INTEGER NOT NULL,
      previous_hash TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      hmac_version TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_created
      ON audit_logs(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_audit_actor
      ON audit_logs(username);

    CREATE INDEX IF NOT EXISTS idx_audit_entity
      ON audit_logs(entity_type, entity_id);

    CREATE INDEX IF NOT EXISTS idx_audit_queue
      ON audit_event_queue(queue_seq);
  `);

  // منع تغيير أو حذف السجلات النهائية.
  await db.execAsync(`
    CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
    BEFORE UPDATE ON audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'سجل التدقيق غير قابل للتعديل');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
    BEFORE DELETE ON audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'سجل التدقيق غير قابل للحذف');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_queue_no_update
    BEFORE UPDATE ON audit_event_queue
    BEGIN
      SELECT RAISE(ABORT, 'طابور التدقيق غير قابل للتعديل');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_queue_no_delete
    BEFORE DELETE ON audit_event_queue
    BEGIN
      SELECT RAISE(ABORT, 'طابور التدقيق غير قابل للحذف');
    END;
  `);

  for (const [table, fields] of Object.entries(AUDIT_TABLE_FIELDS)) {
    await createTableTriggers(db, table, fields);
  }

  await initAuditSchemaV2(db);
}
