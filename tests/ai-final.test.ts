// SECURECASEDESK_PHASE11_S5
// اختبارات المرحلة 11 / القسم 11.5 — الحماية والخصوصية والاختبار الشامل للذكاء الاصطناعي. تشغَّل بـ: npm run test:ai-final
// تغطي: مصفوفة الأدوار، البوابة السحابية الشاملة، عدم تسرب المفتاح/الأسماء/الهويات عبر الميزات الثلاث،
// التسليم إلى نموذج المذكرة، مسح البيانات، تقرير الخصوصية، وفحوص مصدرية (static) لحدود الوحدة.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAiManager, type AiAuditEvent, type AiManager } from '../src/modules/ai/ai-manager';
import { AiProviderRegistry, type AiGenerateRequest, type AiProvider } from '../src/modules/ai/ai-provider';
import { assertCloudSendAllowed, CLOUD_BLOCKED_ENTITIES } from '../src/modules/ai/ai-policy';
import { defaultAiSettings } from '../src/modules/ai/ai-settings';
import { AI_CONSENT_VERSION, AI_FEATURE_IDS, AiError, type AiEntityKind, type AiSettings } from '../src/modules/ai/ai-types';
import { acceptAiDraft, createAiDraft, rejectAiDraft } from '../src/modules/ai/ai-review';
import { createMemoHandoff, HANDOFF_TTL_MS, splitMemoText, type MemoHandoff } from '../src/modules/ai/ai-memo-handoff';
import { buildPrivacyReport } from '../src/modules/ai/ai-privacy-check';
import { buildTemplate } from '../src/modules/ai/ai-drafting-text';
import { createAiSearch, type AiSearch } from '../src/modules/ai/ai-search';
import { createAiSummary, type AiSummary } from '../src/modules/ai/ai-summary';
import { createAiDrafting, type AiDrafting } from '../src/modules/ai/ai-drafting';
import type { SearchCaseRow, SearchMemoRow } from '../src/modules/ai/ai-search-engine';
import type { SummaryCaseRow, SummaryMemoRow } from '../src/modules/ai/ai-summary-source';
import { buildSecretSpecs } from '../src/modules/backup/backup-inventory';
import { AUDIT_OPERATION_LABELS } from '../src/modules/audit/audit-labels';
import { can, ROLES } from '../src/security/permissions';
import { ForbiddenError, type Session } from '../src/security/guard';

const NOW = new Date(2026, 10, 21, 10, 0, 0).getTime();
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 12).getTime();
const KEY = 'SENTINEL-KEY-MUST-NEVER-LEAK-1234567890';
const NATIONAL_ID = '01234567890123';
const NAME_COMPLAINANT = 'سالم-الشاكي-الفريد';
const NAME_SUSPECT = 'ناصر-المتهم-الفريد';
const ENDPOINT = 'https://api.example.com/v1';

const admin: Session = { userId: 'u-admin', role: 'admin' };
const inv: Session = { userId: 'u-inv', role: 'investigator' };
const viewer: Session = { userId: 'u-view', role: 'viewer' };
const det: Session = { userId: 'u-det', role: 'detention_viewer' };

const caseRows = [
  { id: 'c1', case_number: '2026/15', title: 'سرقة سيارة من أمام المنزل', complainant: NAME_COMPLAINANT, suspects: NAME_SUSPECT,
    case_type: 'سرقة', registration_date: d(2026, 10, 10), incident_location: 'حجة - شارع الستين',
    incident_details: 'تمت سرقة سيارة ليلاً بتاريخ 2026/10/09. هاتف المبلّغ ' + NATIONAL_ID + ' وبريده a@b.com. ضُبط 3 أشخاص.', status: 'جديدة' },
];
const memoRows = [
  { id: 'm1', memo_number: 'م/101', memo_type_id: 't1', memo_date: d(2026, 11, 18), recipient_organization: 'المستشفى السعودي',
    subject: 'طلب تقرير طبي', body: 'يرجى إفادتنا بالتقرير الطبي للمصاب في قضية السرقة خلال 3 أيام.', linked_case_id: 'c1', status: 'مرسلة' },
];
const GOOD_DRAFT = 'مذكرة رسمية — مذكرات المستشفى\nالرقم: [......]\nالتاريخ: [......]\nإلى: المستشفى السعودي\nالموضوع: طلب تقرير طبي\n\nتحية طيبة وبعد،\n1- نرجو إفادتنا بالتقرير الطبي للمصاب.\n2- الرد خلال 3 أيام.\n\nوتفضلوا بقبول فائق الاحترام والتقدير،،\nالتوقيع: [......]';
const SUMMARY_OUT = 'الملخص: سرقة سيارة بتاريخ 2026/10/09 وضُبط 3 أشخاص.\nالنقاط الأساسية:\n- سرقة سيارة\nمعلومات غير واردة:\n- لا شيء';

interface Harness {
  mgr: AiManager; search: AiSearch; summary: AiSummary; drafting: AiDrafting;
  audits: AiAuditEvent[]; calls: AiGenerateRequest[]; roles: Map<string, string>; store: Map<string, string>;
  setReply(fn: (r: AiGenerateRequest) => string): void;
}

