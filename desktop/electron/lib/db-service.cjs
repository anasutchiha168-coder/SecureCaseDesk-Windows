'use strict';
// القسم 6: قاعدة البيانات المشفّرة في العملية الرئيسية فقط. الواجهة لا ترى المحرك ولا الملف؛ كل شيء عبر IPC.
// المحرك: SQLite3 Multiple Ciphers بوضع sqlcipher (legacy=4) = نفس إعدادات SQLCipher 4 على أندرويد
// (PBKDF2-HMAC-SHA512 / 256000 تكرار / صفحة 4096 / HMAC-SHA512). فشل التحميل = فشل مغلق، لا رجوع لقاعدة غير مشفّرة.
const fs = require('node:fs');
const path = require('node:path');
const { ScdError } = require('./errors.cjs');

const MAX_HANDLES = 16;
const MAX_SQL = 2 * 1024 * 1024;
const MAX_PARAMS = 5000;
const STMT_CACHE = 100;
const NAME_RE = /^[^\\/:*?"<>|\x00-\x1f]{1,128}$/;
const KEY_RE = /^\s*PRAGMA\s+key\s*=\s*'((?:[^']|'')*)'\s*;?\s*$/i;

const err = (code, msg) => new ScdError(code, msg);
const norm = (sql) => sql.trim().replace(/[;\s]+$/, '').replace(/\s+/g, ' ').toLowerCase();
const cleanMsg = (m) => String(m || 'خطأ في قاعدة البيانات').replace(/[A-Za-z]:[\\/][^\s'"]*/g, '<path>').slice(0, 500);

function loadSqlcipherDriver(req = require) {
  let Database;
  try { Database = req('better-sqlite3-multiple-ciphers'); } catch (e) {
    return { available: false, reason: String(e && e.message).slice(0, 300) };
  }
  return {
    available: true,
    cipher: { init: ["PRAGMA cipher='sqlcipher';", 'PRAGMA legacy=4;'], label: 'sqlcipher-compat-4 (SQLite3MultipleCiphers)' },
    open: (file) => new Database(file),
  };
}

function toParam(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint' || typeof v === 'string') return v;
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  throw err('INVALID_PAYLOAD', 'نوع معامل غير مدعوم');
}
function bindArgs(params) {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) {
    if (params.length > MAX_PARAMS) throw err('INVALID_PAYLOAD', 'معاملات كثيرة');
    return params.map(toParam);
  }
  const named = {};
  const keys = Object.keys(params);
  if (keys.length > MAX_PARAMS) throw err('INVALID_PAYLOAD', 'معاملات كثيرة');
  for (const k of keys) named[k.replace(/^[$:@]/, '')] = toParam(params[k]);
  return [named];
}
function outVal(v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (Buffer.isBuffer(v)) return Uint8Array.from(v);
  return v;
}
const outRow = (r) => { const o = {}; for (const k of Object.keys(r)) o[k] = outVal(r[k]); return o; };

function createDbService({ files, driver, logger, fsImpl = fs }) {
  const conns = new Map();
  let nextId = 1;
  const P = files.policy.P;
  const defaultDir = () => P.join(files.documentRoot, 'SQLite');
  const plain = (p) => p.replace(/\\/g, '/');

  function wrap(fn) {
    try { return fn(); } catch (e) {
      if (e instanceof ScdError) throw e;
      if (logger) logger.warn('خطأ قاعدة بيانات: ' + cleanMsg(e && e.message));
      throw err('DB_ERROR', cleanMsg(e && e.message));
    }
  }
  function get(handle) {
    const c = conns.get(handle);
    if (!c) throw err('DB_NOT_OPEN', 'اتصال قاعدة البيانات غير مفتوح');
    return c;
  }
  function resolveTarget(name, directory) {
    if (!NAME_RE.test(name) || name === '.' || name === '..' || /[. ]$/.test(name)) throw err('INVALID_PAYLOAD', 'اسم قاعدة البيانات غير صالح');
    const dirLocal = directory ? files.localPath(directory, 'write') : defaultDir();
    const full = files.localPath(P.join(dirLocal, name), 'write');
    return { dir: P.dirname(full), full };
  }
  function prep(c, sql) {
    let s = c.cache.get(sql);
    if (!s) {
      s = c.raw.prepare(sql);
      if (c.cache.size >= STMT_CACHE) c.cache.delete(c.cache.keys().next().value);
      c.cache.set(sql, s);
    }
    return s;
  }
  // قاعدة ملف جديدة/فارغة بلا مفتاح = كانت ستُنشأ غير مشفّرة: نمنعها.
  function requireKey(c) {
    if (!driver.cipher || c.keyed || c.memory) return;
    let size = 0;
    try { size = fsImpl.statSync(c.file).size; } catch { size = 0; }
    if (size === 0) throw err('DB_KEY_REQUIRED', 'يجب ضبط مفتاح التشفير قبل استخدام قاعدة جديدة');
  }
  function cipherActive(c) {
    if (!driver.cipher || !c.keyed) return false;
    try { const r = c.raw.prepare('PRAGMA cipher').get(); return !!r && Object.values(r)[0] === 'sqlcipher'; } catch { return false; }
  }

  const api = {
    isAvailable: () => !!driver.available || !!driver.allowPlaintextForTests,
    count: () => conns.size,

    open({ name, directory }) {
      if (!driver.available && !driver.allowPlaintextForTests) throw err('DB_ENGINE_MISSING', 'محرك SQLCipher غير متوفر في هذا البناء');
      if (conns.size >= MAX_HANDLES) throw err('BUSY', 'عدد اتصالات قاعدة البيانات المفتوحة تجاوز الحد');
      const memory = name === ':memory:';
      let file = ':memory:';
      if (!memory) {
        const t = resolveTarget(name, directory);
        fsImpl.mkdirSync(t.dir, { recursive: true });
        file = t.full;
      }
      return wrap(() => {
        const raw = driver.open(file);
        try { if (driver.cipher) for (const s of driver.cipher.init) raw.exec(s); } catch (e) { try { raw.close(); } catch { /* */ } throw e; }
        const id = nextId++;
        conns.set(id, { id, raw, file, memory, keyed: false, inTx: false, cache: new Map() });
        return { handle: id, path: memory ? ':memory:' : plain(file) };
      });
    },

    exec({ handle, sql }) {
      const c = get(handle);
      return wrap(() => {
        const m = KEY_RE.exec(sql);
        if (m) {
          const pass = m[1].replace(/''/g, "'");
          if (!pass) throw err('DB_KEY_INVALID', 'مفتاح التشفير فارغ');
          if (driver.cipher) c.raw.exec("PRAGMA key='" + pass.replace(/'/g, "''") + "';");
          c.keyed = true; c.cache.clear();
          return null;
        }
        requireKey(c);
        c.raw.exec(sql);
        return null;
      });
    },

    run({ handle, sql, params }) {
      const c = get(handle);
      return wrap(() => {
        requireKey(c);
        const s = prep(c, sql);
        const a = bindArgs(params);
        if (s.reader === true) { s.all(...a); return { changes: 0, lastInsertRowId: 0 }; }
        const r = s.run(...a);
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
      });
    },

    all({ handle, sql, params }) {
      const c = get(handle);
      return wrap(() => {
        const n = norm(sql);
        if (n === 'pragma cipher_version') return cipherActive(c) ? [{ cipher_version: driver.cipher.label }] : [];
        if (n === 'pragma cipher_integrity_check') {
          // sqlite3mc يتحقق من HMAC لكل صفحة عند قراءتها؛ integrity_check يقرأ كل الصفحات. فشل القراءة = صفوف تالفة.
          if (!cipherActive(c)) return [];
          try { const r = c.raw.prepare('PRAGMA integrity_check').all(); return r.length === 1 && Object.values(r[0])[0] === 'ok' ? [] : r.map(outRow); } catch (e) { return [{ error: cleanMsg(e.message) }]; }
        }
        requireKey(c);
        const s = prep(c, sql);
        if (s.reader === false) { s.run(...bindArgs(params)); return []; }
        return s.all(...bindArgs(params)).map(outRow);
      });
    },

    first(p) {
      const n = norm(p.sql);
      if (n === 'pragma cipher_version' || n === 'pragma cipher_integrity_check') return api.all(p)[0] || null;
      const c = get(p.handle);
      return wrap(() => {
        requireKey(c);
        const s = prep(c, p.sql);
        if (s.reader === false) { s.run(...bindArgs(p.params)); return null; }
        const r = s.get(...bindArgs(p.params));
        return r ? outRow(r) : null;
      });
    },

    tx({ handle, action }) {
      const c = get(handle);
      return wrap(() => {
        if (action === 'begin') {
          if (c.inTx) throw err('DB_TX_ACTIVE', 'توجد معاملة نشطة بالفعل');
          requireKey(c); c.raw.exec('BEGIN'); c.inTx = true;
        } else if (action === 'commit') {
          if (!c.inTx) throw err('DB_TX_NONE', 'لا توجد معاملة نشطة');
          c.raw.exec('COMMIT'); c.inTx = false;
        } else if (action === 'rollback') {
          if (c.inTx) { c.inTx = false; c.raw.exec('ROLLBACK'); }
        } else throw err('INVALID_PAYLOAD', 'action غير صالح');
        return null;
      });
    },

    close({ handle }) {
      const c = conns.get(handle);
      if (!c) return null;
      conns.delete(handle);
      try { if (c.inTx) c.raw.exec('ROLLBACK'); } catch { /* */ }
      c.cache.clear();
      return wrap(() => { c.raw.close(); return null; });
    },

    // إعادة تحميل الواجهة/انهيارها/إغلاق التطبيق: لا نترك اتصالات ولا معاملات يتيمة (تقفل الملف على Windows).
    closeAll() { let n = 0; for (const id of [...conns.keys()]) { try { api.close({ handle: id }); n++; } catch { /* */ } } return n; },
  };
  return api;
}

module.exports = { createDbService, loadSqlcipherDriver, KEY_RE };
