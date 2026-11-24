#!/usr/bin/env bash
# SecureCaseDesk Windows — القسم 5 (ملفات/طباعة/PDF/استيراد/تصدير/مشاركة). شغّله من جذر المستودع.
set -euo pipefail
[ -d desktop/electron ] && [ -f desktop/shims/registry.json ] || { echo "شغّل السكربت من جذر المستودع (الذي يحوي desktop/)"; exit 1; }
command -v python3 >/dev/null || { echo "python3 مطلوب"; exit 1; }
echo "▶ كتابة ملفات القسم 5"
mkdir -p "$(dirname '.github/workflows/desktop-section5.yml')"
cat > '.github/workflows/desktop-section5.yml' <<'SCD_EOF_1'
name: Desktop section 5 (files + print)
on:
  workflow_dispatch:
  push:
    paths: ['desktop/**', '.github/workflows/desktop-section5.yml']
jobs:
  files:
    runs-on: windows-latest
    timeout-minutes: 40
    defaults:
      run:
        working-directory: desktop
    steps:
      - name: Keep LF line endings (SHA-256 backup check)
        working-directory: .
        run: git config --global core.autocrlf false
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --no-audit --no-fund
      - name: Verify (backup + shims + RN-web + electron + web tests)
        run: npm run verify:section5
      - name: Real Electron smoke (files + printToPDF on Windows)
        run: npm run smoke:files
      - name: Build web bundle
        run: npm run build:web
      - name: Electron smoke on the real bundle
        run: npm run smoke:web
SCD_EOF_1
mkdir -p "$(dirname 'desktop/docs/section-5-report.md')"
cat > 'desktop/docs/section-5-report.md' <<'SCD_EOF_2'
# القسم 5 — الملفات والطباعة وPDF والاستيراد/التصدير والمشاركة

## المعماري
- `expo-file-system` (File/Directory/Paths/FileMode) → shim فوق **IPC متزامن** (`ipcRenderer.sendSync`) لأن الواجهة متزامنة. `bytes()/text()` غير متزامنة.
- main يفحص كل مسار: مجلدان فقط `userData/documents` (دائم) و`userData/cache` (يُفرَّغ عند الإقلاع والإغلاق) + ما منحه المستخدم بحوار النظام (مجلد أو ملف). يمنع: `..`، UNC، تدفقات NTFS، أسماء CON/NUL…، الروابط الرمزية الخارجة، كتابة `.exe/.bat/.ps1/.lnk/.js…`.
- `expo-document-picker` → حوار الفتح؛ الملف يُنسخ إلى `cache/picked/<uuid>/<الاسم>`.
- `Directory.pickDirectoryAsync` → حوار مجلد يمنح كتابة داخله فقط (يُستعمل في «حفظ التقرير/المذكرة»). `createFile` يضيف « (1)» عند التضارب.
- `expo-print` → نافذة خفية بلا JS وبلا شبكة (يُسمح بملف المستند وdata: فقط): `printToPDF` أو حوار الطباعة الأصلي. الإلغاء ليس خطأ.
- `expo-sharing` → فتح PDF/صور/Office بالبرنامج الافتراضي (قائمة بيضاء)، غير ذلك يُظهَر في المستكشف. لا تنفيذ أبداً.
- `Image` (react-native shim) يعرض `file://` عبر `blob:` لأن Chromium/CSP يمنعان `file://` من `app://`.

## فروق عن Android (موثّقة)
move ملف فوق ملف يستبدله؛ move مجلد فوق وجهة موجودة يفشل؛ `writeBytes` متزامنة (يحفظ الترتيب)؛ مشاركة = فتح/إظهار.

## ملاحظة للقسم 6
قاعدة البيانات يجب أن تُوضع تحت `documents/SQLite/` كي تعمل أكواد النسخ الاحتياطي في src (التي تنسخ/تقرأ ملف القاعدة عبر File) دون تعديل.

## ما تحقق فعلياً
اختبارات Node على Linux: 50 (Electron) + 99 (ويب، منها 9 لهذا القسم) ناجحة. **لم يُجرَّب بعد على Windows/Electron الحقيقي**: حوارات النظام، حوار الطباعة، `printToPDF`، `shell.openPath` — يغطيها `npm run smoke:files` في CI (ما عدا الحوارات، تُختبر يدوياً).
SCD_EOF_2
mkdir -p "$(dirname 'desktop/electron/ipc/fs-handlers.cjs')"
cat > 'desktop/electron/ipc/fs-handlers.cjs' <<'SCD_EOF_3'
'use strict';
// معالجات القسم 5: الملفات، حوارات الفتح/الحفظ، الطباعة وPDF، والمشاركة (فتح/إظهار في المستكشف).
// تُسجَّل فقط عند حقن ctx.files من main.cjs (الخدمات تحتاج مسارات المستخدم الحقيقية).
const path = require('node:path');
const { ScdError } = require('../lib/errors.cjs');
const { object } = require('../lib/validate.cjs');
const { DANGEROUS_EXT } = require('../lib/fs-paths.cjs');

const bad = (m) => new ScdError('INVALID_PAYLOAD', m);
const str = (v, name, max = 4096) => { if (typeof v !== 'string' || !v || v.length > max) throw bad(`${name} غير صالح`); return v; };
const optStr = (v, name, max) => (v === undefined || v === null ? undefined : str(v, name, max));
const bool = (v, name) => { if (v === undefined || v === null) return false; if (typeof v !== 'boolean') throw bad(`${name} غير صالح`); return v; };
const int = (v, name, min, max) => { if (!Number.isSafeInteger(v) || v < min || v > max) throw bad(`${name} غير صالح`); return v; };
const kindOf = (v) => { if (v === undefined || v === null) return undefined; if (v !== 'file' && v !== 'dir') throw bad('kind غير صالح'); return v; };
const dataOf = (v) => { if (typeof v === 'string' || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v; throw bad('البيانات غير صالحة'); };

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.zip': 'application/zip', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
// الأنواع التي يجوز فتحها بالبرنامج الافتراضي؛ أي شيء آخر يُظهَر في المستكشف فقط (لا تنفيذ أبداً).
const OPENABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.txt', '.csv', '.xlsx', '.docx']);

function filtersOf(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 10) throw bad('filters غير صالح');
  return v.map((f) => {
    const o = object(f);
    const name = str(o.name, 'اسم الفلتر', 60);
    if (!Array.isArray(o.extensions) || o.extensions.length === 0 || o.extensions.length > 20) throw bad('extensions غير صالح');
    const extensions = o.extensions.map((e) => {
      if (typeof e !== 'string' || !(e === '*' || /^[A-Za-z0-9]{1,10}$/.test(e))) throw bad('امتداد غير صالح');
      return e;
    });
    return { name, extensions };
  });
}

