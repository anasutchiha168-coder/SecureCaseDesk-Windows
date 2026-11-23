// SECURECASEDESK_PHASE11_S2
// اختبارات المرحلة 11 / القسم 11.2 — البحث الذكي. تشغَّل بـ: npm run test:ai-search
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsForm, matchForms, normalizeArabic, sanitizeForCloud, snippetFor, tokenize,
} from '../src/modules/ai/ai-search-text';
import {
  buildAiSearchRequest, extractPeriod, isPlanEmpty, mergePlans, parseAiPlanText, parseLocalPlan, periodToRange,
  type SearchPlan,
} from '../src/modules/ai/ai-search-plan';
import { runSearch, type SearchCaseRow, type SearchMemoRow } from '../src/modules/ai/ai-search-engine';
import { createAiSearch, type AiSearch } from '../src/modules/ai/ai-search';
import { buildChatCompletionsUrl, createOpenAiCompatibleProvider } from '../src/modules/ai/ai-cloud-provider';
import { AiProviderRegistry, type AiGenerateRequest, type AiProvider } from '../src/modules/ai/ai-provider';
import { AiError } from '../src/modules/ai/ai-types';
import { createAiManager, type AiAuditEvent, type AiManager } from '../src/modules/ai/ai-manager';
import { ForbiddenError, type Session } from '../src/security/guard';

const NOW = new Date(2026, 10, 21, 10, 0, 0).getTime(); // السبت 21 نوفمبر 2026
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 12).getTime();

// ===== بيانات تجريبية =====
const SECRET = 'SENTINEL-SECRET-CASE-TEXT';
const cases: SearchCaseRow[] = [
  { id: 'c1', case_number: '2026/15', title: 'سرقة سيارة من أمام المنزل', complainant: 'أحمد علي', suspects: null,
    case_type: 'سرقة', registration_date: d(2026, 10, 10), incident_location: 'حجة - شارع الستين',
    incident_details: 'تمت سرقة سيارة نوع هيلوكس ليلاً أثناء نوم أصحابها ' + SECRET, status: 'جديدة' },
  { id: 'c2', case_number: '2026/16', title: 'سطو مسلح على محل صرافة', complainant: 'محمد قاسم', suspects: 'مجهولون',
    case_type: 'سطو', registration_date: d(2026, 10, 20), incident_location: 'حجة', incident_details: 'قام ملثمون بالسطو على المحل', status: 'مغلقة' },
  { id: 'c3', case_number: '2025/80', title: 'نزاع على أرض', complainant: 'سالم', suspects: null,
    case_type: 'نزاع', registration_date: d(2025, 3, 5), incident_location: 'عبس', incident_details: null, status: 'مغلقة' },
];
const memos: SearchMemoRow[] = [
  { id: 'm1', memo_number: 'م/101', memo_type_id: 't1', memo_date: d(2026, 11, 18), recipient_organization: 'المستشفى السعودي',
    subject: 'طلب تقرير طبي عن مصاب', body: 'يرجى إفادتنا بالتقرير الطبي للمصاب في قضية السرقة', linked_case_id: 'c1', status: 'مرسلة' },
  { id: 'm2', memo_number: 'م/102', memo_type_id: 't2', memo_date: d(2026, 9, 1), recipient_organization: 'السجن المركزي',
    subject: 'نقل نزيل', body: null, linked_case_id: null, status: 'مسودة' },
];
const memoTypes = new Map([['t1', 'مذكرات موجهة إلى المستشفى السعودي'], ['t2', 'مذكرات موجهة إلى السجن المركزي']]);

