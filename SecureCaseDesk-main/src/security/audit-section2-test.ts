// SECURECASEDESK_PHASE8_S2
// اختبارات العبث والحذف والتزامن والاستعادة (منطق صرف، يعمل في Node وعلى الجهاز).
// تشغيل:  npx tsx src/security/audit-section2-test.ts

import {
  GENESIS_HASH, KEY_ROTATION_ENTITY, KEY_ROTATION_OPERATION,
  buildCheckpoint, calculateRowHmac, sha256Hex, versionLabel,
} from './audit-crypto';
import type { AuditLogRow } from './audit-crypto';
import {
  ChainVerifier, dedupeEvents, detectQueueGaps, runAuditIntegritySelfTest,
} from './audit-verifier-core';
import type { CheckpointInput, ChainVerifierOptions } from './audit-verifier-core';

const K1 = new Uint8Array(32).fill(0x11);
const K2 = new Uint8Array(32).fill(0x22);
const CK = new Uint8Array(32).fill(0x33);
const WRONG_CK = new Uint8Array(32).fill(0x44);

type Plan = { rotateAfter?: number[] };

function buildChain(n: number, plan: Plan = {}): AuditLogRow[] {
  const rows: AuditLogRow[] = [];
  let version = 1;
  let prev = GENESIS_HASH;

  for (let i = 1; i <= n; i++) {
    let operation = 'update', entity = 'cases', newValues = '{"i":' + i + '}';
    const isRotation = plan.rotateAfter?.includes(i) ?? false;
    if (isRotation) {
      operation = KEY_ROTATION_OPERATION;
      entity = KEY_ROTATION_ENTITY;
      newValues = JSON.stringify({ from: version, to: version + 1 });
    }
    const key = version === 1 ? K1 : K2;
    const base = {
      sequence_no: i, operation_id: 'op-' + i, source_event_id: 'ev-' + i,
      user_id: 'u1', username: 'المدير', operation_type: operation,
      entity_type: entity, entity_id: 'e' + i, previous_values: null,
      new_values: newValues, correction_reason: null, created_at: 1000 + i,
      previous_hash: prev, hmac_version: versionLabel(version),
    };
    const row = { ...base, record_hash: calculateRowHmac(key, base) };
    rows.push(row);
    prev = row.record_hash;
    if (isRotation) version += 1;
  }
  return rows;
}

const keys = (v: number) => (v === 1 ? K1 : v === 2 ? K2 : null);
const cp = (row: AuditLogRow, key = CK): CheckpointInput => ({
  source: 'external',
  record: buildCheckpoint(
    key, { sequence_no: row.sequence_no, record_hash: row.record_hash, key_version: 1 }, 5000
  ),
});

function verify(
  rows: AuditLogRow[],
  o: Partial<ChainVerifierOptions> = {},
  queueGapCount = 0
) {
  const v = new ChainVerifier({ resolveKey: keys, checkpointKey: CK, externalState: 'ignored', ...o });
  v.feed(rows);
  return v.finish({ queueGapCount });
}
const codes = (r: ReturnType<typeof verify>) => r.findings.map((f) => f.code);
const clone = (rows: AuditLogRow[]) => rows.map((r) => ({ ...r }));

const results: { name: string; pass: boolean; note?: string }[] = [];
function test(name: string, fn: () => boolean | string) {
  try {
    const r = fn();
    results.push({ name, pass: r === true, note: r === true ? undefined : String(r) });
  } catch (e) {
    results.push({ name, pass: false, note: String((e as Error).message) });
  }
}

const chain = buildChain(10);

// ===== سلامة أساسية =====
test('سلسلة سليمة', () => verify(chain).status === 'VALID');
test('اختبار HMAC الداخلي (RFC 4231) والعبث', () => runAuditIntegritySelfTest().ok);
test('التحقق على دفعات يعطي نفس نتيجة الدفعة الواحدة', () => {
  const v = new ChainVerifier({ resolveKey: keys, externalState: 'ignored' });
  for (let i = 0; i < chain.length; i += 3) v.feed(chain.slice(i, i + 3));
  const r = v.finish();
  return r.ok && r.count === 10 && r.lastSequence === 10;
});
test('سلسلة فارغة صالحة', () => verify([]).ok);