function registerFiles(add, ctx) {
  const { files, printer, dialog, shell } = ctx;
  const win = () => {
    const w = ctx.getWindow();
    if (!w || w.isDestroyed()) throw new ScdError('NO_WINDOW', 'النافذة الرئيسية غير متاحة');
    return w;
  };
  const uri = (p) => str(p.uri, 'uri');

  add('scd:fs:roots', (p) => { if (p !== undefined && p !== null) throw bad('لا حمولة'); }, () => files.roots());
  add('scd:fs:stat', (p) => ({ uri: uri(object(p)) }), (p) => files.stat(p.uri));
  add('scd:fs:exists', (p) => { const o = object(p); return { uri: uri(o), kind: kindOf(o.kind) }; }, (p) => {
    const s = files.stat(p.uri);
    return p.kind === 'file' ? s.isFile : p.kind === 'dir' ? s.isDirectory : s.exists;
  });
  add('scd:fs:read', (p) => {
    const o = object(p);
    if (o.as !== undefined && o.as !== 'bytes' && o.as !== 'text') throw bad('as غير صالح');
    return { uri: uri(o), as: o.as || 'bytes' };
  }, (p) => files.read(p.uri, p.as));
  add('scd:fs:read-range', (p) => {
    const o = object(p);
    return { uri: uri(o), offset: int(o.offset, 'offset', 0, 2 ** 40), length: int(o.length, 'length', 0, 64 * 1024 * 1024) };
  }, (p) => files.readRange(p.uri, p.offset, p.length));
  add('scd:fs:write', (p) => {
    const o = object(p);
    const mode = o.mode === undefined ? 'overwrite' : o.mode;
    if (!['create', 'create-overwrite', 'overwrite', 'append'].includes(mode)) throw bad('mode غير صالح');
    return { uri: uri(o), data: dataOf(o.data), mode, intermediates: bool(o.intermediates, 'intermediates') };
  }, (p) => files.write(p.uri, p.data, p.mode, p.intermediates));
  add('scd:fs:write-at', (p) => {
    const o = object(p);
    if (!ArrayBuffer.isView(o.bytes)) throw bad('bytes غير صالح');
    return { uri: uri(o), offset: int(o.offset, 'offset', 0, 2 ** 40), bytes: o.bytes };
  }, (p) => files.writeAt(p.uri, p.offset, p.bytes));
  add('scd:fs:mkdir', (p) => { const o = object(p); return { uri: uri(o), intermediates: bool(o.intermediates, 'intermediates'), idempotent: bool(o.idempotent, 'idempotent') }; },
    (p) => files.mkdir(p.uri, { intermediates: p.intermediates, idempotent: p.idempotent }));
  add('scd:fs:remove', (p) => { const o = object(p); return { uri: uri(o), kind: kindOf(o.kind) }; }, (p) => files.remove(p.uri, { kind: p.kind }));
  add('scd:fs:list', (p) => ({ uri: uri(object(p)) }), (p) => files.list(p.uri));
  add('scd:fs:move', (p) => { const o = object(p); return { from: str(o.from, 'from'), to: str(o.to, 'to'), kind: kindOf(o.kind) }; }, (p) => files.move(p.from, p.to, p.kind));
  add('scd:fs:copy', (p) => { const o = object(p); return { from: str(o.from, 'from'), to: str(o.to, 'to'), kind: kindOf(o.kind) }; }, (p) => files.copy(p.from, p.to, p.kind));

  // ── حوارات النظام ──
  add('scd:fs:open-dialog', (p) => {
    const o = object(p === undefined || p === null ? {} : p);
    return {
      directory: bool(o.directory, 'directory'), multiple: bool(o.multiple, 'multiple'),
      copyToCache: o.copyToCache === undefined ? true : bool(o.copyToCache, 'copyToCache'),
      title: optStr(o.title, 'العنوان', 120), filters: filtersOf(o.filters),
    };
  }, async (p) => {
    const w = win();
    if (p.directory) {
      const r = await dialog.showOpenDialog(w, { title: p.title, properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
      const dir = files.policy.grantDir(r.filePaths[0], true);
      return { canceled: false, uri: files.uriOf(dir), name: path.basename(dir) || dir };
    }
    const r = await dialog.showOpenDialog(w, {
      title: p.title, filters: p.filters.length ? p.filters : undefined,
      properties: ['openFile', ...(p.multiple ? ['multiSelections'] : [])],
    });
    if (r.canceled || !r.filePaths || r.filePaths.length === 0) return { canceled: true };
    const out = r.filePaths.slice(0, 20).map((fp) => {
      let info;
      if (p.copyToCache) info = files.pickedCopy(fp);
      else { files.policy.grantFile(fp, false); info = files.describePath(fp); }
      const mimeType = MIME[path.extname(info.name).toLowerCase()] || 'application/octet-stream';
      return { ...info, mimeType };
    });
    return { canceled: false, files: out };
  });

  add('scd:fs:save-dialog', (p) => {
    const o = object(p === undefined || p === null ? {} : p);
    return { defaultName: optStr(o.defaultName, 'الاسم', 200), title: optStr(o.title, 'العنوان', 120), filters: filtersOf(o.filters) };
  }, async (p) => {
    const r = await dialog.showSaveDialog(win(), {
      title: p.title, defaultPath: p.defaultName ? files.safeName(p.defaultName) : undefined,
      filters: p.filters.length ? p.filters : undefined,
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    if (DANGEROUS_EXT.has(path.extname(r.filePath).toLowerCase())) throw new ScdError('FS_FORBIDDEN', 'نوع الملف غير مسموح بالحفظ');
    const target = files.policy.grantFile(r.filePath, true);
    return { canceled: false, uri: files.uriOf(target), name: path.basename(target) };
  });

  // ── الطباعة وPDF ──
  const printPayload = (p) => {
    const o = object(p);
    if (typeof o.html !== 'string' || o.html.length === 0) throw bad('html مطلوب');
    return o;
  };
  add('scd:print:to-pdf', (p) => {
    const o = printPayload(p);
    const num = (v) => (v === undefined || v === null ? undefined : (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 20000 ? v : (() => { throw bad('أبعاد غير صالحة'); })()));
    return { html: o.html, width: num(o.width), height: num(o.height), landscape: bool(o.landscape, 'landscape'), base64: bool(o.base64, 'base64') };
  }, (p) => printer.toPdf(p));
  add('scd:print:print', (p) => ({ html: printPayload(p).html }), (p) => printer.print(p));

  // ── المشاركة: لا توجد «ورقة مشاركة» في Windows؛ نفتح الملف بالبرنامج الافتراضي أو نُظهره في المستكشف ──
  add('scd:share:available', (p) => { if (p !== undefined && p !== null) throw bad('لا حمولة'); }, () => true);
  add('scd:share:reveal', (p) => {
    const o = object(p);
    if (o.action !== undefined && o.action !== 'open' && o.action !== 'show') throw bad('action غير صالح');
    return { uri: uri(o), action: o.action || 'open' };
  }, async (p) => {
    const local = files.localPath(p.uri, 'read');
    const st = files.stat(p.uri);
    if (!st.isFile) throw new ScdError('NOT_FOUND', 'الملف غير موجود');
    if (p.action === 'open' && OPENABLE.has(path.extname(local).toLowerCase())) {
      const err = await shell.openPath(local);
      if (!err) return { opened: true };
    }
    shell.showItemInFolder(local);
    return { opened: false };
  });
}

module.exports = { registerFiles, MIME, OPENABLE };
SCD_EOF_3
mkdir -p "$(dirname 'desktop/electron/ipc/register.cjs')"
cat > 'desktop/electron/ipc/register.cjs' <<'SCD_EOF_4'
'use strict';
const { CHANNELS, SYNC } = require('../channels.cjs');
const { ScdError, toEnvelopeError } = require('../lib/errors.cjs');
const { isTrustedUrl } = require('../lib/security.cjs');

// يسجّل كل قناة بغلاف موحّد { ok, data | error }. ثلاث بوابات قبل أي تنفيذ:
// 1) القناة في القائمة البيضاء  2) المُرسل هو الإطار الرئيسي لنافذتنا وبمصدر موثوق  3) الحمولة صالحة.
// قنوات SYNC (ملفات القسم 5) تُسجَّل أيضاً لـ ipcRenderer.sendSync، ومعالجاتها متزامنة حتماً.
function registerIpc({ ipcMain, handlers, getWindow, devOrigin, logger }) {
  const trusted = (event) => {
    const w = getWindow();
    if (!w || w.isDestroyed() || event.sender !== w.webContents) return false;
    const frame = event.senderFrame;
    if (!frame || frame !== w.webContents.mainFrame) return false;
    return isTrustedUrl(frame.url, devOrigin);
  };
  const guard = (channel, event) => {
    if (!trusted(event)) {
      logger.warn(`رُفض طلب IPC من مصدر غير موثوق على ${channel}`);
      throw new ScdError('UNTRUSTED_SENDER', 'مصدر الطلب غير موثوق');
    }
  };
  const fail = (channel, e) => {
    if (!(e instanceof ScdError)) logger.error(`فشل ${channel}: ${e && e.message}`);
    return { ok: false, error: toEnvelopeError(e) };
  };

  for (const channel of Object.keys(CHANNELS)) {
    const entry = handlers.get(channel);
    if (!entry) throw new Error(`لا معالج للقناة ${channel}`);
    ipcMain.handle(channel, async (event, payload) => {
      try {
        guard(channel, event);
        const data = await entry.run(entry.validate(payload), event);
        return { ok: true, data: data === undefined ? null : data };
      } catch (e) { return fail(channel, e); }
    });
  }

  for (const channel of SYNC) {
    const entry = handlers.get(channel);
    if (!entry) throw new Error(`لا معالج للقناة ${channel}`);
    ipcMain.on(channel, (event, payload) => {
      try {
        guard(channel, event);
        const data = entry.run(entry.validate(payload), event);
        if (data && typeof data.then === 'function') throw new Error('معالج غير متزامن على قناة متزامنة');
        event.returnValue = { ok: true, data: data === undefined ? null : data };
      } catch (e) { event.returnValue = fail(channel, e); }
    });
  }
}
module.exports = { registerIpc };
SCD_EOF_4
mkdir -p "$(dirname 'desktop/electron/lib/fs-paths.cjs')"
cat > 'desktop/electron/lib/fs-paths.cjs' <<'SCD_EOF_5'
'use strict';
// سياسة المسارات للقسم 5: الواجهة لا ترسل إلا عناوين file:// أو مسارات مطلقة، ولا يُنفَّذ شيء
// إلا داخل: (1) documents  (2) cache  (3) مجلدات/ملفات منحتها حوارات النظام صراحةً (grants).
const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { ScdError } = require('./errors.cjs');

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const BAD_CHARS = /[<>"|?*\x00-\x1f]/;
const DANGEROUS_EXT = new Set(['.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.msi', '.msp', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.lnk', '.hta', '.reg', '.cpl', '.jar', '.scf', '.url', '.sys', '.pif', '.gadget']);

const forbidden = (m) => new ScdError('FS_FORBIDDEN', m || 'المسار غير مسموح');
const bad = (m) => new ScdError('INVALID_PAYLOAD', m);
const pathApi = (platform) => (platform === 'win32' ? path.win32 : path.posix);

// يحوّل عنوان الواجهة إلى مسار محلي مطلق ومُطبَّع، أو يرمي. لا يتحقق من الجذور (هذا شأن createPolicy).
function toLocalPath(uri, platform = process.platform) {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 4096 || uri.includes('\0')) throw bad('مسار الملف غير صالح');
  const P = pathApi(platform);
  let p;
  if (/^file:/i.test(uri)) {
    let u;
    try { u = new URL(uri); } catch { throw bad('عنوان الملف غير صالح'); }
    if (u.host && u.host !== 'localhost') throw forbidden('مسارات الشبكة غير مسموحة');
    try { p = fileURLToPath(u, { windows: platform === 'win32' }); } catch { throw bad('عنوان الملف غير صالح'); }
  } else if (platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(uri) : uri.startsWith('/')) {
    p = uri;
  } else {
    throw bad('يجب أن يكون المسار مطلقاً');
  }
  if (p.includes('\0')) throw bad('مسار الملف غير صالح');
  if (platform === 'win32') {
    if (p.startsWith('\\\\')) throw forbidden('مسارات الشبكة والأجهزة غير مسموحة');
    if (p.slice(2).includes(':')) throw forbidden('تدفقات NTFS البديلة غير مسموحة');
  }
  const abs = P.resolve(p);
  if (platform === 'win32') {
    for (const seg of abs.slice(3).split('\\')) {
      if (!seg) continue;
      if (RESERVED.test(seg) || BAD_CHARS.test(seg) || /[. ]$/.test(seg)) throw forbidden('اسم ملف غير مسموح على Windows');
    }
  }
  return abs;
}

function createPolicy({ roots, platform = process.platform, fsImpl = fs }) {
  const P = pathApi(platform);
  const key = (p) => (platform === 'win32' ? p.toLowerCase() : p);
  const rootList = Object.values(roots).map((r) => P.resolve(r));
  const grants = new Map(); // key(path) → { path, dir, write }
  const MAX_GRANTS = 256;

  const within = (base, p) => {
    const rel = P.relative(base, p);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + P.sep) && !P.isAbsolute(rel));
  };
  const same = (a, b) => key(P.resolve(a)) === key(P.resolve(b));

  // الروابط الرمزية/الوصلات لا تُخرجنا من الجذر: نحلّ المسار الحقيقي لأقرب سلف موجود ثم نلحق به الباقي
  // (يعمل أيضاً لملف لم يُنشأ بعد، مثل ملف حوار «حفظ باسم»).
  function realResolve(p) {
    let cur = p;
    const rest = [];
    for (;;) {
      if (fsImpl.existsSync(cur)) break;
      const up = P.dirname(cur);
      if (up === cur) return null;
      rest.unshift(P.basename(cur));
      cur = up;
    }
    try { return P.join(fsImpl.realpathSync(cur), ...rest); } catch { return null; }
  }
  function realWithin(base, p) {
    const rb = realResolve(base);
    const rp = realResolve(p);
    return !!rb && !!rp && within(rb, rp);
  }

  function check(p, access) {
    if (access === 'write' && DANGEROUS_EXT.has(P.extname(p).toLowerCase())) throw forbidden('نوع الملف غير مسموح بالكتابة');
    for (const r of rootList) if (within(r, p) && realWithin(r, p)) return p;
    for (const g of grants.values()) {
      if (access !== 'read' && !g.write) continue;
      const ok = g.dir ? within(g.path, p) : key(g.path) === key(p);
      if (ok && realWithin(g.path, p)) return p;
    }
    throw forbidden('الوصول خارج المجلدات المسموحة');
  }

  const grant = (p, dir, write) => {
    const n = P.resolve(p);
    if (!grants.has(key(n)) && grants.size >= MAX_GRANTS) grants.delete(grants.keys().next().value);
    grants.set(key(n), { path: n, dir, write });
    return n;
  };

  return {
    platform, P, same, within,
    resolve: (uri, access = 'read') => check(toLocalPath(uri, platform), access),
    checkPath: (p, access = 'read') => check(P.resolve(p), access),
    isRoot: (p) => rootList.some((r) => key(r) === key(P.resolve(p))) || [...grants.values()].some((g) => key(g.path) === key(P.resolve(p))),
    grantDir: (p, write = true) => grant(p, true, write),
    grantFile: (p, write = false) => grant(p, false, write),
    toUri: (p) => pathToFileURL(p).href.replace(/\/+$/, ''),
  };
}

module.exports = { toLocalPath, createPolicy, DANGEROUS_EXT };
SCD_EOF_5
mkdir -p "$(dirname 'desktop/electron/lib/fs-service.cjs')"
cat > 'desktop/electron/lib/fs-service.cjs' <<'SCD_EOF_6'
'use strict';
// عمليات الملفات في العملية الرئيسية (القسم 5). كلها متزامنة داخلياً ليعمل بها IPC المتزامن (File.exists/handle.readBytesSync...).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScdError } = require('./errors.cjs');
const { createPolicy } = require('./fs-paths.cjs');

const MAX_BYTES = 1024 * 1024 * 1024;       // 1GiB لكل قراءة/كتابة كاملة
const MAX_RANGE = 64 * 1024 * 1024;         // 64MiB لكل قراءة/كتابة جزئية
const bad = (m) => new ScdError('INVALID_PAYLOAD', m);

function mapError(e) {
  if (e instanceof ScdError) return e;
  switch (e && e.code) {
    case 'ENOENT': return new ScdError('NOT_FOUND', 'العنصر غير موجود');
    case 'EEXIST': case 'ENOTEMPTY': return new ScdError('ALREADY_EXISTS', 'العنصر موجود مسبقاً');
    case 'EACCES': case 'EPERM': return new ScdError('ACCESS_DENIED', 'تم رفض الوصول إلى الملف');
    case 'EBUSY': return new ScdError('BUSY', 'الملف مستخدم من برنامج آخر');
    case 'ENOSPC': return new ScdError('DISK_FULL', 'لا توجد مساحة كافية على القرص');
    case 'EISDIR': case 'ENOTDIR': return new ScdError('INVALID_PAYLOAD', 'نوع العنصر غير مناسب للعملية');
    default: return new ScdError('IO_ERROR', 'فشلت عملية الملفات');
  }
}

// اسم ملف آمن لنسخ الملفات المُختارة (يزيل محارف Windows الممنوعة والأسماء المحجوزة).
function safeName(name, fallback = 'file') {
  let n = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 120);
  if (!n || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(n)) n = fallback;
  return n;
}

const toU8 = (buf) => (buf.buffer.byteLength === buf.length ? new Uint8Array(buf.buffer, buf.byteOffset, buf.length) : Uint8Array.from(buf));
function toBuf(data) {
  let b;
  if (typeof data === 'string') b = Buffer.from(data, 'utf8');
  else if (ArrayBuffer.isView(data)) b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else if (data instanceof ArrayBuffer) b = Buffer.from(data);
  else throw bad('بيانات غير صالحة');
  if (b.length > MAX_BYTES) throw new ScdError('FILE_TOO_LARGE', 'الملف أكبر من الحد المسموح');
  return b;
}

function createFsService({ documentRoot, cacheRoot, platform = process.platform, fsImpl = fs }) {
  const policy = createPolicy({ roots: { document: documentRoot, cache: cacheRoot }, platform, fsImpl });
  const P = policy.P;
  const statOf = (p) => {
    try { return fsImpl.statSync(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
  };
  const uriOf = (p) => policy.toUri(p);
  const kindOk = (st, kind) => {
    if (kind === 'file' && !st.isFile()) throw bad('العنصر ليس ملفاً');
    if (kind === 'dir' && !st.isDirectory()) throw bad('العنصر ليس مجلداً');
  };
  const existingParent = (p) => {
    const st = statOf(P.dirname(p));
    if (!st || !st.isDirectory()) throw new ScdError('NOT_FOUND', 'المجلد الأب غير موجود');
  };

  const api = {
    policy, cacheRoot: P.resolve(cacheRoot), documentRoot: P.resolve(documentRoot), uriOf, safeName,
    localPath: (uri, access = 'read') => policy.resolve(uri, access),

    ensureRoots() { fsImpl.mkdirSync(documentRoot, { recursive: true }); fsImpl.mkdirSync(cacheRoot, { recursive: true }); },
    purgeCache() {
      let names = [];
      try { names = fsImpl.readdirSync(cacheRoot); } catch { return 0; }
      let n = 0;
      for (const name of names) {
        try { fsImpl.rmSync(path.join(cacheRoot, name), { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); n++; } catch { /* ملف مفتوح في برنامج آخر */ }
      }
      return n;
    },
    roots: () => ({ document: uriOf(documentRoot), cache: uriOf(cacheRoot), platform }),

    stat(uri) {
      const p = policy.resolve(uri, 'read');
      const st = statOf(p);
      if (!st) return { exists: false, isFile: false, isDirectory: false, size: 0, modificationTime: 0 };
      return { exists: true, isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.isFile() ? st.size : 0, modificationTime: Math.floor(st.mtimeMs) };
    },

    read(uri, as = 'bytes') {
      const p = policy.resolve(uri, 'read');
      const st = statOf(p);
      if (!st) throw new ScdError('NOT_FOUND', 'الملف غير موجود');
      if (!st.isFile()) throw bad('العنصر ليس ملفاً');
      if (st.size > MAX_BYTES) throw new ScdError('FILE_TOO_LARGE', 'الملف أكبر من الحد المسموح');
      const buf = fsImpl.readFileSync(p);
      return as === 'text' ? buf.toString('utf8') : toU8(buf);
    },

    readRange(uri, offset, length) {
      if (length > MAX_RANGE) throw new ScdError('FILE_TOO_LARGE', 'المقطع المطلوب أكبر من الحد');
      const p = policy.resolve(uri, 'read');
      const fd = fsImpl.openSync(p, 'r');
      try {
        const b = Buffer.allocUnsafeSlow(length);
        let n = 0;
        while (n < length) {
          const r = fsImpl.readSync(fd, b, n, length - n, offset + n);
          if (r === 0) break;
          n += r;
        }
        return toU8(n === length ? b : b.subarray(0, n));
      } finally { fsImpl.closeSync(fd); }
    },

    // mode: create (يفشل إن وُجد) | create-overwrite | overwrite | append
    write(uri, data, mode = 'overwrite', intermediates = false) {
      const p = policy.resolve(uri, 'write');
      const buf = toBuf(data);
      if (intermediates) { policy.checkPath(P.dirname(p), 'write'); fsImpl.mkdirSync(P.dirname(p), { recursive: true }); }
      const flag = mode === 'create' ? 'wx' : mode === 'append' ? 'a' : 'w';
      const fd = fsImpl.openSync(p, flag);
      try {
        let off = 0;
        while (off < buf.length) off += fsImpl.writeSync(fd, buf, off, buf.length - off);
        if (flag !== 'a') fsImpl.fsyncSync(fd);
      } finally { fsImpl.closeSync(fd); }
      return null;
    },

    writeAt(uri, offset, bytes) {
      if (!ArrayBuffer.isView(bytes)) throw bad('بيانات غير صالحة');
      if (bytes.byteLength > MAX_RANGE) throw new ScdError('FILE_TOO_LARGE', 'المقطع أكبر من الحد');
      const p = policy.resolve(uri, 'write');
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const fd = fsImpl.openSync(p, 'r+');
      try {
        let off = 0;
        while (off < buf.length) off += fsImpl.writeSync(fd, buf, off, buf.length - off, offset + off);
      } finally { fsImpl.closeSync(fd); }
      return null;
    },

    mkdir(uri, { intermediates = false, idempotent = false } = {}) {
      const p = policy.resolve(uri, 'write');
      const st = statOf(p);
      if (st) {
        if (st.isDirectory() && idempotent) return null;
        throw new ScdError('ALREADY_EXISTS', 'العنصر موجود مسبقاً');
      }
      fsImpl.mkdirSync(p, { recursive: !!intermediates });
      return null;
    },

    remove(uri, { kind } = {}) {
      const p = policy.resolve(uri, 'delete');
      if (policy.isRoot(p)) throw new ScdError('FS_FORBIDDEN', 'لا يمكن حذف مجلد جذري');
      const st = statOf(p);
      if (!st) throw new ScdError('NOT_FOUND', 'العنصر غير موجود');
      kindOk(st, kind);
      if (st.isDirectory()) fsImpl.rmSync(p, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
      else fsImpl.unlinkSync(p);
      return null;
    },

    list(uri) {
      const p = policy.resolve(uri, 'read');
      const st = statOf(p);
      if (!st) throw new ScdError('NOT_FOUND', 'المجلد غير موجود');
      if (!st.isDirectory()) throw bad('العنصر ليس مجلداً');
      const out = [];
      for (const name of fsImpl.readdirSync(p)) {
        const child = path.join(p, name);
        const cs = statOf(child);
        if (!cs) continue;
        out.push({ name, uri: uriOf(child), isDirectory: cs.isDirectory(), size: cs.isFile() ? cs.size : 0, modificationTime: Math.floor(cs.mtimeMs) });
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    // نقل: ملف→ملف يستبدل الوجهة؛ مجلد→وجهة موجودة يفشل. عبر الأقراص: نسخ ثم حذف.
    move(from, to, kind) {
      const pf = policy.resolve(from, 'delete');
      const pt = policy.resolve(to, 'write');
      if (policy.isRoot(pf)) throw new ScdError('FS_FORBIDDEN', 'لا يمكن نقل مجلد جذري');
      const sf = statOf(pf);
      if (!sf) throw new ScdError('NOT_FOUND', 'العنصر غير موجود');
      kindOk(sf, kind);
      if (policy.same(pf, pt)) return null;
      if (sf.isDirectory() && policy.within(pf, pt)) throw bad('لا يمكن نقل مجلد إلى داخل نفسه');
      existingParent(pt);
      const st = statOf(pt);
      if (st && !(sf.isFile() && st.isFile())) throw new ScdError('ALREADY_EXISTS', 'الوجهة موجودة مسبقاً');
      try {
        fsImpl.renameSync(pf, pt);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        if (sf.isDirectory()) { fsImpl.cpSync(pf, pt, { recursive: true, errorOnExist: true, force: false }); fsImpl.rmSync(pf, { recursive: true }); }
        else { fsImpl.copyFileSync(pf, pt); fsImpl.unlinkSync(pf); }
      }
      return null;
    },

    copy(from, to, kind) {
      const pf = policy.resolve(from, 'read');
      const pt = policy.resolve(to, 'write');
      const sf = statOf(pf);
      if (!sf) throw new ScdError('NOT_FOUND', 'العنصر غير موجود');
      kindOk(sf, kind);
      if (policy.same(pf, pt)) throw bad('المصدر والوجهة متطابقان');
      if (sf.isDirectory() && policy.within(pf, pt)) throw bad('لا يمكن نسخ مجلد إلى داخل نفسه');
      existingParent(pt);
      const st = statOf(pt);
      if (sf.isDirectory()) {
        if (st) throw new ScdError('ALREADY_EXISTS', 'الوجهة موجودة مسبقاً');
        fsImpl.cpSync(pf, pt, { recursive: true, errorOnExist: true, force: false });
      } else {
        if (st && !st.isFile()) throw new ScdError('ALREADY_EXISTS', 'الوجهة مجلد');
        fsImpl.copyFileSync(pf, pt);
      }
      return null;
    },

    // ملف اختاره المستخدم في حوار النظام: يُنسخ إلى cache/picked/<uuid>/<name> ليعمل به بقية التطبيق دون منح خارجي.
    pickedCopy(srcPath) {
      const st = statOf(srcPath);
      if (!st || !st.isFile()) throw new ScdError('NOT_FOUND', 'الملف المختار غير متاح');
      const name = safeName(path.basename(srcPath));
      const dir = path.join(cacheRoot, 'picked', crypto.randomUUID());
      fsImpl.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, name);
      fsImpl.copyFileSync(srcPath, dest);
      return { uri: uriOf(dest), name, size: st.size, lastModified: Math.floor(st.mtimeMs) };
    },
    describePath(p) {
      const st = statOf(p);
      if (!st || !st.isFile()) throw new ScdError('NOT_FOUND', 'الملف المختار غير متاح');
      return { uri: uriOf(p), name: safeName(path.basename(p)), size: st.size, lastModified: Math.floor(st.mtimeMs) };
    },
  };
  // كل دالة عامة تُحوَّل أخطاؤها إلى ScdError بلا تسريب مسارات.
  for (const k of ['ensureRoots', 'purgeCache', 'stat', 'read', 'readRange', 'write', 'writeAt', 'mkdir', 'remove', 'list', 'move', 'copy', 'pickedCopy', 'describePath']) {
    const fn = api[k];
    api[k] = (...a) => { try { return fn(...a); } catch (e) { throw mapError(e); } };
  }
  return api;
}

module.exports = { createFsService, mapError, safeName };
SCD_EOF_6
mkdir -p "$(dirname 'desktop/electron/lib/print-service.cjs')"
cat > 'desktop/electron/lib/print-service.cjs' <<'SCD_EOF_7'
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
  let allowedFile = null;
  let sessionReady = false;
  const run = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
  const norm = (p) => (platform === 'win32' ? p.toLowerCase() : p);

  function isAllowed(url) {
    if (/^data:/i.test(url)) return true;
    try { return allowedFile && norm(fileURLToPath(url)) === norm(allowedFile); } catch { return false; }
  }

  async function withDocument(html, use) {
    if (typeof html !== 'string' || html.length === 0) throw fail('المستند فارغ');
    if (html.length > MAX_HTML) throw fail('المستند أكبر من الحد المسموح للطباعة');
    const dir = path.join(files.cacheRoot, 'print-tmp');
    fsImpl.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, crypto.randomUUID() + '.html');
    fsImpl.writeFileSync(tmp, html, 'utf8');
    allowedFile = tmp;
    const win = new BrowserWindow({
      show: false, width: 900, height: 1200,
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, partition: PARTITION,
      },
    });
    const wc = win.webContents;
    if (!sessionReady) {
      const ses = wc.session;
      ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !isAllowed(d.url) }));
      ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
      sessionReady = true;
    }
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    try {
      await withTimeout(win.loadURL(pathToFileURL(tmp).href), loadTimeoutMs, 'انتهت مهلة تجهيز المستند للطباعة');
      return await use(wc);
    } finally {
      allowedFile = null;
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
SCD_EOF_7
mkdir -p "$(dirname 'desktop/scripts/smoke-files.cjs')"
cat > 'desktop/scripts/smoke-files.cjs' <<'SCD_EOF_8'
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
SCD_EOF_8
mkdir -p "$(dirname 'desktop/shims/expo-document-picker.ts')"
cat > 'desktop/shims/expo-document-picker.ts' <<'SCD_EOF_9'
// Shim لـ expo-document-picker عبر حوار الفتح الأصلي في Windows (القسم 5).
// copyToCacheDirectory=true (الافتراضي كما في expo): نسخة في cache/picked تُرجع بدل الأصل.
import { SCD_CHANNELS } from './bridge-contract';
import { callAsync } from './fs-bridge';

export type DocumentPickerAsset = { uri: string; name: string; size?: number; mimeType?: string; lastModified?: number };
export type DocumentPickerResult =
  | { canceled: true; assets: null }
  | { canceled: false; assets: DocumentPickerAsset[] };
export interface DocumentPickerOptions { type?: string | string[]; copyToCacheDirectory?: boolean; multiple?: boolean }

const EXT: Record<string, string[]> = {
  'application/pdf': ['pdf'], 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'],
  'image/*': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'], 'text/csv': ['csv'], 'text/plain': ['txt'],
  'application/json': ['json'], 'application/zip': ['zip'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
};
const LABEL: Record<string, string> = { pdf: 'PDF', jpg: 'صور', jpeg: 'صور', png: 'صور', csv: 'CSV', txt: 'نص', json: 'JSON', zip: 'ZIP', xlsx: 'Excel', docx: 'Word' };

export function filtersFor(type?: string | string[]): Array<{ name: string; extensions: string[] }> {
  const types = type === undefined ? ['*/*'] : Array.isArray(type) ? type : [type];
  const exts = new Set<string>();
  for (const t of types) {
    if (!EXT[t]) return [{ name: 'كل الملفات', extensions: ['*'] }];
    for (const e of EXT[t]) exts.add(e);
  }
  const list = [...exts];
  return [{ name: [...new Set(list.map((e) => LABEL[e] ?? e))].join(' / '), extensions: list }];
}

export async function getDocumentAsync(options: DocumentPickerOptions = {}): Promise<DocumentPickerResult> {
  const r = await callAsync<{ canceled: boolean; files?: DocumentPickerAsset[] }>(SCD_CHANNELS.fs.openDialog, {
    multiple: !!options.multiple, copyToCache: options.copyToCacheDirectory !== false,
    title: 'اختيار ملف', filters: filtersFor(options.type),
  });
  if (r.canceled || !r.files || r.files.length === 0) return { canceled: true, assets: null };
  return { canceled: false, assets: r.files };
}
SCD_EOF_9
mkdir -p "$(dirname 'desktop/shims/expo-file-system.ts')"
cat > 'desktop/shims/expo-file-system.ts' <<'SCD_EOF_10'
// Shim لـ expo-file-system (File/Directory/Paths/FileMode المستعملة في src) فوق IPC آمن — القسم 5.
// العناوين file:///C:/... . كل عملية تُفحص في main داخل documents/cache/المجلدات التي منحها المستخدم عبر الحوارات.
// فروق موثّقة عن Android: move لملف فوق ملف يستبدله؛ move لمجلد فوق وجهة موجودة يفشل؛ writeBytes متزامنة (يحفظ الترتيب).
import { SCD_CHANNELS } from './bridge-contract';
import { callSync, callAsync, DesktopFsError } from './fs-bridge';

export { DesktopFsError };
const CH = SCD_CHANNELS.fs;

export const FileMode = { ReadOnly: 'r', WriteOnly: 'w', ReadWrite: 'rw' } as const;
type Mode = 'r' | 'w' | 'rw';
type Part = string | File | Directory;
interface Stat { exists: boolean; isFile: boolean; isDirectory: boolean; size: number; modificationTime: number }
interface Entry { name: string; uri: string; isDirectory: boolean; size: number; modificationTime: number }

const WIN_PATH = /^[a-zA-Z]:[\\/]/;
const enc = (s: string) => encodeURIComponent(s);
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

function pathToUri(p: string): string {
  const segs = p.replace(/\\/g, '/').split('/');
  const drive = segs.shift() ?? '';
  return 'file:///' + [drive, ...segs.filter(Boolean).map(enc)].join('/');
}
function joinParts(parts: Part[]): string {
  if (parts.length === 0) throw new DesktopFsError('INVALID_PAYLOAD', 'مسار فارغ');
  const first = typeof parts[0] === 'string' ? parts[0] : parts[0].uri;
  let out = WIN_PATH.test(first) ? pathToUri(first) : first;
  for (const part of parts.slice(1)) {
    const rel = typeof part === 'string' ? part.split('/').filter(Boolean).map(enc).join('/') : enc(part.name);
    if (rel) out = out.replace(/\/+$/, '') + '/' + rel;
  }
  return out.replace(/\/+$/, '');
}
const lastSeg = (uri: string) => dec(uri.split('/').pop() ?? '');
const parentUri = (uri: string) => uri.replace(/\/[^/]*$/, '');

let ROOTS: { document: string; cache: string } | null = null;
function roots() {
  if (!ROOTS) ROOTS = callSync<{ document: string; cache: string }>(CH.roots);
  return ROOTS;
}
const stat = (uri: string) => callSync<Stat>(CH.stat, { uri });
const toBytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer));

// وجهة move/copy: File/Directory/نص. ملف → مجلد موجود = داخله بنفس الاسم.
function targetUri(source: File | Directory, dest: Part): string {
  if (typeof dest === 'string') return joinParts([dest]);
  if (source instanceof File && dest instanceof Directory) return joinParts([dest, source.name]);
  return dest.uri;
}

export class FileHandle {
  offset = 0;
  private closed = false;
  private readonly uri: string;
  private readonly mode: Mode;
  constructor(uri: string, mode: Mode) { this.uri = uri; this.mode = mode; }
  private live(write: boolean) {
    if (this.closed) throw new DesktopFsError('INVALID_PAYLOAD', 'المقبض مغلق');
    if (write && this.mode === 'r') throw new DesktopFsError('INVALID_PAYLOAD', 'المقبض للقراءة فقط');
    if (!write && this.mode === 'w') throw new DesktopFsError('INVALID_PAYLOAD', 'المقبض للكتابة فقط');
  }
  get size(): number { return stat(this.uri).size; }
  readBytesSync(length: number): Uint8Array {
    this.live(false);
    const r = toBytes(callSync(CH.readRange, { uri: this.uri, offset: this.offset, length }));
    this.offset += r.length;
    return r;
  }
  readBytes(length: number): Uint8Array { return this.readBytesSync(length); }
  writeBytesSync(bytes: Uint8Array): void {
    this.live(true);
    callSync(CH.writeAt, { uri: this.uri, offset: this.offset, bytes });
    this.offset += bytes.length;
  }
  writeBytes(bytes: Uint8Array): void { this.writeBytesSync(bytes); }
  close(): void { this.closed = true; }
}

export class File {
  uri: string;
  constructor(...parts: Part[]) { this.uri = joinParts(parts); }
  get name(): string { return lastSeg(this.uri); }
  get extension(): string { const n = this.name; const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i) : ''; }
  get parentDirectory(): Directory { return new Directory(parentUri(this.uri)); }
  get exists(): boolean { return stat(this.uri).isFile; }
  get size(): number { return stat(this.uri).size; }
  get modificationTime(): number | null { const s = stat(this.uri); return s.exists ? s.modificationTime : null; }
  bytes(): Promise<Uint8Array> { return callAsync(CH.read, { uri: this.uri, as: 'bytes' }).then(toBytes); }
  text(): Promise<string> { return callAsync<string>(CH.read, { uri: this.uri, as: 'text' }); }
  bytesSync(): Uint8Array { return toBytes(callSync(CH.read, { uri: this.uri, as: 'bytes' })); }
  textSync(): string { return callSync<string>(CH.read, { uri: this.uri, as: 'text' }); }
  async base64(): Promise<string> {
    const b = await this.bytes();
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void {
    callSync(CH.write, { uri: this.uri, data: new Uint8Array(0), mode: options?.overwrite ? 'create-overwrite' : 'create', intermediates: !!options?.intermediates });
  }
  write(data: string | Uint8Array): void { callSync(CH.write, { uri: this.uri, data, mode: 'overwrite' }); }
  open(mode: Mode = FileMode.ReadOnly): FileHandle {
    if (!this.exists) throw new DesktopFsError('NOT_FOUND', 'الملف غير موجود');
    return new FileHandle(this.uri, mode);
  }
  delete(): void { callSync(CH.remove, { uri: this.uri, kind: 'file' }); }
  move(dest: Part): void { const to = targetUri(this, dest); callSync(CH.move, { from: this.uri, to, kind: 'file' }); this.uri = to; }
  copy(dest: Part): void { callSync(CH.copy, { from: this.uri, to: targetUri(this, dest), kind: 'file' }); }
}

export class Directory {
  uri: string;
  constructor(...parts: Part[]) { this.uri = joinParts(parts); }
  get name(): string { return lastSeg(this.uri); }
  get parentDirectory(): Directory { return new Directory(parentUri(this.uri)); }
  get exists(): boolean { return stat(this.uri).isDirectory; }
  get size(): number { return this.list().reduce((n, x) => n + x.size, 0); }
  create(options?: { intermediates?: boolean; idempotent?: boolean; overwrite?: boolean }): void {
    callSync(CH.mkdir, { uri: this.uri, intermediates: !!options?.intermediates, idempotent: !!options?.idempotent });
  }
  delete(): void { callSync(CH.remove, { uri: this.uri, kind: 'dir' }); }
  list(): Array<File | Directory> {
    return callSync<Entry[]>(CH.list, { uri: this.uri }).map((e) => (e.isDirectory ? new Directory(e.uri) : new File(e.uri)));
  }
  move(dest: Part): void { const to = targetUri(this, dest); callSync(CH.move, { from: this.uri, to, kind: 'dir' }); this.uri = to; }
  copy(dest: Part): void { callSync(CH.copy, { from: this.uri, to: targetUri(this, dest), kind: 'dir' }); }
  createDirectory(name: string): Directory {
    const d = new Directory(this, name);
    d.create({ intermediates: true, idempotent: true });
    return d;
  }
  // إن وُجد ملف بنفس الاسم يُضاف « (1)» كما يفعل منتقي المجلدات في Android.
  createFile(name: string, _mimeType?: string | null): File {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 0; i < 100; i++) {
      const f = new File(this, i === 0 ? name : `${base} (${i})${ext}`);
      if (!f.exists) { f.create(); return f; }
    }
    throw new DesktopFsError('ALREADY_EXISTS', 'تعذّر إيجاد اسم ملف غير مستعمل');
  }
  static async pickDirectoryAsync(): Promise<Directory> {
    const r = await callAsync<{ canceled: boolean; uri?: string }>(CH.openDialog, { directory: true, title: 'اختر مجلد الحفظ' });
    if (r.canceled || !r.uri) throw new DesktopFsError('CANCELED', 'User cancelled the directory picker');
    return new Directory(r.uri);
  }
}

export const Paths = {
  get document(): Directory { return new Directory(roots().document); },
  get cache(): Directory { return new Directory(roots().cache); },
  join: (...parts: Part[]): string => joinParts(parts),
  basename: (p: string): string => lastSeg(p),
  extname: (p: string): string => { const n = lastSeg(p); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i) : ''; },
  dirname: (p: string): string => parentUri(p),
};
SCD_EOF_10
mkdir -p "$(dirname 'desktop/shims/expo-print.ts')"
cat > 'desktop/shims/expo-print.ts' <<'SCD_EOF_11'
// Shim لـ expo-print عبر webContents.printToPDF / print في Electron (القسم 5).
import { SCD_CHANNELS } from './bridge-contract';
import { callAsync, DesktopFsError } from './fs-bridge';

export const Orientation = { portrait: 'portrait', landscape: 'landscape' } as const;
export interface PrintOptions { html?: string; width?: number; height?: number; base64?: boolean; orientation?: string; [k: string]: unknown }

function needHtml(o: PrintOptions): string {
  if (!o || typeof o.html !== 'string' || o.html.length === 0) throw new DesktopFsError('INVALID_PAYLOAD', 'يلزم تمرير html (الطباعة من uri غير مدعومة على Windows)');
  return o.html;
}
export async function printToFileAsync(options: PrintOptions = {}): Promise<{ uri: string; numberOfPages?: number; base64?: string }> {
  const html = needHtml(options);
  return callAsync(SCD_CHANNELS.print.toPdf, {
    html, width: options.width, height: options.height, base64: !!options.base64, landscape: options.orientation === 'landscape',
  });
}
export async function printAsync(options: PrintOptions = {}): Promise<void> {
  await callAsync(SCD_CHANNELS.print.print, { html: needHtml(options) });
}
export async function selectPrinterAsync(): Promise<never> {
  throw new DesktopFsError('NOT_SUPPORTED', 'اختيار الطابعة يتم من حوار الطباعة في Windows');
}
SCD_EOF_11
mkdir -p "$(dirname 'desktop/shims/expo-sharing.ts')"
cat > 'desktop/shims/expo-sharing.ts' <<'SCD_EOF_12'
// Shim لـ expo-sharing: لا توجد «ورقة مشاركة» في Windows، فنفتح الملف بالبرنامج الافتراضي (PDF/صور/Office)
// أو نُظهره في المستكشف (أنواع أخرى). لا تنفيذ لأي ملف أبداً (قائمة بيضاء في main) — القسم 5.
import { SCD_CHANNELS } from './bridge-contract';
import { callAsync } from './fs-bridge';

export async function isAvailableAsync(): Promise<boolean> {
  return (await callAsync<boolean>(SCD_CHANNELS.share.available)) === true;
}
export async function shareAsync(url: string, _options?: Record<string, unknown>): Promise<void> {
  await callAsync(SCD_CHANNELS.share.reveal, { uri: url, action: 'open' });
}
SCD_EOF_12
mkdir -p "$(dirname 'desktop/shims/file-image.tsx')"
cat > 'desktop/shims/file-image.tsx' <<'SCD_EOF_13'
// Image يقبل عناوين file:// (الصور المفكوكة في cache) على Windows (القسم 5).
// Chromium يمنع صفحة app:// من تحميل file:// مباشرة، فنقرأ البايتات عبر IPC ونعرضها كـ blob: URL (مسموح في CSP)؛
// تُحرَّر عند إلغاء التركيب. تُمرَّر react-native-web من react-native.tsx لتفادي استيرادها (فهي مُعاد توجيهها للـ shim).
import * as React from 'react';
import { File } from './expo-file-system';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

export function createScdImage(R: any) {
  const ScdImage: any = React.forwardRef(function ScdImage(props: any, ref: any) {
    const src = props.source;
    const fileUri: string | null = src && typeof src === 'object' && typeof src.uri === 'string' && /^file:/i.test(src.uri) ? src.uri : null;
    const [blobUrl, setBlobUrl] = React.useState<string | null>(null);
    const onError = props.onError;
    React.useEffect(() => {
      if (!fileUri) { setBlobUrl(null); return undefined; }
      let alive = true;
      let url: string | null = null;
      (async () => {
        try {
          const f = new File(fileUri);
          const bytes = await f.bytes();
          if (!alive) return;
          url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[f.extension.slice(1).toLowerCase()] ?? 'application/octet-stream' }));
          setBlobUrl(url);
        } catch {
          if (alive) { setBlobUrl(null); if (typeof onError === 'function') onError({ nativeEvent: { error: 'FILE_READ_FAILED' } }); }
        }
      })();
      return () => { alive = false; if (url) URL.revokeObjectURL(url); };
    }, [fileUri]);
    if (!fileUri) return React.createElement(R.Image, { ...props, ref });
    if (!blobUrl) return React.createElement(R.View, { style: props.style, accessibilityLabel: props.accessibilityLabel });
    return React.createElement(R.Image, { ...props, ref, source: { ...src, uri: blobUrl } });
  });
  for (const k of ['getSize', 'getSizeWithHeaders', 'prefetch', 'queryCache', 'resolveAssetSource']) {
    if (R.Image && R.Image[k]) ScdImage[k] = R.Image[k];
  }
  return ScdImage;
}
SCD_EOF_13
mkdir -p "$(dirname 'desktop/shims/fs-bridge.ts')"
cat > 'desktop/shims/fs-bridge.ts' <<'SCD_EOF_14'
// جسر الملفات/الطباعة بين الـ shims وعملية Electron الرئيسية (القسم 5).
// callSync يستعمل IPC المتزامن لأن واجهة expo-file-system الجديدة (exists/create/write/readBytesSync) متزامنة.
import { getBridge, parseScdError } from './bridge-contract';

