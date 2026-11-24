'use strict';
// القسم 7: مخزن الأسرار (بديل expo-secure-store) في العملية الرئيسية فقط.
// الخلفية الحقيقية: Electron safeStorage = مفتاح مُغلَّف بـ DPAPI (حساب مستخدم Windows). الواجهة لا ترى إلا الاسم والقيمة عبر IPC.
// سلوك آمن: فشل مغلق. إن لم يتوفر safeStorage لا نكتب شيئاً ولا نرجع لنص عادي.
// استثناء وحيد للاختبار على Winlator/Wine (حيث DPAPI الحقيقي غير موثوق): SCD_WINLATOR=1 يفعّل خلفية برمجية
// (AES-256-GCM بمفتاح ملف محلي) موسومة insecure وتُسجَّل تحذيراً صريحاً، ولا تُقرأ بها عناصر كُتبت بـ DPAPI والعكس.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScdError } = require('./errors.cjs');

const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_VALUE = 256 * 1024;
const MAX_ITEMS = 512;
const FORMAT = 1;
const SESSION_KEY = 'securecase_session_uid';
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const err = (code, msg) => new ScdError(code, msg);
const bad = (m) => err('INVALID_PAYLOAD', m);

function sessionTtlMs(env = process.env) {
  const m = Number(env.SCD_SESSION_TTL_MINUTES);
  if (Number.isFinite(m) && m >= 5 && m <= 7 * 24 * 60) return Math.floor(m) * 60 * 1000;
  return DEFAULT_SESSION_TTL_MS;
}

function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad('اسم المفتاح غير صالح');
  return name;
}
function checkValue(value) {
  if (typeof value !== 'string') throw bad('القيمة يجب أن تكون نصاً');
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE) throw bad('القيمة أكبر من الحد المسموح');
  return value;
}

// خلفية safeStorage (DPAPI على Windows)
function dpapiBackend(safeStorage) {
  return {
    id: 'dpapi',
    insecure: false,
    available: () => { try { return !!safeStorage && safeStorage.isEncryptionAvailable() === true; } catch { return false; } },
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };
}

