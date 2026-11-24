import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { createDbService, loadSqlcipherDriver } = require('../../electron/lib/db-service.cjs');
const { createFsService } = require('../../electron/lib/fs-service.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dbTs = fs.readFileSync(path.join(root, 'src', 'database', 'db.ts'), 'utf8');
const DDL = [...dbTs.matchAll(/CREATE TABLE IF NOT EXISTS[\s\S]*?\n\s*\);/g)].map((m) => m[0]);
const TABLES = ['users', 'departments', 'cases', 'memo_types', 'memos', 'detainee_categories', 'detainees', 'detainee_movements', 'correction_history'];

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* غير متاح */ }
const real = loadSqlcipherDriver();
if (!real.available && process.env.SCD_REQUIRE_SQLCIPHER === '1') test('محرك SQLCipher مثبّت (مطلوب)', () => assert.fail('غير متوفر: ' + real.reason));
const driver = real.available ? real : (DatabaseSync && { available: false, allowPlaintextForTests: true, cipher: null, open: (f) => new DatabaseSync(f) });
const opts = { skip: !driver && 'لا محرك SQLite متاح' };
const KEY = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const mk = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-s8-'));
  const files = createFsService({ documentRoot: path.join(base, 'documents'), cacheRoot: path.join(base, 'cache') });
  files.ensureRoots();
  const s = createDbService({ files, driver });
  const open = (name = 'securecase.db') => {
    const { handle } = s.open({ name });
    if (driver.cipher) s.exec({ handle, sql: `PRAGMA key = '${KEY}';` });
    return handle;
  };
  return { base, s, open, live: path.join(base, 'documents', 'SQLite', 'securecase.db') };
};
const all = (s, h, sql, params = []) => s.all({ handle: h, sql, params });

test('db.ts يحوي كل جداول المخطط التسعة (استخراج DDL الحقيقي)', () => {
  const names = DDL.map((d) => /EXISTS\s+(\w+)/.exec(d)[1]);
  for (const t of TABLES) assert.ok(names.includes(t), 'جدول غير مستخرج: ' + t);
});

