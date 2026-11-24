'use strict';
// طباعة وإنشاء PDF (القسم 5). يُحمَّل HTML في نافذة خفية معزولة: بلا JavaScript وبلا شبكة وبلا preload،
// ولا يُسمح فيها إلا بملف HTML المؤقت نفسه وبيانات data: (الصور المضمّنة). تُنفَّذ الطلبات واحداً بعد واحد.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { ScdError } = require('./errors.cjs');

const MAX_HTML = 8 * 1024 * 1024;
const PARTITION = 'scd-print'; // بلا 'persist:' ⇒ جلسة في الذاكرة فقط

const fail = (m) => new ScdError('PRINT_FAILED', m);

function withTimeout(promise, ms, message) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(fail(message)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

function countPages(buf) {
  const m = buf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return m ? m.length : undefined;
}

function createPrintService({ BrowserWindow, files, fsImpl = fs, loadTimeoutMs = 45000, platform = process.platform }) {
  let queue = Promise.resolve();
  const run = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  // Canonical comparison, including Windows path separators and casing.
  const norm = (p) => {
    const value = platform === 'win32'
      ? path.win32.normalize(p)
      : path.resolve(p);
    return platform === 'win32' ? value.toLowerCase() : value;
  };

  // A print window may load only its own HTML document and embedded data URLs.
  function isAllowed(url, allowedFile) {
    if (/^data:/i.test(url)) return true;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'file:') return false;
      return norm(fileURLToPath(parsed)) === norm(allowedFile);
    } catch {
      return false;
    }
  }

  async function withDocument(html, use) {
    if (typeof html !== 'string' || html.length === 0) throw fail('المستند فارغ');
    if (html.length > MAX_HTML) throw fail('المستند أكبر من الحد المسموح للطباعة');
    const dir = path.join(files.cacheRoot, 'print-tmp');
    fsImpl.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, crypto.randomUUID() + '.html');
    fsImpl.writeFileSync(tmp, html, 'utf8');
    const allowedFile = path.resolve(tmp);
    const partition = 'scd-print-' + crypto.randomUUID();
    const win = new BrowserWindow({
      show: false, width: 900, height: 1200,
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, partition,
      },
    });
    const wc = win.webContents;
    const ses = wc.session;

    // Each print window owns its session and its exact allowed document.
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isAllowed(details.url, allowedFile) });
    });
    ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));

    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, url) => {
      if (!isAllowed(url, allowedFile)) e.preventDefault();
    });
    try {
      await withTimeout(win.loadURL(pathToFileURL(tmp).href), loadTimeoutMs, 'انتهت مهلة تجهيز المستند للطباعة');
      return await use(wc);
    } finally {
      try { win.destroy(); } catch { /* أُغلقت */ }
      try { fsImpl.unlinkSync(tmp); } catch { /* حُذف */ }
    }
  }

  return {
    // width/height بالنقاط (1/72 بوصة) مثل expo-print؛ بدونهما: A4 مع احترام @page في الـ HTML.
    toPdf({ html, width, height, landscape = false, base64 = false }) {
      return run(() => withDocument(html, async (wc) => {
        const sized = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
        let pdf;
        try {
          pdf = await wc.printToPDF({
            printBackground: true, landscape: !!landscape,
            ...(sized ? { pageSize: { width: width / 72, height: height / 72 } } : { pageSize: 'A4', preferCSSPageSize: true }),
          });
        } catch { throw fail('تعذّر إنشاء ملف PDF'); }
        const buf = Buffer.from(pdf);
        if (buf.length < 100 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw fail('الملف الناتج ليس PDF صالحاً');
        const outDir = path.join(files.cacheRoot, 'print');
        fsImpl.mkdirSync(outDir, { recursive: true });
        const out = path.join(outDir, crypto.randomUUID() + '.pdf');
        fsImpl.writeFileSync(out, buf);
        const res = { uri: files.uriOf(out) };
        const pages = countPages(buf);
        if (pages) res.numberOfPages = pages;
        if (base64) res.base64 = buf.toString('base64');
        return res;
      }));
    },

    // يفتح حوار الطباعة الأصلي في Windows. إلغاء المستخدم ليس خطأ.
    print({ html }) {
      return run(() => withDocument(html, (wc) => new Promise((resolve, reject) => {
        wc.print({ silent: false, printBackground: true }, (success, reason) => {
          if (success) return resolve({ printed: true });
          if (/cancel/i.test(String(reason || ''))) return resolve({ printed: false });
          return reject(fail('تعذّرت الطباعة'));
        });
      })));
    },
  };
}

module.exports = { createPrintService, countPages, MAX_HTML };
