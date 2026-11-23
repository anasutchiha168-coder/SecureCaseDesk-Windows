import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { FileMode } from 'expo-file-system';
import { initAuditSchema } from './audit-schema';
import { initSyncSchema } from './sync-schema';
import { initCaseHistorySchema } from '../modules/cases/cases-schema';
import { initAttachmentsSchema } from '../modules/attachments/attachments-schema';
import { fsFile } from '@/modules/backup/fs-uri'; // SECURECASEDESK_FILE_URI_FIX

let db: SQLite.SQLiteDatabase | null = null;

export async function getDb() {
  if (db) return db;
  if (preOpenHook) {
    preOpenState ??= preOpenHook().catch((e) => { preOpenState = null; throw e; });
    await preOpenState; // SECURECASEDESK_PHASE10_S8
    if (db) return db;
  }
  let key = await SecureStore.getItemAsync('db_encryption_key');
  if (!key) {
    key = Crypto.randomUUID();
    await SecureStore.setItemAsync('db_encryption_key', key);
  }
  db = await SQLite.openDatabaseAsync('securecase.db');
  await db.execAsync(`PRAGMA key = '${key}';`);
  
  try {
    const result = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version;');
    if (!result || !result.cipher_version) {
      await db.closeAsync();
      db = null;
      throw new Error('FATAL_SECURITY: SQLCipher غير مفعل.');
    }
    console.log('✅ SQLCipher مفعل. الإصدار:', result.cipher_version);
  } catch (e) {
    console.error('خطأ في التحقق من SQLCipher:', e);
    throw e;
  }
  return db;
}

// SECURECASEDESK_PHASE10_S6: إغلاق الاتصال وتصفير الكاش (تحتاجه الاستعادة قبل استبدال الملف).
export async function closeDb(): Promise<void> {
  if (!db) return;
  const current = db;
  db = null;
  await current.closeAsync();
}

export interface DatabaseEncryptionCheck {
  cipherVersion: string;
  fileSize: number;
  headerReadable: boolean;
  sqliteHeaderDetected: boolean;
  schemaAccessible: boolean;
}

export async function inspectDatabaseEncryption(): Promise<DatabaseEncryptionCheck> {
  const database = await getDb();

  const cipher = await database.getFirstAsync<{ cipher_version: string }>(
    'PRAGMA cipher_version;'
  );

  if (!cipher?.cipher_version) {
    throw new Error('SQLCIPHER_NOT_AVAILABLE');
  }

  // التأكد من إمكانية قراءة بنية القاعدة باستخدام الاتصال الحالي والمفتاح.
  await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM sqlite_master;'
  );

  const file = fsFile(database.databasePath);

  if (!file.exists) {
    throw new Error('DATABASE_FILE_NOT_FOUND');
  }

  const fileSize = file.size;

  if (fileSize < 16) {
    return {
      cipherVersion: cipher.cipher_version,
      fileSize,
      headerReadable: false,
      sqliteHeaderDetected: false,
      schemaAccessible: true,
    };
  }

  const handle = file.open(FileMode.ReadOnly);

  try {
    const bytes = handle.readBytesSync(16);

    const sqliteSignature = [
      83, 81, 76, 105, 116, 101, 32, 102,
      111, 114, 109, 97, 116, 32, 51, 0
    ];

    const headerReadable = bytes.length === 16;

    const sqliteHeaderDetected =
      headerReadable &&
      sqliteSignature.every((value, index) => bytes[index] === value);

    return {
      cipherVersion: cipher.cipher_version,
      fileSize,
      headerReadable,
      sqliteHeaderDetected,
      schemaAccessible: true,
    };
  } finally {
    handle.close();
  }
}

