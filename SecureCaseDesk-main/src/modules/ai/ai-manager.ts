// SECURECASEDESK_PHASE11_S1
// منسّق الذكاء الاصطناعي: نقطة الدخول الوحيدة لإعداداته ولبوابة استخدامه.
// كل الاعتماديات مُحقنة (التخزين، التدقيق، الأدوار، المزوّدات) كي يُختبر بالكامل في Node.
// أي ميزة ذكاء اصطناعي لاحقة (11.2–11.4) يجب أن تمر عبر authorizeUse قبل أي معالجة.

import { can, type Permission } from '../../security/permissions';
import { ForbiddenError, requirePerm, type Session } from '../../security/guard';
import {
  AI_MANAGE_PERMISSION, AI_SECRET_NAMES, AI_USE_PERMISSION, AiError,
  type AiEntityKind, type AiFeatureId, type AiMode, type AiSettings,
} from './ai-types';
import {
  applySettingsChange, auditView, isCloudConsentValid, isPlausibleCloudKey,
  parseStoredSettings, recordCloudConsent, type AiSettingsChange,
} from './ai-settings';
import {
  assertCloudSendAllowed, assertRoleMayUseAi, evaluateAvailability, isFeatureEnabled,
  type Availability,
} from './ai-policy';
import type { AiProvider, AiProviderRegistry, AiProviderStatus } from './ai-provider';

