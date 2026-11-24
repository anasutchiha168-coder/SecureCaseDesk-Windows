'use strict';
// فحص دخاني حقيقي داخل Electron (windows-latest): المحرك المشفّر يعمل بـ ABI الخاص بـ Electron، والملف مشفّر فعلاً.
// الاستعمال: electron scripts/smoke-db.cjs   → يطبع SCD_DB_SMOKE {json} ويخرج 0 عند النجاح.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');
const { createFsService } = require('../electron/lib/fs-service.cjs');
const { createDbService, loadSqlcipherDriver } = require('../electron/lib/db-service.cjs');

app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'scd-smoke6-')));
const checks = [];
const check = (name, ok, extra) => checks.push({ name, ok: !!ok, ...(extra ? { extra } : {}) });
const KEY = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

app.whenReady().then(() => {
  let code = 1;
  try {
    const files = createFsService({ documentRoot: path.join(app.getPath('userData'), 'documents'), cacheRoot: path.join(app.getPath('userData'), 'cache'), platform: process.platform });
    files.ensureRoots();
    const driver = loadSqlcipherDriver();
    check('تحميل better-sqlite3-multiple-ciphers داخل Electron', driver.available, driver.reason);
    if (driver.available) {
      const s = createDbService({ files, driver });
      const o = s.open({ name: 'securecase.db' });
      check('مسار القاعدة بشرطات أمامية داخل documents/SQLite', /\/documents\/SQLite\/securecase\.db$/.test(o.path), o.path);
      let blocked = ''; try { s.exec({ handle: o.handle, sql: 'CREATE TABLE t(x)' }); } catch (e) { blocked = e.code; }
      check('منع إنشاء قاعدة بلا مفتاح', blocked === 'DB_KEY_REQUIRED', blocked);
      s.exec({ handle: o.handle, sql: `PRAGMA key = '${KEY}';` });
      const cv = s.first({ handle: o.handle, sql: 'PRAGMA cipher_version;', params: [] });
      check('PRAGMA cipher_version يعيد قيمة (SQLCipher مفعّل)', cv && /sqlcipher/.test(cv.cipher_version), cv && cv.cipher_version);
      s.exec({ handle: o.handle, sql: 'CREATE TABLE cases (id TEXT PRIMARY KEY, title TEXT NOT NULL)' });
      s.tx({ handle: o.handle, action: 'begin' });
      s.run({ handle: o.handle, sql: 'INSERT INTO cases VALUES (?,?)', params: ['1', 'قضية اعتداء على مواطن'] });
      s.tx({ handle: o.handle, action: 'commit' });
      s.close({ handle: o.handle });
      const raw = fs.readFileSync(o.path);
      check('الترويسة ليست SQLite format 3', raw.subarray(0, 15).toString('latin1') !== 'SQLite format 3');
      check('النص العربي غير ظاهر في الملف', !raw.includes(Buffer.from('قضية اعتداء')));
      const h2 = s.open({ name: 'securecase.db' }).handle;
      s.exec({ handle: h2, sql: `PRAGMA key = '${KEY}';` });
      check('إعادة الفتح بنفس المفتاح تقرأ العربية', s.first({ handle: h2, sql: 'SELECT title FROM cases', params: [] }).title === 'قضية اعتداء على مواطن');
      s.close({ handle: h2 });
      const h3 = s.open({ name: 'securecase.db' }).handle;
      s.exec({ handle: h3, sql: "PRAGMA key = 'wrong';" });
      let wrong = ''; try { s.first({ handle: h3, sql: 'SELECT 1 FROM cases', params: [] }); } catch (e) { wrong = e.code; }
      check('المفتاح الخاطئ يفشل', wrong === 'DB_ERROR', wrong);
      s.close({ handle: h3 });
      check('لا اتصالات مفتوحة بعد الإغلاق', s.count() === 0);
    }
    code = checks.every((c) => c.ok) ? 0 : 1;
  } catch (e) { check('استثناء غير متوقع', false, String(e && e.stack || e).slice(0, 400)); }
  process.stdout.write('SCD_DB_SMOKE ' + JSON.stringify({ ok: code === 0, electron: process.versions.electron, platform: process.platform, checks }) + '\n');
  app.exit(code);
});