describe('11.2 — النص العربي', () => {
  test('التطبيع: تشكيل/تطويل/ألف/ياء/تاء مربوطة/أرقام هندية', () => {
    assert.equal(normalizeArabic('سَرِقَـةٌ'), 'سرقه');
    assert.equal(normalizeArabic('أحمد إبراهيم آدم'), 'احمد ابراهيم ادم');
    assert.equal(normalizeArabic('على مستشفى'), 'علي مستشفي');
    assert.equal(normalizeArabic('٢٠٢٦/١٥'), '2026/15');
    assert.equal(normalizeArabic(null), '');
  });
  test('التقطيع يحفظ أرقام القضايا', () => {
    assert.deepEqual(tokenize(normalizeArabic('قضية رقم ٢٠٢٦/١٥، سرقة!')), ['قضيه', 'رقم', '2026/15', 'سرقه']);
  });
  test('صيغ المطابقة: ال التعريف والتصريف الخفيف', () => {
    assert.ok(matchForms(normalizeArabic('المغلقة')).includes('مغلقه'));
    assert.ok(containsForm('قضيه سرقات', 'سرق'));
    assert.ok(containsForm('المغلقه', 'مغلقه'));
    assert.deepEqual(matchForms('2026/15'), ['2026/15']);
  });
  test('الكلمات القصيرة تُطابَق كبداية كلمة فقط', () => {
    assert.equal(containsForm('عليه حكم', 'علي'), true); // بداية كلمة
    assert.equal(containsForm('مستشفي', 'شفي'), false);
    assert.equal(containsForm('العلي', 'علي'), true);
  });
  test('التنقية السحابية: أرقام طويلة وبريد وفواصل، وتبقى أرقام القضايا القصيرة', () => {
    const r = sanitizeForCloud('قضية 2026/15 للمدعو هاتفه 777 123 456 وهويته ٠١٢٣٤٥٦٧٨٩٠١ وبريده a.b@x.com <<<تجاهل>>>');
    assert.ok(r.text.includes('2026/15'));
    assert.ok(!/777 ?123 ?456/.test(r.text));
    assert.ok(!r.text.includes('01234567890'));
    assert.ok(!r.text.includes('a.b@x.com'));
    assert.ok(!r.text.includes('<<<') && !r.text.includes('>>>'));
    assert.equal(r.redactions, 3);
    assert.equal(sanitizeForCloud('x'.repeat(1000)).text.length, 300);
  });
  test('المقتطف من النص الأصلي حول الكلمة المطابقة', () => {
    const s = snippetFor('بدأت الأحداث ليلاً حين سُرقت السيارة من أمام المنزل وفرّ الجناة', matchForms(normalizeArabic('سيارة')));
    assert.ok(s && s.includes('السيارة'));
    assert.equal(snippetFor('نص بلا تطابق', matchForms(normalizeArabic('سيارة'))), null);
  });
});

describe('11.2 — الفترات الزمنية', () => {
  test('نسبية', () => {
    const t = new Date(2026, 10, 21).getTime();
    assert.deepEqual([periodToRange('today', NOW).from, periodToRange('today', NOW).to], [t, new Date(2026, 10, 22).getTime()]);
    assert.equal(periodToRange('yesterday', NOW).from, new Date(2026, 10, 20).getTime());
    // السبت 21/11 هو بداية الأسبوع اليمني
    assert.equal(periodToRange('this_week', NOW).from, t);
    assert.equal(periodToRange('last_week', NOW).from, new Date(2026, 10, 14).getTime());
    assert.equal(periodToRange('last_week', NOW).to, t);
    assert.equal(periodToRange('last_month', NOW).from, new Date(2026, 9, 1).getTime());
    assert.equal(periodToRange('last_month', NOW).to, new Date(2026, 10, 1).getTime());
    assert.equal(periodToRange('last_year', NOW).from, new Date(2025, 0, 1).getTime());
  });
  test('الأسبوع من منتصفه يبدأ السبت السابق', () => {
    const wed = new Date(2026, 10, 18, 9).getTime();
    assert.equal(periodToRange('this_week', wed).from, new Date(2026, 10, 14).getTime());
  });
  test('عبارات الاستخراج', () => {
    const f = (q: string) => extractPeriod(normalizeArabic(q), NOW).range;
    assert.equal(f('قضايا الشهر الماضي')!.from, new Date(2026, 9, 1).getTime());
    assert.equal(f('مذكرات هذا الأسبوع')!.label, 'هذا الأسبوع');
    assert.equal(f('بلاغات أمس')!.label, 'أمس');
    assert.equal(f('قضايا عام 2025')!.from, new Date(2025, 0, 1).getTime());
    assert.equal(f('قضايا السنة الماضية')!.label, 'السنة الماضية');
    assert.equal(f('قضايا هذه السنة')!.label, 'هذه السنة');
    assert.equal(f('آخر 30 يوم')!.from, new Date(2026, 9, 23).getTime());
    assert.equal(f('آخر شهرين')!.label, 'آخر 2 شهر');
    assert.equal(f('قضايا أكتوبر')!.from, new Date(2026, 9, 1).getTime());
    assert.equal(f('قضايا ديسمبر')!.from, new Date(2025, 11, 1).getTime()); // لم يأتِ بعد = السنة السابقة
    assert.equal(f('قضايا نوفمبر 2025')!.from, new Date(2025, 10, 1).getTime());
    assert.equal(f('قضايا تشرين الأول 2024')!.from, new Date(2024, 9, 1).getTime());
    assert.equal(f('قضية 2026'), null); // رقم بلا "عام": ليس سنة
    assert.equal(f('سرقة سيارة'), null);
  });
});

