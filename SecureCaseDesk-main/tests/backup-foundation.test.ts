// SECURECASEDESK_PHASE10_S1
// اختبارات المرحلة 10 / القسم 10.1 — جرد مصادر النسخ الاحتياطي. تشغَّل بـ: npm run test:backup-foundation
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NodeDb, uuid } from './helpers/node-env';
import {
  analyzeAttachmentFiles, buildSecretSpecs, collectBackupInventory, type InventoryDeps,
} from '../src/modules/backup/backup-inventory';
import {
  REQUIRED_TABLES, SECRET_NAMES, auditHmacKeyName, BackupError,
} from '../src/modules/backup/backup-types';
import { can, ROLES } from '../src/security/permissions';

const SENTINEL = 'SECRET-VALUE-MUST-NEVER-APPEAR';

let db: NodeDb;
let files: string[];
let secrets: Set<string>;
let dbFile: { exists: boolean; sizeBytes: number; walBytes: number };

function makeDeps(): InventoryDeps {
  return {
    db,
    listAttachmentFiles: async () => files,
    getDatabaseFile: async () => dbFile,
    hasSecret: async (n) => secrets.has(n),
    now: () => 1_700_000_000_000,
  };
}

function createSchema(skip: string[] = []) {
  for (const t of REQUIRED_TABLES) {
    if (skip.includes(t)) continue;
    if (t === 'attachments') {
      db.raw.exec('CREATE TABLE attachments (id TEXT PRIMARY KEY, storage_name TEXT NOT NULL, status TEXT NOT NULL)');
    } else if (t === 'audit_key_registry') {
      db.raw.exec('CREATE TABLE audit_key_registry (version INTEGER PRIMARY KEY, fingerprint TEXT)');
    } else {
      db.raw.exec('CREATE TABLE "' + t + '" (id TEXT PRIMARY KEY)');
    }
  }
}

const blobName = () => uuid() + '.enc';

beforeEach(() => {
  db = new NodeDb();
  files = [];
  dbFile = { exists: true, sizeBytes: 4096, walBytes: 0 };
  secrets = new Set([
    SECRET_NAMES.dbKey, SECRET_NAMES.auditActiveVersion, SECRET_NAMES.auditCheckpointKey,
    SECRET_NAMES.attachmentMasterKey, auditHmacKeyName(1),
  ]);
});

describe('10.1 — جاهزية سليمة', () => {
  test('قاعدة سليمة بلا مرفقات: جاهزة بلا موانع', async () => {
    createSchema();
    db.raw.exec('INSERT INTO audit_key_registry (version, fingerprint) VALUES (1, \'f\')');
    const inv = await collectBackupInventory(makeDeps());
    assert.equal(inv.ready, true);
    assert.deepEqual(inv.blockers, []);
    assert.deepEqual(inv.auditKeyVersions, [1]);
    assert.equal(inv.tables.length, REQUIRED_TABLES.length);
  });

  test('مرفقات سليمة: الصفوف النشطة لها ملفات، والمحذوفة منطقياً لا تُعدّ ناقصة', async () => {
    createSchema();
    const a = blobName(), d = blobName();
    db.raw.exec(`INSERT INTO attachments VALUES ('a1','${a}','active'), ('a2','${d}','deleted')`);
    files = [a]; // ملف المحذوف منطقياً غير موجود: وضع طبيعي بعد الصيانة
    const inv = await collectBackupInventory(makeDeps());
    assert.equal(inv.ready, true);
    assert.deepEqual(inv.attachments.missingFiles, []);
    assert.equal(inv.attachments.activeRows, 1);
    assert.equal(inv.attachments.deletedRows, 1);
    assert.deepEqual(inv.warnings, []);
  });
});

describe('10.1 — الموانع (blockers)', () => {
  test('جدول أساسي مفقود يمنع النسخ ويُسمّى', async () => {
    createSchema(['correction_history']);
    const inv = await collectBackupInventory(makeDeps());
    assert.equal(inv.ready, false);
    const b = inv.blockers.find((x) => x.code === 'MISSING_TABLE');
    assert.deepEqual(b?.items, ['correction_history']);
  });

  test('غياب مفتاح قاعدة البيانات يمنع النسخ', async () => {
    createSchema();
    secrets.delete(SECRET_NAMES.dbKey);
    const inv = await collectBackupInventory(makeDeps());
    assert.ok(inv.blockers.some((b) => b.code === 'DB_KEY_MISSING'));
  });

  test('غياب مفتاح HMAC لإصدار مسجّل يمنع النسخ', async () => {
    createSchema();
    db.raw.exec('INSERT INTO audit_key_registry (version, fingerprint) VALUES (1,\'a\'), (2,\'b\')');
    const inv = await collectBackupInventory(makeDeps());
    const b = inv.blockers.find((x) => x.code === 'AUDIT_KEY_MISSING');
    assert.deepEqual(b?.items, [auditHmacKeyName(2)]);
    assert.deepEqual(inv.auditKeyVersions, [1, 2]);
  });

  test('سجلات تدقيق بلا تسجيل مفاتيح تفرض إصدار 1', async () => {
    createSchema();
    db.raw.exec(`INSERT INTO audit_logs (id) VALUES ('x')`);
    secrets.delete(auditHmacKeyName(1));
    const inv = await collectBackupInventory(makeDeps());
    assert.deepEqual(inv.auditKeyVersions, [1]);
    assert.ok(inv.blockers.some((b) => b.code === 'AUDIT_KEY_MISSING'));
  });

  test('غياب إصدار المفتاح النشط يمنع النسخ', async () => {
    createSchema();
    secrets.delete(SECRET_NAMES.auditActiveVersion);
    const inv = await collectBackupInventory(makeDeps());
    assert.ok(inv.blockers.some((b) => b.code === 'AUDIT_ACTIVE_VERSION_MISSING'));
  });

  test('مرفقات بلا مفتاح رئيسي تمنع النسخ، وبلا مرفقات لا تمنع', async () => {
    createSchema();
    secrets.delete(SECRET_NAMES.attachmentMasterKey);
    let inv = await collectBackupInventory(makeDeps());
    assert.equal(inv.ready, true); // لا مرفقات: المفتاح "موصى به" فقط

    const a = blobName();
    db.raw.exec(`INSERT INTO attachments VALUES ('a1','${a}','active')`);
    files = [a];
    inv = await collectBackupInventory(makeDeps());
    assert.ok(inv.blockers.some((b) => b.code === 'ATTACHMENT_KEY_MISSING'));
  });

  test('غياب ملف القاعدة يمنع النسخ', async () => {
    createSchema();
    dbFile = { exists: false, sizeBytes: 0, walBytes: 0 };
    const inv = await collectBackupInventory(makeDeps());
    assert.ok(inv.blockers.some((b) => b.code === 'DATABASE_FILE_MISSING'));
  });
});