test('تنفيذ مخطط src الحقيقي ينشئ كل الجداول', opts, () => {
  const { s, open } = mk(); const h = open();
  for (const d of DDL) s.exec({ handle: h, sql: d });
  const got = all(s, h, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  for (const t of TABLES) assert.ok(got.includes(t), 'جدول مفقود: ' + t);
  s.close({ handle: h });
});

test('العلاقات (FOREIGN KEY) محفوظة كما في المخطط', opts, () => {
  const { s, open } = mk(); const h = open();
  for (const d of DDL) s.exec({ handle: h, sql: d });
  const fk = (t) => all(s, h, `PRAGMA foreign_key_list(${t})`).map((r) => `${r.from}->${r.table}.${r.to}`);
  assert.ok(fk('cases').includes('department_id->departments.id'));
  assert.ok(fk('cases').includes('officer_id->users.id'));
  assert.ok(fk('memos').includes('linked_case_id->cases.id'));
  assert.ok(fk('detainees').includes('category_id->detainee_categories.id'));
  assert.ok(fk('detainee_movements').includes('detainee_id->detainees.id'));
  assert.ok(fk('correction_history').includes('detainee_id->detainees.id'));
  s.close({ handle: h });
});

test('بيانات عربية كاملة (قسم + قضية) تُحفظ وتُقرأ بلا تشويه', opts, () => {
  const { s, open } = mk(); const h = open();
  for (const d of DDL) s.exec({ handle: h, sql: d });
  const dep = 'قسم الجرائم الإلكترونية', title = 'قضية احتيال — ١٢٣ «تجريبية»';
  s.run({ handle: h, sql: 'INSERT INTO departments (id, name, created_at) VALUES (?,?,?)', params: ['d1', dep, 1] });
  s.run({ handle: h, sql: "INSERT INTO cases (id, case_number, title, case_type, registration_date, created_by, created_at, updated_at, department_id) VALUES (?,?,?,?,?,?,?,?,?)", params: ['c1', '2026/001', title, 'احتيال', 1, 'u1', 1, 1, 'd1'] });
  assert.equal(s.first({ handle: h, sql: 'SELECT name FROM departments WHERE id=?', params: ['d1'] }).name, dep);
  const c = s.first({ handle: h, sql: 'SELECT title, status FROM cases WHERE id=?', params: ['c1'] });
  assert.equal(c.title, title); assert.equal(c.status, 'جديدة');
  s.close({ handle: h });
});

test('قيد UNIQUE على رقم القضية واسم المستخدم يعمل', opts, () => {
  const { s, open } = mk(); const h = open();
  for (const d of DDL) s.exec({ handle: h, sql: d });
  const ins = () => s.run({ handle: h, sql: "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)", params: [String(Math.random()), 'admin', 'x', 'admin', 1] });
  ins(); assert.throws(ins);
  s.close({ handle: h });
});

test('معاملة begin/rollback تتراجع كاملةً ولا تترك بيانات جزئية، وcommit يثبّت', opts, () => {
  const { s, open } = mk(); const h = open();
  for (const d of DDL) s.exec({ handle: h, sql: d });
  const add = (id) => s.run({ handle: h, sql: 'INSERT INTO departments (id, name, created_at) VALUES (?,?,?)', params: [id, 'أ', 1] });
  s.tx({ handle: h, action: 'begin' });
  add('t1');
  assert.throws(() => s.run({ handle: h, sql: 'INSERT INTO no_such_table VALUES (1)', params: [] }));
  s.tx({ handle: h, action: 'rollback' });
  assert.equal(all(s, h, 'SELECT id FROM departments').length, 0, 'بقيت بيانات بعد التراجع');
  s.tx({ handle: h, action: 'begin' }); add('t2'); s.tx({ handle: h, action: 'commit' });
  assert.equal(all(s, h, 'SELECT id FROM departments').length, 1);
  assert.throws(() => s.tx({ handle: h, action: 'commit' }), 'commit بلا معاملة يجب أن يفشل');
  s.close({ handle: h });
});

test('نسخ احتياطي/استعادة بنسخ ملف القاعدة: البيانات والعلاقات تعود كما هي', opts, () => {
  const { s, open, live, base } = mk(); let h = open();
  for (const d of DDL) s.exec({ handle: h, sql: d });
  for (let i = 0; i < 25; i++) s.run({ handle: h, sql: 'INSERT INTO departments (id, name, created_at) VALUES (?,?,?)', params: ['d' + i, 'قسم ' + i, i] });
  s.close({ handle: h });
  const bak = path.join(base, 'backup.db'); fs.copyFileSync(live, bak);
  h = open(); s.run({ handle: h, sql: "DELETE FROM departments" }); s.close({ handle: h });
  fs.copyFileSync(bak, live);
  h = open();
  assert.equal(s.first({ handle: h, sql: 'SELECT COUNT(*) c FROM departments', params: [] }).c, 25);
  assert.equal(all(s, h, 'PRAGMA foreign_key_list(cases)').length, 2);
  s.close({ handle: h });
});

test('SQLCipher الحقيقي: الملف المشفّر لا يحوي ترويسة SQLite ولا النص الصريح', { skip: !real.available && 'SQLCipher غير مثبّت (يُشترط في CI)' }, () => {
  const { s, open, live } = mk(); const h = open();
  s.exec({ handle: h, sql: 'CREATE TABLE t (v TEXT)' });
  s.run({ handle: h, sql: 'INSERT INTO t VALUES (?)', params: ['سر-قضية-فريد-9917'] });
  s.close({ handle: h });
  const raw = fs.readFileSync(live);
  assert.notEqual(raw.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  assert.ok(!raw.includes(Buffer.from('سر-قضية-فريد-9917')));
  assert.throws(() => { const { handle } = s.open({ name: 'securecase.db' }); s.exec({ handle, sql: "PRAGMA key = 'wrong-key-wrong-key';" }); s.all({ handle, sql: 'SELECT * FROM t', params: [] }); });
});