// خلفية الاختبار البرمجية (Winlator فقط). المفتاح بجوار البيانات = لا حماية حقيقية.
function softwareBackend(dir) {
  const keyFile = path.join(dir, 'test-key.bin');
  let key = null;
  const loadKey = () => {
    if (key) return key;
    try { key = fs.readFileSync(keyFile); if (key.length !== 32) throw new Error('bad'); } catch {
      fs.mkdirSync(dir, { recursive: true });
      key = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
    }
    return key;
  };
  return {
    id: 'software-test',
    insecure: true,
    available: () => true,
    encrypt: (plain) => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    decrypt: (b64) => {
      const raw = Buffer.from(b64, 'base64');
      if (raw.length < 29) throw new Error('short');
      const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

function createSecureService({ safeStorage, dir, logger, softwareTest = false, now = () => Date.now(), sessionTtl = DEFAULT_SESSION_TTL_MS, fsApi = fs } = {}) {
  if (!dir) throw new Error('dir مطلوب');
  const log = logger || { info() {}, warn() {}, error() {} };
  const file = path.join(dir, 'items.json');
  const bak = path.join(dir, 'items.json.bak');
  const backend = softwareTest ? softwareBackend(dir) : dpapiBackend(safeStorage);
  if (softwareTest) log.warn('⚠ خلفية الأسرار البرمجية للاختبار مفعّلة (SCD_WINLATOR). ليست DPAPI ولا تُستعمل في الإنتاج.');
  const ttl = { [SESSION_KEY]: sessionTtl };
  let cache = null;

  const ready = () => {
    if (!backend.available()) throw err('SECURE_UNAVAILABLE', 'التخزين الآمن غير متاح على هذا الجهاز');
  };
  const parse = (f) => {
    const j = JSON.parse(fsApi.readFileSync(f, 'utf8'));
    if (!j || j.format !== FORMAT || typeof j.items !== 'object' || j.items === null || Array.isArray(j.items)) throw new Error('bad format');
    return j.items;
  };
  const load = () => {
    if (cache) return cache;
    if (!fsApi.existsSync(file) && !fsApi.existsSync(bak)) return (cache = Object.create(null));
    try { cache = Object.assign(Object.create(null), parse(file)); return cache; } catch (e1) {
      log.error('items.json تالف، محاولة الاستعادة من النسخة السابقة');
      try { cache = Object.assign(Object.create(null), parse(bak)); return cache; } catch {
        throw err('SECURE_STORE_CORRUPT', 'ملف التخزين الآمن تالف ولن يُستبدل تلقائياً');
      }
    }
  };
  const persist = (items) => {
    fsApi.mkdirSync(dir, { recursive: true });
    if (fsApi.existsSync(file)) { try { fsApi.copyFileSync(file, bak); } catch { /* نسخة مساعدة فقط */ } }
    const tmp = file + '.' + process.pid + '.tmp';
    const fd = fsApi.openSync(tmp, 'w', 0o600);
    try { fsApi.writeFileSync(fd, JSON.stringify({ format: FORMAT, items }), 'utf8'); fsApi.fsyncSync(fd); } finally { fsApi.closeSync(fd); }
    fsApi.renameSync(tmp, file);
    cache = items;
  };

  function get(name) {
    checkName(name); ready();
    const items = load();
    const it = items[name];
    if (!it) return null;
    if (ttl[name] && typeof it.t === 'number' && now() - it.t > ttl[name]) { // جلسة منتهية: تُحذف ولا تُرجَع
      const next = { ...items }; delete next[name]; persist(next);
      log.info('انتهت صلاحية الجلسة وحُذفت');
      return null;
    }
    if (it.b !== backend.id) throw err('SECURE_BACKEND_MISMATCH', 'العنصر كُتب بخلفية تخزين مختلفة ولا يمكن قراءته هنا');
    let obj;
    try { obj = JSON.parse(backend.decrypt(it.v)); } catch { throw err('SECURE_DECRYPT_FAILED', 'تعذّر فك تشفير العنصر (حساب Windows أو الجهاز مختلف)'); }
    if (!obj || obj.n !== name || typeof obj.v !== 'string') throw err('SECURE_DECRYPT_FAILED', 'العنصر لا يطابق اسمه (عبث محتمل)');
    return obj.v;
  }
  function set(name, value) {
    checkName(name); checkValue(value); ready();
    const items = load();
    if (!items[name] && Object.keys(items).length >= MAX_ITEMS) throw err('SECURE_FULL', 'تجاوز الحد الأقصى لعدد العناصر');
    let v;
    try { v = backend.encrypt(JSON.stringify({ n: name, v: value })); } catch { throw err('SECURE_ENCRYPT_FAILED', 'تعذّر تشفير العنصر'); }
    persist({ ...items, [name]: { v, b: backend.id, t: now() } });
  }
  function remove(name) {
    checkName(name);
    const items = load();
    if (!(name in items)) return;
    const next = { ...items }; delete next[name]; persist(next);
  }
  const info = () => {
    let count = -1; // -1 = تعذّرت القراءة (تالف)؛ info لا ترمي أبداً كي لا يتعطل الإقلاع
    try { count = Object.keys(load()).length; } catch { /* يُعالَج عند أول عملية */ }
    return { backend: backend.id, insecure: backend.insecure, available: backend.available(), count };
  };
  return { get, set, remove, info, NAME_RE, SESSION_KEY };
}

// Windows Hello غير متاح من Electron بدون وحدة أصلية؛ نُعلن ذلك صراحة فتُخفي src خيار البصمة (biometric-policy).
function createAuthService() {
  return {
    available: () => ({ hasHardware: false, enrolled: false }),
    prompt: () => ({ success: false, error: 'not_available' }),
  };
}

module.exports = { createSecureService, createAuthService, sessionTtlMs, NAME_RE, MAX_VALUE, MAX_ITEMS, SESSION_KEY, DEFAULT_SESSION_TTL_MS };