// ===== العبث =====
test('تعديل حقل في سجل وسطي → INVALID_HMAC عند السجل نفسه', () => {
  const t = clone(chain); t[4].new_values = '{"i":999}';
  const r = verify(t);
  return r.status === 'COMPROMISED' && r.firstFailure?.code === 'INVALID_HMAC' &&
    r.firstFailure.sequence === 5;
});
test('تعديل اسم المستخدم المنفّذ', () => {
  const t = clone(chain); t[2].username = 'مستخدم آخر';
  return codes(verify(t)).includes('INVALID_HMAC');
});
test('تعديل previous_hash → BROKEN_LINK', () => {
  const t = clone(chain); t[6].previous_hash = 'f'.repeat(64);
  return codes(verify(t)).includes('BROKEN_LINK');
});
test('حقن سجل مزوّر بتوقيع عشوائي', () => {
  const t = clone(chain); t[3].record_hash = '0'.repeat(64);
  return codes(verify(t)).includes('INVALID_HMAC');
});
test('توقيع سجل بمفتاح خاطئ (مهاجم لا يعرف المفتاح)', () => {
  const t = clone(chain);
  const { record_hash, ...base } = t[5];
  t[5].record_hash = calculateRowHmac(new Uint8Array(32).fill(9), base);
  return codes(verify(t)).includes('INVALID_HMAC');
});

// ===== الحذف =====
test('حذف سجل وسطي → SEQUENCE_GAP', () => {
  const t = clone(chain); t.splice(4, 1);
  const r = verify(t);
  return codes(r).includes('SEQUENCE_GAP') && r.status === 'COMPROMISED';
});
test('حذف أول سجل → SEQUENCE_GAP', () => {
  const t = clone(chain); t.shift();
  return codes(verify(t)).includes('SEQUENCE_GAP');
});
test('حذف عدة سجلات متباعدة يُكتشف كله (لا يتوقف عند أول خطأ)', () => {
  const t = clone(chain); t.splice(7, 1); t.splice(2, 1);
  return codes(verify(t)).filter((c) => c === 'SEQUENCE_GAP').length === 2;
});
test('حذف نهاية السلسلة بدون Checkpoint لا يُكتشف (حد معروف)', () => {
  const t = clone(chain).slice(0, 7);
  return verify(t).ok === true;
});
test('حذف نهاية السلسلة مع Checkpoint خارجي → TAIL_TRUNCATED', () => {
  const t = clone(chain).slice(0, 7);
  const r = verify(t, { checkpoints: [cp(chain[9])], externalState: 'present' });
  return r.status === 'COMPROMISED' && codes(r).includes('TAIL_TRUNCATED') &&
    r.checkpoint === 'FAILED';
});
test('حذف كل السجلات مع بقاء Checkpoint → TAIL_TRUNCATED', () => {
  const r = verify([], { checkpoints: [cp(chain[4])], externalState: 'present' });
  return codes(r).includes('TAIL_TRUNCATED');
});
test('Checkpoint سليم → MATCH', () => {
  const r = verify(chain, { checkpoints: [cp(chain[9])], externalState: 'present' });
  return r.ok && r.checkpoint === 'MATCH';
});
test('Checkpoint أقدم من نهاية السلسلة (نمو طبيعي) → سليم', () => {
  const r = verify(chain, { checkpoints: [cp(chain[5])], externalState: 'present' });
  return r.ok;
});
test('حذف ثم إعادة بناء سجلات مختلفة بنفس الأرقام → CHECKPOINT_MISMATCH', () => {
  const forged = clone(chain).slice(0, 7);
  const base = {
    ...buildChain(10)[7], new_values: '{"forged":true}', previous_hash: forged[6].record_hash,
  } as AuditLogRow;
  const { record_hash, ...b } = base;
  forged.push({ ...b, record_hash: calculateRowHmac(K1, b) });
  const r = verify(forged, { checkpoints: [cp(chain[7])], externalState: 'present' });
  return codes(r).includes('CHECKPOINT_MISMATCH');
});
test('Checkpoint مزوّر (توقيع بمفتاح آخر) → CHECKPOINT_SIGNATURE_INVALID', () => {
  const t = clone(chain).slice(0, 7);
  const r = verify(t, { checkpoints: [cp(t[6], WRONG_CK)], externalState: 'present' });
  return codes(r).includes('CHECKPOINT_SIGNATURE_INVALID');
});
test('Checkpoint خارجي تالف → CHECKPOINT_CORRUPT', () => {
  return codes(verify(chain, { externalState: 'corrupt' })).includes('CHECKPOINT_CORRUPT');
});
test('غياب Checkpoint تحذير فقط وليس فشلاً', () => {
  const r = verify(chain, { externalState: 'missing' });
  return r.ok && codes(r).includes('CHECKPOINT_MISSING');
});
test('مفتاح Checkpoint غير متوفر → INCONCLUSIVE وليس COMPROMISED', () => {
  const r = verify(chain, { checkpoints: [cp(chain[9])], checkpointKey: null, externalState: 'present' });
  return r.status === 'INCONCLUSIVE';
});
test('Checkpoint مستقل: توقيعه بمفتاح السلسلة v1 يُرفض', () => {
  const r = verify(chain, { checkpoints: [cp(chain[9], K1)], externalState: 'present' });
  return codes(r).includes('CHECKPOINT_SIGNATURE_INVALID');
});
test('Checkpoints قاعدة البيانات الوسيطة تكشف استبدال سجل وسطي', () => {
  const t = clone(chain);
  const { record_hash, ...b } = { ...t[4], new_values: '{"x":1}' };
  t[4] = { ...b, record_hash: calculateRowHmac(K1, b) } as AuditLogRow; // لو افترضنا تسرّب المفتاح
  const mid: CheckpointInput = { source: 'database', record: cp(chain[4]).record };
  return codes(verify(t, { checkpoints: [mid], externalState: 'present' })).includes('CHECKPOINT_MISMATCH');
});