export async function initDatabase() {
  const database = await getDb();
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      department_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      last_login INTEGER
    );
  `);

  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `);

  const deptCount = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM departments');
  if (deptCount?.count === 0) {
    const defaultDepts = [
      'قسم الاعتداء والقتل', 'قسم التحري والاستدلال', 'قسم الآداب العامة',
      'قسم مكافحة السرقة', 'قسم المباحث الجنائية', 'قسم الجرائم الإلكترونية'
    ];
    for (const dept of defaultDepts) {
      await database.runAsync(
        'INSERT INTO departments (id, name, created_at) VALUES (?, ?, ?)',
        [Crypto.randomUUID(), dept, Date.now()]
      );
    }
  }

  // ===== المرحلة 7: ترحيل حقول حسابات المستخدمين =====
  const userColumns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(users)');
  const userColumnNames = new Set(userColumns.map((column) => column.name));

  if (!userColumnNames.has('department_id')) {
    await database.execAsync('ALTER TABLE users ADD COLUMN department_id TEXT;');
  }

  if (!userColumnNames.has('is_active')) {
    await database.execAsync(
      'ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));'
    );
  }

  if (!userColumnNames.has('last_login')) {
    await database.execAsync('ALTER TABLE users ADD COLUMN last_login INTEGER;');
  }

  await database.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_users_active_role ON users(is_active, role);
    CREATE INDEX IF NOT EXISTS idx_users_department ON users(department_id);
  `);

  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      case_number TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      complainant TEXT,
      suspects TEXT,
      case_type TEXT NOT NULL,
      department_id TEXT,
      officer_id TEXT,
      registration_date INTEGER NOT NULL,
      incident_location TEXT,
      incident_details TEXT,
      status TEXT NOT NULL DEFAULT 'جديدة',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (department_id) REFERENCES departments(id),
      FOREIGN KEY (officer_id) REFERENCES users(id)
    );
  `);
  
  
  // ===== المرحلة 4: مكتب المدير والمذكرات الرسمية =====

  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS memo_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `);

  const memoTypeCount = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM memo_types'
  );
  if (memoTypeCount?.count === 0) {
    const defaultMemoTypes = [
      'مذكرات موجهة إلى نائب النيابة العامة للبحث والتفتيش والسجون',
      'مذكرات موجهة إلى رئيس نيابة استئناف حجة',
      'مذكرات موجهة إلى المدير العام لأمن المحافظة',
      'مذكرات موجهة إلى المدير العام للمباحث الجنائية',
      'تكليفات ومهام رسمية',
      'مذكرات موجهة إلى مستشفى الجمهوري',
      'مذكرات موجهة إلى المستشفى السعودي',
      'مذكرات موجهة إلى السجن المركزي',
      'تقارير إحصائية',
      'أوامر قضائية إلزامية (إحضار)',
    ];
    for (const typeName of defaultMemoTypes) {
      await database.runAsync(
        'INSERT INTO memo_types (id, name, created_at) VALUES (?, ?, ?)',
        [Crypto.randomUUID(), typeName, Date.now()]
      );
    }
  }

  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS memos (
      id TEXT PRIMARY KEY,
      memo_number TEXT UNIQUE NOT NULL,
      memo_type_id TEXT NOT NULL,
      memo_date INTEGER NOT NULL,
      recipient_organization TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT,
      linked_case_id TEXT,
      status TEXT NOT NULL DEFAULT 'مسودة',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (memo_type_id) REFERENCES memo_types(id),
      FOREIGN KEY (linked_case_id) REFERENCES cases(id)
    );
  `);

  // ===== المرحلة 5: إدارة المحتجزين وسجل الحركات =====

  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS detainee_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `);

  const detCatCount = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM detainee_categories'
  );
  if (detCatCount?.count === 0) {
    const defaultDetCats = [
      'قيد التحقيق الأولي',
      'النيابة الابتدائية',
      'النيابة الجزائية',
      'تحت تصرف المدير العام لأمن المحافظة',
      'استخبارات الشرطة',
      'منطقة ظهر أبو الطير',
      'إدارات أمن المديريات',
      'نيابات المديريات'
    ];
    await database.withTransactionAsync(async () => {
      for (const catName of defaultDetCats) {
        await database.runAsync(
          'INSERT INTO detainee_categories (id, name, created_at) VALUES (?, ?, ?)',
          [Crypto.randomUUID(), catName, Date.now()]
        );
      }
    });
  }

  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS detainees (
      id TEXT PRIMARY KEY,
      reference_number TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      category_id TEXT NOT NULL,
      admission_date INTEGER NOT NULL,
      release_date INTEGER,
      alleged_offense TEXT NOT NULL,
      offense_details TEXT,
      detaining_authority TEXT NOT NULL,
      officer_id TEXT,
      status TEXT NOT NULL DEFAULT 'محتجز',
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (release_date IS NULL OR release_date >= admission_date),
      FOREIGN KEY (category_id) REFERENCES detainee_categories(id),
      FOREIGN KEY (officer_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_detainees_status ON detainees(status);
    CREATE INDEX IF NOT EXISTS idx_detainees_category ON detainees(category_id);
  `);

  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS detainee_movements (
      id TEXT PRIMARY KEY,
      movement_number TEXT UNIQUE NOT NULL,
      detainee_id TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      movement_date INTEGER NOT NULL,
      previous_authority TEXT,
      new_authority TEXT,
      executed_by TEXT NOT NULL,
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'application',
      related_movement_id TEXT,
      created_at INTEGER NOT NULL,
      CHECK (movement_type IN (
        'إيداع', 'إفراج', 'نقل', 'تغيير جهة الحجز',
        'تمديد أو تحديث الحجز', 'تصحيح', 'إلغاء تصحيحي موثّق'
      )),
      FOREIGN KEY (detainee_id) REFERENCES detainees(id),
      FOREIGN KEY (executed_by) REFERENCES users(id),
      FOREIGN KEY (related_movement_id) REFERENCES detainee_movements(id)
    );
    CREATE INDEX IF NOT EXISTS idx_movements_detainee
      ON detainee_movements(detainee_id, movement_date);

    CREATE TRIGGER IF NOT EXISTS trg_movements_no_update
    BEFORE UPDATE ON detainee_movements
    BEGIN
      SELECT RAISE(ABORT, 'سجل الحركات لا يقبل التعديل');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_movements_no_delete
    BEFORE DELETE ON detainee_movements
    BEGIN
      SELECT RAISE(ABORT, 'سجل الحركات لا يقبل الحذف');
    END;
  `);

  // ===== المرحلة 6: سجل التصحيحات (غير قابل للتعديل أو الحذف) =====

  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS correction_history (
      id TEXT PRIMARY KEY,
      detainee_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      previous_value TEXT,
      new_value TEXT,
      reason TEXT NOT NULL,
      executed_by TEXT NOT NULL,
      related_movement_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (detainee_id) REFERENCES detainees(id),
      FOREIGN KEY (executed_by) REFERENCES users(id),
      FOREIGN KEY (related_movement_id) REFERENCES detainee_movements(id)
    );
  `);

  await database.execAsync(`
    CREATE TRIGGER IF NOT EXISTS trg_corrections_no_update
    BEFORE UPDATE ON correction_history
    BEGIN
      SELECT RAISE(ABORT, 'سجل التصحيحات غير قابل للتعديل');
    END;
  `);

  await database.execAsync(`
    CREATE TRIGGER IF NOT EXISTS trg_corrections_no_delete
    BEFORE DELETE ON correction_history
    BEGIN
      SELECT RAISE(ABORT, 'سجل التصحيحات غير قابل للحذف');
    END;
  `);

  const corrTriggers = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_corrections_%'`
  );
  console.log('سجل التصحيحات جاهز. عدد الحمايات:', corrTriggers?.count);


  // ===== المرحلة 3: سجل تعديل القضايا (للإلحاق فقط) =====
  await initCaseHistorySchema(database);

  // ===== المرحلة 9 / القسم 1: المرفقات (قبل التدقيق ليلتقط مشغلاتها) =====
  await initAttachmentsSchema(database);

  // ===== المرحلة 8 / القسم 1: تأسيس محرك سجل التدقيق =====
  // ينشئ جداول audit_logs و audit_event_queue و audit_context،
  // ومشغلات (triggers) الالتقاط التلقائي على كل الجداول المتتبَّعة.
  // يجب أن يُستدعى بعد إنشاء كل الجداول المتتبَّعة أعلاه مباشرة.
  await initAuditSchema(database);

  // ===== القسم 16.2: جاهزية المزامنة (محلية فقط) =====
  await initSyncSchema(database);

  console.log('تم تهيئة جداول قاعدة البيانات بنجاح.');
}

// SECURECASEDESK_PHASE10_S8
// خطاف يُنفَّذ مرة واحدة قبل أول فتح للقاعدة (تعافي الاستبدال المنقطع). فشله يمنع الفتح ويُعاد تجريبه لاحقاً.
let preOpenHook: (() => Promise<void>) | null = null;
let preOpenState: Promise<void> | null = null;
export function setPreOpenHook(hook: () => Promise<void>): void {
  preOpenHook = hook;
  preOpenState = null;
}