export class DesktopFsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DesktopFsError';
    this.code = code;
  }
}

function toError(e: unknown): DesktopFsError {
  if (e instanceof DesktopFsError) return e;
  const p = parseScdError(e);
  return new DesktopFsError(p.code, p.message);
}

export function callSync<T = unknown>(channel: string, payload?: unknown): T {
  const b = getBridge();
  if (!b || typeof b.invokeSync !== 'function') throw new DesktopFsError('NO_BRIDGE', 'جسر سطح المكتب غير متاح');
  try { return b.invokeSync<T>(channel, payload); } catch (e) { throw toError(e); }
}

export async function callAsync<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const b = getBridge();
  if (!b) throw new DesktopFsError('NO_BRIDGE', 'جسر سطح المكتب غير متاح');
  try { return await b.invoke<T>(channel, payload); } catch (e) { throw toError(e); }
}
SCD_EOF_14
mkdir -p "$(dirname 'desktop/tests/electron/fs-ipc.test.mjs')"
cat > 'desktop/tests/electron/fs-ipc.test.mjs' <<'SCD_EOF_15'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CHANNELS, SYNC } = require('../../electron/channels.cjs');
const { buildHandlers } = require('../../electron/ipc/handlers.cjs');
const { registerIpc } = require('../../electron/ipc/register.cjs');
const { createFsService } = require('../../electron/lib/fs-service.cjs');