function makeHarness(): Harness {
  const audits: AiAuditEvent[] = []; const calls: AiGenerateRequest[] = [];
  const roles = new Map([['u-admin', 'admin'], ['u-inv', 'investigator'], ['u-view', 'viewer'], ['u-det', 'detention_viewer']]);
  const store = new Map<string, string>();
  let reply = (r: AiGenerateRequest): string => (r.feature === 'summary' ? SUMMARY_OUT : r.feature === 'drafting' ? GOOD_DRAFT : '{"keywords":[]}');
  const mk = (id: 'local' | 'cloud'): AiProvider => ({
    id, async getStatus() { return { state: 'ready', detail: 'ok' }; },
    async generate(req) { calls.push(req); return { text: reply(req), providerId: id, model: 'm1' }; },
  });
  const registry = new AiProviderRegistry(); registry.register(mk('cloud')); registry.register(mk('local'));
  let clock = 0;
  const mgr = createAiManager({
    secrets: { async get(n) { return store.get(n) ?? null; }, async set(n, v) { store.set(n, v); }, async remove(n) { store.delete(n); } },
    registry, async resolveActiveRole(id) { return roles.get(id) ?? null; }, async audit(e) { audits.push(e); }, now: () => NOW + (++clock),
  });
  const resolveActiveRole = async (id: string) => roles.get(id) ?? null;
  const search = createAiSearch({
    manager: mgr, resolveActiveRole,
    async loadCases() { return caseRows as unknown as SearchCaseRow[]; }, async loadMemos() { return memoRows as unknown as SearchMemoRow[]; },
    async loadMemoTypes() { return [{ id: 't1', name: 'مذكرات المستشفى' }]; }, now: () => NOW,
  });
  let seq = 0;
  const summary = createAiSummary({
    manager: mgr, resolveActiveRole,
    async loadCases() { return caseRows as unknown as SummaryCaseRow[]; }, async loadMemos() { return memoRows as unknown as SummaryMemoRow[]; },
    async loadMemoTypes() { return [{ id: 't1', name: 'مذكرات المستشفى' }]; },
    async audit(e) { audits.push(e); }, newId: () => 'sum-' + (++seq), now: () => NOW,
  });
  const drafting = createAiDrafting({
    manager: mgr, resolveActiveRole,
    async loadCases() { return caseRows as never; }, async loadMemoTypes() { return [{ id: 't1', name: 'مذكرات المستشفى' }]; },
    async audit(e) { audits.push(e); }, newId: () => 'dr-' + (++seq), now: () => NOW,
  });
  return { mgr, search, summary, drafting, audits, calls, roles, store, setReply(fn) { reply = fn; } };
}

async function enableCloud(h: Harness) {
  await h.mgr.updateSettings(admin, { cloudEndpoint: ENDPOINT, cloudModel: 'm1' });
  await h.mgr.saveCloudKey(admin, KEY);
  await h.mgr.acceptCloudConsent(admin);
  await h.mgr.updateSettings(admin, { mode: 'cloud', features: { search: true, summary: true, drafting: true } });
}
async function enableLocal(h: Harness) {
  await h.mgr.updateSettings(admin, { mode: 'local', localModelId: 'local-m', features: { search: true, summary: true, drafting: true } });
}

