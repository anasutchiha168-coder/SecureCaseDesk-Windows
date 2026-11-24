// القسم 7: خدمة الأسرار. safeStorage هنا مزيّف قابل للعكس لاختبار المنطق؛ DPAPI الحقيقي يُفحص في smoke:secure على Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSecureService, createAuthService, sessionTtlMs, SESSION_KEY, MAX_VALUE, MAX_ITEMS } = require('../../electron/lib/secure-service.cjs');

const fakeSafe = (avail = true) => ({
  isEncryptionAvailable: () => avail,
  encryptString: (s) => Buffer.from('ENC1:' + Buffer.from(s, 'utf8').toString('base64').split('').reverse().join('')),
  decryptString: (b) => {
    const t = b.toString();
    if (!t.startsWith('ENC1:')) throw new Error('bad blob');
    return Buffer.from(t.slice(5).split('').reverse().join(''), 'base64').toString('utf8');
  },
});
const mk = (o = {}) => {
  const dir = o.dir || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scd-sec-')), 'secure');
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  return { dir, logs, s: createSecureService({ safeStorage: fakeSafe(), dir, logger, ...o }) };
};
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('set/get/remove وقيمة عربية وقيمة مفقودة = null', () => {
  const { s } = mk();
  assert.equal(s.get('db_encryption_key'), null);
  s.set('db_encryption_key', 'مفتاح-سري-١٢٣');
  assert.equal(s.get('db_encryption_key'), 'مفتاح-سري-١٢٣');
  s.set('db_encryption_key', 'v2');
  assert.equal(s.get('db_encryption_key'), 'v2');
  s.remove('db_encryption_key'); s.remove('غير_موجود'.replace(/[^\x00-\x7f]/g, 'x'));
  assert.equal(s.get('db_encryption_key'), null);
});

test('الملف على القرص لا يحوي القيمة ولا نصاً مقروءاً، والسجلات لا تحويها', () => {
  const { s, dir, logs } = mk();
  s.set('attachment_master_key_v1', 'SUPER-SECRET-VALUE-0123456789abcdef');
  const raw = fs.readFileSync(path.join(dir, 'items.json'), 'utf8');
  assert.ok(!raw.includes('SUPER-SECRET'));
  assert.ok(!Buffer.from(raw).toString('base64').includes('SUPER'));
  assert.ok(!logs.join('\n').includes('SUPER-SECRET'));
});

test('يبقى بعد إعادة التشغيل (نسخة خدمة جديدة)', () => {
  const a = mk();
  a.s.set('k1', 'v1');
  const b = createSecureService({ safeStorage: fakeSafe(), dir: a.dir });
  assert.equal(b.get('k1'), 'v1');
});

test('التحقق من الأسماء والقيم', () => {
  const { s } = mk();
  for (const n of ['', 'a b', 'a/b', 'a\\b', "a'b", 'x'.repeat(129), 5, null, undefined, {}, '__proto__x/']) {
    assert.equal(code(() => s.get(n)), 'INVALID_PAYLOAD', String(n));
    assert.equal(code(() => s.set(n, 'v')), 'INVALID_PAYLOAD');
    assert.equal(code(() => s.remove(n)), 'INVALID_PAYLOAD');
  }
  assert.equal(code(() => s.set('k', 5)), 'INVALID_PAYLOAD');
  assert.equal(code(() => s.set('k', null)), 'INVALID_PAYLOAD');
  assert.equal(code(() => s.set('k', 'x'.repeat(MAX_VALUE + 1))), 'INVALID_PAYLOAD');
  s.set('k', 'x'.repeat(MAX_VALUE));
  s.set('__proto__', 'safe'); // اسم صالح الصيغة؛ لا يلوّث Object.prototype
  assert.equal(({}).safe, undefined);
  assert.equal(s.get('__proto__'), 'safe');
});

test('حد عدد العناصر', () => {
  const { s } = mk();
  for (let i = 0; i < MAX_ITEMS; i++) s.set('k' + i, 'v');
  assert.equal(code(() => s.set('extra', 'v')), 'SECURE_FULL');
  s.set('k0', 'تحديث'); // التحديث مسموح
  assert.equal(s.get('k0'), 'تحديث');
});

test('فشل مغلق عند غياب safeStorage', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scd-sec-')), 'secure');
  for (const safeStorage of [fakeSafe(false), undefined, { isEncryptionAvailable: () => { throw new Error('x'); } }]) {
    const s = createSecureService({ safeStorage, dir });
    assert.equal(code(() => s.set('k', 'v')), 'SECURE_UNAVAILABLE');
    assert.equal(code(() => s.get('k')), 'SECURE_UNAVAILABLE');
  }
  assert.ok(!fs.existsSync(path.join(dir, 'items.json')), 'لا كتابة بلا تشفير');
});

test('فك التشفير الفاشل لا يُرجع null (حتى لا يُنشأ مفتاح قاعدة جديد بصمت)', () => {
  const a = mk();
  a.s.set('db_encryption_key', 'K');
  const other = { ...fakeSafe(), decryptString: () => { throw new Error('DPAPI other user'); } };
  const b = createSecureService({ safeStorage: other, dir: a.dir });
  assert.equal(code(() => b.get('db_encryption_key')), 'SECURE_DECRYPT_FAILED');
});