function setup({ openPaths = [], savePath = null, openPathError = '' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-ipc-'));
  const files = createFsService({ documentRoot: path.join(base, 'documents'), cacheRoot: path.join(base, 'cache') });
  files.ensureRoots();
  const mainFrame = { url: 'app://bundle/' };
  const webContents = { mainFrame };
  const win = { webContents, isDestroyed: () => false };
  const shellCalls = [];
  const dialogCalls = [];
  const dialog = {
    showOpenDialog: async (_w, o) => { dialogCalls.push(o); return openPaths.length ? { canceled: false, filePaths: openPaths } : { canceled: true, filePaths: [] }; },
    showSaveDialog: async (_w, o) => { dialogCalls.push(o); return savePath ? { canceled: false, filePath: savePath } : { canceled: true }; },
  };
  const shell = { openPath: async (p) => { shellCalls.push(['open', p]); return openPathError; }, showItemInFolder: (p) => shellCalls.push(['show', p]) };
  const printer = { toPdf: async (p) => ({ uri: 'file:///x.pdf', echo: p.width }), print: async () => ({ printed: true }) };
  const invoke = new Map(); const sync = new Map();
  const logger = { info() {}, warn() {}, error() {} };
  registerIpc({
    ipcMain: { handle: (c, f) => invoke.set(c, f), on: (c, f) => sync.set(c, f) }, logger, getWindow: () => win, devOrigin: null,
    handlers: buildHandlers({ app: { getVersion: () => '1', isPackaged: true, getLocale: () => 'ar' }, getWindow: () => win, versions: {}, platform: 'win32', arch: 'x64', files, printer, dialog, shell }),
  });
  const ev = (over = {}) => ({ sender: webContents, senderFrame: mainFrame, ...over });
  const call = async (ch, payload) => invoke.get(ch)(ev(), structuredClone(payload));
  const callSync = (ch, payload, over) => { const e = ev(over); sync.get(ch)(e, structuredClone(payload)); return e.returnValue; };
  const u = (...p) => pathToFileURL(path.join(base, 'documents', ...p)).href;
  return { base, files, call, callSync, ev, invoke, sync, shellCalls, dialogCalls, u, webContents };
}

test('كل قنوات SYNC مسجّلة لـ sendSync وكل قنوات CHANNELS لـ invoke', () => {
  const { invoke, sync } = setup();
  assert.deepEqual([...invoke.keys()].sort(), Object.keys(CHANNELS).sort());
  assert.deepEqual([...sync.keys()].sort(), [...SYNC].sort());
  for (const c of SYNC) assert.ok(c.startsWith('scd:fs:'), c);
});

test('IPC متزامن: roots/write/read-range/stat وأخطاء بلا مسارات داخلية', () => {
  const { callSync, u } = setup();
  const roots = callSync('scd:fs:roots');
  assert.equal(roots.ok, true); assert.match(roots.data.document, /^file:\/\//);
  assert.equal(callSync('scd:fs:write', { uri: u('a.bin'), data: new Uint8Array([7, 8, 9]), mode: 'create' }).ok, true);
  assert.deepEqual([...callSync('scd:fs:read-range', { uri: u('a.bin'), offset: 1, length: 5 }).data], [8, 9]);
  const dup = callSync('scd:fs:write', { uri: u('a.bin'), data: 'x', mode: 'create' });
  assert.equal(dup.ok, false); assert.equal(dup.error.code, 'ALREADY_EXISTS');
  assert.ok(!JSON.stringify(dup).includes(os.tmpdir()));
});

test('مصدر غير موثوق يُرفض على القنوات المتزامنة وغير المتزامنة', async () => {
  const { callSync, call, ev, sync, invoke } = setup();
  assert.equal(callSync('scd:fs:roots', undefined, { sender: {} }).error.code, 'UNTRUSTED_SENDER');
  assert.equal(callSync('scd:fs:roots', undefined, { senderFrame: { url: 'https://evil.example/' } }).error.code, 'UNTRUSTED_SENDER');
  const r = await invoke.get('scd:fs:read')(ev({ senderFrame: { url: 'https://evil.example/' } }), { uri: 'x' });
  assert.equal(r.error.code, 'UNTRUSTED_SENDER');
  void call; void sync;
});

test('التحقق من الحمولة: حقول ناقصة/خاطئة', async () => {
  const { call, callSync } = setup();
  assert.equal((await call('scd:fs:read', {})).error.code, 'INVALID_PAYLOAD');
  assert.equal((await call('scd:fs:read', { uri: 'file:///x', as: 'zip' })).error.code, 'INVALID_PAYLOAD');
  assert.equal(callSync('scd:fs:write', { uri: 'file:///x', data: 5 }).error.code, 'INVALID_PAYLOAD');
  assert.equal(callSync('scd:fs:read-range', { uri: 'file:///x', offset: -1, length: 1 }).error.code, 'INVALID_PAYLOAD');
  assert.equal(callSync('scd:fs:remove', { uri: 'file:///x', kind: 'weird' }).error.code, 'INVALID_PAYLOAD');
  assert.equal((await call('scd:print:to-pdf', { html: '' })).error.code, 'INVALID_PAYLOAD');
  assert.equal((await call('scd:print:to-pdf', { html: 'x', width: -5, height: 10 })).error.code, 'INVALID_PAYLOAD');
});

test('open-dialog: ملف يُنسخ إلى cache/picked، والإلغاء، والمرشّحات الخاطئة', async () => {
  const src = path.join(os.tmpdir(), `scd-src-${process.pid}.pdf`); fs.writeFileSync(src, '%PDF-1.4');
  const t = setup({ openPaths: [src] });
  const r = await t.call('scd:fs:open-dialog', { filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  assert.equal(r.ok, true); assert.equal(r.data.canceled, false);
  const f = r.data.files[0];
  assert.equal(f.mimeType, 'application/pdf'); assert.match(f.uri, /\/cache\/picked\//);
  assert.equal(t.files.read(f.uri, 'text'), '%PDF-1.4');
  assert.deepEqual(t.dialogCalls[0].filters, [{ name: 'PDF', extensions: ['pdf'] }]);
  assert.equal((await setup().call('scd:fs:open-dialog', {})).data.canceled, true);
  assert.equal((await t.call('scd:fs:open-dialog', { filters: [{ name: 'x', extensions: ['../e'] }] })).error.code, 'INVALID_PAYLOAD');
});

test('open-dialog مجلد: يمنح كتابة داخله فقط (مسار Directory.pickDirectoryAsync)', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-dest-'));
  const t = setup({ openPaths: [dest] });
  const target = pathToFileURL(path.join(dest, 'r.pdf')).href;
  assert.equal(t.callSync('scd:fs:write', { uri: target, data: 'x', mode: 'create' }).error.code, 'FS_FORBIDDEN');
  const r = await t.call('scd:fs:open-dialog', { directory: true });
  assert.equal(r.data.canceled, false);
  assert.equal(t.callSync('scd:fs:write', { uri: target, data: 'x', mode: 'create' }).ok, true);
  assert.equal(fs.readFileSync(path.join(dest, 'r.pdf'), 'utf8'), 'x');
});

test('save-dialog: يمنح الملف المختار فقط ويرفض الامتدادات الخطرة', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-save-'));
  const okPath = path.join(dest, 'تقرير.pdf');
  const t = setup({ savePath: okPath });
  const r = await t.call('scd:fs:save-dialog', { defaultName: 'تقرير.pdf' });
  assert.equal(r.data.name, 'تقرير.pdf');
  assert.equal(t.callSync('scd:fs:write', { uri: r.data.uri, data: 'p', mode: 'create' }).ok, true);
  assert.equal(t.callSync('scd:fs:write', { uri: pathToFileURL(path.join(dest, 'other.pdf')).href, data: 'p', mode: 'create' }).error.code, 'FS_FORBIDDEN');
  const evil = setup({ savePath: path.join(dest, 'x.exe') });
  assert.equal((await evil.call('scd:fs:save-dialog', {})).error.code, 'FS_FORBIDDEN');
  assert.equal((await setup().call('scd:fs:save-dialog', {})).data.canceled, true);
});

test('share:reveal: يفتح PDF/صور فقط؛ غيرها يُظهَر في المستكشف ولا يُنفَّذ أبداً', async () => {
  const t = setup();
  t.files.write(t.u('a.pdf'), '%PDF', 'create'); t.files.write(t.u('b.docx'), 'x', 'create'); t.files.write(t.u('c.txt'), 'x', 'create');
  assert.deepEqual((await t.call('scd:share:reveal', { uri: t.u('a.pdf') })).data, { opened: true });
  assert.equal(t.shellCalls[0][0], 'open');
  t.files.write(t.u('data.bin'), 'x', 'create');
  assert.deepEqual((await t.call('scd:share:reveal', { uri: t.u('data.bin') })).data, { opened: false });
  assert.equal(t.shellCalls.at(-1)[0], 'show');
  // مسار خارج الجذور مرفوض قبل أي استدعاء للنظام
  const before = t.shellCalls.length;
  assert.equal((await t.call('scd:share:reveal', { uri: 'file:///C:/Windows/System32/calc.exe' })).ok, false);
  assert.equal(t.shellCalls.length, before);
  assert.equal((await t.call('scd:share:reveal', { uri: t.u('missing.pdf') })).error.code, 'NOT_FOUND');
  assert.equal((await t.call('scd:share:available')).data, true);
  const failing = setup({ openPathError: 'no association' });
  failing.files.write(failing.u('a.pdf'), '%PDF', 'create');
  assert.deepEqual((await failing.call('scd:share:reveal', { uri: failing.u('a.pdf') })).data, { opened: false });
  assert.equal(failing.shellCalls.at(-1)[0], 'show');
});

test('الطباعة تمرّ للخدمة بالأبعاد', async () => {
  const t = setup();
  assert.equal((await t.call('scd:print:to-pdf', { html: '<p>x</p>', width: 595, height: 842 })).data.echo, 595);
  assert.equal((await t.call('scd:print:print', { html: '<p>x</p>' })).data.printed, true);
});
SCD_EOF_15
mkdir -p "$(dirname 'desktop/tests/electron/fs.test.mjs')"
cat > 'desktop/tests/electron/fs.test.mjs' <<'SCD_EOF_16'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createFsService } = require('../../electron/lib/fs-service.cjs');
const { toLocalPath } = require('../../electron/lib/fs-paths.cjs');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-fs-'));
  const documentRoot = path.join(base, 'documents');
  const cacheRoot = path.join(base, 'cache');
  const svc = createFsService({ documentRoot, cacheRoot });
  svc.ensureRoots();
  const u = (...p) => pathToFileURL(path.join(documentRoot, ...p)).href;
  return { base, documentRoot, cacheRoot, svc, u };
}
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('كتابة وقراءة وstat ورفض create على موجود', () => {
  const { svc, u } = setup();
  svc.write(u('a.bin'), new Uint8Array([1, 2, 3]), 'create');
  assert.deepEqual([...svc.read(u('a.bin'))], [1, 2, 3]);
  assert.equal(svc.stat(u('a.bin')).size, 3);
  assert.equal(code(() => svc.write(u('a.bin'), new Uint8Array([9]), 'create')), 'ALREADY_EXISTS');
  svc.write(u('a.bin'), 'مرحبا', 'overwrite');
  assert.equal(svc.read(u('a.bin'), 'text'), 'مرحبا');
  assert.equal(svc.stat(u('nope')).exists, false);
  assert.equal(code(() => svc.read(u('nope'))), 'NOT_FOUND');
});

test('أسماء بمسافات و% و# وحروف عربية تعمل', () => {
  const { svc, documentRoot } = setup();
  const name = 'تقرير 100% #1 (نسخة).pdf';
  const uri = pathToFileURL(path.join(documentRoot, name)).href;
  svc.write(uri, 'x', 'create');
  assert.ok(fs.existsSync(path.join(documentRoot, name)));
  assert.equal(svc.list(pathToFileURL(documentRoot).href)[0].name, name);
});

test('منع الخروج من الجذور: .. ومسار مطلق وجار بنفس البادئة', () => {
  const { svc, base, documentRoot } = setup();
  const evil = path.join(base, 'documents-evil');
  fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, 's.txt'), 'secret');
  assert.equal(code(() => svc.read(pathToFileURL(path.join(documentRoot, '..', 'documents-evil', 's.txt')).href)), 'FS_FORBIDDEN');
  assert.equal(code(() => svc.read(pathToFileURL(path.join(evil, 's.txt')).href)), 'FS_FORBIDDEN');
  assert.equal(code(() => svc.read(path.join(base, 'documents', '..', 'documents-evil', 's.txt'))), 'FS_FORBIDDEN');
  assert.equal(code(() => svc.read('relative/path.txt')), 'INVALID_PAYLOAD');
  assert.equal(code(() => svc.read('file://server/share/x')), 'FS_FORBIDDEN');
});