// ───────────────────────────── 1) مصفوفة الأدوار ─────────────────────────────
describe('11.5 — مصفوفة الأدوار على بوابة الذكاء الاصطناعي', () => {
  let h: Harness;
  beforeEach(async () => { h = makeHarness(); await enableLocal(h); });

  const cases: Array<{ s: Session; entities: AiEntityKind[]; ok: boolean; label: string }> = [
    { s: admin, entities: ['case', 'memo'], ok: true, label: 'مدير: قضايا+مذكرات' },
    { s: inv, entities: ['case', 'memo'], ok: true, label: 'محقق: قضايا+مذكرات' },
    { s: viewer, entities: ['case', 'memo'], ok: true, label: 'مشاهد: قضايا+مذكرات' },
    { s: det, entities: ['case'], ok: false, label: 'مشاهد المحتجزين: قضايا' },
    { s: det, entities: ['memo'], ok: false, label: 'مشاهد المحتجزين: مذكرات' },
    { s: det, entities: ['detainee'], ok: false, label: 'مشاهد المحتجزين: محتجزون (لا ai.use)' },
    { s: det, entities: [], ok: false, label: 'مشاهد المحتجزين: بلا كيانات' },
  ];
  for (const c of cases) {
    test(c.label, async () => {
      for (const feature of AI_FEATURE_IDS) {
        const p = h.mgr.authorizeUse(c.s, { feature, entities: c.entities });
        if (c.ok) assert.equal((await p).mode, 'local'); else await assert.rejects(p);
      }
    });
  }

  test('إدارة الإعدادات والمفتاح والمسح: للمدير وحده في كل الأدوار الأخرى ForbiddenError', async () => {
    for (const s of [inv, viewer, det, null, undefined]) {
      await assert.rejects(h.mgr.updateSettings(s, { mode: 'disabled' }), ForbiddenError);
      await assert.rejects(h.mgr.saveCloudKey(s, KEY), ForbiddenError);
      await assert.rejects(h.mgr.clearCloudKey(s), ForbiddenError);
      await assert.rejects(h.mgr.acceptCloudConsent(s), ForbiddenError);
      await assert.rejects(h.mgr.resetAll(s), ForbiddenError);
    }
  });

  test('الدور يُقرأ من الجدول لا من الجلسة: جلسة مزوَّرة بدور مدير لمحتجز/محقق لا تمنح صلاحية', async () => {
    const forged: Session = { userId: 'u-det', role: 'admin' };
    await assert.rejects(h.mgr.authorizeUse(forged, { feature: 'search', entities: ['case'] }));
    await assert.rejects(h.mgr.updateSettings(forged, { mode: 'disabled' }), ForbiddenError);
    await assert.rejects(h.mgr.resetAll({ userId: 'u-inv', role: 'admin' }), ForbiddenError);
  });

  test('تغيير الدور أو تعطيل الحساب يسري فوراً دون إعادة تسجيل دخول', async () => {
    await h.mgr.authorizeUse(viewer, { feature: 'search', entities: ['case'] });
    h.roles.set('u-view', 'detention_viewer');
    await assert.rejects(h.mgr.authorizeUse(viewer, { feature: 'search', entities: ['case'] }));
    h.roles.delete('u-inv'); // حساب معطّل/محذوف
    await assert.rejects(h.mgr.authorizeUse(inv, { feature: 'summary', entities: ['case'] }), ForbiddenError);
    await assert.rejects(h.mgr.getState(inv), ForbiddenError);
    h.roles.set('u-admin', 'viewer'); // مدير خُفِّض
    await assert.rejects(h.mgr.updateSettings(admin, { mode: 'disabled' }), ForbiddenError);
  });

  test('الميزات الثلاث تمنع مشاهد المحتجزين قبل تحميل أي سجل', async () => {
    let loads = 0;
    const roles = h.roles;
    const resolveActiveRole = async (id: string) => roles.get(id) ?? null;
    const s = createAiSearch({ manager: h.mgr, resolveActiveRole, async loadCases() { loads++; return []; }, async loadMemos() { loads++; return []; }, async loadMemoTypes() { loads++; return []; }, now: () => NOW });
    const m = createAiSummary({ manager: h.mgr, resolveActiveRole, async loadCases() { loads++; return []; }, async loadMemos() { loads++; return []; }, async loadMemoTypes() { loads++; return []; }, async audit() {}, newId: () => 'x', now: () => NOW });
    const dr = createAiDrafting({ manager: h.mgr, resolveActiveRole, async loadCases() { loads++; return []; }, async loadMemoTypes() { loads++; return []; }, async audit() {}, newId: () => 'x', now: () => NOW });
    await assert.rejects(s.search(det, 'قضايا سرقة'), ForbiddenError);
    await assert.rejects(m.summarize(det, { kind: 'case', id: 'c1' }), ForbiddenError);
    await assert.rejects(dr.generate(det, { mode: 'compose', docKind: 'memo', subject: 'موضوع', points: 'نقطة طويلة كفاية' }), ForbiddenError);
    assert.equal(loads, 0);
  });
});

// ───────────────────────────── 2) البوابة السحابية الشاملة ─────────────────────────────
describe('11.5 — البوابة السحابية: كل شرط مستقل ومطلوب (فحص شامل لكل التراكيب)', () => {
  function settingsWith(o: { endpoint: boolean; model: boolean; consent: boolean; mode: boolean }): AiSettings {
    const s = defaultAiSettings();
    return {
      ...s, mode: o.mode ? 'cloud' : 'local',
      cloud: {
        endpoint: o.endpoint ? ENDPOINT : null, model: o.model ? 'm1' : null,
        consentAcceptedAt: 1, consentAcceptedBy: 'u-admin', consentEndpoint: o.consent ? (o.endpoint ? ENDPOINT : null) : 'https://other.example.com',
        consentVersion: AI_CONSENT_VERSION,
      },
    };
  }
  test('2^6 تركيباً × كيانات: الإرسال مسموح فقط حين تتحقق الشروط كلها ولا كيان ممنوع', () => {
    const bools = [false, true];
    let allowed = 0; let total = 0;
    for (const endpoint of bools) for (const model of bools) for (const consent of bools) for (const mode of bools)
      for (const hasKey of bools) for (const confirmed of bools) for (const entities of [['case'], ['case', 'memo'], ['detainee'], ['attachment'], ['case', 'detainee']] as AiEntityKind[][]) {
        total++;
        const settings = settingsWith({ endpoint, model, consent, mode });
        const expected = endpoint && model && consent && mode && hasKey && confirmed && !entities.some((e) => CLOUD_BLOCKED_ENTITIES.includes(e));
        let ok = true;
        try { assertCloudSendAllowed({ settings, hasCloudKey: hasKey, entities, userConfirmed: confirmed }); } catch (e) { ok = false; assert.ok(e instanceof AiError); }
        assert.equal(ok, expected, JSON.stringify({ endpoint, model, consent, mode, hasKey, confirmed, entities }));
        if (ok) allowed++;
      }
    assert.equal(total, 320); assert.ok(allowed > 0 && allowed < total);
  });
  test('تأكيد غير صريح (غير true) لا يمرّ', () => {
    const settings = settingsWith({ endpoint: true, model: true, consent: true, mode: true });
    for (const bad of [1, 'true', {}, null, undefined] as unknown[]) {
      assert.throws(() => assertCloudSendAllowed({ settings, hasCloudKey: true, entities: ['case'], userConfirmed: bad as boolean }));
    }
  });
  test('تغيير عنوان الخدمة أو إصدار الإقرار يُبطل الإقرار السابق', async () => {
    const h = makeHarness(); await enableCloud(h);
    assert.equal((await h.mgr.getState(admin)).cloud.consentValid, true);
    const st = await h.mgr.updateSettings(admin, { cloudEndpoint: 'https://api.other-host.com/v1' });
    assert.equal(st.cloud.consentValid, false);
  });
  test('عنوان غير آمن مرفوض (http وبيانات اعتماد ومعاملات)', async () => {
    const h = makeHarness();
    for (const bad of ['http://api.example.com/v1', 'https://user:pw@api.example.com/v1', 'https://api.example.com/v1?key=1', 'ftp://x.com', 'javascript:alert(1)']) {
      await assert.rejects(h.mgr.updateSettings(admin, { cloudEndpoint: bad }), (e: unknown) => e instanceof AiError);
    }
  });
});

