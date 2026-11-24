// منطق خدمة قاعدة البيانات (القسم 6) بمحرك node:sqlite البديل (بلا تشفير) + محرك وهمي يحاكي sqlcipher لفحص مسار المفتاح.
// التشفير الحقيقي يُفحص في db-sqlcipher.test.mjs (يحتاج better-sqlite3-multiple-ciphers).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createDbService, loadSqlcipherDriver } = require('../../electron/lib/db-service.cjs');
const { createFsService } = require('../../electron/lib/fs-service.cjs');
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* غير متاح */ }
const opts = { skip: !DatabaseSync && 'node:sqlite غير متاح' };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-db-'));
const files = createFsService({ documentRoot: path.join(base, 'documents'), cacheRoot: path.join(base, 'cache') });
files.ensureRoots();
const plainDriver = DatabaseSync && { available: false, allowPlaintextForTests: true, cipher: null, open: (f) => new DatabaseSync(f) };
// يحاكي sqlcipher: يسجّل كل exec ويجيب PRAGMA cipher كما يفعل sqlite3mc عند تفعيل المفتاح.
function fakeCipherDriver(log) {
  return {
    available: true, cipher: { init: ["PRAGMA cipher='sqlcipher';", 'PRAGMA legacy=4;'], label: 'sqlcipher-compat-4 (test)' },
    open: (f) => {
      const raw = new DatabaseSync(f);
      return {
        exec: (s) => { log.push(s); if (!/^PRAGMA (cipher|legacy|key)/i.test(s)) raw.exec(s); },
        prepare: (s) => (/^PRAGMA cipher$/i.test(s) ? { get: () => ({ cipher: 'sqlcipher' }) } : raw.prepare(s)),
        close: () => raw.close(),
      };
    },
  };
}
const svc = () => createDbService({ files, driver: plainDriver });

test('CRUD وأنواع القيم والعربية', opts, () => {
  const s = svc();
  const { handle } = s.open({ name: 'a.db' });
  s.exec({ handle, sql: 'CREATE TABLE t(id INTEGER PRIMARY KEY, n TEXT, v REAL, b BLOB, f INTEGER)' });
  const r = s.run({ handle, sql: 'INSERT INTO t(n,v,b,f) VALUES (?,?,?,?)', params: ['قضية ١', 1.5, new Uint8Array([1, 2, 3]), true] });
  assert.deepEqual(r, { changes: 1, lastInsertRowId: 1 });
  const row = s.first({ handle, sql: 'SELECT * FROM t WHERE id = ?', params: [1] });
  assert.equal(row.n, 'قضية ١'); assert.equal(row.f, 1);
  assert.ok(row.b instanceof Uint8Array && row.b.length === 3 && row.b[2] === 3);
  assert.equal(s.first({ handle, sql: 'SELECT * FROM t WHERE id = 99', params: [] }), null);
  assert.equal(s.all({ handle, sql: 'SELECT * FROM t', params: [] }).length, 1);
  s.run({ handle, sql: 'INSERT INTO t(n) VALUES (:n)', params: { $n: 'مسمّى' } });
  assert.equal(s.first({ handle, sql: 'SELECT COUNT(*) AS c FROM t', params: [] }).c, 2);
  s.close({ handle });
});

test('مسار الملف: شرطات أمامية داخل documents/SQLite', opts, () => {
  const s = svc();
  const o = s.open({ name: 'p.db' });
  assert.ok(!o.path.includes('\\'));
  assert.ok(o.path.endsWith('/SQLite/p.db'));
  s.close({ handle: o.handle });
});

