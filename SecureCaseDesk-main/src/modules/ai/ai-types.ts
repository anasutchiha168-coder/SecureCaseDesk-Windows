// SECURECASEDESK_PHASE11_S1
// أنواع وثوابت وحدة الذكاء الاصطناعي (القسم 11.1: تأسيس البنية فقط).
// لا اعتماد على Expo هنا كي يمكن اختبارها في Node. لا تُنفَّذ أي استدعاءات ذكاء اصطناعي في هذا القسم.

export const AI_SETTINGS_VERSION = 1;
// يُرفع عند تغيير نص الإقرار؛ أي إقرار بإصدار أقدم يُعدّ باطلاً.
export const AI_CONSENT_VERSION = 1;

export const AI_MANAGE_PERMISSION = 'ai.manage' as const;
export const AI_USE_PERMISSION = 'ai.use' as const;

// مفاتيح SecureStore (تُصنَّف "مستبعدة" من النسخ الاحتياطي: إعداد خاص بالجهاز، ومفتاح الخدمة سرّ).
export const AI_SECRET_NAMES = {
  settings: 'securecase_ai_settings_v1',
  cloudKey: 'securecase_ai_cloud_key_v1',
} as const;

export type AiMode = 'disabled' | 'local' | 'cloud';
export const AI_MODES: readonly AiMode[] = ['disabled', 'local', 'cloud'];

export type AiFeatureId = 'search' | 'summary' | 'drafting';

export interface AiFeatureSpec {
  id: AiFeatureId;
  label: string;
  description: string;
  section: string;
}

export const AI_FEATURES: readonly AiFeatureSpec[] = [
  { id: 'search', label: 'البحث الذكي', section: '11.2',
    description: 'البحث باللغة الطبيعية في القضايا والمذكرات المسموح للمستخدم بالوصول إليها.' },
  { id: 'summary', label: 'التلخيص الذكي', section: '11.3',
    description: 'تلخيص القضايا والمذكرات والمستندات الطويلة مع الحفاظ على المعلومات الأساسية.' },
  { id: 'drafting', label: 'المساعد في صياغة المستندات', section: '11.4',
    description: 'مسودات للمذكرات والتقارير والخطابات الرسمية تخضع لمراجعة بشرية قبل اعتمادها.' },
];

export const AI_FEATURE_IDS: readonly AiFeatureId[] = AI_FEATURES.map((f) => f.id);

// أنواع السجلات التي قد تُمرَّر إلى الذكاء الاصطناعي.
export type AiEntityKind = 'case' | 'memo' | 'detainee' | 'attachment';

export interface AiCloudSettings {
  endpoint: string | null;
  model: string | null;
  // الإقرار مرتبط بالعنوان والإصدار: تغيير أيٍّ منهما يُبطله.
  consentAcceptedAt: number | null;
  consentAcceptedBy: string | null;
  consentEndpoint: string | null;
  consentVersion: number | null;
}

export interface AiLocalSettings {
  modelId: string | null;
}

export interface AiSettings {
  version: number;
  mode: AiMode;
  features: Record<AiFeatureId, boolean>;
  cloud: AiCloudSettings;
  local: AiLocalSettings;
  updatedAt: number;
  updatedBy: string | null;
}

export type AiErrorCode =
  | 'AI_DISABLED'
  | 'FEATURE_DISABLED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_NOT_IMPLEMENTED'
  | 'CLOUD_NOT_CONFIGURED'
  | 'CLOUD_ENDPOINT_INVALID'
  | 'CLOUD_KEY_INVALID'
  | 'CLOUD_CONSENT_REQUIRED'
  | 'CLOUD_CONFIRMATION_REQUIRED'
  | 'CLOUD_ENTITY_BLOCKED'
  | 'ENTITY_NOT_PERMITTED'
  | 'INVALID_SETTINGS'
  | 'REVIEW_REQUIRED'
  | 'REVIEW_INVALID'
  | 'AUDIT_FAILED'
  | 'STORAGE_FAILED'
  | 'PROVIDER_BAD_RESPONSE'
  | 'SEARCH_QUERY_INVALID'
  | 'SUMMARY_TARGET_INVALID'
  | 'DRAFTING_INPUT_INVALID';

const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  AI_DISABLED: 'الذكاء الاصطناعي معطّل.',
  FEATURE_DISABLED: 'هذه الميزة غير مفعّلة.',
  PROVIDER_UNAVAILABLE: 'مزوّد الذكاء الاصطناعي غير متاح.',
  PROVIDER_NOT_IMPLEMENTED: 'اتصال المزوّد غير مُنفَّذ بعد في هذا الإصدار.',
  CLOUD_NOT_CONFIGURED: 'إعدادات الخدمة السحابية غير مكتملة.',
  CLOUD_ENDPOINT_INVALID: 'عنوان الخدمة السحابية غير صالح: يجب أن يكون HTTPS بدون بيانات اعتماد أو معاملات.',
  CLOUD_KEY_INVALID: 'مفتاح الخدمة السحابية غير صالح.',
  CLOUD_CONSENT_REQUIRED: 'لا يوجد إقرار سارٍ بإرسال البيانات إلى الخدمة السحابية.',
  CLOUD_CONFIRMATION_REQUIRED: 'يتطلب الإرسال إلى الخدمة السحابية تأكيداً صريحاً من المستخدم لهذا الطلب.',
  CLOUD_ENTITY_BLOCKED: 'هذا النوع من البيانات ممنوع إرساله إلى الخدمة السحابية.',
  ENTITY_NOT_PERMITTED: 'لا تملك صلاحية الوصول إلى هذا النوع من البيانات.',
  INVALID_SETTINGS: 'إعدادات الذكاء الاصطناعي غير صالحة.',
  REVIEW_REQUIRED: 'المحتوى المولَّد لم يُراجَع ولم يُعتمد من مستخدم.',
  REVIEW_INVALID: 'إجراء المراجعة غير صالح.',
  AUDIT_FAILED: 'تعذر تسجيل العملية في سجل التدقيق، لذلك لم تُنفَّذ.',
  STORAGE_FAILED: 'تعذر حفظ إعدادات الذكاء الاصطناعي.',
  PROVIDER_BAD_RESPONSE: 'ردّ المزوّد غير مفهوم أو فارغ.',
  DRAFTING_INPUT_INVALID: 'بيانات الصياغة غير صالحة: تحقق من الحقول المطلوبة وأن النصوص ضمن الحدود المسموحة.',
  SUMMARY_TARGET_INVALID: 'السجل المطلوب تلخيصه غير موجود أو غير متاح لك.',
  SEARCH_QUERY_INVALID: 'اكتب طلب بحث من حرفين على الأقل (بحد أقصى 300 حرف) يتضمن كلمة أو فترة زمنية أو نوع سجل.',
};

export class AiError extends Error {
  readonly code: AiErrorCode;
  constructor(code: AiErrorCode, detail?: string) {
    super(code + (detail ? ':' + detail : ''));
    this.name = 'AiError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function aiErrorMessage(code: AiErrorCode | string): string {
  return (AI_ERROR_MESSAGES as Record<string, string>)[code] ?? 'حدث خطأ غير متوقع في وحدة الذكاء الاصطناعي.';
}

export function isAiError(e: unknown): e is AiError {
  return e instanceof AiError;
}