// ===== إعادة الترتيب =====
test('تبديل ترتيب سجلين في المصفوفة → OUT_OF_ORDER/BROKEN', () => {
  const t = clone(chain); [t[3], t[4]] = [t[4], t[3]];
  const r = verify(t);
  return r.status === 'COMPROMISED' &&
    (codes(r).includes('OUT_OF_ORDER') || codes(r).includes('SEQUENCE_GAP'));
});
test('تبديل محتوى سجلين مع إبقاء الأرقام → INVALID_HMAC', () => {
  const t = clone(chain);
  const a = { ...t[3] }, b = { ...t[4] };
  t[3] = { ...b, sequence_no: a.sequence_no };
  t[4] = { ...a, sequence_no: b.sequence_no };
  return codes(verify(t)).includes('INVALID_HMAC');
});
test('تكرار سجل (حقن نسخة) → OUT_OF_ORDER', () => {
  const t = clone(chain); t.splice(5, 0, { ...t[4] });
  return codes(verify(t)).includes('OUT_OF_ORDER');
});
test('رقم تسلسلي سالب أو صفري يُرفض', () => {
  const t = clone(chain); t.unshift({ ...t[0], sequence_no: 0 });
  return verify(t).status === 'COMPROMISED';
});

// ===== المفاتيح وإصداراتها =====
const rotated = buildChain(10, { rotateAfter: [5] });
test('تدوير مفتاح صحيح: v1 ثم v2 عبر سجل تدوير موثّق', () => {
  const r = verify(rotated);
  return r.ok && r.keyVersionsUsed.join() === '1,2' &&
    rotated[4].operation_type === KEY_ROTATION_OPERATION &&
    rotated[5].hmac_version === versionLabel(2);
});
test('تبديل الإصدار بدون سجل تدوير → UNAUTHORIZED_KEY_SWITCH', () => {
  const t = clone(rotated);
  // نعيد توقيع السجل 4 بإصدار 2 كأن مهاجماً يملك المفتاحين
  for (let i = 3; i < t.length; i++) {
    t[i].hmac_version = versionLabel(2);
    t[i].previous_hash = t[i - 1].record_hash;
    const { record_hash, ...b } = t[i];
    t[i].record_hash = calculateRowHmac(K2, b);
  }
  return codes(verify(t)).includes('UNAUTHORIZED_KEY_SWITCH');
});
test('الرجوع إلى إصدار قديم بعد التدوير → KEY_VERSION_REGRESSION', () => {
  const t = clone(rotated);
  const i = 8;
  t[i].hmac_version = versionLabel(1);
  t[i].previous_hash = t[i - 1].record_hash;
  const { record_hash, ...b } = t[i];
  t[i].record_hash = calculateRowHmac(K1, b);
  return codes(verify(t)).includes('KEY_VERSION_REGRESSION');
});
test('مفتاح قديم مفقود → INCONCLUSIVE (لا يُعلن عبثاً كاذباً)', () => {
  const r = verify(rotated, { resolveKey: (v) => (v === 2 ? K2 : null) });
  return r.status === 'INCONCLUSIVE' && codes(r).includes('KEY_UNAVAILABLE');
});
test('مفتاح مفقود لا يمنع اكتشاف حذف في السلسلة', () => {
  const t = clone(rotated); t.splice(2, 1);
  const r = verify(t, { resolveKey: (v) => (v === 2 ? K2 : null) });
  return r.status === 'COMPROMISED';
});
test('بصمة المفتاح المسجّلة: استبدال المفتاح يُكتشف', () => {
  const fp = new Map([[1, sha256Hex(K1)], [2, sha256Hex(new Uint8Array(32).fill(0x99))]]);
  return codes(verify(rotated, { fingerprints: fp })).includes('KEY_FINGERPRINT_MISMATCH');
});
test('بصمات صحيحة تمر', () => {
  const fp = new Map([[1, sha256Hex(K1)], [2, sha256Hex(K2)]]);
  return verify(rotated, { fingerprints: fp }).ok;
});
test('إصدار توقيع غير معروف/مشوّه', () => {
  const t = clone(chain); t[2].hmac_version = 'HMAC-SHA256-v0';
  return codes(verify(t)).includes('UNKNOWN_VERSION');
});
test('قفز الإصدار v1 → v3 مرفوض', () => {
  const t = clone(rotated);
  for (let i = 6; i < t.length; i++) {
    t[i].hmac_version = versionLabel(3);
    t[i].previous_hash = t[i - 1].record_hash;
    const { record_hash, ...b } = t[i];
    t[i].record_hash = calculateRowHmac(K2, b);
  }
  return codes(verify(t, { resolveKey: (v) => (v === 3 ? K2 : keys(v)) })).includes('UNAUTHORIZED_KEY_SWITCH');
});