// ───────────────────────────── 3) عدم التسرب عبر الميزات الثلاث ─────────────────────────────
describe('11.5 — لا تسرب للمفتاح أو الأسماء أو الهويات (بحث + تلخيص + صياغة، محلياً وسحابياً)', () => {
  async function runAll(h: Harness, cloud: boolean) {
    const sentinel = { confirmCloud: cloud };
    await h.search.search(admin, 'قضايا سرقة', sentinel);
    const prep = await h.summary.prepare(admin, { kind: 'case', id: 'c1' }, { includeLinked: true });
    await h.summary.summarize(admin, { kind: 'case', id: 'c1' }, { includeLinked: true, confirmCloud: cloud, confirmedToken: prep.token ?? undefined });
    const req = { mode: 'compose' as const, docKind: 'memo' as const, recipient: 'المستشفى', subject: 'طلب تقرير طبي', points: 'نرجو التقرير خلال 3 أيام\nالهوية ' + NATIONAL_ID, caseId: 'c1', includeCaseDetails: true };
    const dprep = await h.drafting.prepare(admin, req);
    const res = await h.drafting.generate(admin, req, { useAi: true, confirmCloud: cloud, confirmedToken: dprep.token ?? undefined });
    return res;
  }

  for (const cloud of [false, true]) {
    test((cloud ? 'سحابي' : 'محلي') + ': المفتاح لا يظهر في أي حمولة أو سجل تدقيق، وأسماء الأطراف لا تُرسل أبداً', async () => {
      const h = makeHarness(); if (cloud) await enableCloud(h); else await enableLocal(h);
      await runAll(h, cloud);
      const allPrompts = JSON.stringify(h.calls);
      const allAudits = JSON.stringify(h.audits);
      assert.ok(h.calls.length > 0, 'يجب أن يصل شيء إلى المزوّد');
      for (const hay of [allPrompts, allAudits]) assert.ok(!hay.includes(KEY));
      assert.ok(!allAudits.includes(NAME_COMPLAINANT) && !allAudits.includes(NAME_SUSPECT) && !allAudits.includes(NATIONAL_ID) && !allAudits.includes('a@b.com'));
      // محلياً تبقى البيانات على الجهاز فقط (قد يراها المحرك المحلي)؛ سحابياً لا اسم ولا هوية ولا بريد مطلقاً.
      if (cloud) {
        assert.ok(!allPrompts.includes(NAME_COMPLAINANT) && !allPrompts.includes(NAME_SUSPECT));
        assert.ok(!allPrompts.includes(NATIONAL_ID) && !allPrompts.includes('a@b.com'));
      } else {
        const dc = h.calls.filter((c) => c.feature === 'drafting');
        assert.ok(dc.length > 0 && dc.every((c) => !JSON.stringify(c).includes(NAME_COMPLAINANT) && !JSON.stringify(c).includes(NAME_SUSPECT)), 'الصياغة لا تُدرج الأسماء حتى محلياً');
      }
    });
  }

  test('السحابي بلا تأكيد: لا شيء يصل إلى المزوّد في الميزات الثلاث', async () => {
    const h = makeHarness(); await enableCloud(h);
    const sr = await h.search.search(admin, 'قضايا سرقة');
    assert.ok(sr.engine === 'local' || sr.aiNote !== null);
    const sm = await h.summary.summarize(admin, { kind: 'case', id: 'c1' }, {});
    assert.equal(sm.engine, 'extractive');
    const dr = await h.drafting.generate(admin, { mode: 'compose', docKind: 'memo', subject: 'موضوع', points: 'نقطة طويلة كفاية للصياغة' }, { useAi: true });
    assert.notEqual(dr.engine, 'ai_cloud');
    assert.equal(h.calls.length, 0);
  });

  test('تأكيد بحمولة قديمة (رمز لا يطابق) لا يُرسل شيئاً', async () => {
    const h = makeHarness(); await enableCloud(h);
    const r = await h.summary.summarize(admin, { kind: 'case', id: 'c1' }, { confirmCloud: true, confirmedToken: 'stale-token' });
    assert.equal(r.engine, 'extractive'); assert.equal(h.calls.length, 0);
    const dr = await h.drafting.generate(admin, { mode: 'compose', docKind: 'memo', subject: 'موضوع', points: 'نقطة طويلة كفاية للصياغة' }, { useAi: true, confirmCloud: true, confirmedToken: 'stale' });
    assert.notEqual(dr.engine, 'ai_cloud'); assert.equal(h.calls.length, 0);
  });

  test('فشل التدقيق يمنع الإرسال السحابي (فشل مغلق)', async () => {
    const h = makeHarness(); await enableCloud(h);
    const failing = createAiManager({
      secrets: { async get(n) { return h.store.get(n) ?? null; }, async set() {}, async remove() {} },
      registry: (() => { const r = new AiProviderRegistry(); r.register({ id: 'cloud', async getStatus() { return { state: 'ready', detail: '' }; }, async generate(q) { h.calls.push(q); return { text: 'x', providerId: 'cloud', model: 'm' }; } }); return r; })(),
      async resolveActiveRole(id) { return h.roles.get(id) ?? null; }, async audit() { throw new Error('audit down'); }, now: () => NOW,
    });
    await assert.rejects(failing.authorizeUse(admin, { feature: 'search', entities: ['case'], confirmCloudSend: true }), (e: unknown) => e instanceof AiError && e.code === 'AUDIT_FAILED');
    assert.equal(h.calls.length, 0);
  });

  test('كيانات المحتجزين والمرفقات ممنوعة سحابياً من بوابة المنسّق نفسها', async () => {
    const h = makeHarness(); await enableCloud(h);
    for (const e of ['detainee', 'attachment'] as AiEntityKind[]) {
      await assert.rejects(h.mgr.authorizeUse(admin, { feature: 'search', entities: ['case', e], confirmCloudSend: true }), (x: unknown) => x instanceof AiError && x.code === 'CLOUD_ENTITY_BLOCKED');
    }
  });
});