export interface SecretStoreLike {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface AiAuditEvent {
  operationType: string;
  entityType: 'ai';
  entityId: string;
  previousValues?: unknown;
  newValues?: unknown;
  reason: string;
  actorUserId: string;
}

export interface AiManagerDeps {
  secrets: SecretStoreLike;
  registry: AiProviderRegistry;
  // الدور الحالي من جدول المستخدمين للحساب النشط، أو null إن كان معطلاً/غير موجود.
  resolveActiveRole(userId: string): Promise<string | null>;
  audit(event: AiAuditEvent): Promise<void>;
  now(): number;
}

export interface AiPublicState {
  mode: AiMode;
  features: Record<AiFeatureId, boolean>;
  cloud: {
    endpoint: string | null; model: string | null;
    hasKey: boolean; consentValid: boolean; consentAcceptedAt: number | null;
  };
  localModelId: string | null;
  availability: Availability;
  providerStatus: AiProviderStatus | null;
  // true إن كان المخزَّن تالفاً فأُعيد الوضع المعطّل.
  settingsRecovered: boolean;
  canManage: boolean;
  updatedAt: number;
}

export interface AiUseRequest {
  feature: AiFeatureId;
  entities: readonly AiEntityKind[];
  // تأكيد المستخدم لهذا الطلب (مطلوب فقط عند الوضع السحابي).
  confirmCloudSend?: boolean;
}

export interface AiUseGrant {
  mode: Exclude<AiMode, 'disabled'>;
  provider: AiProvider;
  model: string | null;
}

export interface AiManager {
  getState(session: Session | null | undefined): Promise<AiPublicState>;
  updateSettings(session: Session | null | undefined, change: AiSettingsChange): Promise<AiPublicState>;
  acceptCloudConsent(session: Session | null | undefined): Promise<AiPublicState>;
  saveCloudKey(session: Session | null | undefined, key: string): Promise<AiPublicState>;
  clearCloudKey(session: Session | null | undefined): Promise<AiPublicState>;
  // SECURECASEDESK_PHASE11_S5: مسح كل بيانات الذكاء الاصطناعي من الجهاز (إعدادات + إقرار + مفتاح) والعودة إلى «معطّل».
  resetAll(session: Session | null | undefined): Promise<AiPublicState>;
  authorizeUse(session: Session | null | undefined, request: AiUseRequest): Promise<AiUseGrant>;
}

export function createAiManager(deps: AiManagerDeps): AiManager {
  // تسلسل التعديلات حتى لا يضيع تعديل بسبب سباق قراءة/كتابة.
  let chain: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

  async function loadSettings(): Promise<{ settings: AiSettings; recovered: boolean }> {
    let raw: string | null;
    try {
      raw = await deps.secrets.get(AI_SECRET_NAMES.settings);
    } catch {
      // تعذر القراءة = معطّل (فشل مغلق).
      const parsed = parseStoredSettings(null);
      return { settings: parsed.settings, recovered: true };
    }
    const parsed = parseStoredSettings(raw);
    return { settings: parsed.settings, recovered: parsed.recovered };
  }

  async function saveSettings(settings: AiSettings): Promise<void> {
    try {
      await deps.secrets.set(AI_SECRET_NAMES.settings, JSON.stringify(settings));
    } catch {
      throw new AiError('STORAGE_FAILED');
    }
  }

  async function hasKey(): Promise<boolean> {
    try {
      const v = await deps.secrets.get(AI_SECRET_NAMES.cloudKey);
      return typeof v === 'string' && v.length > 0;
    } catch {
      return false;
    }
  }

  // فحص مزدوج: الجلسة (قبل أي لمس للبيانات) ثم الدور الحالي من جدول المستخدمين.
  async function requireManager(session: Session | null | undefined): Promise<Session> {
    const s = requirePerm(session, AI_MANAGE_PERMISSION);
    const role = await deps.resolveActiveRole(s.userId);
    if (!role || !can(role, AI_MANAGE_PERMISSION as Permission)) throw new ForbiddenError(AI_MANAGE_PERMISSION);
    return s;
  }

  async function buildState(canManage: boolean): Promise<AiPublicState> {
    const { settings, recovered } = await loadSettings();
    const keyPresent = await hasKey();
    const provider = deps.registry.forMode(settings.mode);
    let providerStatus: AiProviderStatus | null = null;
    if (provider) {
      try {
        providerStatus = await provider.getStatus();
      } catch {
        providerStatus = { state: 'unsupported', detail: 'تعذر فحص حالة المزوّد.' };
      }
    }
    return {
      mode: settings.mode,
      features: { ...settings.features },
      cloud: {
        endpoint: settings.cloud.endpoint,
        model: settings.cloud.model,
        hasKey: keyPresent,
        consentValid: isCloudConsentValid(settings),
        consentAcceptedAt: settings.cloud.consentAcceptedAt,
      },
      localModelId: settings.local.modelId,
      availability: evaluateAvailability(settings, providerStatus?.state ?? null, keyPresent),
      providerStatus,
      settingsRecovered: recovered,
      canManage,
      updatedAt: settings.updatedAt,
    };
  }

  // حفظ ثم تدقيق؛ فشل التدقيق يُرجع الحالة السابقة ويُلغي العملية (لا تغيير بلا أثر).
  async function commitSettings(
    prev: AiSettings, next: AiSettings, operationType: string, reason: string, actor: string
  ): Promise<void> {
    await saveSettings(next);
    try {
      await deps.audit({
        operationType, entityType: 'ai', entityId: 'settings',
        previousValues: auditView(prev), newValues: auditView(next), reason, actorUserId: actor,
      });
    } catch {
      try { await saveSettings(prev); } catch { /* أفضل جهد */ }
      throw new AiError('AUDIT_FAILED');
    }
  }

  return {
    async getState(session) {
      const canManage = !!session && can(session.role, AI_MANAGE_PERMISSION);
      const s = canManage ? requirePerm(session, AI_MANAGE_PERMISSION) : requirePerm(session, AI_USE_PERMISSION);
      const role = await deps.resolveActiveRole(s.userId);
      if (!role || !can(role, canManage ? AI_MANAGE_PERMISSION : AI_USE_PERMISSION)) {
        throw new ForbiddenError(canManage ? AI_MANAGE_PERMISSION : AI_USE_PERMISSION);
      }
      return buildState(canManage);
    },

    updateSettings(session, change) {
      return serialize(async () => {
        const s = await requireManager(session);
        const { settings: prev } = await loadSettings();
        const next = applySettingsChange(prev, change, s.userId, deps.now());
        await commitSettings(prev, next, 'ai_settings_change', 'تغيير إعدادات الذكاء الاصطناعي', s.userId);
        return buildState(true);
      });
    },

    acceptCloudConsent(session) {
      return serialize(async () => {
        const s = await requireManager(session);
        const { settings: prev } = await loadSettings();
        const next = recordCloudConsent(prev, s.userId, deps.now());
        await commitSettings(prev, next, 'ai_consent', 'إقرار بإرسال البيانات إلى الخدمة السحابية', s.userId);
        return buildState(true);
      });
    },

    saveCloudKey(session, key) {
      return serialize(async () => {
        const s = await requireManager(session);
        if (!isPlausibleCloudKey(key)) throw new AiError('CLOUD_KEY_INVALID');
        let previousKey: string | null = null;
        try { previousKey = await deps.secrets.get(AI_SECRET_NAMES.cloudKey); } catch { /* لا يوجد */ }
        try {
          await deps.secrets.set(AI_SECRET_NAMES.cloudKey, key);
        } catch {
          throw new AiError('STORAGE_FAILED');
        }
        try {
          // قيمة المفتاح لا تدخل التدقيق أبداً؛ يُسجَّل حدوث التغيير فقط.
          await deps.audit({
            operationType: 'ai_key_change', entityType: 'ai', entityId: 'cloud_key',
            previousValues: { present: previousKey !== null }, newValues: { present: true },
            reason: 'تعيين مفتاح الخدمة السحابية', actorUserId: s.userId,
          });
        } catch {
          try {
            if (previousKey !== null) await deps.secrets.set(AI_SECRET_NAMES.cloudKey, previousKey);
            else await deps.secrets.remove(AI_SECRET_NAMES.cloudKey);
          } catch { /* أفضل جهد */ }
          throw new AiError('AUDIT_FAILED');
        }
        return buildState(true);
      });
    },

    clearCloudKey(session) {
      return serialize(async () => {
        const s = await requireManager(session);
        let previousKey: string | null = null;
        try { previousKey = await deps.secrets.get(AI_SECRET_NAMES.cloudKey); } catch { /* لا يوجد */ }
        try {
          await deps.secrets.remove(AI_SECRET_NAMES.cloudKey);
        } catch {
          throw new AiError('STORAGE_FAILED');
        }
        // بلا مفتاح لا يعمل الوضع السحابي: يُعاد تلقائياً إلى "معطّل" كي لا يبقى وضع معلَّق.
        const { settings: prev } = await loadSettings();
        if (prev.mode === 'cloud') {
          const next: AiSettings = { ...prev, mode: 'disabled', updatedAt: deps.now(), updatedBy: s.userId };
          await saveSettings(next);
        }
        try {
          await deps.audit({
            operationType: 'ai_key_change', entityType: 'ai', entityId: 'cloud_key',
            previousValues: { present: previousKey !== null }, newValues: { present: false },
            reason: 'حذف مفتاح الخدمة السحابية', actorUserId: s.userId,
          });
        } catch {
          // الحذف نفسه أكثر أماناً من الإبقاء؛ لا نُرجع المفتاح. نُبلغ فقط بتعذر التدقيق.
          throw new AiError('AUDIT_FAILED');
        }
        return buildState(true);
      });
    },

    // SECURECASEDESK_PHASE11_S5
    resetAll(session) {
      return serialize(async () => {
        const s = await requireManager(session);
        const { settings: prev } = await loadSettings();
        let hadKey = false;
        try { hadKey = (await deps.secrets.get(AI_SECRET_NAMES.cloudKey)) !== null; } catch { /* لا يوجد */ }
        try {
          await deps.secrets.remove(AI_SECRET_NAMES.cloudKey);
          await deps.secrets.remove(AI_SECRET_NAMES.settings);
        } catch {
          throw new AiError('STORAGE_FAILED');
        }
        try {
          await deps.audit({
            operationType: 'ai_reset', entityType: 'ai', entityId: 'all',
            previousValues: { ...auditView(prev), keyPresent: hadKey }, newValues: { mode: 'disabled', keyPresent: false },
            reason: 'مسح كل بيانات الذكاء الاصطناعي من الجهاز', actorUserId: s.userId,
          });
        } catch {
          // المسح نفسه أكثر أماناً من الإبقاء؛ لا نُرجع شيئاً.
          throw new AiError('AUDIT_FAILED');
        }
        return buildState(true);
      });
    },

    async authorizeUse(session, request) {
      const s = requirePerm(session, AI_USE_PERMISSION);
      // الدور من الجدول لا من الجلسة: تغيير الدور أو تعطيل الحساب يسري فوراً.
      const dbRole = await deps.resolveActiveRole(s.userId);
      if (!dbRole) throw new ForbiddenError(AI_USE_PERMISSION);
      assertRoleMayUseAi(dbRole, request.entities);

      const { settings } = await loadSettings();
      if (settings.mode === 'disabled') throw new AiError('AI_DISABLED');
      if (!isFeatureEnabled(settings, request.feature)) throw new AiError('FEATURE_DISABLED', request.feature);

      const keyPresent = await hasKey();
      const provider = deps.registry.forMode(settings.mode);
      let providerState: AiProviderStatus['state'] | null = null;
      if (provider) {
        try { providerState = (await provider.getStatus()).state; } catch { providerState = null; }
      }
      const availability = evaluateAvailability(settings, providerState, keyPresent);
      if (!availability.available) {
        throw new AiError(availability.code === 'OK' ? 'PROVIDER_UNAVAILABLE' : availability.code);
      }
      if (!provider) throw new AiError('PROVIDER_UNAVAILABLE');

      const isCloud = settings.mode === 'cloud';
      if (isCloud) {
        assertCloudSendAllowed({
          settings, hasCloudKey: keyPresent, entities: request.entities,
          userConfirmed: request.confirmCloudSend === true,
        });
      }

      // يُسجَّل وصف الطلب لا محتواه. السحابي: فشل التدقيق يمنع الإرسال. المحلي: أفضل جهد.
      try {
        await deps.audit({
          operationType: 'ai_request', entityType: 'ai', entityId: request.feature,
          newValues: { feature: request.feature, mode: settings.mode, entities: [...request.entities], cloud: isCloud },
          reason: 'طلب ذكاء اصطناعي', actorUserId: s.userId,
        });
      } catch {
        if (isCloud) throw new AiError('AUDIT_FAILED');
      }

      return {
        mode: settings.mode,
        provider,
        model: isCloud ? settings.cloud.model : settings.local.modelId,
      };
    },
  };
}