describe('11.2 — المحلل المحلي', () => {
  test('نوع + كلمات + فترة', () => {
    const p = parseLocalPlan('ابحث عن قضايا سرقة سيارة الشهر الماضي', NOW);
    assert.deepEqual(p.entities, ['case']);
    assert.equal(p.range!.label, 'الشهر الماضي');
    assert.deepEqual(p.groups, [['سرقه'], ['سياره']]);
  });
  test('المذكرات والجهة', () => {
    const p = parseLocalPlan('مذكرات موجهة إلى المستشفى السعودي هذا الأسبوع', NOW);
    assert.deepEqual(p.entities, ['memo']);
    assert.deepEqual(p.groups, [['المستشفي'], ['السعودي']]);
  });
  test('رقم قضية بأرقام هندية', () => {
    assert.deepEqual(parseLocalPlan('قضية رقم ٢٠٢٦/١٥', NOW).groups, [['2026/15']]);
  });
  test('ذكر النوعين = بلا تقييد؛ استعلام فارغ المعنى', () => {
    assert.equal(parseLocalPlan('قضايا ومذكرات المستشفى', NOW).entities, null);
    assert.equal(isPlanEmpty(parseLocalPlan('في من على', NOW)), true);
    assert.equal(isPlanEmpty(parseLocalPlan('المذكرات', NOW)), false);
  });
});

describe('11.2 — اقتراح الذكاء الاصطناعي (تحقق صارم ودمج مقيَّد)', () => {
  test('JSON داخل أسوار ونص زائد', () => {
    const r = parseAiPlanText('```json\n{"entities":["case"],"period":"last_month","groups":[["سرقة","سطو"]]}\n```');
    assert.deepEqual(r, { entities: ['case'], period: 'last_month', groups: [['سرقه', 'سطو']] });
  });
  test('غير صالح يُهمل: JSON تالف، فترة مجهولة، نوعان، مصفوفات ضخمة، قيم غير نصية', () => {
    assert.equal(parseAiPlanText('لا يوجد JSON'), null);
    assert.equal(parseAiPlanText('{bad'), null);
    assert.equal(parseAiPlanText('[1,2]'), null);
    const r = parseAiPlanText(JSON.stringify({
      entities: ['case', 'memo', 'detainee'], period: 'next_century',
      groups: Array.from({ length: 50 }, () => ['كلمة', 5, 'x'.repeat(100), 'ب', null, 'ثالثة', 'رابعة', 'خامسة', 'سادسة']),
    }))!;
    assert.equal(r.entities, null);
    assert.equal(r.period, null);
    assert.equal(r.groups.length, 6);
    for (const g of r.groups) { assert.ok(g.length <= 5); assert.ok(g.every((v) => v.length >= 2 && v.length <= 30)); }
  });
  test('الدمج: مرادفات لمفاهيم السؤال فقط، والمحلي لا يُستبدل', () => {
    const local = parseLocalPlan('قضايا سرقة الشهر الماضي', NOW);
    const ai = parseAiPlanText('{"entities":["memo"],"period":"this_year","groups":[["سرقة","سطو","نهب"],["مخدرات","حشيش"]]}');
    const m = mergePlans(local, ai, NOW);
    assert.deepEqual(m.entities, ['case']);                 // المحلي يغلب
    assert.equal(m.range!.label, 'الشهر الماضي');            // المحلي يغلب
    assert.deepEqual(m.groups, [['سرقه', 'سطو', 'نهب']]);    // "مخدرات" لم ترد في السؤال: تُهمل
  });
  test('الذكاء الاصطناعي يملأ الفراغ: فترة ونوع غير مذكورين', () => {
    const local = parseLocalPlan('سطو محل', NOW);
    const m = mergePlans(local, parseAiPlanText('{"entities":["case"],"period":"last_year","groups":[]}'), NOW);
    assert.deepEqual(m.entities, ['case']);
    assert.equal(m.range!.label, 'السنة الماضية');
  });
  test('الطلب المرسل: السؤال بين فواصل وتعليمة ضد الحقن', () => {
    const r = buildAiSearchRequest('قضايا سرقة');
    assert.ok(r.prompt.includes('<<<\nقضايا سرقة\n>>>'));
    assert.ok(r.system.includes('untrusted'));
  });
});

