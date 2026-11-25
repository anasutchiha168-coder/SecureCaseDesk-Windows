// SECURECASEDESK_DETAINEES_V22_S2
// القسم 2: فصل بيانات الأشخاص عن فترات الاحتجاز.
//   persons   : هوية الشخص وبياناته الثابتة (شخص واحد، قد تكون له عدة فترات احتجاز).
//   detainees : يبقى جدول «فترات الاحتجاز» (كل صف = فترة واحدة) حتى لا تنكسر الحركات والتصحيحات
//               والتقارير والنسخ الاحتياطي؛ يُضاف إليه person_id وحقول الفترة المأخوذة من Excel.
// لا يُدمج شخصان بتشابه الأسماء أبداً: كل سجل قديم يصبح شخصاً مستقلاً. الدمج قرار بشري موثّق لاحقاً.
// ترحيل غير هدّام: لا يُحذف ولا يُغيَّر أي عمود أو صف موجود.

export interface PersonsSchemaDb {
  execAsync(sql: string): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAllAsync<T>(sql: string, params?: any): Promise<T[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getFirstAsync<T>(sql: string, params?: any): Promise<T | null>;
}

const UUID_V4 = `lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))`;

// أعمدة فترة الاحتجاز الجديدة (كلها اختيارية ما عدا period_no). المصدر: أعمدة Excel.
export const PERIOD_NEW_COLUMNS: readonly (readonly [string, string])[] = [
  ['person_id', 'TEXT REFERENCES persons(id)'],
  ['period_no', 'INTEGER NOT NULL DEFAULT 1'],
  ['age_at_admission', 'INTEGER'],              // العمر
  ['case_role', 'TEXT'],                        // صفة السجين في القضية
  ['report_number', 'TEXT'],                    // رقم البلاغ
  ['legal_status', 'TEXT'],                     // وضع السجين
  ['prosecution_referral_date', 'INTEGER'],     // تاريخ إحالة الملف إلى النيابة
  ['exit_type', 'TEXT'],                        // نوع الخروج من السجن
  ['exit_procedure', 'TEXT'],                   // إجراءات الخروج
  ['exit_directive_source', 'TEXT'],            // مصدر التوجيه بالخروج
  ['legacy_serial', 'TEXT'],                    // عمود «م» في Excel (غير فريد؛ للمرجعية فقط)
];

export async function initPersonsSchema(db: PersonsSchemaDb): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS persons (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      id_type TEXT,
      id_number TEXT,
      phone TEXT,
      governorate TEXT,
      district TEXT,
      sub_district TEXT,
      current_residence TEXT,
      occupation TEXT,
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_persons_name ON persons(full_name);
    CREATE INDEX IF NOT EXISTS idx_persons_identity ON persons(id_type, id_number);
  `);

  const existing = await db.getAllAsync<{ name: string }>('PRAGMA table_info(detainees)');
  if (existing.length === 0) return; // جدول الفترات غير موجود (لا يحدث في initDatabase)
  const have = new Set(existing.map((c) => c.name));
  let added = 0;
  for (const [name, def] of PERIOD_NEW_COLUMNS) {
    if (!have.has(name)) {
      await db.execAsync(`ALTER TABLE detainees ADD COLUMN ${name} ${def};`);
      added++;
    }
  }

  // مشغلات التدقيق تُنشأ بـ IF NOT EXISTS بقائمة أعمدة ثابتة وقت الإنشاء؛ لذلك عند إضافة أعمدة تُحذف مشغلات
  // detainees لتُعاد إنشاؤها فوراً بالقائمة الجديدة في initAuditSchema (الذي يُستدعى بعد هذه الدالة في initDatabase).
  if (added > 0) {
    await db.execAsync(`
      DROP TRIGGER IF EXISTS audit_detainees_insert;
      DROP TRIGGER IF EXISTS audit_detainees_update;
      DROP TRIGGER IF EXISTS audit_detainees_delete;
    `);
  }

  const pending = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM detainees WHERE person_id IS NULL'
  );
  if ((pending?.count ?? 0) > 0) {
    // ترحيل السجلات القديمة: كل سجل ⇒ شخص مستقل (بلا أي دمج). لا يُسجَّل ضجيج تدقيق/مزامنة لهذا التحديث الآلي.
    await db.execAsync(`
      DROP TRIGGER IF EXISTS audit_detainees_update;
      DROP TRIGGER IF EXISTS trg_sync_detainees_au;
    `);
    try {
      await db.execAsync(`
        BEGIN IMMEDIATE;
        CREATE TEMP TABLE IF NOT EXISTS _persons_backfill (detainee_id TEXT PRIMARY KEY, person_id TEXT NOT NULL);
        DELETE FROM _persons_backfill;
        INSERT INTO _persons_backfill (detainee_id, person_id)
          SELECT id, ${UUID_V4} FROM detainees WHERE person_id IS NULL;
        INSERT INTO persons (id, full_name, created_by, created_at, updated_at)
          SELECT b.person_id, d.full_name, d.created_by, d.created_at, d.updated_at
          FROM _persons_backfill b JOIN detainees d ON d.id = b.detainee_id;
        UPDATE detainees
          SET person_id = (SELECT b.person_id FROM _persons_backfill b WHERE b.detainee_id = detainees.id)
          WHERE person_id IS NULL;
        DROP TABLE _persons_backfill;
        COMMIT;
      `);
    } catch (e) {
      try { await db.execAsync('ROLLBACK;'); } catch { /* لا معاملة مفتوحة */ }
      throw e;
    }
  }

  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_detainees_person ON detainees(person_id, period_no);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_detainees_person_period
      ON detainees(person_id, period_no) WHERE person_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_detainees_one_open_period
      ON detainees(person_id) WHERE person_id IS NOT NULL AND release_date IS NULL;

    CREATE TRIGGER IF NOT EXISTS trg_detainees_require_person_ins
    BEFORE INSERT ON detainees WHEN NEW.person_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'لا يجوز تسجيل فترة احتجاز بلا شخص مرتبط'); END;

    CREATE TRIGGER IF NOT EXISTS trg_detainees_require_person_upd
    BEFORE UPDATE OF person_id ON detainees WHEN NEW.person_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'لا يجوز فصل فترة احتجاز عن الشخص المرتبط'); END;

    -- توافق مؤقت حتى القسم 3: تصحيح الاسم على الفترة ينعكس على سجل الشخص.
    CREATE TRIGGER IF NOT EXISTS trg_detainees_name_to_person
    AFTER UPDATE OF full_name ON detainees WHEN NEW.person_id IS NOT NULL
    BEGIN
      UPDATE persons SET full_name = NEW.full_name, updated_at = NEW.updated_at
      WHERE id = NEW.person_id AND full_name <> NEW.full_name;
    END;

    -- أيام الاحتجاز بالأيام التقويمية الفعلية (يوم الدخول لا يُحسب؛ نفس اليوم = 0)، بالتوقيت المحلي.
    DROP VIEW IF EXISTS v_detention_periods;
    CREATE VIEW v_detention_periods AS
    SELECT d.*,
      MAX(0, CAST(
        julianday(date(COALESCE(d.release_date, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) / 1000, 'unixepoch', 'localtime'))
        - julianday(date(d.admission_date / 1000, 'unixepoch', 'localtime'))
      AS INTEGER)) AS detention_days
    FROM detainees d;
  `);
}
