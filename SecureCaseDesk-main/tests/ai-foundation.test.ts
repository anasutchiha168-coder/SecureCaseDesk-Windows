// SECURECASEDESK_PHASE11_S1
// اختبارات المرحلة 11 / القسم 11.1 — بنية الذكاء الاصطناعي. تشغَّل بـ: npm run test:ai-foundation
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_SECRET_NAMES, AI_CONSENT_VERSION, AiError, aiErrorMessage, type AiFeatureId,
} from '../src/modules/ai/ai-types';
import {
  applySettingsChange, defaultAiSettings, isCloudConsentValid, isPlausibleCloudKey,
  normalizeCloudEndpoint, parseStoredSettings, recordCloudConsent,
} from '../src/modules/ai/ai-settings';
import { assertCloudSendAllowed, assertRoleMayUseAi, evaluateAvailability } from '../src/modules/ai/ai-policy';
import {
  AiProviderRegistry, createCloudPlaceholderProvider, createLocalPlaceholderProvider, type AiProvider,
} from '../src/modules/ai/ai-provider';
import { acceptAiDraft, assertDraftAccepted, createAiDraft, rejectAiDraft } from '../src/modules/ai/ai-review';
import { createAiManager, type AiAuditEvent, type AiManager } from '../src/modules/ai/ai-manager';
import { can, ROLES } from '../src/security/permissions';
import { ForbiddenError, type Session } from '../src/security/guard';

const KEY = 'SENTINEL-KEY-MUST-NEVER-LEAK-1234567890';
const EP = 'https://api.example.com/v1';

function expectAi(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof AiError && e.code === code, 'expected ' + code);
}
async function expectAiAsync(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof AiError && e.code === code, 'expected ' + code);
}

describe('11.1 — الصلاحيات', () => {
  test('ai.manage للمدير فقط', () => {
    assert.equal(can('admin', 'ai.manage'), true);
    for (const r of ROLES.filter((x) => x.key !== 'admin')) assert.equal(can(r.key, 'ai.manage'), false, r.key);
    assert.equal(can('unknown', 'ai.manage'), false);
    assert.equal(can(null, 'ai.manage'), false);
  });
  test('ai.use: المدير والمحقق والمطّلع، وليس مشاهد المحتجزين', () => {
    assert.equal(can('admin', 'ai.use'), true);
    assert.equal(can('investigator', 'ai.use'), true);
    assert.equal(can('viewer', 'ai.use'), true);
    assert.equal(can('detention_viewer', 'ai.use'), false);
    assert.equal(can('unknown', 'ai.use'), false);
  });
});