test('المعاملات: commit وrollback ومنع التداخل', opts, () => {
  const s = svc();
  const { handle } = s.open({ name: 'tx.db' });
  s.exec({ handle, sql: 'CREATE TABLE t(x)' });
  s.tx({ handle, action: 'begin' });
  s.run({ handle, sql: 'INSERT INTO t VALUES (1)', params: [] });
  assert.throws(() => s.tx({ handle, action: 'begin' }), { code: 'DB_TX_ACTIVE' });
  s.tx({ handle, action: 'rollback' });
  assert.equal(s.first({ handle, sql: 'SELECT COUNT(*) c FROM t', params: [] }).c, 0);
  s.tx({ handle, action: 'begin' });
  s.run({ handle, sql: 'INSERT INTO t VALUES (2)', params: [] });
  s.tx({ handle, action: 'commit' });
  assert.equal(s.first({ handle, sql: 'SELECT COUNT(*) c FROM t', params: [] }).c, 1);
  assert.throws(() => s.tx({ handle, action: 'commit' }), { code: 'DB_TX_NONE' });
  s.close({ handle });
});

test('رسائل الأخطاء تصل كما هي (قيود وRAISE عربية) وبلا مسارات', opts, () => {
  const s = svc();
  const { handle } = s.open({ name: 'e.db' });
  s.exec({ handle, sql: `CREATE TABLE u(n TEXT UNIQUE); CREATE TRIGGER no_upd BEFORE UPDATE ON u BEGIN SELECT RAISE(ABORT, 'سجل الحركات لا يقبل التعديل'); END;` });
  s.run({ handle, sql: 'INSERT INTO u VALUES (?)', params: ['a'] });
  assert.throws(() => s.run({ handle, sql: 'INSERT INTO u VALUES (?)', params: ['a'] }), (e) => e.code === 'DB_ERROR' && /UNIQUE constraint failed/.test(e.message));
  assert.throws(() => s.run({ handle, sql: 'UPDATE u SET n = ?', params: ['b'] }), (e) => /سجل الحركات لا يقبل التعديل/.test(e.message));
  assert.throws(() => s.exec({ handle, sql: 'SELEC 1' }), (e) => e.code === 'DB_ERROR' && !/[A-Za-z]:[\\/]/.test(e.message));
  s.close({ handle });
});

test('أنواع معاملات غير مدعومة ترفض', opts, () => {
  const s = svc();
  const { handle } = s.open({ name: 'bad.db' });
  s.exec({ handle, sql: 'CREATE TABLE t(x)' });
  assert.throws(() => s.run({ handle, sql: 'INSERT INTO t VALUES (?)', params: [new Date()] }), { code: 'INVALID_PAYLOAD' });
  s.close({ handle });
});

test('أسماء ومسارات خطرة ترفض', opts, () => {
  const s = svc();
  for (const name of ['..', '../x.db', 'a/b.db', 'a\\b.db', 'x:y.db', ...(process.platform === 'win32' ? ['con.db'] : []), 'نقطة.', '']) {
    assert.throws(() => s.open({ name }), (e) => e.code === 'INVALID_PAYLOAD' || e.code === 'FS_FORBIDDEN', name);
  }
  assert.throws(() => s.open({ name: 'x.db', directory: os.tmpdir() }), { code: 'FS_FORBIDDEN' });
  assert.throws(() => s.open({ name: 'x.db', directory: path.join(base, 'documents', '..', 'evil') }), { code: 'FS_FORBIDDEN' });
  assert.equal(s.count(), 0);
});

test('directory داخل documents مقبول (مثل inspect/restore) سواء مسار عادي أو file://', opts, () => {
  const s = svc();
  const dir = path.join(base, 'documents', 'restore-staging');
  const a = s.open({ name: 'stg.db', directory: dir });
  const b = s.open({ name: 'stg2.db', directory: files.uriOf(dir) });
  assert.ok(fs.existsSync(path.join(dir, 'stg.db')) || a.path.endsWith('/restore-staging/stg.db'));
  s.close({ handle: a.handle }); s.close({ handle: b.handle });
});