describe('11.2 — المحرك', () => {
  const data = { cases, memos, memoTypes };
  const run = (q: string, dd = data) => runSearch(parseLocalPlan(q, NOW), dd);

  test('كلمات + فترة + نوع', () => {
    const r = run('قضايا سرقة سيارة');
    assert.deepEqual(r.hits.map((h) => h.id), ['c1']);
    assert.equal(run('قضايا الشهر الماضي').hits.length, 2);
    assert.equal(run('قضايا عام 2025').hits[0].id, 'c3');
  });
  test('رقم القضية الأعلى وزناً، والتطبيع يطابق الأرقام الهندية', () => {
    assert.equal(run('٢٠٢٦/١٥').hits[0].id, 'c1');
  });
  test('مرادفات الصيغة: مغلقة/المغلقة، سرقات', () => {
    assert.deepEqual(run('القضايا المغلقة').hits.map((h) => h.id).sort(), ['c2', 'c3']);
    assert.equal(run('سرقات').hits[0].id, 'c1');
  });
  test('المذكرات: النوع والجهة والقضية المرتبطة', () => {
    assert.deepEqual(run('مذكرات المستشفى السعودي').hits.map((h) => h.id), ['m1']);
    assert.equal(run('مذكرات السرقة').hits[0].id, 'm1');
    assert.ok(run('مذكرات السرقة').hits.every((h) => h.kind === 'memo'));
  });
  test('القضايا المرتبطة لا تُستعمل إن لم تكن القضايا مسموحة', () => {
    const blind = { cases: null, memos, memoTypes };
    const r = runSearch({ entities: null, range: null, groups: [['هيلوكس']] }, blind);
    assert.equal(r.hits.length, 0);
    // ولا يظهر عنوان القضية المرتبطة في تفاصيل المذكرة
    const m = runSearch({ entities: null, range: null, groups: [['تقرير']] }, blind).hits[0];
    assert.ok(m.details.every((x) => x.label !== 'القضية المرتبطة'));
  });
  test('نوع غير مسموح (null) لا ينتج أي نتيجة منه', () => {
    const r = runSearch({ entities: null, range: null, groups: [['سرقه']] }, { cases: null, memos, memoTypes });
    assert.ok(r.hits.every((h) => h.kind === 'memo'));
    assert.equal(r.scanned.cases, 0);
  });
  test('عدة كلمات: حد أدنى للمطابقة (نصفها) ولا مطابقة جزئية لكلمتين', () => {
    assert.equal(run('سرقة طائرة').hits.length, 0);           // كلمتان: يجب الاثنتان
    assert.equal(run('سرقة سيارة هيلوكس ليلا').hits[0].id, 'c1');
    assert.ok(run('سرقة سيارة هيلوكس ليلا').hits[0].snippet);
  });
  test('الأحدث أولاً عند تساوي الدرجة، وحد النتائج 50', () => {
    const many: SearchCaseRow[] = Array.from({ length: 80 }, (_, i) => ({ ...cases[0], id: 'x' + i, case_number: 'N' + i, registration_date: d(2026, 1, 1) + i }));
    const r = runSearch({ entities: ['case'], range: null, groups: [['سرقه']] }, { cases: many, memos: null, memoTypes });
    assert.equal(r.hits.length, 50);
    assert.equal(r.totalMatched, 80);
    assert.equal(r.truncated, true);
    assert.equal(r.hits[0].id, 'x79');
  });
  test('فترة بلا كلمات تعيد السجلات داخل الفترة فقط', () => {
    const r = run('المذكرات هذا الشهر');
    assert.deepEqual(r.hits.map((h) => h.id), ['m1']);
  });
});