test('الرابط الرمزي الخارجي لا يُخرج من documents', (t) => {
  const { svc, base, documentRoot, u } = setup();
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'x.txt'), 'x');
  try { fs.symlinkSync(outside, path.join(documentRoot, 'link'), 'junction'); } catch { return t.skip('لا صلاحية إنشاء روابط'); }
  assert.equal(code(() => svc.read(u('link', 'x.txt'))), 'FS_FORBIDDEN');
  assert.equal(code(() => svc.write(u('link', 'new.txt'), 'x', 'overwrite')), 'FS_FORBIDDEN');
});

test('منع كتابة الملفات التنفيذية والنصوص البرمجية', () => {
  const { svc, u } = setup();
  for (const n of ['a.exe', 'b.BAT', 'c.ps1', 'd.lnk', 'e.js']) assert.equal(code(() => svc.write(u(n), 'x', 'overwrite')), 'FS_FORBIDDEN', n);
});

test('handle: writeAt/readRange بالتسلسل وعند نهاية الملف', () => {
  const { svc, u } = setup();
  svc.write(u('h.bin'), new Uint8Array(0), 'create');
  svc.writeAt(u('h.bin'), 0, new Uint8Array([1, 2, 3, 4]));
  svc.writeAt(u('h.bin'), 4, new Uint8Array([5, 6]));
  assert.deepEqual([...svc.readRange(u('h.bin'), 2, 3)], [3, 4, 5]);
  assert.deepEqual([...svc.readRange(u('h.bin'), 4, 10)], [5, 6]);
  assert.equal(svc.readRange(u('h.bin'), 99, 5).length, 0);
  assert.equal(code(() => svc.writeAt(u('missing'), 0, new Uint8Array([1]))), 'NOT_FOUND');
});

