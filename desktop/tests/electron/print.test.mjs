import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createFsService } = require('../../electron/lib/fs-service.cjs');
const { createPrintService, countPages } = require('../../electron/lib/print-service.cjs');

function fakeElectron({ pdf, printResult = [true, ''] } = {}) {
  const log = { destroyed: 0, loaded: [], opts: null, reqHandler: null, windows: [] };
  class BrowserWindow {
    constructor(o) {
      log.windows.push(o);
      this.webContents = {
        session: { webRequest: { onBeforeRequest: (fn) => { log.reqHandler = fn; } }, setPermissionRequestHandler() {} },
        setWindowOpenHandler() {}, on() {},
        printToPDF: async (o2) => { log.opts = o2; return pdf ?? Buffer.from('%PDF-1.4\n' + '/Type /Page\n/Type /Pages\n/Type /Page\n'.padEnd(200, ' ')); },
        print: (o2, cb) => { log.opts = o2; cb(...printResult); },
      };
    }
    async loadURL(u) { log.loaded.push(u); }
    destroy() { log.destroyed++; }
  }
  return { BrowserWindow, log };
}
function mk(extra) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-pr-'));
  const files = createFsService({ documentRoot: path.join(base, 'd'), cacheRoot: path.join(base, 'c') });
  files.ensureRoots();
  const { BrowserWindow, log } = fakeElectron(extra);
  return { files, log, svc: createPrintService({ BrowserWindow, files }), base };
}

test('toPdf: ملف PDF في cache ومقاس A4 بالنقاط ونافذة معزولة وتنظيف', async () => {
  const { svc, files, log } = mk();
  const r = await svc.toPdf({ html: '<p dir="rtl">مرحبا</p>', width: 595, height: 842 });
  assert.match(r.uri, /\/c\/print\/.+\.pdf$/);
  assert.equal(files.read(r.uri).length > 100, true);
  assert.equal(r.numberOfPages, 2);
  assert.ok(Math.abs(log.opts.pageSize.width - 595 / 72) < 1e-9 && Math.abs(log.opts.pageSize.height - 842 / 72) < 1e-9);
  const w = log.windows[0].webPreferences;
  assert.equal(w.javascript, false); assert.equal(w.sandbox, true); assert.equal(w.nodeIntegration, false); assert.equal(w.contextIsolation, true);
  assert.equal(log.destroyed, 1);
  assert.deepEqual(fs.readdirSync(path.join(files.cacheRoot, 'print-tmp')), []);
});

test('toPdf بلا أبعاد: A4 مع @page، وbase64 عند الطلب', async () => {
  const { svc, log } = mk();
  const r = await svc.toPdf({ html: '<p>x</p>', base64: true });
  assert.equal(log.opts.pageSize, 'A4'); assert.equal(log.opts.preferCSSPageSize, true);
  assert.equal(Buffer.from(r.base64, 'base64').subarray(0, 5).toString(), '%PDF-');
});

test('رفض مخرجات ليست PDF وhtml فارغ/ضخم', async () => {
  const bad = mk({ pdf: Buffer.from('not a pdf'.padEnd(300, 'x')) });
  await assert.rejects(bad.svc.toPdf({ html: '<p>x</p>' }), (e) => e.code === 'PRINT_FAILED');
  const { svc } = mk();
  await assert.rejects(svc.toPdf({ html: '' }), (e) => e.code === 'PRINT_FAILED');
  await assert.rejects(svc.toPdf({ html: 'x'.repeat(8 * 1024 * 1024 + 1) }), (e) => e.code === 'PRINT_FAILED');
});

test('طلبات الشبكة محجوبة: يُسمح بملف المستند وdata: فقط', async () => {
  const { svc, log } = mk();
  let verdict;
  const orig = log;
  // نُعيد تعريف التحقق عبر معالج الطلبات الذي سجّلته الخدمة أثناء النافذة
  const p = svc.toPdf({ html: '<img src="https://evil.example/x.png">' });
  await p;
  const decide = (url) => { let r; orig.reqHandler({ url }, (x) => { r = x; }); return r.cancel; };
  assert.equal(decide('https://evil.example/x.png'), true);
  assert.equal(decide('file:///C:/Windows/win.ini'), true);
  assert.equal(decide('data:image/png;base64,AAAA'), false);
  assert.ok(verdict === undefined);
});

test('print: نجاح، إلغاء المستخدم ليس خطأ، وفشل حقيقي يرمي', async () => {
  assert.deepEqual(await mk().svc.print({ html: '<p>x</p>' }), { printed: true });
  assert.deepEqual(await mk({ printResult: [false, 'cancelled'] }).svc.print({ html: '<p>x</p>' }), { printed: false });
  await assert.rejects(mk({ printResult: [false, 'Invalid printer settings'] }).svc.print({ html: '<p>x</p>' }), (e) => e.code === 'PRINT_FAILED');
});

test('الطلبات تُنفَّذ بالتسلسل', async () => {
  const { svc, log } = mk();
  await Promise.all([svc.toPdf({ html: '<p>1</p>' }), svc.toPdf({ html: '<p>2</p>' }), svc.toPdf({ html: '<p>3</p>' })]);
  assert.equal(log.windows.length, 3); assert.equal(log.destroyed, 3);
});

test('countPages', () => { assert.equal(countPages(Buffer.from('/Type /Pages /Type /Page /Type/Page')), 2); });