// ===== المنسّق مع منسّق ذكاء اصطناعي حقيقي ومزوّد مزيَّف =====
const admin: Session = { userId: 'u-admin', role: 'admin' };
const inv: Session = { userId: 'u-inv', role: 'investigator' };
const viewer: Session = { userId: 'u-view', role: 'viewer' };
const det: Session = { userId: 'u-det', role: 'detention_viewer' };
const KEY = 'SENTINEL-KEY-MUST-NEVER-LEAK-1234567890';

describe('11.2 — المنسّق والصلاحيات والخصوصية', () => {
  let mgr: AiManager;
  let search: AiSearch;
  let audits: AiAuditEvent[];
  let roles: Map<string, string>;
  let calls: AiGenerateRequest[];
  let reply: () => Promise<string>;
  let failAudit: boolean;
  let loaderSessions: Session[];
  let clock: number;

  beforeEach(() => {
    audits = []; calls = []; loaderSessions = []; failAudit = false; clock = NOW;
    reply = async () => '{"entities":[],"period":null,"groups":[["سرقة","سطو"]]}';
    roles = new Map([['u-admin', 'admin'], ['u-inv', 'investigator'], ['u-view', 'viewer'], ['u-det', 'detention_viewer']]);
    const store = new Map<string, string>();
    const provider: AiProvider = {
      id: 'cloud',
      async getStatus() { return { state: 'ready', detail: 'ok' }; },
      async generate(req) { calls.push(req); return { text: await reply(), providerId: 'cloud', model: 'm1' }; },
    };
    const registry = new AiProviderRegistry();
    registry.register(provider);
    mgr = createAiManager({
      secrets: {
        async get(n) { return store.get(n) ?? null; },
        async set(n, v) { store.set(n, v); },
        async remove(n) { store.delete(n); },
      },
      registry,
      async resolveActiveRole(id) { return roles.get(id) ?? null; },
      async audit(e) { if (failAudit) throw new Error('audit down'); audits.push(e); },
      now: () => ++clock,
    });
    search = createAiSearch({
      manager: mgr,
      async resolveActiveRole(id) { return roles.get(id) ?? null; },
      async loadCases(s) { loaderSessions.push(s); return cases; },
      async loadMemos(s) { loaderSessions.push(s); return memos; },
      async loadMemoTypes() { return [...memoTypes].map(([id, name]) => ({ id, name })); },
      now: () => NOW,
    });
  });

  async function enableCloud() {
    await mgr.updateSettings(admin, { cloudEndpoint: 'https://api.example.com/v1', cloudModel: 'm1' });
    await mgr.saveCloudKey(admin, KEY);
    await mgr.acceptCloudConsent(admin);
    await mgr.updateSettings(admin, { mode: 'cloud', features: { search: true } });
    audits.length = 0;
  }

  test('الأدوار الثلاثة المسموحة تبحث؛ مشاهد المحتجزين والجلسة الناقصة والحساب المعطّل مرفوضون', async () => {
    for (const s of [admin, inv, viewer]) assert.equal((await search.search(s, 'قضايا سرقة')).outcome.hits[0].id, 'c1');
    await assert.rejects(search.search(det, 'قضايا سرقة'), ForbiddenError);
    await assert.rejects(search.getStatus(det), ForbiddenError);
    await assert.rejects(search.search(null, 'قضايا سرقة'), ForbiddenError);
    roles.delete('u-view');
    await assert.rejects(search.search(viewer, 'قضايا سرقة'), ForbiddenError);
  });

  test('الدور يُقرأ من الجدول: جلسة "مطّلع" بعد تحويله إلى مشاهد محتجزين = رفض، ولا يُحمَّل شيء', async () => {
    roles.set('u-view', 'detention_viewer');
    await assert.rejects(search.search(viewer, 'قضايا سرقة'), ForbiddenError);
    assert.equal(loaderSessions.length, 0);
  });

  test('المحمّلات تستلم الدور الموثوق من الجدول لا من الجلسة', async () => {
    roles.set('u-inv', 'viewer');
    await search.search({ userId: 'u-inv', role: 'admin' }, 'قضايا سرقة');
    assert.ok(loaderSessions.length > 0);
    assert.ok(loaderSessions.every((s) => s.role === 'viewer'));
  });

  test('استعلامات غير صالحة', async () => {
    for (const q of ['', 'a', '   ', 'في من على', 'س'.repeat(301)]) {
      await assert.rejects(search.search(viewer, q), (e: unknown) => e instanceof AiError && e.code === 'SEARCH_QUERY_INVALID', JSON.stringify(q.slice(0, 5)));
    }
  });

  test('الذكاء الاصطناعي معطّل (الافتراضي): بحث محلي كامل ولا استدعاء للمزوّد', async () => {
    const st = await search.getStatus(viewer);
    assert.equal(st.aiUsable, false);
    const r = await search.search(viewer, 'قضايا سرقة');
    assert.equal(r.engine, 'local');
    assert.equal(r.aiNote, null);
    assert.equal(calls.length, 0);
  });

  test('الميزة مغلقة رغم تفعيل الوضع: محلي', async () => {
    await enableCloud();
    await mgr.updateSettings(admin, { features: { search: false } });
    const st = await search.getStatus(viewer);
    assert.equal(st.aiUsable, false);
    assert.equal((await search.search(viewer, 'قضايا سرقة', { confirmCloud: true })).engine, 'local');
    assert.equal(calls.length, 0);
  });

  test('الوضع السحابي بلا تأكيد: لا إرسال أبداً، والنتيجة محلية مع ملاحظة', async () => {
    await enableCloud();
    const st = await search.getStatus(viewer);
    assert.equal(st.aiUsable, true);
    assert.equal(st.cloudConfirmationNeeded, true);
    const r = await search.search(viewer, 'قضايا سرقة');
    assert.equal(r.engine, 'local');
    assert.ok(r.aiNote);
    assert.equal(calls.length, 0);
    assert.equal(r.outcome.hits[0].id, 'c1');
  });

  test('الوضع السحابي مع تأكيد: يُرسل السؤال المنقّى فقط، ولا أي نص من السجلات', async () => {
    await enableCloud();
    const q = 'قضايا سرقة المدعو أحمد هاتفه 777123456789 الشهر الماضي';
    const r = await search.search(viewer, q, { confirmCloud: true });
    assert.equal(r.engine, 'ai_cloud');
    assert.equal(calls.length, 1);
    const sent = calls[0].system + '\n' + calls[0].prompt;
    assert.ok(!sent.includes('777123456789'));
    assert.ok(sent.includes('[رقم]'));
    // لا شيء من السجلات (عناوين، تفاصيل، أسماء مدّعين، أرقام) في الطلب
    for (const secret of [SECRET, 'هيلوكس', 'أحمد علي', 'محمد قاسم', '2026/15', 'السجن المركزي', 'تقرير طبي']) {
      assert.ok(!sent.includes(secret), 'تسرّب: ' + secret);
    }
    assert.equal(calls[0].feature, 'search');
    assert.ok(JSON.stringify(audits).indexOf('أحمد') === -1);   // التدقيق لا يحوي نص السؤال
    assert.ok(audits.some((a) => a.operationType === 'ai_request'));
  });

  test('المرادفات من الذكاء الاصطناعي توسّع النتائج (سطو ≈ سرقة)', async () => {
    await enableCloud();
    const local = await search.search(viewer, 'قضايا سرقة');
    assert.deepEqual(local.outcome.hits.map((h) => h.id), ['c1']);
    const ai = await search.search(viewer, 'قضايا سرقة', { confirmCloud: true });
    assert.deepEqual(ai.outcome.hits.map((h) => h.id).sort(), ['c1', 'c2']);
    assert.equal(ai.outcome.hits[0].id, 'c1');   // الأصلي يتقدّم على المرادف
  });

  test('فشل المزوّد أو ردّ تالف أو JSON مضلِّل: تراجع إلى المحلي بلا انهيار', async () => {
    await enableCloud();
    reply = async () => { throw new AiError('PROVIDER_UNAVAILABLE', 'network'); };
    let r = await search.search(viewer, 'قضايا سرقة', { confirmCloud: true });
    assert.equal(r.engine, 'local'); assert.ok(r.aiNote); assert.equal(r.outcome.hits[0].id, 'c1');
    reply = async () => 'عذراً لا أستطيع';
    r = await search.search(viewer, 'قضايا سرقة', { confirmCloud: true });
    assert.equal(r.engine, 'local'); assert.ok(r.aiNote);
    reply = async () => '{"entities":["memo"],"period":"this_year","groups":[["محتجزين","سجناء"]]}';
    r = await search.search(viewer, 'قضايا سرقة', { confirmCloud: true });
    assert.deepEqual(r.outcome.hits.map((h) => h.id), ['c1']);   // لا يضيف مفاهيم ولا يحوّل النوع
    assert.ok(r.outcome.hits.every((h) => h.kind === 'case'));
  });

  test('فشل التدقيق في الوضع السحابي يمنع الإرسال ويُنفَّذ البحث محلياً', async () => {
    await enableCloud();
    failAudit = true;
    const r = await search.search(viewer, 'قضايا سرقة', { confirmCloud: true });
    assert.equal(calls.length, 0);
    assert.equal(r.engine, 'local');
    assert.equal(r.outcome.hits[0].id, 'c1');
  });

  test('الذكاء الاصطناعي لا يوسّع الصلاحيات: ردّ يطلب نوعاً آخر لا يغيّر النوع المحدد في السؤال', async () => {
    await enableCloud();
    reply = async () => '{"entities":["memo"],"period":null,"groups":[]}';
    const r = await search.search(viewer, 'قضايا سرقة', { confirmCloud: true });
    assert.ok(r.outcome.hits.every((h) => h.kind === 'case'));
  });

  test('ملخص البحث يعرض الفهم المحلي (للشفافية)', async () => {
    const r = await search.search(viewer, 'مذكرات المستشفى هذا الأسبوع');
    assert.deepEqual(r.summary.entities, ['memo']);
    assert.equal(r.summary.rangeLabel, 'هذا الأسبوع');
  });
});