test('mkdir/list/remove/move/copy', () => {
  const { svc, u, documentRoot } = setup();
  svc.mkdir(u('d1', 'sub'), { intermediates: true });
  assert.equal(code(() => svc.mkdir(u('d1'), {})), 'ALREADY_EXISTS');
  svc.mkdir(u('d1'), { idempotent: true });
  assert.equal(code(() => svc.mkdir(u('x', 'y'), {})), 'NOT_FOUND');
  svc.write(u('d1', 'f.txt'), 'hi', 'create');
  assert.deepEqual(svc.list(u('d1')).map((e) => [e.name, e.isDirectory]), [['f.txt', false], ['sub', true]]);

  svc.write(u('m1.txt'), 'one', 'create'); svc.write(u('m2.txt'), 'two', 'create');
  svc.move(u('m1.txt'), u('m2.txt'), 'file');                       // ملف فوق ملف: يستبدل
  assert.equal(svc.read(u('m2.txt'), 'text'), 'one');
  assert.equal(svc.stat(u('m1.txt')).exists, false);
  svc.copy(u('d1'), u('d2'), 'dir');
  assert.equal(svc.read(u('d2', 'f.txt'), 'text'), 'hi');
  assert.equal(code(() => svc.copy(u('d1'), u('d2'), 'dir')), 'ALREADY_EXISTS');
  assert.equal(code(() => svc.move(u('d1'), u('d1', 'sub', 'in'), 'dir')), 'INVALID_PAYLOAD');
  assert.equal(code(() => svc.move(u('d1'), u('d2'), 'dir')), 'ALREADY_EXISTS');
  svc.move(u('d1'), u('d3'), 'dir');
  assert.ok(fs.existsSync(path.join(documentRoot, 'd3', 'f.txt')));
  assert.equal(code(() => svc.remove(u('d3'), { kind: 'file' })), 'INVALID_PAYLOAD');
  svc.remove(u('d3'), { kind: 'dir' });
  assert.equal(code(() => svc.remove(u('d3'))), 'NOT_FOUND');
  assert.equal(code(() => svc.remove(pathToFileURL(documentRoot).href)), 'FS_FORBIDDEN');
});

test('المنح: مجلد اختاره المستخدم يُسمح به وغيره لا', () => {
  const { svc, base, u } = setup();
  const ext = path.join(base, 'Downloads'); fs.mkdirSync(ext);
  const target = pathToFileURL(path.join(ext, 'r.pdf')).href;
  assert.equal(code(() => svc.write(target, 'x', 'create')), 'FS_FORBIDDEN');
  svc.policy.grantDir(ext, true);
  svc.write(target, 'x', 'create');
  assert.equal(fs.readFileSync(path.join(ext, 'r.pdf'), 'utf8'), 'x');
  svc.policy.grantFile(path.join(base, 'only.txt'), false);
  fs.writeFileSync(path.join(base, 'only.txt'), 'o');
  assert.equal(svc.read(pathToFileURL(path.join(base, 'only.txt')).href, 'text'), 'o');
  assert.equal(code(() => svc.write(pathToFileURL(path.join(base, 'only.txt')).href, 'z', 'overwrite')), 'FS_FORBIDDEN');
  assert.equal(code(() => svc.read(pathToFileURL(path.join(base, 'other.txt')).href)), 'FS_FORBIDDEN');
  assert.ok(u('x'));
});