test('الحد الأقصى للاتصالات وإغلاق الكل وidempotent close', opts, () => {
  const s = svc();
  const hs = [];
  for (let i = 0; i < 16; i++) hs.push(s.open({ name: `m${i}.db` }).handle);
  assert.throws(() => s.open({ name: 'm99.db' }), { code: 'BUSY' });
  assert.equal(s.closeAll(), 16);
  assert.equal(s.count(), 0);
  assert.equal(s.close({ handle: hs[0] }), null);
  assert.throws(() => s.exec({ handle: hs[0], sql: 'SELECT 1' }), { code: 'DB_NOT_OPEN' });
});

test('closeAll يتراجع عن معاملة معلّقة ويحرّر الملف', opts, () => {
  const s = svc();
  const { handle } = s.open({ name: 'drop.db' });
  s.exec({ handle, sql: 'CREATE TABLE t(x)' });
  s.tx({ handle, action: 'begin' });
  s.run({ handle, sql: 'INSERT INTO t VALUES (1)', params: [] });
  s.closeAll();
  const h2 = s.open({ name: 'drop.db' }).handle;
  assert.equal(s.first({ handle: h2, sql: 'SELECT COUNT(*) c FROM t', params: [] }).c, 0);
  s.close({ handle: h2 });
});

test('المحرك المفقود = فشل مغلق لا قاعدة غير مشفّرة', () => {
  const missing = loadSqlcipherDriver(() => { throw new Error('Cannot find module'); });
  assert.equal(missing.available, false);
  const s = createDbService({ files, driver: missing });
  assert.throws(() => s.open({ name: 'z.db' }), { code: 'DB_ENGINE_MISSING' });
  assert.equal(s.isAvailable(), false);
});

test('مسار المفتاح: تهيئة sqlcipher قبل المفتاح، تهريب الاقتباس، منع المفتاح الفارغ', opts, () => {
  const log = [];
  const s = createDbService({ files, driver: fakeCipherDriver(log) });
  const { handle } = s.open({ name: 'k.db' });
  assert.deepEqual(log.slice(0, 2), ["PRAGMA cipher='sqlcipher';", 'PRAGMA legacy=4;']);
  assert.throws(() => s.exec({ handle, sql: 'CREATE TABLE t(x)' }), { code: 'DB_KEY_REQUIRED' });
  assert.throws(() => s.exec({ handle, sql: "PRAGMA key = '';" }), { code: 'DB_KEY_INVALID' });
  s.exec({ handle, sql: "PRAGMA key = 'a''b-uuid';" });
  assert.ok(log.includes("PRAGMA key='a''b-uuid';"), log.join('|'));
  s.exec({ handle, sql: 'CREATE TABLE t(x)' });
  assert.equal(s.close({ handle }), null);
});

test('PRAGMA cipher_version: قيمة فقط حين يكون المفتاح مطبّقاً والشفرة نشطة، وإلا فارغ (فشل مغلق)', opts, () => {
  const log = [];
  const s = createDbService({ files, driver: fakeCipherDriver(log) });
  const { handle } = s.open({ name: 'cv.db' });
  assert.equal(s.first({ handle, sql: 'PRAGMA cipher_version;', params: [] }), null);
  s.exec({ handle, sql: "PRAGMA key = 'k1';" });
  const r = s.first({ handle, sql: 'pragma cipher_version ;', params: [] });
  assert.match(r.cipher_version, /sqlcipher-compat-4/);
  assert.deepEqual(s.all({ handle, sql: 'PRAGMA cipher_integrity_check;', params: [] }), []);
  s.close({ handle });
  const plain = svc();
  const h = plain.open({ name: 'cv2.db' }).handle;
  assert.equal(plain.first({ handle: h, sql: 'PRAGMA cipher_version;', params: [] }), null);
  plain.close({ handle: h });
});

test(':memory: يعمل بلا مجلد', opts, () => {
  const s = svc();
  const { handle, path: p } = s.open({ name: ':memory:' });
  assert.equal(p, ':memory:');
  s.exec({ handle, sql: 'CREATE TABLE t(x)' });
  s.close({ handle });
});