// ===== المزوّد السحابي (صيغة OpenAI القياسية) =====
describe('11.2 — المزوّد السحابي', () => {
  const cfg = { endpoint: 'https://api.example.com/v1', model: 'gpt-4o-mini', apiKey: KEY };
  type Call = { url: string; init: RequestInit };
  function fakeFetch(handler: (c: Call, n: number) => { status: number; body: string } | Promise<never>) {
    const calls: Call[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = await handler({ url, init }, calls.length);
      return { status: r.status, text: async () => r.body } as Response;
    }) as unknown as typeof fetch;
    return { fn, calls };
  }
  const ok = (content: unknown) => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) });
  const req: AiGenerateRequest = { feature: 'search', system: 'S', prompt: 'P', maxOutputTokens: 300 };

  test('الصيغة: العنوان، الترويسات، الجسم', async () => {
    const f = fakeFetch(() => ok('{"a":1}'));
    const p = createOpenAiCompatibleProvider({ getConfig: async () => cfg, fetchFn: f.fn });
    const r = await p.generate(req);
    assert.equal(r.text, '{"a":1}');
    assert.equal(f.calls[0].url, 'https://api.example.com/v1/chat/completions');
    const h = f.calls[0].init.headers as Record<string, string>;
    assert.equal(h.Authorization, 'Bearer ' + KEY);
    const body = JSON.parse(String(f.calls[0].init.body));
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(body.max_tokens, 300);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'P' }]);
    assert.equal(f.calls[0].init.method, 'POST');
  });
  test('لا تكرار للمسار، ودعم محتوى على شكل أجزاء', async () => {
    assert.equal(buildChatCompletionsUrl('https://x.com/v1/chat/completions'), 'https://x.com/v1/chat/completions');
    const f = fakeFetch(() => ok([{ type: 'text', text: 'أ' }, { type: 'text', text: 'ب' }]));
    const p = createOpenAiCompatibleProvider({ getConfig: async () => ({ ...cfg, endpoint: 'https://x.com/v1/chat/completions' }), fetchFn: f.fn });
    assert.equal((await p.generate(req)).text, 'أب');
    assert.equal(f.calls[0].url, 'https://x.com/v1/chat/completions');
  });
  test('إعادة محاولة واحدة بـ max_completion_tokens', async () => {
    const f = fakeFetch((_c, n) => (n === 1 ? { status: 400, body: 'Unsupported parameter: max_tokens ... use max_completion_tokens' } : ok('x')));
    const p = createOpenAiCompatibleProvider({ getConfig: async () => cfg, fetchFn: f.fn });
    await p.generate(req);
    assert.equal(f.calls.length, 2);
    const b2 = JSON.parse(String(f.calls[1].init.body));
    assert.equal(b2.max_completion_tokens, 300);
    assert.equal('max_tokens' in b2, false);
  });
  test('الأخطاء: مفتاح، خادم، شبكة، JSON، فراغ — ولا تسرّب للمفتاح أو لنص الخادم', async () => {
    const mk = (h: Parameters<typeof fakeFetch>[0]) => createOpenAiCompatibleProvider({ getConfig: async () => cfg, fetchFn: fakeFetch(h).fn });
    const code = async (p: AiProvider) => { try { await p.generate(req); return 'none'; } catch (e) { assert.ok(e instanceof AiError); assert.ok(!e.message.includes(KEY)); assert.ok(!e.message.includes('SERVER-SECRET')); return (e as AiError).code; } };
    assert.equal(await code(mk(() => ({ status: 401, body: 'SERVER-SECRET' }))), 'CLOUD_KEY_INVALID');
    assert.equal(await code(mk(() => ({ status: 403, body: '' }))), 'CLOUD_KEY_INVALID');
    assert.equal(await code(mk(() => ({ status: 500, body: 'SERVER-SECRET' }))), 'PROVIDER_UNAVAILABLE');
    assert.equal(await code(mk(() => Promise.reject(new Error('net down ' + KEY)) as Promise<never>)), 'PROVIDER_UNAVAILABLE');
    assert.equal(await code(mk(() => ({ status: 200, body: 'not json SERVER-SECRET' }))), 'PROVIDER_BAD_RESPONSE');
    assert.equal(await code(mk(() => ok('   '))), 'PROVIDER_BAD_RESPONSE');
    assert.equal(await code(mk(() => ({ status: 200, body: '{"choices":[]}' }))), 'PROVIDER_BAD_RESPONSE');
  });
  test('مهلة الاتصال', async () => {
    const slow = (async (_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(new Error('aborted')));
    })) as unknown as typeof fetch;
    const p = createOpenAiCompatibleProvider({ getConfig: async () => cfg, fetchFn: slow, timeoutMs: 20 });
    await assert.rejects(p.generate(req), (e: unknown) => e instanceof AiError && e.code === 'PROVIDER_UNAVAILABLE' && e.message.includes('timeout'));
  });
  test('إعداد ناقص أو عنوان غير آمن يُرفض قبل أي اتصال', async () => {
    const f = fakeFetch(() => ok('x'));
    for (const c of [{ ...cfg, apiKey: null }, { ...cfg, model: null }, { ...cfg, endpoint: null }]) {
      await assert.rejects(createOpenAiCompatibleProvider({ getConfig: async () => c, fetchFn: f.fn }).generate(req),
        (e: unknown) => e instanceof AiError && e.code === 'CLOUD_NOT_CONFIGURED');
    }
    await assert.rejects(createOpenAiCompatibleProvider({ getConfig: async () => ({ ...cfg, endpoint: 'http://api.example.com/v1' }), fetchFn: f.fn }).generate(req),
      (e: unknown) => e instanceof AiError && e.code === 'CLOUD_ENDPOINT_INVALID');
    assert.equal(f.calls.length, 0);
  });
  test('getStatus لا يتصل بالشبكة', async () => {
    const f = fakeFetch(() => ok('x'));
    const ready = createOpenAiCompatibleProvider({ getConfig: async () => cfg, fetchFn: f.fn });
    assert.equal((await ready.getStatus()).state, 'ready');
    const no = createOpenAiCompatibleProvider({ getConfig: async () => ({ ...cfg, apiKey: null }), fetchFn: f.fn });
    assert.equal((await no.getStatus()).state, 'not_configured');
    assert.equal(f.calls.length, 0);
  });
});

// تحقق من أن الأنواع المستعملة في الاختبار متوافقة
const _typecheck: SearchPlan = { entities: null, range: null, groups: [] };
void _typecheck;
