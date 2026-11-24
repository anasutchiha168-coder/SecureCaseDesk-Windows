// الاستعادة بأسلوب أندرويد بالمحرك الحقيقي: (1) استبدال ملف القاعدة بنسخة بعد إغلاق الاتصالات
// (2) قاعدة أنشأها sqlcipher الرسمي (تعادل نسخة أندرويد) تُنسخ مكان القاعدة وتُفتح وتُفحص.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createDbService, loadSqlcipherDriver } = require('../../electron/lib/db-service.cjs');
const { createFsService } = require('../../electron/lib/fs-service.cjs');
const REQUIRE = process.env.SCD_REQUIRE_SQLCIPHER === '1';
const FIX = process.env.SCD_FIXTURE_DIR;
const driver = loadSqlcipherDriver();
if (!driver.available && REQUIRE) test('محرك SQLCipher مثبّت (مطلوب في CI)', () => assert.fail('غير متوفر: ' + driver.reason));
const skip = !driver.available && 'better-sqlite3-multiple-ciphers غير مثبّتة';
const KEY = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const mk = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-rst-'));
  const files = createFsService({ documentRoot: path.join(base, 'documents'), cacheRoot: path.join(base, 'cache') });
  files.ensureRoots();
  return { base, s: createDbService({ files, driver }), live: path.join(base, 'documents', 'SQLite', 'securecase.db') };
};
const openKeyed = (s, key = KEY) => { const { handle } = s.open({ name: 'securecase.db' }); s.exec({ handle, sql: `PRAGMA key = '${key}';` }); return handle; };
const count = (s, h, t) => s.first({ handle: h, sql: `SELECT COUNT(*) c FROM ${t}`, params: [] }).c;

test('استبدال ملف القاعدة بنسخة احتياطية بعد closeAll ثم الفتح بنفس المفتاح', { skip }, () => {
  const { base, s, live } = mk();
  let h = openKeyed(s);
  s.exec({ handle: h, sql: 'CREATE TABLE cases (id TEXT PRIMARY KEY, title TEXT NOT NULL)' });
  s.run({ handle: h, sql: 'INSERT INTO cases VALUES (?,?)', params: ['1', 'قضية أولى'] });
  s.closeAll();
  const bak = path.join(base, 'backup.db'); fs.copyFileSync(live, bak);
  h = openKeyed(s);
  s.run({ handle: h, sql: 'INSERT INTO cases VALUES (?,?)', params: ['2', 'قضية بعد النسخة'] });
  assert.equal(count(s, h, 'cases'), 2);
  assert.equal(s.closeAll(), 1);
  for (const x of ['-wal', '-shm', '-journal']) fs.rmSync(live + x, { force: true });
  fs.copyFileSync(bak, live);
  h = openKeyed(s);
  assert.equal(count(s, h, 'cases'), 1);
  assert.match(s.first({ handle: h, sql: 'PRAGMA cipher_version;', params: [] }).cipher_version, /sqlcipher/);
  assert.deepEqual(s.all({ handle: h, sql: 'PRAGMA cipher_integrity_check;', params: [] }), []);
  s.closeAll();
});

test('نسخة من sqlcipher الرسمي (تعادل أندرويد) تُنسخ مكان القاعدة وتُفتح وتُقرأ', { skip: skip || (!FIX && 'SCD_FIXTURE_DIR غير مضبوط (يعمل في job التوافق)') }, () => {
  const { s, live } = mk();
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'sqlcipher-4.db'), live);
  const key = fs.readFileSync(path.join(FIX, 'fixture-key.txt'), 'utf8');
  const h = openKeyed(s, key);
  assert.equal(count(s, h, 'cases'), 3);
  assert.equal(s.first({ handle: h, sql: "SELECT title FROM cases WHERE id='1'", params: [] }).title, 'قضية اعتداء');
  assert.match(s.first({ handle: h, sql: 'PRAGMA cipher_version;', params: [] }).cipher_version, /sqlcipher/);
  assert.deepEqual(s.all({ handle: h, sql: 'PRAGMA cipher_integrity_check;', params: [] }), []);
  assert.throws(() => s.run({ handle: h, sql: "UPDATE movements SET t='y'", params: [] }), /سجل الحركات لا يقبل التعديل/);
  s.closeAll();
});

test('مفتاح خاطئ على نسخة مستعادة يُرفض ولا يُنشئ قاعدة بديلة', { skip: skip || (!FIX && 'SCD_FIXTURE_DIR غير مضبوط') }, () => {
  const { s, live } = mk();
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'sqlcipher-4.db'), live);
  const before = fs.statSync(live).size;
  const h = openKeyed(s, 'wrong-key');
  assert.throws(() => s.first({ handle: h, sql: 'SELECT COUNT(*) c FROM cases', params: [] }), { code: 'DB_ERROR' });
  s.closeAll();
  assert.equal(fs.statSync(live).size, before);
});