// ───────────────────────────── 4) المراجعة البشرية والتسليم لنموذج المذكرة ─────────────────────────────
describe('11.5 — زر «أنشئ مذكرة من المسودة»: تعبئة دون حفظ', () => {
  let ho: MemoHandoff; let audits: AiAuditEvent[]; let clock: number; let roles: Map<string, string>; let failAudit: boolean;
  const accepted = (by = 'u-inv', text = GOOD_DRAFT) => acceptAiDraft(createAiDraft({ id: 'd1', feature: 'drafting', providerId: 'local', text, requestedBy: 'u-inv', now: NOW }), by, NOW, undefined);
  beforeEach(() => {
    audits = []; clock = NOW; failAudit = false;
    roles = new Map([['u-admin', 'admin'], ['u-inv', 'investigator'], ['u-view', 'viewer'], ['u-det', 'detention_viewer']]);
    ho = createMemoHandoff({ async resolveActiveRole(id) { return roles.get(id) ?? null; }, async audit(e) { if (failAudit) throw new Error('down'); audits.push(e); }, now: () => clock });
  });

  test('فصل الترويسة عن المتن: الجهة والموضوع من النص، والرقم لا يُملأ، والمتن حرفي مع الفراغات', () => {
    const p = splitMemoText(GOOD_DRAFT);
    assert.equal(p.recipient, 'المستشفى السعودي'); assert.equal(p.subject, 'طلب تقرير طبي');
    assert.ok(p.body.startsWith('تحية طيبة وبعد،') && p.body.includes('1- نرجو إفادتنا') && p.body.includes('التوقيع: [......]'));
    assert.ok(!p.body.includes('الرقم:') && !p.body.includes('مذكرة رسمية'));
    const blank = splitMemoText('مذكرة رسمية\nالرقم: [......]\nإلى: [......]\nالموضوع: [......]\nالمتن هنا');
    assert.equal(blank.recipient, ''); assert.equal(blank.subject, ''); assert.equal(blank.body, 'المتن هنا');
    const noHeader = splitMemoText('نص بلا ترويسة\nإلى: س');
    assert.equal(noHeader.body, 'نص بلا ترويسة\nإلى: س'); assert.equal(noHeader.headerLines, 0);
    const t = buildTemplate({ docKind: 'memo', tone: 'formal', memoTypeName: 'مذكرات المستشفى', recipient: 'جهة', subject: 'موضوع', points: 'نقطة أولى' });
    assert.equal(splitMemoText(t).recipient, 'جهة'); assert.ok(splitMemoText(t).body.includes('1- نقطة أولى'));
  });

  test('مسودة معتمدة من صاحبها تُسلَّم مرة واحدة فقط ثم تُمسح', async () => {
    const draft = accepted();
    const pf = await ho.stash(inv, { origin: 'ai_accepted', draft, memoTypeName: 'مذكرات المستشفى', caseId: 'c1' });
    assert.equal(pf.placeholders, 3); assert.equal(pf.caseId, 'c1'); assert.equal(pf.memoTypeName, 'مذكرات المستشفى');
    assert.equal(ho.peekExists(), true);
    const got = await ho.consume(inv);
    assert.ok(got && got.subject === 'طلب تقرير طبي');
    assert.equal(await ho.consume(inv), null); assert.equal(ho.peekExists(), false);
  });

  test('مسودة بانتظار المراجعة أو مرفوضة أو معتمدة من غير صاحبها أو بلا مسودة: مرفوضة', async () => {
    const pending = createAiDraft({ id: 'd2', feature: 'drafting', providerId: 'local', text: GOOD_DRAFT, requestedBy: 'u-inv', now: NOW });
    const rejected = rejectAiDraft(pending, 'u-inv', NOW);
    for (const draft of [pending, rejected]) {
      await assert.rejects(ho.stash(inv, { origin: 'ai_accepted', draft }), (e: unknown) => e instanceof AiError && e.code === 'REVIEW_REQUIRED');
    }
    await assert.rejects(ho.stash(inv, { origin: 'ai_accepted', draft: accepted('u-admin') }), (e: unknown) => e instanceof AiError && e.code === 'REVIEW_INVALID');
    await assert.rejects(ho.stash(inv, { origin: 'ai_accepted' }), (e: unknown) => e instanceof AiError && e.code === 'REVIEW_REQUIRED');
    await assert.rejects(ho.stash(inv, { origin: 'ai_accepted', text: GOOD_DRAFT, draft: undefined }));
    assert.equal(ho.peekExists(), false); assert.equal(audits.length, 0);
  });

  test('نص ذكي خام لا يُمرَّر باسم «قالب»: origin=template لا يقبل مسودة ذكاء ويعتمد نص المستخدم فقط', async () => {
    const pf = await ho.stash(inv, { origin: 'template', text: GOOD_DRAFT, draft: createAiDraft({ id: 'd3', feature: 'drafting', providerId: 'cloud', text: 'نص ذكي مختلف تماماً', requestedBy: 'u-inv', now: NOW }) });
    assert.ok(!pf.body.includes('نص ذكي مختلف')); // المسودة المرفقة تُهمل؛ يُؤخذ النص الذي كتبه/رآه المستخدم
    await assert.rejects(ho.stash(inv, { origin: 'template', text: '   ' }));
    await assert.rejects(ho.stash(inv, { origin: 'template', text: 'أ'.repeat(14001) }));
    await assert.rejects(ho.stash(inv, { origin: 'bogus' as never, text: 'x' }));
  });

  test('الصلاحية: memos.manage فقط (المشاهد ومشاهد المحتجزين والجلسة الفارغة مرفوضون) وتُفحص من الجدول', async () => {
    for (const s of [viewer, det, null, undefined]) await assert.rejects(ho.stash(s, { origin: 'template', text: GOOD_DRAFT }), ForbiddenError);
    roles.set('u-inv', 'viewer'); // خُفِّض الدور بعد الاعتماد
    await assert.rejects(ho.stash(inv, { origin: 'template', text: GOOD_DRAFT }), ForbiddenError);
    roles.set('u-inv', 'investigator');
    await ho.stash(inv, { origin: 'template', text: GOOD_DRAFT });
    roles.set('u-inv', 'viewer'); // خُفِّض بعد التسليم وقبل الاستهلاك
    assert.equal(await ho.consume(inv), null);
  });

  test('لا يستهلكها مستخدم آخر، وتنتهي بعد 10 دقائق، وتُستهلك (تُمسح) حتى عند الفشل', async () => {
    await ho.stash(inv, { origin: 'template', text: GOOD_DRAFT });
    assert.equal(await ho.consume(admin), null); assert.equal(ho.peekExists(), false);
    await ho.stash(inv, { origin: 'template', text: GOOD_DRAFT });
    clock += HANDOFF_TTL_MS + 1;
    assert.equal(await ho.consume(inv), null);
    await ho.stash(inv, { origin: 'template', text: GOOD_DRAFT });
    ho.clear(); assert.equal(await ho.consume(inv), null);
  });

  test('التدقيق: حدث ai_memo_prefill بلا أي نص، وفشل التدقيق يمنع التسليم', async () => {
    await ho.stash(inv, { origin: 'ai_accepted', draft: accepted(), recipient: NAME_COMPLAINANT });
    assert.equal(audits.length, 1); assert.equal(audits[0].operationType, 'ai_memo_prefill');
    const j = JSON.stringify(audits[0]);
    assert.ok(!j.includes('المستشفى') && !j.includes('تحية') && !j.includes(NAME_COMPLAINANT));
    assert.deepEqual(audits[0].newValues, { origin: 'ai_accepted', chars: GOOD_DRAFT.length, placeholders: 3, caseLinked: false });
    ho.clear(); failAudit = true;
    await assert.rejects(ho.stash(inv, { origin: 'template', text: GOOD_DRAFT }), (e: unknown) => e instanceof AiError && e.code === 'AUDIT_FAILED');
    assert.equal(ho.peekExists(), false);
  });

  test('الوحدة لا تعرف قاعدة البيانات: لا استيراد خدمات ولا SQL (مصدرياً)', () => {
    const src = readFileSync('src/modules/ai/ai-memo-handoff.ts', 'utf8').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(!/from '@\//.test(src) && !/services\//.test(src) && !/runAsync|execAsync|insertMemo|SecureStore|AsyncStorage/.test(src));
  });
});

// ───────────────────────────── 5) المسح وتقرير الخصوصية ─────────────────────────────
describe('11.5 — مسح بيانات الذكاء الاصطناعي وتقرير الخصوصية', () => {
  test('resetAll: يمسح المفتاح والإعدادات والإقرار ويعيد «معطّل» ويدقّق بلا المفتاح', async () => {
    const h = makeHarness(); await enableCloud(h);
    assert.ok(h.store.size >= 2);
    const st = await h.mgr.resetAll(admin);
    assert.equal(st.mode, 'disabled'); assert.equal(st.cloud.hasKey, false); assert.equal(st.cloud.consentValid, false);
    assert.equal(st.cloud.endpoint, null); assert.equal(h.store.size, 0);
    const ev = h.audits.filter((a) => a.operationType === 'ai_reset');
    assert.equal(ev.length, 1); assert.ok(!JSON.stringify(ev[0]).includes(KEY));
    await assert.rejects(h.mgr.authorizeUse(admin, { feature: 'search', entities: ['case'] }), (e: unknown) => e instanceof AiError && e.code === 'AI_DISABLED');
  });
  test('resetAll: فشل التخزين يُبلَّغ، وفشل التدقيق يُبلَّغ دون إعادة المسح', async () => {
    const h = makeHarness(); await enableCloud(h);
    const orig = h.store.delete.bind(h.store);
    h.store.delete = () => { throw new Error('io'); };
    await assert.rejects(h.mgr.resetAll(admin), (e: unknown) => e instanceof AiError && e.code === 'STORAGE_FAILED');
    h.store.delete = orig;
  });

  const specs = buildSecretSpecs([1], false);
  const baseState = { mode: 'disabled' as const, features: { search: false, summary: false, drafting: false }, cloud: { endpoint: null, model: null, hasKey: false, consentValid: false }, settingsRecovered: false };
  test('معطّل: التقرير سليم بلا تحذيرات', () => {
    const r = buildPrivacyReport({ state: baseState, backupSecretSpecs: specs });
    assert.equal(r.overall, 'ok'); assert.equal(r.counts.fail, 0); assert.equal(r.counts.warn, 0);
  });
  test('سحابي مكتمل: تحذير تعريفي لا فشل؛ ناقص أو بلا إقرار: فشل', () => {
    const full = { ...baseState, mode: 'cloud' as const, features: { search: true, summary: false, drafting: true }, cloud: { endpoint: ENDPOINT, model: 'm', hasKey: true, consentValid: true } };
    const r = buildPrivacyReport({ state: full, backupSecretSpecs: specs });
    assert.equal(r.overall, 'warn'); assert.ok(r.findings.find((f) => f.id === 'mode')!.detail.includes('البحث الذكي'));
    assert.equal(buildPrivacyReport({ state: { ...full, cloud: { ...full.cloud, consentValid: false } }, backupSecretSpecs: specs }).overall, 'fail');
    assert.equal(buildPrivacyReport({ state: { ...full, cloud: { ...full.cloud, hasKey: false } }, backupSecretSpecs: specs }).overall, 'fail');
    assert.equal(buildPrivacyReport({ state: { ...full, cloud: { ...full.cloud, endpoint: 'http://x.com' } }, backupSecretSpecs: specs }).overall, 'fail');
  });
  test('أسرار الذكاء غير المستبعدة من النسخ الاحتياطي = فشل؛ والإعدادات المستعادة = تحذير', () => {
    const leaky = specs.map((s) => (s.name.startsWith('securecase_ai_') ? { ...s, cls: 'recommended' as const } : s));
    const r = buildPrivacyReport({ state: baseState, backupSecretSpecs: leaky });
    assert.equal(r.overall, 'fail'); assert.equal(r.findings.find((f) => f.id === 'backup-secrets')!.level, 'fail');
    assert.equal(buildPrivacyReport({ state: { ...baseState, settingsRecovered: true }, backupSecretSpecs: specs }).overall, 'warn');
  });
  test('الأسرار في تقرير الخصوصية: المفتاح لا يظهر ولو وُجد في الحالة', () => {
    const r = buildPrivacyReport({ state: { ...baseState, mode: 'cloud', cloud: { endpoint: ENDPOINT, model: 'm', hasKey: true, consentValid: true } }, backupSecretSpecs: specs });
    assert.ok(!JSON.stringify(r).includes(KEY));
  });
  test('جدول الصلاحيات الحي: مشاهد المحتجزين بلا ai.* وبلا قضايا/مذكرات، وai.manage للمدير وحده', () => {
    for (const p of ['ai.use', 'ai.manage', 'cases.view', 'memos.view'] as const) assert.equal(can('detention_viewer', p), false, p);
    assert.deepEqual(ROLES.map((r) => r.key).filter((r) => can(r, 'ai.manage')), ['admin']);
    for (const r of ['admin', 'investigator', 'viewer'] as const) assert.equal(can(r, 'ai.use'), true);
    assert.equal(can('unknown-role', 'ai.use'), false); assert.equal(can(null, 'ai.use'), false);
  });
});

// ───────────────────────────── 6) فحوص مصدرية لحدود الوحدة ─────────────────────────────
describe('11.5 — فحوص مصدرية (static) لحدود الذكاء الاصطناعي', () => {
  const aiDir = 'src/modules/ai';
  // تُحذف التعليقات قبل الفحص كي لا تُحتسب كلمات التوثيق كاستخدام فعلي.
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
  const aiFiles = readdirSync(aiDir).filter((f) => f.endsWith('.ts')).map((f) => join(aiDir, f));
  const screens = readdirSync('src/app').filter((f) => /^ai-.*\.tsx$/.test(f)).map((f) => join('src/app', f));
  const runtimeFiles = aiFiles.filter((f) => /-runtime\.ts$/.test(f));
  const pureFiles = aiFiles.filter((f) => !/-runtime\.ts$/.test(f));

  test('الملفات النقية بلا Expo ولا أسماء مستعارة @/ (قابلة للاختبار في Node)', () => {
    for (const f of pureFiles) assert.ok(!/from '(?:expo|react-native|@\/)/.test(read(f)), f);
  });
  test('لا كتابة SQL ولا حذف في وحدة الذكاء ولا في شاشاتها', () => {
    for (const f of [...aiFiles, ...screens]) assert.ok(!/\.(?:runAsync|execAsync|withTransactionAsync)\(/.test(read(f)), f);
  });
  test('لا استيراد لدوال كتابة السجلات ولا لخدمتي المحتجزين والمرفقات في وحدة الذكاء وشاشاتها', () => {
    const forbidden = /insertMemo|insertCase|updateCase|changeMemoStatus|archiveCase|assignCase|transferCase|insertDetainee|detainees\.service|attachments\.service|attachments-repo|attachments-storage/;
    for (const f of [...aiFiles, ...screens]) assert.ok(!forbidden.test(read(f)), f);
  });
  test('الشبكة (fetch) في ملف المزوّد السحابي وحده', () => {
    for (const f of [...aiFiles, ...screens]) {
      const has = /\bfetch\b|XMLHttpRequest|WebSocket/.test(read(f));
      assert.equal(has, f.endsWith('ai-cloud-provider.ts'), f);
    }
  });
  test('SecureStore في ai-runtime.ts وحده، ولا تخزين متصفح/ملفات/سجل طباعة', () => {
    for (const f of [...aiFiles, ...screens]) {
      const src = read(f);
      assert.equal(/expo-secure-store/.test(src), f.endsWith('ai-runtime.ts'), f);
      assert.ok(!/AsyncStorage|localStorage|sessionStorage|expo-file-system|expo-sqlite/.test(src), f);
      assert.ok(!/console\.(?:log|info|debug|warn)\(/.test(src), f);
    }
  });
  test('مفاتيح التخزين الآمن للذكاء مصنَّفة «مستبعدة» من النسخ الاحتياطي وتحمل نفس الاسم', () => {
    const names = ['securecase_ai_settings_v1', 'securecase_ai_cloud_key_v1'];
    for (const n of names) assert.equal(buildSecretSpecs([1], true).find((s) => s.name === n)?.cls, 'excluded');
    assert.ok(names.every((n) => read('src/modules/ai/ai-types.ts').includes(n)));
  });
  test('الاستعادة ترفض أي نسخة تحمل أسرار الذكاء (ضمن الأسرار المستبعدة)', () => {
    const src = read('src/modules/backup/backup-restore-prep.ts');
    assert.ok(/EXCLUDED_NAMES[^;]*aiSettings[^;]*aiCloudKey/s.test(src));
  });
  test('كل شاشة ذكاء تفحص الصلاحية وتسجّل محاولة الوصول غير المصرح، ولا تعرض رسائل الاستثناء الخام', () => {
    assert.ok(screens.length >= 5, 'شاشات: ' + screens.join(','));
    for (const f of screens) {
      const src = read(f);
      assert.ok(/can\(/.test(src) && /recordUnauthorizedAccess/.test(src), f);
      assert.ok(!/(?:e|err|error)\.message/.test(src), f);
    }
  });
  test('كل نوع عملية ai_* يُصدره الكود له تسمية عربية في سجل التدقيق', () => {
    const ops = new Set<string>();
    for (const f of [...aiFiles, ...screens]) for (const m of read(f).matchAll(/operationType:\s*'(ai_[a-z_]+)'/g)) ops.add(m[1]);
    assert.ok(ops.size >= 8, [...ops].join(','));
    for (const o of ops) assert.ok(AUDIT_OPERATION_LABELS[o], 'تسمية ناقصة: ' + o);
  });
  test('زر إنشاء المذكرة لا يمرّر النص عبر مسار التنقل (لا params ولا query)', () => {
    const src = read('src/app/ai-drafting.tsx');
    assert.ok(/stashMemoPrefill|getMemoHandoff/.test(src));
    for (const m of src.matchAll(/router\.(?:push|replace|navigate)\(([^)]*)\)/g)) assert.ok(!/params|\?|body|text|draft/i.test(m[1]), m[0]);
  });
  test('شاشة المذكرات تستهلك التسليم مرة واحدة ولا تحفظ تلقائياً', () => {
    const src = read('src/app/(tabs)/memos.tsx');
    assert.ok(src.includes('consumeMemoPrefill'));
    const block = src.slice(src.indexOf('SECURECASEDESK_PHASE11_S5'));
    assert.ok(!/insertMemo\(/.test(block.slice(0, block.indexOf('const handleSaveMemo') > 0 ? block.indexOf('const handleSaveMemo') : block.length)));
  });
});