describe('11.1 — الإعدادات', () => {
  test('الافتراضي معطّل وكل الميزات مغلقة', () => {
    const s = defaultAiSettings();
    assert.equal(s.mode, 'disabled');
    assert.deepEqual(s.features, { search: false, summary: false, drafting: false });
    assert.equal(isCloudConsentValid(s), false);
  });

  test('قراءة تالفة أو بإصدار مجهول أو نمط مجهول = معطّل', () => {
    for (const raw of ['{not json', '[]', '"x"', '{"version":99,"mode":"cloud"}', '{"version":1,"mode":"turbo"}']) {
      const p = parseStoredSettings(raw);
      assert.equal(p.settings.mode, 'disabled', raw);
      assert.equal(p.recovered, true, raw);
    }
    assert.equal(parseStoredSettings(null).recovered, false);
    assert.equal(parseStoredSettings('').settings.mode, 'disabled');
  });

  test('وضع سحابي مخزَّن بلا عنوان صالح يُعاد إلى معطّل', () => {
    const raw = JSON.stringify({ ...defaultAiSettings(), mode: 'cloud', cloud: { ...defaultAiSettings().cloud, endpoint: 'http://x.com' } });
    const p = parseStoredSettings(raw);
    assert.equal(p.settings.mode, 'disabled');
    assert.equal(p.recovered, true);
  });

  test('قيم الميزات غير المنطقية تُهمَل', () => {
    const raw = JSON.stringify({ ...defaultAiSettings(), mode: 'local', features: { search: 'yes', summary: true, hack: true } });
    const p = parseStoredSettings(raw).settings;
    assert.equal(p.features.search, false);
    assert.equal(p.features.summary, true);
    assert.equal((p.features as Record<string, boolean>).hack, undefined);
  });

  test('تطبيع عنوان الخدمة', () => {
    assert.equal(normalizeCloudEndpoint('https://API.Example.com/v1/'), 'https://api.example.com/v1');
    assert.equal(normalizeCloudEndpoint('  https://api.example.com:8443/x  '), 'https://api.example.com:8443/x');
    const bad = [
      'http://api.example.com', 'ftp://api.example.com', 'https://user:pw@api.example.com',
      'https://api.example.com/v1?key=1', 'https://api.example.com/#x', 'https://localhost/v1',
      'https://printer.local/v1', 'https://192.168.1.5/v1', 'https://api.example.com:99999/v1',
      'https://', 'api.example.com', '', null, 42, 'https://exa mple.com',
    ];
    for (const b of bad) assert.equal(normalizeCloudEndpoint(b), null, String(b));
  });

  test('مفتاح الخدمة: طول وأحرف مطبوعة بلا مسافات', () => {
    assert.equal(isPlausibleCloudKey(KEY), true);
    for (const b of ['short', 'has space in key 1234567890', 'x'.repeat(513), '', null, 5, 'مفتاح-عربي-1234567890']) {
      assert.equal(isPlausibleCloudKey(b), false, String(b));
    }
  });

  test('التفعيل السحابي يتطلب عنواناً ثم إقراراً', () => {
    const base = defaultAiSettings();
    expectAi(() => applySettingsChange(base, { mode: 'cloud' }, 'u1', 1), 'CLOUD_NOT_CONFIGURED');
    expectAi(() => applySettingsChange(base, { cloudEndpoint: EP, mode: 'cloud' }, 'u1', 1), 'CLOUD_CONSENT_REQUIRED');
    const withEp = applySettingsChange(base, { cloudEndpoint: EP, cloudModel: 'm1' }, 'u1', 1);
    const consented = recordCloudConsent(withEp, 'u1', 2);
    const cloud = applySettingsChange(consented, { mode: 'cloud' }, 'u1', 3);
    assert.equal(cloud.mode, 'cloud');
    assert.equal(cloud.cloud.consentVersion, AI_CONSENT_VERSION);
  });

  test('تغيير العنوان يُبطل الإقرار', () => {
    let s = applySettingsChange(defaultAiSettings(), { cloudEndpoint: EP, cloudModel: 'm1' }, 'u1', 1);
    s = recordCloudConsent(s, 'u1', 2);
    assert.equal(isCloudConsentValid(s), true);
    const changed = applySettingsChange(s, { cloudEndpoint: 'https://other.example.org/v1' }, 'u1', 3);
    assert.equal(isCloudConsentValid(changed), false);
    // إعادة العنوان نفسه لا تُنعش الإقرار القديم.
    const back = applySettingsChange(changed, { cloudEndpoint: EP }, 'u1', 4);
    assert.equal(isCloudConsentValid(back), false);
  });

  test('إقرار بإصدار قديم لا يُقبل', () => {
    let s = applySettingsChange(defaultAiSettings(), { cloudEndpoint: EP }, 'u1', 1);
    s = recordCloudConsent(s, 'u1', 2);
    s.cloud.consentVersion = AI_CONSENT_VERSION - 1;
    assert.equal(isCloudConsentValid(s), false);
  });

  test('ميزة مجهولة أو قيمة غير منطقية ترفض، ولا يتغير المدخل', () => {
    const base = defaultAiSettings();
    const snapshot = JSON.stringify(base);
    expectAi(() => applySettingsChange(base, { features: { hack: true } as never }, 'u1', 1), 'INVALID_SETTINGS');
    expectAi(() => applySettingsChange(base, { features: { search: 'x' as never } }, 'u1', 1), 'INVALID_SETTINGS');
    expectAi(() => applySettingsChange(base, { mode: 'turbo' as never }, 'u1', 1), 'INVALID_SETTINGS');
    expectAi(() => applySettingsChange(base, { cloudEndpoint: 'http://x.com' }, 'u1', 1), 'CLOUD_ENDPOINT_INVALID');
    expectAi(() => applySettingsChange(base, { mode: 'local' }, '', 1), 'INVALID_SETTINGS');
    assert.equal(JSON.stringify(base), snapshot);
  });
});

