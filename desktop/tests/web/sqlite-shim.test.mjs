// يختبر shim expo-sqlite (القسم 6) مقابل معالجات Electron الحقيقية وخدمة قاعدة البيانات عبر جسر وهمي (structuredClone كـ IPC).
// المحرك هنا node:sqlite البديل؛ التشفير الحقيقي في tests/electron/db-sqlcipher.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register, createRequire } from 'node:module';
register('./_ts-resolve.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const { buildHandlers } = require('../../electron/ipc/handlers.cjs');
const { createFsService } = require('../../electron/lib/fs-service.cjs');
const { createDbService } = require('../../electron/lib/db-service.cjs');
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* غير متاح */ }
const opts = { skip: !DatabaseSync && 'node:sqlite غير متاح' };

if (DatabaseSync) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-sqshim-'));
  const files = createFsService({ documentRoot: path.join(base, 'documents'), cacheRoot: path.join(base, 'cache') });
  files.ensureRoots();
  const db = createDbService({ files, driver: { available: false, allowPlaintextForTests: true, cipher: null, open: (f) => new DatabaseSync(f) } });
  const handlers = buildHandlers({ app: {}, getWindow: () => ({ isDestroyed: () => false }), versions: {}, platform: process.platform, arch: 'x64', files, db });
  const run = (ch, p) => { const e = handlers.get(ch); const data = e.run(e.validate(structuredClone(p))); return data === undefined ? null : data; };
  globalThis.window = {
    scd: {
      isDesktop: true, platform: process.platform,
      invokeSync: (ch, p) => structuredClone(run(ch, p)),
      invoke: async (ch, p) => { const e = handlers.get(ch); try { return structuredClone(await e.run(e.validate(structuredClone(p)))); } catch (err) { throw new Error(`[${err.code || 'INTERNAL'}] ${err.message}`); } },
    },
  };
  globalThis.__db = db;
}
const SQLite = DatabaseSync ? await import('../../shims/expo-sqlite.ts') : null;

test('defaultDatabaseDirectory ومسار القاعدة بصيغة src (شرطات أمامية، بلا file://)', opts, async () => {
  assert.ok(SQLite.defaultDatabaseDirectory.endsWith('/SQLite'), SQLite.defaultDatabaseDirectory);
  assert.ok(!SQLite.defaultDatabaseDirectory.includes('\\') && !/^file:/.test(SQLite.defaultDatabaseDirectory));
  const db = await SQLite.openDatabaseAsync('securecase.db');
  assert.equal(db.databasePath, SQLite.defaultDatabaseDirectory + '/securecase.db');
  assert.equal(db.databasePath.lastIndexOf('/'), SQLite.defaultDatabaseDirectory.length);
  await db.closeAsync();
});

test('نمط db.ts: key ثم cipher_version (فارغ مع المحرك البديل = فشل مغلق) ثم CRUD', opts, async () => {
  const db = await SQLite.openDatabaseAsync('securecase.db');
  await db.execAsync(`PRAGMA key = 'uuid-1';`);
  assert.equal(await db.getFirstAsync('PRAGMA cipher_version;'), null);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, title TEXT NOT NULL, n INTEGER)`);
  await db.runAsync('INSERT INTO cases (id,title,n) VALUES (?,?,?)', ['a', 'قضية اعتداء', 5]);
  await db.runAsync('INSERT INTO cases (id,title,n) VALUES (?,?,?)', 'b', 'قضية سرقة', 7);   // صيغة variadic
  await db.runAsync('INSERT INTO cases (id,title,n) VALUES ($id,$t,$n)', { $id: 'c', $t: 'x', $n: 1 });
  assert.equal((await db.getAllAsync('SELECT * FROM cases ORDER BY id')).length, 3);
  assert.equal((await db.getFirstAsync('SELECT title FROM cases WHERE id = ?', ['b'])).title, 'قضية سرقة');
  assert.equal(await db.getFirstAsync('SELECT * FROM cases WHERE id = ?', ['zz']), null);
  await db.closeAsync();
  await db.closeAsync(); // idempotent
  await assert.rejects(db.getAllAsync('SELECT 1'), { code: 'DB_NOT_OPEN' });
});

test('withTransactionAsync: commit، rollback عند الخطأ مع إعادة الرمي، والخطأ الأصلي يُحفظ', opts, async () => {
  const db = await SQLite.openDatabaseAsync('tx.db');
  await db.execAsync('CREATE TABLE t(x INTEGER UNIQUE)');
  await db.withTransactionAsync(async () => { await db.runAsync('INSERT INTO t VALUES (1)'); await db.runAsync('INSERT INTO t VALUES (2)'); });
  assert.equal((await db.getFirstAsync('SELECT COUNT(*) c FROM t')).c, 2);
  await assert.rejects(db.withTransactionAsync(async () => { await db.runAsync('INSERT INTO t VALUES (3)'); throw new Error('boom'); }), /boom/);
  assert.equal((await db.getFirstAsync('SELECT COUNT(*) c FROM t')).c, 2);
  await assert.rejects(db.withTransactionAsync(async () => { await db.runAsync('INSERT INTO t VALUES (4)'); await db.runAsync('INSERT INTO t VALUES (4)'); }), /UNIQUE constraint failed/);
  assert.equal((await db.getFirstAsync('SELECT COUNT(*) c FROM t')).c, 2);
  await db.closeAsync();
});

test('فتح بدليل صريح (مثل inspect/restore) وبـ useNewConnection، واتصالان على نفس الملف', opts, async () => {
  const dir = SQLite.defaultDatabaseDirectory + '/staging';
  const a = await SQLite.openDatabaseAsync('inspect.db', { useNewConnection: true }, dir);
  assert.equal(a.databasePath, dir + '/inspect.db');
  await a.execAsync('CREATE TABLE t(x)'); await a.runAsync('INSERT INTO t VALUES (1)');
  const b = await SQLite.openDatabaseAsync('inspect.db', { useNewConnection: true }, dir);
  assert.equal((await b.getFirstAsync('SELECT COUNT(*) c FROM t')).c, 1);
  await a.closeAsync(); await b.closeAsync();
});

test('BLOB يذهب ويعود Uint8Array، وأخطاء القيود تحتفظ بنصها', opts, async () => {
  const db = await SQLite.openDatabaseAsync('blob.db');
  await db.execAsync(`CREATE TABLE b(id INTEGER PRIMARY KEY, d BLOB, n TEXT NOT NULL)`);
  await db.runAsync('INSERT INTO b(d,n) VALUES (?,?)', [new Uint8Array([9, 8, 7]), 'x']);
  const r = await db.getFirstAsync('SELECT d FROM b');
  assert.deepEqual([...r.d], [9, 8, 7]);
  await assert.rejects(db.runAsync('INSERT INTO b(d,n) VALUES (?,?)', [null, null]), /NOT NULL constraint failed/);
  await db.closeAsync();
});

test('إغلاق الكل (إعادة تحميل الواجهة) يُسقط المقابض ولا يُبقي معاملة', opts, async () => {
  const db = await SQLite.openDatabaseAsync('reload.db');
  await db.execAsync('CREATE TABLE t(x)');
  const pending = db.withTransactionAsync(async () => { await db.runAsync('INSERT INTO t VALUES (1)'); globalThis.__db.closeAll(); await db.runAsync('INSERT INTO t VALUES (2)'); });
  await assert.rejects(pending, { code: 'DB_NOT_OPEN' });
  const again = await SQLite.openDatabaseAsync('reload.db');
  assert.equal((await again.getFirstAsync('SELECT COUNT(*) c FROM t')).c, 0);
  await again.closeAsync();
});
