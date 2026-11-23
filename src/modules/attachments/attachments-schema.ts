// SECURECASEDESK_PHASE9_S1
// جدول المرفقات. للإضافة فقط: لا حذف فعلياً، والتعديل الوحيد المسموح هو الانتقال من active إلى deleted
// (حذف منطقي مع السبب والمنفِّذ). يُستدعى قبل initAuditSchema ليتلقى مشغلات التدقيق.

import type { SQLiteDatabase } from 'expo-sqlite';

export async function initAttachmentsSchema(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('case', 'memo', 'detainee')),
      entity_id TEXT NOT NULL,
      original_name TEXT NOT NULL CHECK (length(original_name) > 0),
      extension TEXT NOT NULL CHECK (extension IN ('pdf', 'jpg', 'jpeg', 'png')),
      mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 15728640),
      sha256_plain TEXT NOT NULL CHECK (length(sha256_plain) = 64),
      sha256_cipher TEXT NOT NULL CHECK (length(sha256_cipher) = 64),
      enc_version INTEGER NOT NULL DEFAULT 1,
      storage_name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_by TEXT,
      deleted_at INTEGER,
      reason TEXT,
      CHECK (
        (status = 'active' AND deleted_by IS NULL AND deleted_at IS NULL AND reason IS NULL) OR
        (status = 'deleted' AND deleted_by IS NOT NULL AND deleted_at IS NOT NULL
          AND reason IS NOT NULL AND length(trim(reason)) >= 5)
      ),
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (deleted_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_entity
      ON attachments(entity_type, entity_id, status);
    CREATE INDEX IF NOT EXISTS idx_attachments_hash
      ON attachments(entity_type, entity_id, sha256_plain);
  `);

  // السجل المرتبط يجب أن يكون موجوداً (لا توجد مفاتيح أجنبية متعددة الأشكال في SQLite).
  await db.execAsync(`
    CREATE TRIGGER IF NOT EXISTS trg_attachments_entity_exists
    BEFORE INSERT ON attachments
    WHEN NOT (
      (NEW.entity_type = 'case' AND EXISTS (SELECT 1 FROM cases WHERE id = NEW.entity_id)) OR
      (NEW.entity_type = 'memo' AND EXISTS (SELECT 1 FROM memos WHERE id = NEW.entity_id)) OR
      (NEW.entity_type = 'detainee' AND EXISTS (SELECT 1 FROM detainees WHERE id = NEW.entity_id))
    )
    BEGIN SELECT RAISE(ABORT, 'السجل المرتبط بالمرفق غير موجود'); END;

    CREATE TRIGGER IF NOT EXISTS trg_attachments_insert_active
    BEFORE INSERT ON attachments
    WHEN NEW.status <> 'active'
    BEGIN SELECT RAISE(ABORT, 'يجب أن يبدأ المرفق بحالة نشط'); END;

    CREATE TRIGGER IF NOT EXISTS trg_attachments_no_delete
    BEFORE DELETE ON attachments
    BEGIN SELECT RAISE(ABORT, 'سجل المرفقات لا يقبل الحذف'); END;

    CREATE TRIGGER IF NOT EXISTS trg_attachments_immutable
    BEFORE UPDATE ON attachments
    WHEN OLD.status = 'deleted'
      OR NEW.status <> 'deleted'
      OR NEW.id IS NOT OLD.id
      OR NEW.entity_type IS NOT OLD.entity_type
      OR NEW.entity_id IS NOT OLD.entity_id
      OR NEW.original_name IS NOT OLD.original_name
      OR NEW.extension IS NOT OLD.extension
      OR NEW.mime_type IS NOT OLD.mime_type
      OR NEW.size_bytes IS NOT OLD.size_bytes
      OR NEW.sha256_plain IS NOT OLD.sha256_plain
      OR NEW.sha256_cipher IS NOT OLD.sha256_cipher
      OR NEW.enc_version IS NOT OLD.enc_version
      OR NEW.storage_name IS NOT OLD.storage_name
      OR NEW.created_by IS NOT OLD.created_by
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'بيانات المرفق غير قابلة للتعديل'); END;
  `);
}