describe('11.1 — السياسة', () => {
  test('مشاهد المحتجزين معزول عن القضايا والمذكرات', () => {
    expectAi(() => assertRoleMayUseAi('detention_viewer', ['case']), 'ENTITY_NOT_PERMITTED');
    expectAi(() => assertRoleMayUseAi('detention_viewer', []), 'ENTITY_NOT_PERMITTED');
    expectAi(() => assertRoleMayUseAi('unknown', ['case']), 'ENTITY_NOT_PERMITTED');
    expectAi(() => assertRoleMayUseAi('viewer', ['bogus' as never]), 'ENTITY_NOT_PERMITTED');
    assertRoleMayUseAi('viewer', ['case', 'memo', 'detainee']);
    assertRoleMayUseAi('investigator', ['case', 'memo']);
  });

  test('شروط الإرسال السحابي مستقلة ومطلوبة كلها', () => {
    let s = applySettingsChange(defaultAiSettings(), { cloudEndpoint: EP, cloudModel: 'm1' }, 'u1', 1);
    s = recordCloudConsent(s, 'u1', 2);
    s = applySettingsChange(s, { mode: 'cloud' }, 'u1', 3);
    const ok = { settings: s, hasCloudKey: true, entities: ['case'] as const, userConfirmed: true };
    assertCloudSendAllowed(ok);
    expectAi(() => assertCloudSendAllowed({ ...ok, hasCloudKey: false }), 'CLOUD_NOT_CONFIGURED');
    expectAi(() => assertCloudSendAllowed({ ...ok, userConfirmed: false }), 'CLOUD_CONFIRMATION_REQUIRED');
    expectAi(() => assertCloudSendAllowed({ ...ok, entities: ['detainee'] }), 'CLOUD_ENTITY_BLOCKED');
    expectAi(() => assertCloudSendAllowed({ ...ok, entities: ['case', 'attachment'] }), 'CLOUD_ENTITY_BLOCKED');
    expectAi(() => assertCloudSendAllowed({ ...ok, settings: { ...s, mode: 'local' } }), 'PROVIDER_UNAVAILABLE');
    expectAi(() => assertCloudSendAllowed({ ...ok, settings: { ...s, cloud: { ...s.cloud, consentVersion: 0 } } }), 'CLOUD_CONSENT_REQUIRED');
    expectAi(() => assertCloudSendAllowed({ ...ok, settings: { ...s, cloud: { ...s.cloud, model: null } } }), 'CLOUD_NOT_CONFIGURED');
  });

  test('التوفر: المعطّل غير متاح، والمزوّد غير الجاهز غير متاح', () => {
    const d = defaultAiSettings();
    assert.equal(evaluateAvailability(d, null, false).code, 'AI_DISABLED');
    const local = applySettingsChange(d, { mode: 'local' }, 'u1', 1);
    assert.equal(evaluateAvailability(local, 'not_installed', false).code, 'PROVIDER_UNAVAILABLE');
    assert.equal(evaluateAvailability(local, 'ready', false).available, true);
  });
});

describe('11.1 — المزوّدات الصادقة', () => {
  test('المزوّدان الحاليان يُبلغان أنهما غير جاهزين ولا يولّدان شيئاً', async () => {
    for (const p of [createLocalPlaceholderProvider(), createCloudPlaceholderProvider()]) {
      assert.equal((await p.getStatus()).state, 'not_installed');
      await expectAiAsync(p.generate({ feature: 'search', system: '', prompt: 'x' }), 'PROVIDER_NOT_IMPLEMENTED');
    }
  });
  test('السجل: لا مزوّد للوضع المعطّل', () => {
    const r = new AiProviderRegistry();
    r.register(createLocalPlaceholderProvider());
    assert.equal(r.forMode('disabled'), null);
    assert.equal(r.forMode('local')?.id, 'local');
    assert.equal(r.forMode('cloud'), null);
  });
});

