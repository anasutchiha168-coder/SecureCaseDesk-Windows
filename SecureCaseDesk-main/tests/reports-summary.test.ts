// SECURECASEDESK_REPORT_SUMMARY — اختبارات التلخيص الآلي وحمولة الذكاء الاصطناعي وسياساتها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReportDocument } from '../src/modules/reports/reports-types';
import { applyReportSummary, buildAiDigest, buildAutoSummaryText, digestEntities, sanitizeSummaryText } from '../src/modules/reports/reports-summary';
import { createReportAi } from '../src/modules/ai/ai-report-summary';
import { AiError } from '../src/modules/ai/ai-types';

const base = (kind: ReportDocument['kind'], sections: ReportDocument['sections']): ReportDocument => ({
  kind, title: 'عنوان', documentNumber: 'SCD-1', createdAt: 0, createdBy: 'admin', filtersText: 'كل الفترات', sections, rowCount: 3,
});

const det = base('detainees_current', [
  { type: 'kv', heading: 'الملخص', rows: [{ label: 'عدد المحتجزين الحاليين', value: '3' }] },
  { type: 'table', heading: 'سجل المحتجزين الحاليين', columns: ['الرقم المرجعي', 'الاسم', 'الفئة', 'جهة الحجز', 'التهمة', 'تاريخ الإيداع', 'المدة (يوم)'],
    rows: [['R1', 'أحمد سري', 'بالغ', 'قسم أ', 'سرقة', '2026-11-01', '21'], ['R2', 'خالد سري', 'بالغ', 'قسم أ', 'سرقة', '2026-11-10', '12'], ['R3', 'سعيد سري', 'حدث', 'قسم ب', 'اعتداء', '2026-11-15', '7']] },
]);
const caseFile = base('case_file', [
  { type: 'kv', heading: 'بيانات القضية', rows: [
    { label: 'رقم القضية', value: '2026/001' }, { label: 'نوع القضية', value: 'سرقة' }, { label: 'الحالة', value: 'جديدة' },
    { label: 'القسم المختص', value: 'البحث الجنائي' }, { label: 'تاريخ التسجيل', value: '2026-11-22' },
    { label: 'المشتكي / المجني عليه', value: 'سري جداً' }, { label: 'المتهمون والأطراف', value: 'اسم متهم' }, { label: 'سجّلها', value: 'user1' } ] },
  { type: 'text', heading: 'تفاصيل الحادثة', text: 'نص حر فيه أسماء' },
  { type: 'table', heading: 'المذكرات المرتبطة', columns: ['رقم المذكرة', 'التاريخ'], rows: [['1', '2026-11-20']] },
  { type: 'table', heading: 'المرفقات', columns: ['اسم الملف'], rows: [], emptyText: 'لا توجد مرفقات.' },
]);

test('الملخص الآلي: جمل من البيانات فقط، ويُدرج أول المستند دون تعديل الأصل', () => {
  const t = buildAutoSummaryText(det);
  assert.match(t, /3 سجل/); assert.match(t, /أطول مدة 21/); assert.match(t, /دون ذكاء اصطناعي/);
  const out = applyReportSummary(det, { mode: 'auto' })!;
  assert.equal(out.sections[0].heading, 'ملخص آلي'); assert.equal(out.sections.length, det.sections.length + 1); assert.equal(det.sections.length, 2);
  assert.match(buildAutoSummaryText(caseFile), /القضية رقم 2026\/001.*جديدة/);
});

test('حمولة الذكاء الاصطناعي: لا أسماء ولا تهم ولا نص حر ولا بيانات أطراف', () => {
  const d = buildAiDigest(det).text;
  for (const bad of ['أحمد', 'خالد', 'سعيد', 'سرقة', 'اعتداء', 'R1']) assert.ok(!d.includes(bad), 'يجب ألا تظهر: ' + bad);
  assert.match(d, /عدد السجلات: 3/); assert.match(d, /بالغ \(2\)/);
  const c = buildAiDigest(caseFile);
  for (const bad of ['سري جداً', 'اسم متهم', 'user1', 'نص حر']) assert.ok(!c.text.includes(bad), bad);
  assert.ok(c.withheldFields.includes('المتهمون والأطراف'));
});

test('أنواع السجلات الممسوسة (لسياسة المحتجزين)', () => {
  assert.deepEqual(digestEntities(det), ['detainee']);
  assert.deepEqual(digestEntities(caseFile), ['case', 'memo']);
  assert.deepEqual(digestEntities(base('operations', [])), []);
});

