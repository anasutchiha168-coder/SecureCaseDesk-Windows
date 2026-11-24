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
