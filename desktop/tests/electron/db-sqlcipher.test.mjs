// اختبارات المحرك الحقيقي (SQLite3 Multiple Ciphers بوضع sqlcipher). تُتخطّى محلياً إن لم تُثبَّت الحزمة،
// وفي CI يُضبط SCD_REQUIRE_SQLCIPHER=1 فيصبح غيابها فشلاً. SCD_FIXTURE_DIR = مجلد قواعد أنشأها sqlcipher CLI الرسمي (مستقل عن محركنا).
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-sqlc-'));
const files = createFsService({ documentRoot: path.join(base, 'documents'), cacheRoot: path.join(base, 'cache') });
files.ensureRoots();
const svc = () => createDbService({ files, driver });
const dbFile = (n) => path.join(base, 'documents', 'SQLite', n);
const open = (s, name, key = KEY) => { const { handle } = s.open({ name }); if (key) s.exec({ handle, sql: `PRAGMA key = '${key}';` }); return handle; };
const SCHEMA = `CREATE TABLE cases (id TEXT PRIMARY KEY, title TEXT NOT NULL, n INTEGER);
  CREATE TABLE movements (id INTEGER PRIMARY KEY, t TEXT);
  CREATE TRIGGER trg_no_update BEFORE UPDATE ON movements BEGIN SELECT RAISE(ABORT, 'سجل الحركات لا يقبل التعديل'); END;`;