describe('11.1 — المراجعة البشرية', () => {
  const mk = () => createAiDraft({ id: 'd1', feature: 'drafting', providerId: 'local', text: 'مسودة', requestedBy: 'u1', now: 1 });
  test('المسودة تبدأ بانتظار المراجعة ولا تُستعمل قبل الاعتماد', () => {
    const d = mk();
    assert.equal(d.status, 'pending_review');
    expectAi(() => assertDraftAccepted(d), 'REVIEW_REQUIRED');
  });
  test('الاعتماد مع تحرير يحفظ النص النهائي ويعلّم التحرير', () => {
    const a = acceptAiDraft(mk(), 'u2', 5, 'نص معدّل');
    assert.equal(assertDraftAccepted(a), 'نص معدّل');
    assert.equal(a.edited, true);
    assert.equal(a.reviewedBy, 'u2');
    assert.equal(acceptAiDraft(mk(), 'u2', 5).edited, false);
  });
  test('الرفض لا يمنح نصاً، ولا مراجعة ثانية، ولا مراجع فارغ', () => {
    const r = rejectAiDraft(mk(), 'u2', 5);
    expectAi(() => assertDraftAccepted(r), 'REVIEW_REQUIRED');
    expectAi(() => acceptAiDraft(r, 'u2', 6), 'REVIEW_INVALID');
    expectAi(() => acceptAiDraft(mk(), '', 6), 'REVIEW_INVALID');
    expectAi(() => acceptAiDraft(mk(), 'u2', 6, '   '), 'REVIEW_INVALID');
  });
  test('المسودة غير قابلة للتعديل المباشر', () => {
    const d = mk() as { status: string };
    assert.throws(() => { 'use strict'; d.status = 'accepted'; });
  });
});