test('pickedCopy و purgeCache', () => {
  const { svc, base, cacheRoot } = setup();
  const src = path.join(base, 'مستند: تجربة?.pdf'.replace(/[:?]/g, '')); fs.writeFileSync(src, '%PDF-1');
  const r = svc.pickedCopy(src);
  assert.match(r.uri, /\/cache\/picked\//);
  assert.equal(svc.read(r.uri, 'text'), '%PDF-1');
  assert.ok(svc.purgeCache() >= 1);
  assert.deepEqual(fs.readdirSync(cacheRoot), []);
});

test('toLocalPath على Windows: محركات وUNC وADS وأسماء محجوزة', () => {
  assert.equal(toLocalPath('file:///C:/Users/a%20b/x.pdf', 'win32'), 'C:\\Users\\a b\\x.pdf');
  assert.equal(toLocalPath('C:/Users/x.pdf', 'win32'), 'C:\\Users\\x.pdf');
  const c = (u) => { try { toLocalPath(u, 'win32'); } catch (e) { return e.code; } };
  assert.equal(c('file://server/share/x.pdf'), 'FS_FORBIDDEN');
  assert.equal(c('\\\\server\\share\\x'), 'INVALID_PAYLOAD');
  assert.equal(c('C:\\a\\b.txt:stream'), 'FS_FORBIDDEN');
  assert.equal(c('C:\\a\\NUL'), 'FS_FORBIDDEN');
  assert.equal(c('C:\\a\\com1.txt'), 'FS_FORBIDDEN');
  assert.equal(c('C:\\a\\b.'), 'FS_FORBIDDEN');
  assert.equal(c('/etc/passwd'), 'INVALID_PAYLOAD');
  assert.equal(c('file:///C:/a/%00b'), 'INVALID_PAYLOAD');
});
SCD_EOF_16
mkdir -p "$(dirname 'desktop/tests/electron/print.test.mjs')"
cat > 'desktop/tests/electron/print.test.mjs' <<'SCD_EOF_17'
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
SCD_EOF_17
mkdir -p "$(dirname 'desktop/tests/web/_ts-resolve.mjs')"
cat > 'desktop/tests/web/_ts-resolve.mjs' <<'SCD_EOF_18'
// Hook لاختبارات الـ shims: يحلّ الاستيراد النسبي بلا امتداد إلى .ts كما يفعل Metro (الاختبارات تعمل بـ --experimental-strip-types).
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier)) return nextResolve(specifier + '.ts', context);
    throw e;
  }
}
SCD_EOF_18
mkdir -p "$(dirname 'desktop/tests/web/fs-shim.test.mjs')"
cat > 'desktop/tests/web/fs-shim.test.mjs' <<'SCD_EOF_19'
// يختبر shims القسم 5 (expo-file-system/print/sharing/document-picker) مقابل معالجات Electron الحقيقية عبر جسر وهمي
// ينسخ الحمولات بـ structuredClone مثل IPC الفعلي. لا يحتاج Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./_ts-resolve.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const { buildHandlers } = require('../../electron/ipc/handlers.cjs');
const { createFsService } = require('../../electron/lib/fs-service.cjs');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-shim-'));
const files = createFsService({ documentRoot: path.join(base, 'documents'), cacheRoot: path.join(base, 'cache') });
files.ensureRoots();
const pickQueue = { open: [], save: [] };
const win = { isDestroyed: () => false };
const printed = [];
const shellCalls = [];
const handlers = buildHandlers({
  app: {}, getWindow: () => win, versions: {}, platform: 'win32', arch: 'x64', files,
  printer: { toPdf: async (p) => { printed.push(p); return { uri: 'file:///x.pdf', numberOfPages: 1 }; }, print: async (p) => { printed.push(p); return { printed: true }; } },
  dialog: { showOpenDialog: async () => pickQueue.open.shift() ?? { canceled: true }, showSaveDialog: async () => pickQueue.save.shift() ?? { canceled: true } },
  shell: { openPath: async (p) => { shellCalls.push(p); return ''; }, showItemInFolder() {} },
});
const run = (ch, payload) => {
  const e = handlers.get(ch);
  try { const data = e.run(e.validate(structuredClone(payload))); return { ok: true, data: data === undefined ? null : data, async: !!(data && typeof data.then === 'function') }; }
  catch (err) { return { ok: false, error: { code: err.code || 'INTERNAL', message: err.message } }; }
};
const decode = (res) => { if (res.ok) return structuredClone(res.data); const e = new Error(`[${res.error.code}] ${res.error.message}`); throw e; };
globalThis.window = {
  scd: {
    isDesktop: true, platform: 'win32',
    invokeSync: (ch, p) => { const r = run(ch, p); if (r.ok) assert.equal(r.async, false, 'قناة متزامنة أعادت وعداً: ' + ch); return decode(r); },
    invoke: async (ch, p) => { const e = handlers.get(ch); try { return structuredClone(await e.run(e.validate(structuredClone(p)))); } catch (err) { throw new Error(`[${err.code || 'INTERNAL'}] ${err.message}`); } },
  },
};

const FS = await import('../../shims/expo-file-system.ts');
const Print = await import('../../shims/expo-print.ts');
const Sharing = await import('../../shims/expo-sharing.ts');
const Picker = await import('../../shims/expo-document-picker.ts');
const { File, Directory, Paths, FileMode } = FS;
const rejectsCode = async (p, code) => assert.rejects(p, (e) => e.code === code);
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code);

test('Paths + Directory.create/exists + File.create/write/exists/size/bytes', async () => {
  const dir = new Directory(Paths.document, 'attachments');
  assert.equal(dir.exists, false);
  dir.create({ intermediates: true, idempotent: true });
  dir.create({ intermediates: true, idempotent: true });
  assert.equal(dir.exists, true);
  const f = new File(dir, 'تقرير 100% #1.bin');
  assert.equal(f.exists, false);
  f.create();
  f.write(new Uint8Array([1, 2, 3]));
  assert.equal(f.exists, true); assert.equal(f.size, 3);
  assert.deepEqual([...(await f.bytes())], [1, 2, 3]);
  assert.equal(f.name, 'تقرير 100% #1.bin'); assert.equal(f.extension, '.bin');
  assert.equal(f.parentDirectory.name, 'attachments');
  throwsCode(() => f.create(), 'ALREADY_EXISTS');
  f.create({ overwrite: true }); assert.equal(f.size, 0);
  f.write('نص عربي'); assert.equal(await f.text(), 'نص عربي'); assert.equal(f.textSync(), 'نص عربي');
});

test('handle: كتابة متسلسلة WriteOnly وقراءة متسلسلة ReadOnly (مقاطع)', () => {
  const f = new File(Paths.cache, 'h.bin');
  f.create();
  const w = f.open(FileMode.WriteOnly);
  w.writeBytes(new Uint8Array([1, 2, 3])); w.writeBytesSync(new Uint8Array([4, 5]));
  assert.equal(w.offset, 5); w.close();
  throwsCode(() => w.writeBytes(new Uint8Array([9])), 'INVALID_PAYLOAD');
  const r = f.open(FileMode.ReadOnly);
  assert.deepEqual([...r.readBytesSync(2)], [1, 2]); assert.deepEqual([...r.readBytesSync(10)], [3, 4, 5]);
  assert.equal(r.readBytesSync(4).length, 0); assert.equal(r.size, 5);
  throwsCode(() => r.writeBytes(new Uint8Array([1])), 'INVALID_PAYLOAD');
  r.close();
  throwsCode(() => new File(Paths.cache, 'nope.bin').open(FileMode.ReadOnly), 'NOT_FOUND');
});

test('list/move/copy/delete على ملفات ومجلدات، وmove يحدّث uri، ونقل ملف إلى مجلد', () => {
  const d = new Directory(Paths.document, 'ops'); d.create({ intermediates: true });
  const a = new File(d, 'a.txt'); a.create(); a.write('A');
  const sub = new Directory(d, 'sub'); sub.create();
  assert.deepEqual(d.list().map((x) => [x.name, x instanceof Directory]), [['a.txt', false], ['sub', true]]);
  a.move(new File(d, 'b.txt')); assert.equal(a.name, 'b.txt'); assert.equal(a.exists, true);
  a.move(sub); assert.equal(a.uri.endsWith('/sub/b.txt'), true);
  const c = new File(d, 'c.txt'); a.copy(c); assert.equal(c.textSync(), 'A'); assert.equal(a.exists, true);
  const dc = new Directory(Paths.document, 'ops-copy'); d.copy(dc); assert.equal(new File(dc, 'c.txt').exists, true);
  throwsCode(() => d.copy(dc), 'ALREADY_EXISTS');
  throwsCode(() => new File(d, 'c.txt').move(new Directory(d, 'zzz', 'q')), 'NOT_FOUND');
  d.delete(); assert.equal(d.exists, false);
  throwsCode(() => d.delete(), 'NOT_FOUND');
  throwsCode(() => new Directory(Paths.document).delete(), 'FS_FORBIDDEN');
});

test('مسارات خارج الجذور ومسارات Windows الخام', async () => {
  throwsCode(() => new File('file:///etc/passwd').exists, 'FS_FORBIDDEN');
  assert.throws(() => new File('C:\\Windows\\win.ini').exists, (e) => ['FS_FORBIDDEN', 'INVALID_PAYLOAD'].includes(e.code));
  await rejectsCode(new File(Paths.document, '..', 'x').bytes(), 'FS_FORBIDDEN');
  throwsCode(() => new File(Paths.document, 'run.exe').write('x'), 'FS_FORBIDDEN');
});

test('Directory.pickDirectoryAsync: اختيار → كتابة createFile بلا تضارب (1)، وإلغاء → خطأ يطابق /cancel/', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-pick-'));
  pickQueue.open.push({ canceled: false, filePaths: [dest] });
  const target = await Directory.pickDirectoryAsync();
  const f1 = target.createFile('r.pdf', 'application/pdf'); f1.write(new Uint8Array([1, 2]));
  const f2 = target.createFile('r.pdf', 'application/pdf');
  assert.equal(f1.name, 'r.pdf'); assert.equal(f2.name, 'r (1).pdf');
  assert.deepEqual([...(await f1.bytes())], [1, 2]);
  await assert.rejects(Directory.pickDirectoryAsync(), (e) => /cancel/i.test(e.message));
});

test('expo-document-picker: نسخة في cache مع الاسم الأصلي، المرشّحات، والإلغاء', async () => {
  const src = path.join(base, 'صورة.png'); fs.writeFileSync(src, 'PNG');
  pickQueue.open.push({ canceled: false, filePaths: [src] });
  const r = await Picker.getDocumentAsync({ type: ['application/pdf', 'image/jpeg', 'image/png'], copyToCacheDirectory: true, multiple: false });
  assert.equal(r.canceled, false);
  assert.equal(r.assets[0].name, 'صورة.png'); assert.equal(r.assets[0].mimeType, 'image/png'); assert.equal(r.assets[0].size, 3);
  assert.equal(new File(r.assets[0].uri).textSync(), 'PNG');
  assert.deepEqual((await Picker.getDocumentAsync()).assets, null);
  assert.deepEqual(Picker.filtersFor(['application/pdf', 'image/png'])[0].extensions, ['pdf', 'png']);
  assert.deepEqual(Picker.filtersFor('*/*')[0].extensions, ['*']);
});

test('expo-print: printToFileAsync/printAsync تمرّر html والأبعاد وترفض غير ذلك', async () => {
  const r = await Print.printToFileAsync({ html: '<p>x</p>', width: 595, height: 842, margins: { left: 1 } });
  assert.equal(r.uri, 'file:///x.pdf'); assert.equal(printed.at(-1).width, 595);
  await Print.printAsync({ html: '<p>y</p>' });
  await rejectsCode(Print.printToFileAsync({}), 'INVALID_PAYLOAD');
  await rejectsCode(Print.printAsync({ uri: 'file:///x.pdf' }), 'INVALID_PAYLOAD');
});

