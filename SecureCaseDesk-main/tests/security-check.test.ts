// SECURECASEDESK_PHASE12_S2
// اختبار منطق تقييم فحص تشفير القاعدة (الذي تعرضه شاشة «فحص الأمان على الجهاز»).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEncryptionFacts, summarizeChecks, type EncryptionFacts } from '../src/modules/diagnostics/security-check';

const good: EncryptionFacts = {
  cipherVersion: '4.17.0', headerReadable: true, sqliteHeaderDetected: false, fileSize: 262144,
  schemaAccessible: true, wrongKeyRejected: true, reopenOk: true,
};
const level = (f: EncryptionFacts, id: string) => evaluateEncryptionFacts(f).find((c) => c.id === id)!.level;

test('كل الحقائق سليمة ← النتيجة العامة نجاح', () => {
  const s = summarizeChecks(evaluateEncryptionFacts(good));
  assert.deepEqual(s, { overall: 'pass', pass: 5, warn: 0, fail: 0 });
});

test('غياب SQLCipher ← فشل', () => {
  assert.equal(level({ ...good, cipherVersion: null }, 'cipher'), 'fail');
  assert.equal(summarizeChecks(evaluateEncryptionFacts({ ...good, cipherVersion: null })).overall, 'fail');
});

test('ظهور ترويسة SQLite الصريحة ← فشل (ملف غير مشفّر)', () => {
  assert.equal(level({ ...good, sqliteHeaderDetected: true }, 'header'), 'fail');
});

test('تعذّر قراءة الترويسة ← تنبيه لا نجاح', () => {
  assert.equal(level({ ...good, headerReadable: false }, 'header'), 'warn');
});

test('قراءة القاعدة بمفتاح خاطئ ← فشل', () => {
  assert.equal(level({ ...good, wrongKeyRejected: false }, 'wrongkey'), 'fail');
});

test('الفحوص غير المنفّذة تظهر تنبيهاً وليست نجاحاً', () => {
  const f = { ...good, wrongKeyRejected: null, reopenOk: null };
  assert.equal(level(f, 'wrongkey'), 'warn');
  assert.equal(level(f, 'reopen'), 'warn');
  assert.equal(summarizeChecks(evaluateEncryptionFacts(f)).overall, 'warn');
});

test('فشل إعادة الفتح أو القراءة بالمفتاح الصحيح ← فشل', () => {
  assert.equal(level({ ...good, reopenOk: false }, 'reopen'), 'fail');
  assert.equal(level({ ...good, schemaAccessible: false }, 'schema'), 'fail');
});

test('الفشل يغلب التنبيه في الحالة العامة', () => {
  const s = summarizeChecks(evaluateEncryptionFacts({ ...good, cipherVersion: null, wrongKeyRejected: null }));
  assert.equal(s.overall, 'fail');
});