describe('11.1 — المنسّق', () => {
  let store: Map<string, string>;
  let audits: AiAuditEvent[];
  let roles: Map<string, string | null>;
  let failAudit: boolean;
  let failGet: boolean;
  let providerState: 'ready' | 'not_installed';
  let mgr: AiManager;
  let clock: number;

  const admin: Session = { userId: 'admin1', role: 'admin' };
  const inv: Session = { userId: 'inv1', role: 'investigator' };
  const viewer: Session = { userId: 'view1', role: 'viewer' };
  const detViewer: Session = { userId: 'det1', role: 'detention_viewer' };

  function fakeProvider(id: 'local' | 'cloud'): AiProvider {
    return {
      id,
      async getStatus() { return { state: providerState, detail: 'x' }; },
      async generate() { throw new AiError('PROVIDER_NOT_IMPLEMENTED'); },
    };
  }

  beforeEach(() => {
    store = new Map();
    audits = [];
    failAudit = false;
    failGet = false;
    providerState = 'ready';
    clock = 1000;
    roles = new Map([['admin1', 'admin'], ['inv1', 'investigator'], ['view1', 'viewer'], ['det1', 'detention_viewer']]);
    const registry = new AiProviderRegistry();
    registry.register(fakeProvider('local'));
    registry.register(fakeProvider('cloud'));
    mgr = createAiManager({
      secrets: {
        async get(n) { if (failGet) throw new Error('boom'); return store.get(n) ?? null; },
        async set(n, v) { store.set(n, v); },
        async remove(n) { store.delete(n); },
      },
      registry,
      async resolveActiveRole(id) { return roles.get(id) ?? null; },
      async audit(e) { if (failAudit) throw new Error('audit down'); audits.push(e); },
      now: () => ++clock,
    });
  });

  async function enableCloud() {
    await mgr.updateSettings(admin, { cloudEndpoint: EP, cloudModel: 'm1' });
    await mgr.saveCloudKey(admin, KEY);
    await mgr.acceptCloudConsent(admin);
    await mgr.updateSettings(admin, { mode: 'cloud', features: { search: true, summary: true, drafting: true } });
  }

  test('الحالة الافتراضية: معطّل، والمطّلع يرى الحالة بلا إدارة', async () => {
    const a = await mgr.getState(admin);
    assert.equal(a.mode, 'disabled');
    assert.equal(a.canManage, true);
    assert.equal(a.availability.code, 'AI_DISABLED');
    const v = await mgr.getState(viewer);
    assert.equal(v.canManage, false);
  });

  test('مشاهد المحتجزين ممنوع حتى من الحالة', async () => {
    await assert.rejects(mgr.getState(detViewer), ForbiddenError);
    await assert.rejects(mgr.getState(null), ForbiddenError);
  });

  test('غير المدير لا يعدّل شيئاً ولا يُكتب شيء', async () => {
    for (const s of [inv, viewer, detViewer]) {
      await assert.rejects(mgr.updateSettings(s, { mode: 'local' }), ForbiddenError);
      await assert.rejects(mgr.saveCloudKey(s, KEY), ForbiddenError);
      await assert.rejects(mgr.clearCloudKey(s), ForbiddenError);
      await assert.rejects(mgr.acceptCloudConsent(s), ForbiddenError);
    }
    assert.equal(store.size, 0);
    assert.equal(audits.length, 0);
  });

  test('الدور يُقرأ من الجدول: جلسة مدير لحساب معطَّل أو بدور تغيّر تُرفض', async () => {
    roles.set('admin1', null);
    await assert.rejects(mgr.updateSettings(admin, { mode: 'local' }), ForbiddenError);
    roles.set('admin1', 'viewer');
    await assert.rejects(mgr.updateSettings(admin, { mode: 'local' }), ForbiddenError);
    assert.equal(store.size, 0);
  });

  test('تغيير الإعدادات يُحفظ ويُدقَّق بالقيم السابقة والجديدة', async () => {
    const st = await mgr.updateSettings(admin, { mode: 'local', features: { search: true } });
    assert.equal(st.mode, 'local');
    assert.equal(st.features.search, true);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operationType, 'ai_settings_change');
    assert.equal(audits[0].actorUserId, 'admin1');
    assert.equal((audits[0].previousValues as { mode: string }).mode, 'disabled');
    assert.equal((audits[0].newValues as { mode: string }).mode, 'local');
  });

  test('فشل التدقيق يُرجع الإعداد السابق ويُلقي AUDIT_FAILED', async () => {
    failAudit = true;
    await expectAiAsync(mgr.updateSettings(admin, { mode: 'local' }), 'AUDIT_FAILED');
    failAudit = false;
    assert.equal((await mgr.getState(admin)).mode, 'disabled');
  });

  test('المفتاح: لا يظهر في الحالة ولا في التدقيق، ويُرفض غير المعقول', async () => {
    await expectAiAsync(mgr.saveCloudKey(admin, 'short'), 'CLOUD_KEY_INVALID');
    const st = await mgr.saveCloudKey(admin, KEY);
    assert.equal(st.cloud.hasKey, true);
    assert.equal(JSON.stringify(st).includes(KEY), false);
    assert.equal(JSON.stringify(audits).includes(KEY), false);
    assert.equal(audits[0].operationType, 'ai_key_change');
  });

  test('فشل تدقيق حفظ المفتاح يتراجع عنه', async () => {
    failAudit = true;
    await expectAiAsync(mgr.saveCloudKey(admin, KEY), 'AUDIT_FAILED');
    assert.equal(store.has(AI_SECRET_NAMES.cloudKey), false);
  });

  test('الوضع السحابي: لا تفعيل بلا مفتاح/إقرار، ويتجه للمعطّل عند حذف المفتاح', async () => {
    await expectAiAsync(mgr.updateSettings(admin, { mode: 'cloud' }), 'CLOUD_NOT_CONFIGURED');
    await enableCloud();
    assert.equal((await mgr.getState(admin)).mode, 'cloud');
    const after = await mgr.clearCloudKey(admin);
    assert.equal(after.mode, 'disabled');
    assert.equal(after.cloud.hasKey, false);
  });

  test('إعدادات مخزَّنة تالفة أو فشل القراءة = معطّل', async () => {
    store.set(AI_SECRET_NAMES.settings, '{broken');
    const a = await mgr.getState(admin);
    assert.equal(a.mode, 'disabled');
    assert.equal(a.settingsRecovered, true);
    failGet = true;
    assert.equal((await mgr.getState(admin)).mode, 'disabled');
  });

  test('authorizeUse: معطّل، ثم ميزة مغلقة، ثم نجاح محلي', async () => {
    await expectAiAsync(mgr.authorizeUse(inv, { feature: 'search', entities: ['case'] }), 'AI_DISABLED');
    await mgr.updateSettings(admin, { mode: 'local' });
    await expectAiAsync(mgr.authorizeUse(inv, { feature: 'search', entities: ['case'] }), 'FEATURE_DISABLED');
    await mgr.updateSettings(admin, { features: { search: true } });
    const grant = await mgr.authorizeUse(inv, { feature: 'search', entities: ['case', 'memo'] });
    assert.equal(grant.mode, 'local');
    const last = audits[audits.length - 1];
    assert.equal(last.operationType, 'ai_request');
    assert.deepEqual((last.newValues as { entities: string[] }).entities, ['case', 'memo']);
  });

  test('authorizeUse: مزوّد غير جاهز = مرفوض (المزوّدات الحالية غير منفَّذة)', async () => {
    await mgr.updateSettings(admin, { mode: 'local', features: { search: true } });
    providerState = 'not_installed';
    await expectAiAsync(mgr.authorizeUse(inv, { feature: 'search', entities: ['case'] }), 'PROVIDER_UNAVAILABLE');
  });

  test('authorizeUse: عزل مشاهد المحتجزين وحساب معطّل ودور تغيّر', async () => {
    await mgr.updateSettings(admin, { mode: 'local', features: { search: true } });
    await assert.rejects(mgr.authorizeUse(detViewer, { feature: 'search', entities: ['case'] }), ForbiddenError);
    roles.set('inv1', null);
    await assert.rejects(mgr.authorizeUse(inv, { feature: 'search', entities: ['case'] }), ForbiddenError);
    roles.set('inv1', 'detention_viewer');
    await assert.rejects(mgr.authorizeUse(inv, { feature: 'search', entities: ['case'] }), AiError);
  });

  test('authorizeUse سحابي: تأكيد صريح، ومنع المحتجزين والمرفقات، وفشل التدقيق يمنع', async () => {
    await enableCloud();
    const req = { feature: 'summary' as AiFeatureId, entities: ['case' as const] };
    await expectAiAsync(mgr.authorizeUse(inv, req), 'CLOUD_CONFIRMATION_REQUIRED');
    await expectAiAsync(mgr.authorizeUse(viewer, { ...req, entities: ['detainee'], confirmCloudSend: true }), 'CLOUD_ENTITY_BLOCKED');
    await expectAiAsync(mgr.authorizeUse(inv, { ...req, entities: ['attachment'], confirmCloudSend: true }), 'CLOUD_ENTITY_BLOCKED');
    const before = audits.length;
    failAudit = true;
    await expectAiAsync(mgr.authorizeUse(inv, { ...req, confirmCloudSend: true }), 'AUDIT_FAILED');
    failAudit = false;
    const grant = await mgr.authorizeUse(inv, { ...req, confirmCloudSend: true });
    assert.equal(grant.mode, 'cloud');
    assert.equal(grant.model, 'm1');
    assert.equal(audits.length, before + 1);
    assert.equal((audits[audits.length - 1].newValues as { cloud: boolean }).cloud, true);
  });

  test('بعد إبطال الإقرار (تغيير العنوان) لا يعمل السحابي', async () => {
    await enableCloud();
    await mgr.updateSettings(admin, { cloudEndpoint: 'https://other.example.org/v1' });
    const st = await mgr.getState(admin);
    assert.equal(st.cloud.consentValid, false);
    assert.equal(st.mode, 'disabled'); // سقط الإقرار فعاد الوضع إلى معطّل تلقائياً
    await expectAiAsync(
      mgr.authorizeUse(inv, { feature: 'search', entities: ['case'], confirmCloudSend: true }),
      'AI_DISABLED'
    );
    // وطلب صريح للبقاء سحابياً دون إقرار جديد مرفوض.
    await expectAiAsync(mgr.updateSettings(admin, { mode: 'cloud' }), 'CLOUD_CONSENT_REQUIRED');
  });

  test('تعديلات متزامنة لا تضيع (تسلسل)', async () => {
    await Promise.all([
      mgr.updateSettings(admin, { features: { search: true } }),
      mgr.updateSettings(admin, { features: { summary: true } }),
      mgr.updateSettings(admin, { features: { drafting: true } }),
    ]);
    const s = await mgr.getState(admin);
    assert.deepEqual(s.features, { search: true, summary: true, drafting: true });
  });

  test('رسائل الأخطاء بالعربية لكل الرموز', () => {
    for (const c of ['AI_DISABLED', 'CLOUD_CONSENT_REQUIRED', 'AUDIT_FAILED', 'REVIEW_REQUIRED']) {
      assert.match(aiErrorMessage(c), /[؀-ۿ]/);
    }
    assert.match(aiErrorMessage('???'), /[؀-ۿ]/);
  });
});