test('تبديل النصوص المشفّرة بين عنصرين يُكشف', () => {
  const { s, dir } = mk();
  s.set('a_key', 'AAA'); s.set('b_key', 'BBB');
  const f = path.join(dir, 'items.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  [j.items.a_key.v, j.items.b_key.v] = [j.items.b_key.v, j.items.a_key.v];
  fs.writeFileSync(f, JSON.stringify(j));
  const s2 = createSecureService({ safeStorage: fakeSafe(), dir });
  assert.equal(code(() => s2.get('a_key')), 'SECURE_DECRYPT_FAILED');
});

test('ملف تالف: استعادة من .bak وإلا فشل مغلق دون استبدال', () => {
  const { s, dir } = mk();
  s.set('k', 'v1'); s.set('k2', 'v2'); // ينشئ .bak بالحالة السابقة
  fs.writeFileSync(path.join(dir, 'items.json'), '{ not json');
  const s2 = createSecureService({ safeStorage: fakeSafe(), dir });
  assert.equal(s2.get('k'), 'v1'); // من النسخة السابقة
  fs.writeFileSync(path.join(dir, 'items.json'), 'garbage'); fs.writeFileSync(path.join(dir, 'items.json.bak'), 'garbage');
  const s3 = createSecureService({ safeStorage: fakeSafe(), dir });
  assert.equal(code(() => s3.get('k')), 'SECURE_STORE_CORRUPT');
  assert.equal(code(() => s3.set('n', 'v')), 'SECURE_STORE_CORRUPT');
  assert.equal(fs.readFileSync(path.join(dir, 'items.json'), 'utf8'), 'garbage', 'لم يُستبدل');
  assert.equal(s3.info().count, -1); // info لا ترمي
});

test('الجلسة تنتهي بعد المدة وتُحذف، وغيرها لا ينتهي', () => {
  let t = 1_000_000;
  const { s } = mk({ now: () => t, sessionTtl: 60_000 });
  s.set(SESSION_KEY, 'user-1'); s.set('db_encryption_key', 'K');
  t += 59_000; assert.equal(s.get(SESSION_KEY), 'user-1');
  t += 2_000; assert.equal(s.get(SESSION_KEY), null);
  assert.equal(s.get(SESSION_KEY), null);
  t += 10 * 365 * 86_400_000; assert.equal(s.get('db_encryption_key'), 'K');
  s.set(SESSION_KEY, 'user-2'); // دخول جديد يجدّد المدة
  assert.equal(s.get(SESSION_KEY), 'user-2');
});

test('sessionTtlMs: افتراضي 12 ساعة وحدود الضبط', () => {
  assert.equal(sessionTtlMs({}), 12 * 3600_000);
  assert.equal(sessionTtlMs({ SCD_SESSION_TTL_MINUTES: '30' }), 30 * 60_000);
  assert.equal(sessionTtlMs({ SCD_SESSION_TTL_MINUTES: '1' }), 12 * 3600_000);
  assert.equal(sessionTtlMs({ SCD_SESSION_TTL_MINUTES: 'abc' }), 12 * 3600_000);
  assert.equal(sessionTtlMs({ SCD_SESSION_TTL_MINUTES: '99999999' }), 12 * 3600_000);
});

test('خلفية Winlator البرمجية: تعمل بلا safeStorage، موسومة insecure، وتحذّر في السجل', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scd-sec-')), 'secure');
  const logs = [];
  const s = createSecureService({ dir, softwareTest: true, logger: { info() {}, error() {}, warn: (m) => logs.push(m) } });
  assert.deepEqual({ ...s.info(), count: 0 }, { backend: 'software-test', insecure: true, available: true, count: 0 });
  assert.ok(logs.some((m) => m.includes('SCD_WINLATOR')));
  s.set('k', 'قيمة'); assert.equal(s.get('k'), 'قيمة');
  const raw = fs.readFileSync(path.join(dir, 'items.json'), 'utf8');
  assert.ok(!raw.includes('قيمة'));
  // عنصر كُتب بـ DPAPI لا يُقرأ بخلفية الاختبار والعكس (لا خلط صامت)
  const real = createSecureService({ safeStorage: fakeSafe(), dir });
  assert.equal(code(() => real.get('k')), 'SECURE_BACKEND_MISMATCH');
  // عبث بالنص المشفّر في خلفية الاختبار يفشل (GCM)
  const f = path.join(dir, 'items.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const b = Buffer.from(j.items.k.v, 'base64'); b[b.length - 1] ^= 1; j.items.k.v = b.toString('base64'); fs.writeFileSync(f, JSON.stringify(j));
  const s2 = createSecureService({ dir, softwareTest: true });
  assert.equal(code(() => s2.get('k')), 'SECURE_DECRYPT_FAILED');
});

test('الخلفية العادية ليست insecure', () => {
  const { s } = mk();
  assert.deepEqual({ ...s.info() }, { backend: 'dpapi', insecure: false, available: true, count: 0 });
});

test('auth: لا نُظهر نجاحاً مزوّراً (Windows Hello غير مدعوم)', () => {
  const a = createAuthService();
  assert.deepEqual(a.available(), { hasHardware: false, enrolled: false });
  assert.deepEqual(a.prompt(), { success: false, error: 'not_available' });
});
