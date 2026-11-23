// SECURECASEDESK_PHASE11_S1
// سياسة الوصول والخصوصية للذكاء الاصطناعي (نقية، بلا Expo).
// الذكاء الاصطناعي لا يوسّع الصلاحيات: لا يرى المستخدم عبره إلا ما يراه أصلاً في التطبيق.

import { can, type Permission } from '../../security/permissions';
import {
  AI_USE_PERMISSION, AiError,
  type AiEntityKind, type AiFeatureId, type AiMode, type AiSettings,
} from './ai-types';
import { isCloudConsentValid } from './ai-settings';

// صلاحية القراءة المطلوبة لكل نوع بيانات (نفس صلاحيات الشاشات الأصلية).
export const ENTITY_READ_PERMISSION: Record<AiEntityKind, Permission> = {
  case: 'cases.view',
  memo: 'memos.view',
  detainee: 'detainees.view',
  // المرفق يتبع سجله الأصلي؛ تُفحص صلاحية السجل الأصلي بالإضافة إلى هذه.
  attachment: 'dashboard.view',
};

// أنواع بيانات لا تغادر الجهاز أبداً في هذا الإصدار (قرار تصميم يُراجَع في 11.5):
//  - بيانات المحتجزين: أشد الفئات حساسية.
//  - المرفقات: صور/ملفات PDF مشفرة، ولا يُرسَل منها شيء.
export const CLOUD_BLOCKED_ENTITIES: readonly AiEntityKind[] = ['detainee', 'attachment'];

// فحص صلاحية الدور لاستخدام الميزة على الأنواع المطلوبة.
// مشاهد المحتجزين لا يملك ai.use أصلاً، وهذا فحص ثانٍ بعمق دفاعي.
export function assertRoleMayUseAi(role: string | null | undefined, entities: readonly AiEntityKind[]): void {
  if (!can(role, AI_USE_PERMISSION)) throw new AiError('ENTITY_NOT_PERMITTED', 'ai.use');
  for (const kind of entities) {
    if (!Object.prototype.hasOwnProperty.call(ENTITY_READ_PERMISSION, kind)) {
      throw new AiError('ENTITY_NOT_PERMITTED', String(kind));
    }
    if (!can(role, ENTITY_READ_PERMISSION[kind])) throw new AiError('ENTITY_NOT_PERMITTED', kind);
  }
}

export interface CloudSendContext {
  settings: AiSettings;
  hasCloudKey: boolean;
  entities: readonly AiEntityKind[];
  // تأكيد صريح من المستخدم لهذا الطلب بعد عرض ما سيُرسل (يُفرض في 11.2 وما بعده).
  userConfirmed: boolean;
}

// يُلقي AiError إن كان الإرسال إلى الخدمة السحابية غير مسموح. كل شرط مستقل ومطلوب.
export function assertCloudSendAllowed(ctx: CloudSendContext): void {
  const { settings } = ctx;
  if (settings.mode !== 'cloud') throw new AiError('PROVIDER_UNAVAILABLE', 'mode');
  if (!settings.cloud.endpoint || !settings.cloud.model) throw new AiError('CLOUD_NOT_CONFIGURED');
  if (!ctx.hasCloudKey) throw new AiError('CLOUD_NOT_CONFIGURED', 'key');
  if (!isCloudConsentValid(settings)) throw new AiError('CLOUD_CONSENT_REQUIRED');
  for (const kind of ctx.entities) {
    if (CLOUD_BLOCKED_ENTITIES.includes(kind)) throw new AiError('CLOUD_ENTITY_BLOCKED', kind);
  }
  if (ctx.userConfirmed !== true) throw new AiError('CLOUD_CONFIRMATION_REQUIRED');
}

export type AvailabilityCode =
  | 'OK' | 'AI_DISABLED' | 'PROVIDER_UNAVAILABLE' | 'CLOUD_NOT_CONFIGURED' | 'CLOUD_CONSENT_REQUIRED';

export interface Availability {
  available: boolean;
  code: AvailabilityCode;
  message: string;
}

export type ProviderState = 'ready' | 'not_installed' | 'not_configured' | 'unsupported';

// حالة عامة تعرضها الواجهة. لا تُرسل شيئاً ولا تتصل بأي شبكة.
export function evaluateAvailability(
  settings: AiSettings, providerState: ProviderState | null, hasCloudKey: boolean
): Availability {
  const mode: AiMode = settings.mode;
  if (mode === 'disabled') {
    return { available: false, code: 'AI_DISABLED', message: 'الذكاء الاصطناعي معطّل. التطبيق يعمل كاملاً بدونه.' };
  }
  if (mode === 'cloud') {
    if (!settings.cloud.endpoint || !settings.cloud.model || !hasCloudKey) {
      return { available: false, code: 'CLOUD_NOT_CONFIGURED', message: 'إعدادات الخدمة السحابية غير مكتملة (العنوان أو النموذج أو المفتاح).' };
    }
    if (!isCloudConsentValid(settings)) {
      return { available: false, code: 'CLOUD_CONSENT_REQUIRED', message: 'يلزم إقرار مدير النظام بإرسال البيانات إلى الخدمة السحابية.' };
    }
  }
  if (providerState !== 'ready') {
    return { available: false, code: 'PROVIDER_UNAVAILABLE', message: providerMessage(mode, providerState) };
  }
  return { available: true, code: 'OK', message: 'الذكاء الاصطناعي جاهز.' };
}

function providerMessage(mode: AiMode, state: ProviderState | null): string {
  if (mode === 'local') {
    if (state === 'not_installed') return 'لم يُدمج محرك ذكاء اصطناعي محلي في هذا الإصدار بعد.';
    if (state === 'unsupported') return 'الجهاز لا يدعم المحرك المحلي.';
    return 'المحرك المحلي غير متاح.';
  }
  return 'مزوّد الخدمة السحابية غير متاح أو غير مُنفَّذ بعد في هذا الإصدار.';
}

export function isFeatureEnabled(settings: AiSettings, feature: AiFeatureId): boolean {
  return settings.mode !== 'disabled' && settings.features[feature] === true;
}
