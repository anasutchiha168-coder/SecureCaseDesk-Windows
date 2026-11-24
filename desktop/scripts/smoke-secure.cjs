'use strict';
// فحص دخاني حقيقي داخل Electron على Windows (GitHub Actions): safeStorage/DPAPI يعمل فعلاً والملف لا يحوي النص الصريح.
// الاستعمال: electron scripts/smoke-secure.cjs → يطبع SCD_SECURE_SMOKE {json} ويخرج 0 عند النجاح.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, safeStorage } = require('electron');
const { createSecureService } = require('../electron/lib/secure-service.cjs');

app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'scd-smoke7-')));
const checks = [];
const check = (name, ok, extra) => checks.push({ name, ok: !!ok, ...(extra !== undefined ? { extra } : {}) });
const SECRET = 'f47ac10b-58cc-4372-a567-0e02b2c3d479-سر-عربي';

app.whenReady().then(() => {
  let code = 1;
  try {
    const dir = path.join(app.getPath('userData'), 'secure');
    check('منصة Windows', process.platform === 'win32' || process.env.SCD_SMOKE_ANY_OS === '1', process.platform);
    check('safeStorage.isEncryptionAvailable() = true', safeStorage.isEncryptionAvailable() === true);
    const s = createSecureService({ safeStorage, dir });
    check('الخلفية dpapi وليست insecure', s.info().backend === 'dpapi' && s.info().insecure === false);
    s.set('db_encryption_key', SECRET);
    check('قراءة القيمة بعد الكتابة (عربي)', s.get('db_encryption_key') === SECRET);
    const raw = fs.readFileSync(path.join(dir, 'items.json'));
    check('الملف لا يحوي القيمة الصريحة', !raw.includes(Buffer.from(SECRET)) && !raw.toString('utf8').includes('f47ac10b'));
    const blob = Buffer.from(JSON.parse(raw.toString('utf8')).items.db_encryption_key.v, 'base64');
    check('النص المشفّر يبدأ بترويسة OSCrypt (v10/v11) على Windows', process.platform !== 'win32' || /^v1[01]/.test(blob.subarray(0, 3).toString('latin1')), blob.subarray(0, 3).toString('latin1'));
    const again = createSecureService({ safeStorage, dir });
    check('البقاء بعد إعادة إنشاء الخدمة', again.get('db_encryption_key') === SECRET);
    let t = Date.now();
    const ttl = createSecureService({ safeStorage, dir: path.join(dir, 'ttl'), now: () => t, sessionTtl: 1000 });
    ttl.set('securecase_session_uid', 'u1'); t += 2000;
    check('انتهاء الجلسة', ttl.get('securecase_session_uid') === null);
    s.remove('db_encryption_key');
    check('الحذف', s.get('db_encryption_key') === null);
    code = checks.every((c) => c.ok) ? 0 : 1;
  } catch (e) {
    check('استثناء غير متوقع', false, String(e && e.message));
  }
  process.stdout.write('SCD_SECURE_SMOKE ' + JSON.stringify({ ok: code === 0, checks }) + '\n');
  app.exit(code);
});