test('تشفير فعلي: الترويسة ليست SQLite والنص العربي غير ظاهر، والمفتاح الصحيح فقط يفتح', { skip }, () => {
  const s = svc();
  const h = open(s, 'enc.db');
  assert.match(s.first({ handle: h, sql: 'PRAGMA cipher_version;', params: [] }).cipher_version, /sqlcipher/);
  s.exec({ handle: h, sql: SCHEMA });
  for (let i = 0; i < 20; i++) s.run({ handle: h, sql: 'INSERT INTO cases VALUES (?,?,?)', params: [String(i), 'قضية اعتداء على مواطن رقم ' + i, i] });
  s.close({ handle: h });
  const raw = fs.readFileSync(dbFile('enc.db'));
  assert.notEqual(raw.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  assert.ok(!raw.includes(Buffer.from('قضية اعتداء')), 'نص عربي ظاهر في الملف');
  const ok = open(s, 'enc.db');
  assert.equal(s.first({ handle: ok, sql: 'SELECT COUNT(*) c FROM cases', params: [] }).c, 20);
  s.close({ handle: ok });
  const wrong = open(s, 'enc.db', 'wrong-key');
  assert.throws(() => s.first({ handle: wrong, sql: 'SELECT COUNT(*) c FROM cases', params: [] }), { code: 'DB_ERROR' });
  s.close({ handle: wrong });
  const none = open(s, 'enc.db', null);
  assert.throws(() => s.first({ handle: none, sql: 'SELECT COUNT(*) c FROM cases', params: [] }), { code: 'DB_ERROR' });
  s.close({ handle: none });
});

test('قاعدة جديدة بلا مفتاح تُمنع (لا ملف غير مشفّر بالخطأ)', { skip }, () => {
  const s = svc();
  const h = open(s, 'nokey.db', null);
  assert.throws(() => s.exec({ handle: h, sql: 'CREATE TABLE t(x)' }), { code: 'DB_KEY_REQUIRED' });
  s.close({ handle: h });
});

test('المشغّلات والقيود والرسائل العربية تعمل على المحرك المشفّر', { skip }, () => {
  const s = svc();
  const h = open(s, 'trg.db');
  s.exec({ handle: h, sql: SCHEMA });
  s.run({ handle: h, sql: 'INSERT INTO movements(t) VALUES (?)', params: ['x'] });
  assert.throws(() => s.run({ handle: h, sql: 'UPDATE movements SET t = ?', params: ['y'] }), /سجل الحركات لا يقبل التعديل/);
  assert.throws(() => s.run({ handle: h, sql: 'INSERT INTO cases VALUES (?,?,?)', params: ['1', null, 1] }), /NOT NULL constraint failed/);
  s.close({ handle: h });
});

test('WAL + checkpoint + نسخ الملف بعد الإغلاق (أسلوب النسخ الاحتياطي) ثم فتحه بنفس المفتاح', { skip }, () => {
  const s = svc();
  const h = open(s, 'wal.db');
  s.all({ handle: h, sql: 'PRAGMA journal_mode = WAL;', params: [] });
  s.exec({ handle: h, sql: SCHEMA });
  s.run({ handle: h, sql: 'INSERT INTO cases VALUES (?,?,?)', params: ['1', 'قضية', 1] });
  s.all({ handle: h, sql: 'PRAGMA wal_checkpoint(TRUNCATE);', params: [] });
  s.close({ handle: h });
  fs.copyFileSync(dbFile('wal.db'), dbFile('wal-copy.db'));
  const c = open(s, 'wal-copy.db');
  assert.equal(s.first({ handle: c, sql: 'SELECT title FROM cases', params: [] }).title, 'قضية');
  s.close({ handle: c });
});

test('cipher_integrity_check: سليمة = لا صفوف، وصفحة معطوبة = صفوف/خطأ', { skip }, () => {
  const s = svc();
  const h = open(s, 'integ.db');
  s.exec({ handle: h, sql: SCHEMA });
  s.exec({ handle: h, sql: 'BEGIN' });
  for (let i = 0; i < 3000; i++) s.run({ handle: h, sql: 'INSERT INTO cases VALUES (?,?,?)', params: [String(i), 'عنوان طويل نسبياً لضمان عدة صفحات ' + i, i] });
  s.exec({ handle: h, sql: 'COMMIT' });
  assert.deepEqual(s.all({ handle: h, sql: 'PRAGMA cipher_integrity_check;', params: [] }), []);
  s.close({ handle: h });
  const f = dbFile('integ.db');
  const buf = fs.readFileSync(f);
  assert.ok(buf.length > 4096 * 4, 'الملف أصغر من المتوقع');
  buf[4096 * 3 + 200] ^= 0xff;
  fs.writeFileSync(f, buf);
  const h2 = open(s, 'integ.db');
  let bad = false;
  try { bad = s.all({ handle: h2, sql: 'PRAGMA cipher_integrity_check;', params: [] }).length > 0; } catch { bad = true; }
  assert.ok(bad, 'التلف لم يُكتشف');
  s.close({ handle: h2 });
});

test('توافق مع SQLCipher الرسمي: قاعدة أنشأها sqlcipher CLI تُفتح وتُقرأ هنا (تعادل نسخة أندرويد)', { skip: skip || (!FIX && 'SCD_FIXTURE_DIR غير مضبوط') }, () => {
  const s = svc();
  const key = fs.readFileSync(path.join(FIX, 'fixture-key.txt'), 'utf8').trim();
  fs.mkdirSync(path.dirname(dbFile('x')), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'sqlcipher-4.db'), dbFile('from-cli.db'));
  const h = open(s, 'from-cli.db', key);
  assert.equal(s.first({ handle: h, sql: 'SELECT COUNT(*) c FROM cases', params: [] }).c, 3);
  assert.equal(s.first({ handle: h, sql: "SELECT title FROM cases WHERE id = '1'", params: [] }).title, 'قضية اعتداء');
  assert.throws(() => s.run({ handle: h, sql: 'UPDATE movements SET t = ?', params: ['y'] }), /سجل الحركات لا يقبل التعديل/);
  assert.deepEqual(s.all({ handle: h, sql: 'PRAGMA cipher_integrity_check;', params: [] }), []);
  s.close({ handle: h });
});

test('توافق معاكس: قاعدة أنشأناها هنا تُكتب في SCD_FIXTURE_DIR ليقرأها sqlcipher CLI', { skip: skip || (!FIX && 'SCD_FIXTURE_DIR غير مضبوط') }, () => {
  const s = svc();
  const key = fs.readFileSync(path.join(FIX, 'fixture-key.txt'), 'utf8').trim();
  const h = open(s, 'windows-made.db', key);
  s.exec({ handle: h, sql: SCHEMA });
  for (const [i, t] of [[1, 'قضية اعتداء'], [2, 'قضية سرقة'], [3, 'قضية ٣']]) s.run({ handle: h, sql: 'INSERT INTO cases VALUES (?,?,?)', params: [String(i), t, i] });
  s.close({ handle: h });
  fs.copyFileSync(dbFile('windows-made.db'), path.join(FIX, 'windows-made.db'));
  assert.ok(fs.statSync(path.join(FIX, 'windows-made.db')).size > 0);
});