// ===== الاستعادة =====
test('استعادة نسخة قديمة سليمة داخلياً: تُكتشف عبر Checkpoint فقط', () => {
  const old = clone(chain).slice(0, 6);
  const noCp = verify(old);
  const withCp = verify(old, { checkpoints: [cp(chain[9])], externalState: 'present' });
  return noCp.ok && withCp.status === 'COMPROMISED' && codes(withCp).includes('TAIL_TRUNCATED');
});
test('بعد قبول الاستعادة (Checkpoint أدنى موقّع جديد) تعود السلسلة سليمة', () => {
  const old = clone(chain).slice(0, 6);
  const r = verify(old, { checkpoints: [cp(old[5])], externalState: 'present' });
  return r.ok && r.checkpoint === 'MATCH';
});
test('نسخة احتياطية معبوث بها تبقى مكتشفة بعد الاستعادة', () => {
  const old = clone(chain).slice(0, 6); old[2].new_values = '{"evil":1}';
  return verify(old, { checkpoints: [cp(chain[5])], externalState: 'present' }).status === 'COMPROMISED';
});
test('استعادة نسخة v1 فقط بعد التدوير إلى v2 تعمل (المفاتيح القديمة محفوظة)', () => {
  const old = clone(rotated).slice(0, 4);
  return verify(old).ok;
});
test('استعادة نسخة أحدث على جهاز لا يملك مفتاح v2 → INCONCLUSIVE', () => {
  const r = verify(rotated, { resolveKey: (v) => (v === 1 ? K1 : null) });
  return r.status === 'INCONCLUSIVE';
});

// ===== التزامن ومنع التكرار =====
test('فجوة الطابور: حدث قديم غير مسجّل بعد حدث مسجّل = حذف', () => {
  return detectQueueGaps([5, 9], 8).join() === '5' && verify(chain, {}, 1).status === 'COMPROMISED';
});
test('لا فجوة عندما الأحداث المعلّقة أحدث من آخر مسجّل', () => {
  return detectQueueGaps([9, 10], 8).length === 0 && detectQueueGaps([1], null).length === 0;
});
test('منع التكرار: المفتاح المعروف والتكرار داخل الدفعة', () => {
  const { fresh, duplicates } = dedupeEvents(
    [{ event_key: 'a' }, { event_key: 'b' }, { event_key: 'b' }, { event_key: 'c' }],
    new Set(['a'])
  );
  return fresh.map((x) => x.event_key).join() === 'b,c' && duplicates.length === 2;
});
test('إعادة إرسال نفس الدفعة مرتين لا تنتج أحداثاً جديدة', () => {
  const batch = [{ event_key: 'x' }, { event_key: 'y' }];
  const first = dedupeEvents(batch, new Set());
  const second = dedupeEvents(batch, new Set(first.fresh.map((e) => e.event_key)));
  return first.fresh.length === 2 && second.fresh.length === 0;
});
test('سقف عدد النتائج يمنع تضخم التقرير', () => {
  const t = clone(chain).map((r) => ({ ...r, record_hash: '0'.repeat(64) }));
  const v = new ChainVerifier({ resolveKey: keys, maxFindings: 3, externalState: 'ignored' });
  v.feed(t);
  const r = v.finish();
  return r.findings.length === 3 && r.findingsTruncated;
});

// ===== التقرير =====
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log((r.pass ? 'نجح  ' : 'فشل  ') + r.name + (r.note ? ' → ' + r.note : ''));
}
console.log('\nالإجمالي: ' + results.length + ' | ناجح: ' + (results.length - failed) + ' | فاشل: ' + failed);
export const SECTION2_PURE_TEST_RESULTS = results;
if (failed > 0 && typeof process !== 'undefined') process.exitCode = 1;