test('تنقية نص الملخص المعتمد', () => {
  assert.equal(sanitizeSummaryText('  ab '), null);
  assert.equal(applyReportSummary(det, { mode: 'ai', text: '' }), null);
  assert.equal(sanitizeSummaryText('نص\u202Eصحيح\u0000 هنا'), 'نصصحيح  هنا');
});

// ---- منسّق الذكاء مع اعتماديات مزيفة ----
function mkAi(opts: { mode: 'disabled' | 'local' | 'cloud'; reply?: string; auditFails?: boolean; role?: string }) {
  const sent: string[] = []; const audits: string[] = [];
  const ai = createReportAi({
    manager: {
      async getState() { return { mode: opts.mode, features: { summary: true }, availability: { available: opts.mode !== 'disabled', message: 'm' } } as never; },
      async authorizeUse(_s, req) {
        if (opts.mode === 'cloud' && req.confirmCloudSend !== true) throw new AiError('CLOUD_CONFIRMATION_REQUIRED');
        return { mode: opts.mode as 'local' | 'cloud', model: 'x', provider: { id: opts.mode as 'local' | 'cloud', getStatus: async () => ({ state: 'ready', detail: '' }),
          generate: async (r) => { sent.push(r.prompt); return { text: opts.reply ?? 'الملخص: يوجد 3 سجل في التقرير بحسب الخلاصة المرفقة.', providerId: opts.mode as 'local' | 'cloud', model: 'x' }; } } };
      },
    },
    resolveActiveRole: async () => opts.role ?? 'admin',
    audit: async (e) => { if (opts.auditFails) throw new Error('x'); audits.push(e.operationType); },
    newId: () => 'id1', now: () => 1,
  });
  return { ai, sent, audits };
}
const S = { userId: 'u1', role: 'admin' } as never;

test('سحابي: المحتجزون ممنوعون، والقضايا تتطلب تأكيداً مربوطاً بالرمز', async () => {
  const { ai, sent } = mkAi({ mode: 'cloud' });
  const p = await ai.prepare(S, det);
  assert.equal(p.aiUsable, false); assert.match(p.message, /المحتجزين/);
  const r = await ai.summarize(S, det, { confirmCloud: true, confirmedToken: 'x' });
  assert.equal(r.draft, null); assert.equal(sent.length, 0);

  const cp = await ai.prepare(S, caseFile);
  assert.equal(cp.willSendToCloud, true); assert.ok(cp.payload && cp.token);
  const bad = await ai.summarize(S, caseFile, { confirmCloud: true, confirmedToken: 'غير مطابق' });
  assert.equal(bad.draft, null); assert.equal(sent.length, 0);
  const ok = await ai.summarize(S, caseFile, { confirmCloud: true, confirmedToken: cp.token! });
  assert.ok(ok.draft); assert.equal(sent.length, 1); assert.ok(!sent[0].includes('اسم متهم'));
});

test('سحابي: فشل التدقيق يمنع الإرسال؛ محلي يسمح بالمحتجزين', async () => {
  const f = mkAi({ mode: 'cloud', auditFails: true });
  const cp = await f.ai.prepare(S, caseFile);
  const r = await f.ai.summarize(S, caseFile, { confirmCloud: true, confirmedToken: cp.token! });
  assert.equal(r.draft, null); assert.equal(f.sent.length, 0);
  const l = mkAi({ mode: 'local' });
  assert.equal((await l.ai.prepare(S, det)).aiUsable, true);
  assert.ok((await l.ai.summarize(S, det, {})).draft);
});

test('معطّل = غير متاح؛ المراجعة تُلزم المالك وتُدقَّق', async () => {
  assert.equal((await mkAi({ mode: 'disabled' }).ai.prepare(S, caseFile)).aiUsable, false);
  const { ai, audits } = mkAi({ mode: 'local' });
  const r = await ai.summarize(S, caseFile, {});
  const rev = await ai.reviewDraft(S, r.draft!, caseFile, 'accept', 'نص معدّل بعد المراجعة');
  assert.equal(rev.finalText, 'نص معدّل بعد المراجعة'); assert.ok(audits.includes('ai_report_summary_review'));
  await assert.rejects(ai.reviewDraft({ userId: 'other', role: 'admin' } as never, r.draft!, caseFile, 'accept'));
});