describe('10.1 — التحذيرات', () => {
  test('مرفق نشط بلا ملف: تحذير يسمّي المعرّف دون منع النسخ', async () => {
    createSchema();
    db.raw.exec(`INSERT INTO attachments VALUES ('a1','${blobName()}','active')`);
    const inv = await collectBackupInventory(makeDeps());
    assert.equal(inv.ready, true);
    assert.deepEqual(inv.warnings.find((w) => w.code === 'ATTACHMENT_FILES_MISSING')?.items, ['a1']);
  });

  test('ملفات يتيمة وبقايا .tmp وأسماء غريبة تُصنَّف ولا تُحذف', async () => {
    createSchema();
    const orphan = blobName();
    const tmp = blobName() + '.tmp';
    files = [orphan, tmp, 'notes.txt'];
    const before = [...files];
    const inv = await collectBackupInventory(makeDeps());
    assert.deepEqual(inv.attachments.orphanFiles, [orphan]);
    assert.deepEqual(inv.attachments.tmpFiles, [tmp]);
    assert.deepEqual(inv.attachments.unexpectedFiles, ['notes.txt']);
    assert.deepEqual(files, before); // الجرد لا يعدّل شيئاً
    const codes = inv.warnings.map((w) => w.code).sort();
    assert.deepEqual(codes, ['ORPHAN_ATTACHMENT_FILES', 'TMP_ATTACHMENT_FILES', 'UNEXPECTED_FILES']);
  });

  test('ملف WAL غير مدمج يظهر كتحذير', async () => {
    createSchema();
    dbFile = { exists: true, sizeBytes: 4096, walBytes: 2048 };
    const inv = await collectBackupInventory(makeDeps());
    assert.ok(inv.warnings.some((w) => w.code === 'WAL_PENDING'));
    assert.equal(inv.ready, true);
  });

  test('ملف قديم لمرفق محذوف منطقياً يُحصى ولا يُعدّ يتيماً', () => {
    const n = blobName();
    const r = analyzeAttachmentFiles([{ id: 'a', storage_name: n, status: 'deleted' }], [n]);
    assert.equal(r.deletedRowFiles, 1);
    assert.deepEqual(r.orphanFiles, []);
  });
});

describe('10.1 — الأسرار', () => {
  test('التقرير لا يحمل قيم الأسرار أبداً', async () => {
    createSchema();
    const deps = makeDeps();
    deps.hasSecret = async (n) => { void SENTINEL; return secrets.has(n); };
    const inv = await collectBackupInventory(deps);
    const text = JSON.stringify(inv);
    assert.ok(!text.includes(SENTINEL));
    for (const s of inv.secrets) assert.deepEqual(Object.keys(s).sort(), ['cls', 'name', 'present', 'reason']);
  });

  test('جلسة المستخدم ورمز الخادم وعنوانه مستبعدة دائماً', () => {
    const specs = buildSecretSpecs([1], true);
    for (const n of [SECRET_NAMES.sessionUser, SECRET_NAMES.apiToken, SECRET_NAMES.apiUrl]) {
      assert.equal(specs.find((s) => s.name === n)?.cls, 'excluded');
    }
  });

  test('كل إصدار HMAC مسجّل يصبح سراً إلزامياً', () => {
    const specs = buildSecretSpecs([1, 2, 3], false);
    for (const v of [1, 2, 3]) {
      assert.equal(specs.find((s) => s.name === auditHmacKeyName(v))?.cls, 'required');
    }
  });
});

describe('10.1 — الصلاحيات', () => {
  test('backup.manage للمدير فقط', () => {
    assert.equal(can('admin', 'backup.manage'), true);
    for (const r of ROLES.filter((x) => x.key !== 'admin')) {
      assert.equal(can(r.key, 'backup.manage'), false, r.key);
    }
    assert.equal(can('unknown', 'backup.manage'), false);
    assert.equal(can(null, 'backup.manage'), false);
  });

  test('BackupError يحمل رمزاً ورسالة عربية', () => {
    const e = new BackupError('NOT_READY');
    assert.equal(e.code, 'NOT_READY');
    assert.ok(e.message.length > 0);
    assert.ok(e instanceof BackupError);
  });
});