test('expo-sharing: متاح، ويفتح PDF في cache عبر البرنامج الافتراضي', async () => {
  assert.equal(await Sharing.isAvailableAsync(), true);
  const f = new File(Paths.cache, 'view.pdf'); f.create(); f.write('%PDF-');
  await Sharing.shareAsync(f.uri, { mimeType: 'application/pdf', dialogTitle: 'x' });
  assert.equal(shellCalls.length, 1); assert.ok(shellCalls[0].endsWith('view.pdf'));
  await rejectsCode(Sharing.shareAsync('file:///C:/Windows/System32/cmd.exe'), 'FS_FORBIDDEN');
});

test('بلا جسر Electron: خطأ واضح NO_BRIDGE بدل فشل صامت', () => {
  const saved = globalThis.window; globalThis.window = {};
  try { throwsCode(() => new File('file:///x').exists, 'NO_BRIDGE'); } finally { globalThis.window = saved; }
});
SCD_EOF_19
echo "▶ ترقيع ملفات الأقسام 2–4"
cat > /tmp/scd_s5_patch.py <<'SCD_EOF_PATCH'
#!/usr/bin/env python3
# يطبّق تعديلات القسم 5 على ملفات الأقسام 2–4. آمن للتشغيل مرتين (يتخطى ما طُبّق). يفشل بوضوح إن تغيّر النص الأصلي.
import json, os, re, sys
root = sys.argv[1] if len(sys.argv) > 1 else '.'
def P(*a): return os.path.join(root, *a)
def rd(p):
    with open(p, encoding='utf8', newline='') as f: return f.read()
def wr(p, s):
    with open(p, 'w', encoding='utf8', newline='') as f: f.write(s)
def sub(path, old, new, marker):
    s = rd(path)
    if marker in s:
        print('  = تم مسبقاً:', os.path.basename(path), '-', marker); return
    if s.count(old) != 1:
        sys.exit(f'✘ تعذّر العثور على الموضع في {path} (يتطلب {marker}). النص الأصلي تغيّر؟')
    wr(path, s.replace(old, new)); print('  ✔', os.path.basename(path), '-', marker)

NEWCH = "'scd:fs:roots', 'scd:fs:copy', 'scd:fs:move', 'scd:fs:read-range', 'scd:fs:write-at'"

# 1) channels.cjs
c = P('electron', 'channels.cjs')
sub(c, "'scd:fs:stat': 5, 'scd:fs:mkdir': 5, 'scd:fs:open-dialog': 5, 'scd:fs:save-dialog': 5,",
    "'scd:fs:stat': 5, 'scd:fs:mkdir': 5, 'scd:fs:open-dialog': 5, 'scd:fs:save-dialog': 5,\n  'scd:fs:roots': 5, 'scd:fs:copy': 5, 'scd:fs:move': 5, 'scd:fs:read-range': 5, 'scd:fs:write-at': 5,", "'scd:fs:read-range': 5")
sub(c, "module.exports = { CHANNELS, EVENTS };",
    "// قنوات تُستدعى أيضاً عبر ipcRenderer.sendSync (القسم 5): واجهة File/Directory في expo-file-system متزامنة.\n"
    "// معالجاتها متزامنة حتماً. الحوارات والطباعة غير متزامنة ولا تُدرج هنا.\n"
    "const SYNC = Object.freeze([\n  'scd:fs:roots', 'scd:fs:stat', 'scd:fs:exists', 'scd:fs:read', 'scd:fs:read-range', 'scd:fs:write', 'scd:fs:write-at',\n"
    "  'scd:fs:mkdir', 'scd:fs:remove', 'scd:fs:list', 'scd:fs:move', 'scd:fs:copy',\n]);\n\nmodule.exports = { CHANNELS, EVENTS, SYNC };", "const SYNC")

# 2) handlers.cjs
h = P('electron', 'ipc', 'handlers.cjs')
sub(h, "  // القنوات غير المنفّذة بعد:",
    "  // القسم 5: الملفات والطباعة والمشاركة (تُحقن الخدمات من main.cjs؛ دونها تبقى القنوات NOT_IMPLEMENTED).\n"
    "  if (ctx.files) require('./fs-handlers.cjs').registerFiles(add, ctx);\n\n  // القنوات غير المنفّذة بعد:", "registerFiles")

# 3) preload.cjs
pl = P('electron', 'preload.cjs')
sub(pl, "'scd:fs:stat', 'scd:fs:mkdir', 'scd:fs:open-dialog', 'scd:fs:save-dialog',",
    "'scd:fs:stat', 'scd:fs:mkdir', 'scd:fs:open-dialog', 'scd:fs:save-dialog',\n  " + NEWCH + ",", "'scd:fs:read-range'")
sub(pl, "const EVENTS = new Set(['scd:event:window-state']);",
    "const EVENTS = new Set(['scd:event:window-state']);\n"
    "// القنوات المسموح استدعاؤها بشكل متزامن (ملفات القسم 5 فقط). main يتحقق من المُرسل والحمولة لكل منها.\n"
    "const SYNC = new Set([\n  'scd:fs:roots', 'scd:fs:stat', 'scd:fs:exists', 'scd:fs:read', 'scd:fs:read-range', 'scd:fs:write', 'scd:fs:write-at',\n"
    "  'scd:fs:mkdir', 'scd:fs:remove', 'scd:fs:list', 'scd:fs:move', 'scd:fs:copy',\n]);", "const SYNC = new Set")
sub(pl, "function on(event, callback) {",
    "function invokeSync(channel, payload) {\n"
    "  if (typeof channel !== 'string' || !SYNC.has(channel)) throw fail('CHANNEL_NOT_ALLOWED', 'قناة متزامنة غير مسموحة');\n"
    "  const res = ipcRenderer.sendSync(channel, payload);\n"
    "  if (res && res.ok === true) return res.data;\n"
    "  const err = res && res.error ? res.error : {};\n"
    "  throw fail(typeof err.code === 'string' ? err.code : 'INTERNAL', typeof err.message === 'string' ? err.message : 'فشل غير معروف');\n"
    "}\n\nfunction on(event, callback) {", "function invokeSync")
sub(pl, "{ isDesktop: true, platform: process.platform, invoke, on }", "{ isDesktop: true, platform: process.platform, invoke, invokeSync, on }", "invoke, invokeSync, on")

# 4) bridge-contract.ts
b = P('shims', 'bridge-contract.ts')
sub(b, "saveDialog: 'scd:fs:save-dialog' },",
    "saveDialog: 'scd:fs:save-dialog',\n          roots: 'scd:fs:roots', copy: 'scd:fs:copy', move: 'scd:fs:move', readRange: 'scd:fs:read-range', writeAt: 'scd:fs:write-at' },", "readRange:")
sub(b, "  | 'NOT_IMPLEMENTED' | 'NO_WINDOW' | 'INTERNAL';",
    "  | 'NOT_IMPLEMENTED' | 'NO_WINDOW' | 'INTERNAL'\n  | 'FS_FORBIDDEN' | 'NOT_FOUND' | 'ALREADY_EXISTS' | 'ACCESS_DENIED' | 'BUSY' | 'DISK_FULL' | 'IO_ERROR' | 'FILE_TOO_LARGE' | 'PRINT_FAILED';", "'FS_FORBIDDEN'")
sub(b, "  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;",
    "  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;\n  // متزامن (قنوات الملفات فقط): واجهة File/Directory في expo-file-system متزامنة.\n  invokeSync<T = unknown>(channel: string, payload?: unknown): T;", "invokeSync<T")

# 5) main.cjs
m = P('electron', 'main.cjs')
sub(m, "const { installMenu } = require('./menu.cjs');",
    "const { installMenu } = require('./menu.cjs');\nconst { createFsService } = require('./lib/fs-service.cjs');\nconst { createPrintService } = require('./lib/print-service.cjs');", "createFsService")
sub(m, "    installProtocol();\n    lockDownSession();",
    "    // القسم 5: documents (دائم) وcache (يُفرَّغ عند الإقلاع والإغلاق لأنه قد يحوي مرفقات مفكوكة).\n"
    "    const files = createFsService({\n      documentRoot: path.join(app.getPath('userData'), 'documents'),\n      cacheRoot: path.join(app.getPath('userData'), 'cache'),\n      platform: process.platform,\n    });\n"
    "    files.ensureRoots();\n    files.purgeCache();\n    const printer = createPrintService({ BrowserWindow, files, platform: process.platform });\n"
    "    app.on('will-quit', () => { files.purgeCache(); });\n    installProtocol();\n    lockDownSession();", "createPrintService({")
sub(m, "        app, getWindow: () => mainWindow, versions: process.versions, platform: process.platform, arch: process.arch,\n      }),",
    "        app, getWindow: () => mainWindow, versions: process.versions, platform: process.platform, arch: process.arch,\n        files, printer, dialog, shell,\n      }),", "files, printer, dialog, shell")

# 6) react-native.tsx + rn-compat.json
r = P('shims', 'react-native.tsx')
sub(r, "import { compensateStyle, interpretProbe, swapAlign } from './text-align-fix';",
    "import { compensateStyle, interpretProbe, swapAlign } from './text-align-fix';\nimport { createScdImage } from './file-image';", "createScdImage")
sub(r, "const R = RNW as any;\n",
    "const R = RNW as any;\n\n// ── Image: عناوين file:// (الصور المفكوكة في cache) تُعرض عبر blob: لأن Chromium يمنع file:// من app:// (القسم 5) ──\nexport const Image = createScdImage(R);\n", "export const Image = createScdImage")
j = P('shims', 'rn-compat.json')
s = rd(j)
if '"Image": {\n      "status": "shim"' not in s:
    old = '"Image": {\n      "status": "native-web"\n    },'
    if s.count(old) != 1: sys.exit('✘ rn-compat.json: تصنيف Image غير موجود بالشكل المتوقع')
    s = s.replace(old, '"Image": {\n      "status": "shim",\n      "file": "react-native.tsx",\n      "note": "القسم 5: عناوين file:// تُعرض عبر blob: (CSP/Chromium يمنعان file:// من app://)؛ غيرها يمرّ كما هو"\n    },')
    wr(j, s); print('  ✔ rn-compat.json - Image')
else: print('  = تم مسبقاً: rn-compat.json - Image')

# 7) tests/electron/ipc.test.mjs (قنوات fs/print لم تعد NOT_IMPLEMENTED؛ وipcMain الوهمي يحتاج on)
t = P('tests', 'electron', 'ipc.test.mjs')
sub(t, "const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };", "const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };", "on: () => {}")
sub(t, "ipcMain: { handle: (c, f) => m.set(c, f) }", "ipcMain: { handle: (c, f) => m.set(c, f), on: () => {} }", "m.set(c, f), on:")
sub(t, "[['scd:fs:read', 5], ['scd:db:open', 6], ['scd:secure:get', 7], ['scd:print:to-pdf', 5]]",
    "[['scd:db:open', 6], ['scd:db:tx', 6], ['scd:secure:get', 7], ['scd:auth:prompt', 7]]", "['scd:db:tx', 6]")

# 8) package.json
pj = P('package.json')
d = json.loads(rd(pj))
sc = d['scripts']
if 'verify:section5' not in sc:
    sc['test:files'] = 'node --test "tests/electron/fs*.test.mjs" "tests/electron/print.test.mjs"'
    sc['smoke:files'] = 'electron scripts/smoke-files.cjs'
    sc['verify:section5'] = ('node scripts/verify-backup.mjs && node scripts/check-shims.mjs && node scripts/check-rnweb-compat.mjs && '
                             'node --test "tests/electron/*.test.mjs" && node --experimental-strip-types --test "tests/web/*.test.mjs"')
    wr(pj, json.dumps(d, ensure_ascii=False, indent=2) + '\n'); print('  ✔ package.json - verify:section5')
else: print('  = تم مسبقاً: package.json')
SCD_EOF_PATCH
python3 /tmp/scd_s5_patch.py desktop
rm -f /tmp/scd_s5_patch.py
echo "▶ الاختبارات"
cd desktop
node --test "tests/electron/*.test.mjs"
node --experimental-strip-types --test "tests/web/*.test.mjs"
node scripts/check-shims.mjs >/dev/null && node scripts/check-rnweb-compat.mjs >/dev/null && echo "✔ shims وRN-web مصنّفة"
echo "✔ القسم 5 جاهز. ادفع التغييرات ثم شغّل workflow: Desktop section 5"
