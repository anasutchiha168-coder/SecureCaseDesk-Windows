// SECURECASEDESK_PHASE8_S2
// جداول القسم الثاني: سجل المفاتيح، Checkpoints، وتنبيهات السلامة (كلها للإضافة فقط).

import type { SQLiteDatabase } from 'expo-sqlite';

export async function initAuditSchemaV2(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS audit_key_registry (
      version INTEGER PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      activated_after_seq INTEGER
    );

    CREATE TABLE IF NOT EXISTS audit_checkpoints (
      sequence_no INTEGER PRIMARY KEY,
      record_hash TEXT NOT NULL,
      entry_count INTEGER NOT NULL,
      key_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      signature TEXT NOT NULL,
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_integrity_alerts (
      alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_key TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL,
      severity TEXT NOT NULL,
      sequence_no INTEGER,
      detail TEXT,
      detected_at INTEGER NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS trg_audit_key_registry_no_update
    BEFORE UPDATE ON audit_key_registry
    BEGIN SELECT RAISE(ABORT, 'سجل مفاتيح التدقيق غير قابل للتعديل'); END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_key_registry_no_delete
    BEFORE DELETE ON audit_key_registry
    BEGIN SELECT RAISE(ABORT, 'سجل مفاتيح التدقيق غير قابل للحذف'); END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_checkpoints_no_update
    BEFORE UPDATE ON audit_checkpoints
    BEGIN SELECT RAISE(ABORT, 'نقاط التحقق غير قابلة للتعديل'); END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_checkpoints_no_delete
    BEFORE DELETE ON audit_checkpoints
    BEGIN SELECT RAISE(ABORT, 'نقاط التحقق غير قابلة للحذف'); END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_alerts_no_update
    BEFORE UPDATE ON audit_integrity_alerts
    BEGIN SELECT RAISE(ABORT, 'تنبيهات السلامة غير قابلة للتعديل'); END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_alerts_no_delete
    BEFORE DELETE ON audit_integrity_alerts
    BEGIN SELECT RAISE(ABORT, 'تنبيهات السلامة غير قابلة للحذف'); END;
  `);
}
