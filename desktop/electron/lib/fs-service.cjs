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
