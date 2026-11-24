'use strict';
// فحص دخاني حقيقي داخل Electron (يُشغَّل على windows-latest): ملفات + printToPDF لمستند عربي RTL + حجب الشبكة.
// الاستعمال: electron scripts/smoke-files.cjs   → يطبع SCD_FILES_SMOKE {json} ويخرج 0 عند النجاح.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
const { createFsService } = require('../electron/lib/fs-service.cjs');
const { createPrintService } = require('../electron/lib/print-service.cjs');

app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'scd-smoke5-')));
const checks = [];
const check = (name, ok, extra) => checks.push({ name, ok: !!ok, ...(extra ? { extra } : {}) });

app.whenReady().then(async () => {
  try {
    const files = createFsService({ documentRoot: path.join(app.getPath('userData'), 'documents'), cacheRoot: path.join(app.getPath('userData'), 'cache'), platform: process.platform });
    files.ensureRoots();
    const r = files.roots();
    const u = (n) => r.document + '/' + encodeURIComponent(n);
    files.write(u('تقرير 1.bin'), new Uint8Array([1, 2, 3]), 'create');
    check('كتابة/قراءة اسم عربي بمسافة', files.read(u('تقرير 1.bin')).length === 3);
    files.move(u('تقرير 1.bin'), u('نقل.bin'), 'file');
    check('نقل ملف', files.stat(u('نقل.bin')).exists && !files.stat(u('تقرير 1.bin')).exists);
    let blocked = ''; try { files.read('file:///C:/Windows/win.ini'); } catch (e) { blocked = e.code; }
    check('منع القراءة خارج الجذور', blocked === 'FS_FORBIDDEN', blocked);
    let unc = ''; try { files.read('file://server/share/x.pdf'); } catch (e) { unc = e.code; }
    check('منع مسارات UNC', unc === 'FS_FORBIDDEN', unc);

    const printer = createPrintService({ BrowserWindow, files, platform: process.platform });
    const html = '<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><body style="font-family:Cairo,Tahoma,sans-serif"><h1>تقرير تجريبي</h1><p>نص عربي للتحقق من PDF</p><img src="https://example.invalid/x.png"></body></html>';
    const t0 = Date.now();
    const pdf = await printer.toPdf({ html, width: 595, height: 842 });
    const bytes = files.read(pdf.uri);
    check('PDF صالح (%PDF- وحجم>1KB)', Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-' && bytes.length > 1024, `${bytes.length}B ${Date.now() - t0}ms pages=${pdf.numberOfPages}`);
    const a4 = await printer.toPdf({ html });
    check('PDF بلا أبعاد (A4/CSS)', files.read(a4.uri).length > 1024);
    check('تنظيف print-tmp', fs.readdirSync(path.join(files.cacheRoot, 'print-tmp')).length === 0);
    check('purgeCache', files.purgeCache() >= 1 && fs.readdirSync(files.cacheRoot).length === 0);
  } catch (e) { check('استثناء غير متوقع', false, String(e && e.stack || e)); }
  const ok = checks.every((c) => c.ok);
  process.stdout.write('SCD_FILES_SMOKE ' + JSON.stringify({ ok, platform: process.platform, electron: process.versions.electron, checks }) + '\n');
  app.exit(ok ? 0 : 1);
});
setTimeout(() => { process.stdout.write('SCD_FILES_SMOKE ' + JSON.stringify({ ok: false, error: 'timeout', checks }) + '\n'); app.exit(1); }, 90000);
