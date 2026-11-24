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
