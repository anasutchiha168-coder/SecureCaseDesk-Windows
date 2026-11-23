#!/usr/bin/env bash
# SecureCaseDesk v2.2 — المرحلة 11 / القسم 11.1: تأسيس بنية الذكاء الاصطناعي
# التشغيل من جذر المشروع:   bash phase11_s1_install.sh
# آمن لإعادة التشغيل: ينسخ احتياطياً كل ملف موجود يُعدَّل (*.bak_التاريخ) ولا يكرر التعديلات.
set -euo pipefail

TS="$(date +%Y%m%d_%H%M%S)"
say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

say "فحص المكان"
[ -f package.json ] && [ -f src/security/permissions.ts ] && [ -f src/modules/backup/backup-types.ts ] \
  || die "شغّل السكربت من جذر مشروع SecureCaseDesk (الذي فيه package.json و src/)."
grep -q '"name": "securecasedesk"' package.json || die "package.json ليس لمشروع securecasedesk."
command -v node >/dev/null 2>&1 || die "Node.js غير متوفر."
grep -q "'backup.manage'" src/security/permissions.ts || die "المرحلة 10.1 غير موجودة (backup.manage مفقودة)."
ok "المشروع سليم المكان والبنية"

# كتابة ملف جديد (نسخ احتياطي للقديم إن اختلف محتواه)
write_file() {
  local target="$1" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  mkdir -p "$(dirname "$target")"
  if [ -f "$target" ]; then
    if cmp -s "$tmp" "$target"; then ok "بلا تغيير: $target"; rm -f "$tmp"; return; fi
    cp "$target" "$target.bak_$TS"
    warn "نُسخ احتياطياً: $target.bak_$TS"
  fi
  mv "$tmp" "$target"
  ok "كُتب: $target"
}

say "إنشاء ملفات الذكاء الاصطناعي"
write_file 'src/modules/ai/ai-types.ts' <<'SCD_EOF_0'
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
  | 'STORAGE_FAILED';

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
SCD_EOF_0
write_file 'src/modules/ai/ai-settings.ts' <<'SCD_EOF_1'
// SECURECASEDESK_PHASE11_S1
// منطق الإعدادات النقي (بلا Expo). القاعدة العامة: الرفض هو الأصل.
//  - الافتراضي: الذكاء الاصطناعي معطّل وكل الميزات مغلقة.
//  - أي إعداد تالف أو غير معروف عند القراءة = الإعدادات الافتراضية (معطّل).
//  - التفعيل السحابي لا يتم دون: عنوان HTTPS صالح + إقرار مرتبط بالعنوان والإصدار.

import {
  AI_CONSENT_VERSION, AI_FEATURE_IDS, AI_MODES, AI_SETTINGS_VERSION,
  AiError,
  type AiFeatureId, type AiMode, type AiSettings,
} from './ai-types';

export function defaultAiSettings(): AiSettings {
  return {
    version: AI_SETTINGS_VERSION,
    mode: 'disabled',
    features: { search: false, summary: false, drafting: false },
    cloud: {
      endpoint: null, model: null,
      consentAcceptedAt: null, consentAcceptedBy: null, consentEndpoint: null, consentVersion: null,
    },
    local: { modelId: null },
    updatedAt: 0,
    updatedBy: null,
  };
}

// ===== التحقق من المدخلات =====

const HOST = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const ENDPOINT_RE = new RegExp(
  '^https://' + HOST + '(?:\\.' + HOST + ')*(?::[0-9]{1,5})?(?:/[A-Za-z0-9\\-._~%!$&\'()*+,;=:/]*)?$',
  'i'
);

// لا يُستعمل new URL عمداً: تطبيق URL في React Native ناقص (hostname قد يُلقي استثناءً).
export function normalizeCloudEndpoint(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const v = input.trim();
  if (v.length < 12 || v.length > 300) return null;
  if (!ENDPOINT_RE.test(v)) return null;
  if (v.includes('@') || v.includes('?') || v.includes('#')) return null;
  const hostPart = v.slice('https://'.length).split('/')[0].split(':')[0].toLowerCase();
  if (hostPart === 'localhost' || hostPart.endsWith('.local')) return null;
  if (/^[0-9.]+$/.test(hostPart)) return null; // عناوين IP الصريحة غير مسموحة
  const portMatch = /:([0-9]{1,5})(?:\/|$)/.exec(v.slice('https://'.length));
  if (portMatch && (Number(portMatch[1]) < 1 || Number(portMatch[1]) > 65535)) return null;
  // حذف الشرطة الأخيرة وتوحيد حالة اسم المضيف فقط.
  const rest = v.slice('https://'.length);
  const slash = rest.indexOf('/');
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? '' : rest.slice(slash).replace(/\/+$/, '');
  return 'https://' + host + path;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
export function normalizeModelName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const v = input.trim();
  return MODEL_RE.test(v) ? v : null;
}

// مفتاح الخدمة: نص مطبوع بلا مسافات. لا يُسجَّل ولا يُعاد للواجهة.
export function isPlausibleCloudKey(input: unknown): input is string {
  return typeof input === 'string' && /^[\x21-\x7E]{16,512}$/.test(input);
}

// ===== القراءة الآمنة =====

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface ParsedSettings {
  settings: AiSettings;
  // true إن كان المخزَّن تالفاً أو بإصدار غير معروف فأُعيد الافتراضي (معطّل).
  recovered: boolean;
}

export function parseStoredSettings(raw: string | null | undefined): ParsedSettings {
  if (raw === null || raw === undefined || raw === '') {
    return { settings: defaultAiSettings(), recovered: false };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { settings: defaultAiSettings(), recovered: true };
  }
  if (!isRecord(data) || data.version !== AI_SETTINGS_VERSION) {
    return { settings: defaultAiSettings(), recovered: true };
  }

  const base = defaultAiSettings();
  const mode = AI_MODES.includes(data.mode as AiMode) ? (data.mode as AiMode) : null;
  if (!mode) return { settings: base, recovered: true };

  const featuresIn = isRecord(data.features) ? data.features : {};
  const features = { ...base.features };
  for (const id of AI_FEATURE_IDS) features[id] = featuresIn[id] === true;

  const cloudIn = isRecord(data.cloud) ? data.cloud : {};
  const endpoint = cloudIn.endpoint === null || cloudIn.endpoint === undefined
    ? null : normalizeCloudEndpoint(cloudIn.endpoint);
  const model = cloudIn.model === null || cloudIn.model === undefined
    ? null : normalizeModelName(cloudIn.model);
  const consentEndpoint = cloudIn.consentEndpoint === null || cloudIn.consentEndpoint === undefined
    ? null : normalizeCloudEndpoint(cloudIn.consentEndpoint);

  const settings: AiSettings = {
    version: AI_SETTINGS_VERSION,
    mode,
    features,
    cloud: {
      endpoint,
      model,
      consentAcceptedAt: numOrNull(cloudIn.consentAcceptedAt),
      consentAcceptedBy: strOrNull(cloudIn.consentAcceptedBy),
      consentEndpoint,
      consentVersion: numOrNull(cloudIn.consentVersion),
    },
    local: { modelId: isRecord(data.local) ? normalizeModelName(data.local.modelId) : null },
    updatedAt: numOrNull(data.updatedAt) ?? 0,
    updatedBy: strOrNull(data.updatedBy),
  };

  // اتساق: وضع سحابي بلا عنوان صالح لا يُقبل من المخزَّن.
  let recovered = false;
  if (settings.mode === 'cloud' && !settings.cloud.endpoint) {
    settings.mode = 'disabled';
    recovered = true;
  }
  return { settings, recovered };
}

// ===== الإقرار السحابي =====

export function isCloudConsentValid(s: AiSettings): boolean {
  const c = s.cloud;
  return (
    c.endpoint !== null &&
    c.consentAcceptedAt !== null &&
    c.consentAcceptedBy !== null &&
    c.consentEndpoint === c.endpoint &&
    c.consentVersion === AI_CONSENT_VERSION
  );
}

// ===== التعديل =====

export interface AiSettingsChange {
  mode?: AiMode;
  features?: Partial<Record<AiFeatureId, boolean>>;
  cloudEndpoint?: string | null;
  cloudModel?: string | null;
  localModelId?: string | null;
}

function clone(s: AiSettings): AiSettings {
  return JSON.parse(JSON.stringify(s)) as AiSettings;
}

// يعيد إعداداً جديداً أو يُلقي AiError. لا يعدّل المدخل.
export function applySettingsChange(
  current: AiSettings, change: AiSettingsChange, actorId: string, now: number
): AiSettings {
  if (!actorId) throw new AiError('INVALID_SETTINGS', 'actor');
  const next = clone(current);

  if (change.cloudEndpoint !== undefined) {
    if (change.cloudEndpoint === null || change.cloudEndpoint === '') {
      next.cloud.endpoint = null;
    } else {
      const ep = normalizeCloudEndpoint(change.cloudEndpoint);
      if (!ep) throw new AiError('CLOUD_ENDPOINT_INVALID');
      next.cloud.endpoint = ep;
    }
    // تغيير العنوان يُبطل الإقرار السابق.
    if (next.cloud.endpoint !== next.cloud.consentEndpoint) {
      next.cloud.consentAcceptedAt = null;
      next.cloud.consentAcceptedBy = null;
      next.cloud.consentEndpoint = null;
      next.cloud.consentVersion = null;
    }
  }

  if (change.cloudModel !== undefined) {
    if (change.cloudModel === null || change.cloudModel === '') {
      next.cloud.model = null;
    } else {
      const m = normalizeModelName(change.cloudModel);
      if (!m) throw new AiError('INVALID_SETTINGS', 'model');
      next.cloud.model = m;
    }
  }

  if (change.localModelId !== undefined) {
    if (change.localModelId === null || change.localModelId === '') {
      next.local.modelId = null;
    } else {
      const m = normalizeModelName(change.localModelId);
      if (!m) throw new AiError('INVALID_SETTINGS', 'localModel');
      next.local.modelId = m;
    }
  }

  if (change.features) {
    for (const [k, v] of Object.entries(change.features)) {
      if (!AI_FEATURE_IDS.includes(k as AiFeatureId) || typeof v !== 'boolean') {
        throw new AiError('INVALID_SETTINGS', 'feature');
      }
      next.features[k as AiFeatureId] = v;
    }
  }

  if (change.mode !== undefined) {
    if (!AI_MODES.includes(change.mode)) throw new AiError('INVALID_SETTINGS', 'mode');
    next.mode = change.mode;
  }

  // تغيير العنوان أثناء الوضع السحابي (دون طلب صريح للبقاء سحابياً) يُسقط الإقرار، فيُعاد الوضع إلى "معطّل".
  if (change.mode === undefined && next.mode === 'cloud' && !isCloudConsentValid(next)) {
    next.mode = 'disabled';
  }

  // التفعيل السحابي يتطلب عنواناً صالحاً وإقراراً ساري المفعول.
  if (next.mode === 'cloud') {
    if (!next.cloud.endpoint) throw new AiError('CLOUD_NOT_CONFIGURED');
    if (!isCloudConsentValid(next)) throw new AiError('CLOUD_CONSENT_REQUIRED');
  }

  next.updatedAt = now;
  next.updatedBy = actorId;
  return next;
}

// تسجيل الإقرار: يربطه بالعنوان الحالي وبإصدار النص.
export function recordCloudConsent(current: AiSettings, actorId: string, now: number): AiSettings {
  if (!actorId) throw new AiError('INVALID_SETTINGS', 'actor');
  if (!current.cloud.endpoint) throw new AiError('CLOUD_NOT_CONFIGURED');
  const next = clone(current);
  next.cloud.consentAcceptedAt = now;
  next.cloud.consentAcceptedBy = actorId;
  next.cloud.consentEndpoint = next.cloud.endpoint;
  next.cloud.consentVersion = AI_CONSENT_VERSION;
  next.updatedAt = now;
  next.updatedBy = actorId;
  return next;
}

// نسخة للتدقيق: لا أسرار فيها أصلاً، لكن نحصرها في الحقول المفيدة.
export function auditView(s: AiSettings): Record<string, unknown> {
  return {
    mode: s.mode,
    features: { ...s.features },
    cloudEndpoint: s.cloud.endpoint,
    cloudModel: s.cloud.model,
    cloudConsentValid: isCloudConsentValid(s),
    localModelId: s.local.modelId,
  };
}
SCD_EOF_1
write_file 'src/modules/ai/ai-policy.ts' <<'SCD_EOF_2'
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
SCD_EOF_2
write_file 'src/modules/ai/ai-provider.ts' <<'SCD_EOF_3'
// SECURECASEDESK_PHASE11_S1
// واجهة مزوّد الذكاء الاصطناعي. القسم 11.1 يعرّف الواجهة والسجل فقط:
// لا يوجد هنا أي تنفيذ وهمي يتظاهر بإنتاج ردود. المزوّدات الحالية تُبلغ بصدق أنها غير جاهزة.

import { AiError, type AiFeatureId, type AiMode } from './ai-types';
import type { ProviderState } from './ai-policy';

export type AiProviderId = 'local' | 'cloud';

export interface AiProviderStatus {
  state: ProviderState;
  detail: string;
}

export interface AiGenerateRequest {
  feature: AiFeatureId;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
}

export interface AiGenerateResult {
  text: string;
  providerId: AiProviderId;
  model: string | null;
}

export interface AiProvider {
  readonly id: AiProviderId;
  getStatus(): Promise<AiProviderStatus>;
  generate(request: AiGenerateRequest, signal?: AbortSignal): Promise<AiGenerateResult>;
}

// مزوّد محلي: لم يُدمج أي محرك على الجهاز بعد.
export function createLocalPlaceholderProvider(): AiProvider {
  return {
    id: 'local',
    async getStatus() {
      return { state: 'not_installed', detail: 'لم يُدمج محرك محلي بعد.' };
    },
    async generate() {
      throw new AiError('PROVIDER_NOT_IMPLEMENTED', 'local');
    },
  };
}

// مزوّد سحابي: صيغة الطلب مع المزوّد الفعلي تُحسم في 11.2 بعد اختيار الخدمة. لا اتصال شبكي هنا.
export function createCloudPlaceholderProvider(): AiProvider {
  return {
    id: 'cloud',
    async getStatus() {
      return { state: 'not_installed', detail: 'اتصال الخدمة السحابية غير مُنفَّذ بعد (11.2).' };
    },
    async generate() {
      throw new AiError('PROVIDER_NOT_IMPLEMENTED', 'cloud');
    },
  };
}

export class AiProviderRegistry {
  private readonly providers = new Map<AiProviderId, AiProvider>();

  register(provider: AiProvider): void {
    this.providers.set(provider.id, provider);
  }

  forMode(mode: AiMode): AiProvider | null {
    if (mode === 'disabled') return null;
    return this.providers.get(mode) ?? null;
  }
}
SCD_EOF_3
write_file 'src/modules/ai/ai-review.ts' <<'SCD_EOF_4'
// SECURECASEDESK_PHASE11_S1
// المراجعة البشرية الإلزامية. أي نص يولّده الذكاء الاصطناعي يبدأ "بانتظار المراجعة"،
// ولا يجوز لأي كود كتابته في سجل حقيقي إلا عبر assertDraftAccepted بعد اعتماد مستخدم فعلي.
// لا تعديل ذاتي للسجلات: هذه الوحدة لا تعرف شيئاً عن قاعدة البيانات أصلاً.

import { AiError, type AiFeatureId } from './ai-types';
import type { AiProviderId } from './ai-provider';

export type AiDraftStatus = 'pending_review' | 'accepted' | 'rejected';

export interface AiDraft {
  readonly id: string;
  readonly feature: AiFeatureId;
  readonly providerId: AiProviderId;
  readonly generatedText: string;
  // النص النهائي بعد تحرير المراجع (يساوي المولَّد إن لم يُحرَّر).
  readonly finalText: string;
  readonly status: AiDraftStatus;
  readonly requestedBy: string;
  readonly createdAt: number;
  readonly reviewedBy: string | null;
  readonly reviewedAt: number | null;
  readonly edited: boolean;
}

export function createAiDraft(input: {
  id: string; feature: AiFeatureId; providerId: AiProviderId;
  text: string; requestedBy: string; now: number;
}): AiDraft {
  if (!input.id || !input.requestedBy) throw new AiError('REVIEW_INVALID');
  return Object.freeze({
    id: input.id, feature: input.feature, providerId: input.providerId,
    generatedText: input.text, finalText: input.text,
    status: 'pending_review' as const,
    requestedBy: input.requestedBy, createdAt: input.now,
    reviewedBy: null, reviewedAt: null, edited: false,
  });
}

function review(draft: AiDraft, status: 'accepted' | 'rejected', reviewerId: string, now: number, editedText?: string): AiDraft {
  if (draft.status !== 'pending_review') throw new AiError('REVIEW_INVALID', 'already-reviewed');
  if (!reviewerId) throw new AiError('REVIEW_INVALID', 'reviewer');
  const finalText = status === 'accepted' && typeof editedText === 'string' ? editedText : draft.generatedText;
  if (status === 'accepted' && finalText.trim().length === 0) throw new AiError('REVIEW_INVALID', 'empty');
  return Object.freeze({
    ...draft,
    status,
    finalText: status === 'accepted' ? finalText : draft.finalText,
    edited: status === 'accepted' && finalText !== draft.generatedText,
    reviewedBy: reviewerId,
    reviewedAt: now,
  });
}

export function acceptAiDraft(draft: AiDraft, reviewerId: string, now: number, editedText?: string): AiDraft {
  return review(draft, 'accepted', reviewerId, now, editedText);
}

export function rejectAiDraft(draft: AiDraft, reviewerId: string, now: number): AiDraft {
  return review(draft, 'rejected', reviewerId, now);
}

// الحارس الذي يجب أن يمر منه أي كود يريد استعمال نص مولَّد: يعيد النص النهائي المعتمد فقط.
export function assertDraftAccepted(draft: AiDraft): string {
  if (draft.status !== 'accepted' || !draft.reviewedBy || draft.reviewedAt === null) {
    throw new AiError('REVIEW_REQUIRED');
  }
  return draft.finalText;
}
SCD_EOF_4
write_file 'src/modules/ai/ai-manager.ts' <<'SCD_EOF_5'
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
SCD_EOF_5
write_file 'src/modules/ai/ai-runtime.ts' <<'SCD_EOF_6'
// SECURECASEDESK_PHASE11_S1
// محوّل Expo لوحدة الذكاء الاصطناعي: يربط المنسّق بـ SecureStore وقاعدة البيانات وسجل التدقيق.
// ⚠️ لم يُختبر على جهاز Android حقيقي بعد (يتطلب dev build)، ويحتاج فحص tsc.

import * as SecureStore from 'expo-secure-store';
import { getDb } from '@/database/db';
import { recordAuditEvent } from '@/services/audit.service';
import {
  createAiManager, type AiManager, type SecretStoreLike,
} from './ai-manager';
import {
  AiProviderRegistry, createCloudPlaceholderProvider, createLocalPlaceholderProvider,
} from './ai-provider';

const secretStore: SecretStoreLike = {
  get: (name) => SecureStore.getItemAsync(name),
  set: (name, value) => SecureStore.setItemAsync(name, value),
  remove: (name) => SecureStore.deleteItemAsync(name),
};

let manager: AiManager | null = null;

export function getAiManager(): AiManager {
  if (manager) return manager;

  const registry = new AiProviderRegistry();
  registry.register(createLocalPlaceholderProvider());
  registry.register(createCloudPlaceholderProvider());

  manager = createAiManager({
    secrets: secretStore,
    registry,
    async resolveActiveRole(userId) {
      const db = await getDb();
      const row = await db.getFirstAsync<{ role: string; is_active: number }>(
        'SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?', [userId]
      );
      return row && Number(row.is_active) === 1 ? String(row.role) : null;
    },
    async audit(event) {
      const db = await getDb();
      const u = await db.getFirstAsync<{ username: string }>(
        'SELECT username FROM users WHERE id = ?', [event.actorUserId]
      );
      await recordAuditEvent({
        operationType: event.operationType,
        entityType: event.entityType,
        entityId: event.entityId,
        previousValues: event.previousValues,
        newValues: event.newValues,
        reason: event.reason,
        actor: { id: event.actorUserId, username: u?.username ?? null },
      });
    },
    now: () => Date.now(),
  });
  return manager;
}
SCD_EOF_6
write_file 'src/app/ai-settings.tsx' <<'SCD_EOF_7'
// SECURECASEDESK_PHASE11_S1
// شاشة إعدادات الذكاء الاصطناعي (مدير النظام فقط). التحكم بالتفعيل/التعطيل ووضع التشغيل والميزات.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert, Switch, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { RefreshCw, X } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Colors, Radius, Fonts, FontSizes } from '@/constants/theme';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration';
import { getAiManager } from '@/modules/ai/ai-runtime';
import type { AiPublicState } from '@/modules/ai/ai-manager';
import {
  AI_FEATURES, AI_CONSENT_VERSION, aiErrorMessage, isAiError, type AiMode,
} from '@/modules/ai/ai-types';

const MODE_LABELS: Record<AiMode, string> = { disabled: 'معطّل', local: 'محلي', cloud: 'سحابي' };
const MODES: AiMode[] = ['disabled', 'local', 'cloud'];

const CONSENT_TEXT =
  'عند تفعيل الوضع السحابي قد تُرسَل نصوص تختارها أنت إلى خدمة خارجية خارج الجهاز. ' +
  'لا تُرسل بيانات المحتجزين ولا المرفقات أبداً. لا يُرسل أي شيء إلا بعد تأكيدك الصريح في كل طلب. ' +
  'مخرجات الذكاء الاصطناعي مسودات تخضع لمراجعتك قبل اعتمادها ولا تُعدّل أي سجل تلقائياً.';

function errText(e: unknown): string {
  if (isAiError(e)) return aiErrorMessage(e.code);
  return 'حدث خطأ غير متوقع';
}

export default function AiSettingsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'ai.manage');
  const session = user ? { userId: user.id, role: user.role } : null;

  const [state, setState] = useState<AiPublicState | null>(null);
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    if (user && !allowed) {
      void recordUnauthorizedAccess({
        userId: user.id, username: user.username, role: user.role,
        resource: 'screen:ai-settings', detail: 'محاولة فتح إعدادات الذكاء الاصطناعي',
      });
    }
  }, [user?.id, allowed]);

  const apply = (s: AiPublicState) => {
    setState(s);
    setEndpoint(s.cloud.endpoint ?? '');
    setModel(s.cloud.model ?? '');
  };

  const load = useCallback(async () => {
    if (!session) return;
    try {
      apply(await getAiManager().getState(session));
    } catch (e) {
      Alert.alert('تعذر تحميل الإعدادات', errText(e));
    }
  }, [user?.id]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed]);

  const run = async (task: () => Promise<AiPublicState>) => {
    if (!session || busy) return;
    setBusy(true);
    try {
      apply(await task());
    } catch (e) {
      Alert.alert('تعذر تنفيذ العملية', errText(e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const mgr = getAiManager();

  const changeMode = (mode: AiMode) => {
    if (!state || mode === state.mode) return;
    if (mode === 'cloud') {
      Alert.alert('تفعيل الوضع السحابي', 'سيُسمح بإرسال نصوص إلى خدمة خارجية بعد تأكيدك في كل طلب. هل تريد المتابعة؟', [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'متابعة', onPress: () => void run(() => mgr.updateSettings(session, { mode })) },
      ]);
      return;
    }
    void run(() => mgr.updateSettings(session, { mode }));
  };

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()}>
        <X size={20} color={Colors.textPrimary} />
      </Pressable>
      <Text style={styles.title}>إعدادات الذكاء الاصطناعي</Text>
      <Pressable style={styles.iconBtn} onPress={() => void load()} disabled={!allowed}>
        <RefreshCw size={20} color={Colors.primaryLight} />
      </Pressable>
    </View>
  );

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.denied}>غير مصرح لك بإدارة الذكاء الاصطناعي</Text>
          <Text style={styles.muted}>تم تسجيل هذه المحاولة في سجل التدقيق</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!state) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}><ActivityIndicator color={Colors.primary} /></View>
      </SafeAreaView>
    );
  }

  const cloudReady = !!state.cloud.endpoint && !!state.cloud.model && state.cloud.hasKey && state.cloud.consentValid;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {state.settingsRecovered && (
          <View style={[styles.card, { borderColor: Colors.warning }]}>
            <Text style={styles.warn}>تعذرت قراءة الإعدادات المحفوظة فأُعيد الوضع إلى "معطّل" حفاظاً على الأمان.</Text>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>الحالة</Text>
          <Text style={[styles.statusText, { color: state.availability.available ? Colors.success : Colors.textSecondary }]}>
            {state.availability.message}
          </Text>
          {state.providerStatus && <Text style={styles.muted}>المزوّد: {state.providerStatus.detail}</Text>}
          <Text style={styles.muted}>
            التطبيق بكامل وحداته الأساسية يعمل دون الذكاء الاصطناعي. لا تُنفَّذ أي ميزة ذكاء اصطناعي في هذا الإصدار بعد.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>وضع التشغيل</Text>
          <View style={styles.modeRow}>
            {MODES.map((m) => (
              <Pressable
                key={m}
                disabled={busy}
                onPress={() => changeMode(m)}
                style={[styles.modeBtn, state.mode === m && styles.modeBtnActive]}
              >
                <Text style={[styles.modeText, state.mode === m && styles.modeTextActive]}>{MODE_LABELS[m]}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>الميزات</Text>
          {AI_FEATURES.map((f) => (
            <View key={f.id} style={styles.featureRow}>
              <Switch
                value={state.features[f.id]}
                disabled={busy}
                onValueChange={(v) => void run(() => mgr.updateSettings(session, { features: { [f.id]: v } }))}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.featureLabel}>{f.label}</Text>
                <Text style={styles.muted}>{f.description}</Text>
                <Text style={styles.muted}>تُنفَّذ في القسم {f.section}</Text>
              </View>
            </View>
          ))}
          {state.mode === 'disabled' && (
            <Text style={styles.muted}>الميزات لا تعمل ما دام الوضع "معطّل" حتى لو كانت مفعّلة هنا.</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>الخدمة السحابية (اختيارية)</Text>
          <Text style={styles.label}>عنوان الخدمة (HTTPS فقط)</Text>
          <TextInput
            style={styles.input} value={endpoint} onChangeText={setEndpoint}
            autoCapitalize="none" autoCorrect={false} keyboardType="url"
            placeholder="https://api.example.com/v1" placeholderTextColor={Colors.textMuted}
          />
          <Text style={styles.label}>اسم النموذج</Text>
          <TextInput
            style={styles.input} value={model} onChangeText={setModel}
            autoCapitalize="none" autoCorrect={false}
            placeholder="model-name" placeholderTextColor={Colors.textMuted}
          />
          <Pressable
            disabled={busy}
            style={styles.actionBtn}
            onPress={() => void run(() => mgr.updateSettings(session, { cloudEndpoint: endpoint.trim(), cloudModel: model.trim() }))}
          >
            <Text style={styles.actionText}>حفظ العنوان والنموذج</Text>
          </Pressable>

          <Text style={[styles.label, { marginTop: 12 }]}>
            مفتاح الخدمة {state.cloud.hasKey ? '(محفوظ في التخزين الآمن)' : '(غير محفوظ)'}
          </Text>
          <TextInput
            style={styles.input} value={apiKey} onChangeText={setApiKey}
            autoCapitalize="none" autoCorrect={false} secureTextEntry
            placeholder="أدخل مفتاحاً جديداً" placeholderTextColor={Colors.textMuted}
          />
          <View style={styles.row}>
            <Pressable
              disabled={busy || apiKey.length === 0}
              style={[styles.actionBtn, { flex: 1 }]}
              onPress={() => void run(async () => {
                const s = await mgr.saveCloudKey(session, apiKey);
                setApiKey('');
                return s;
              })}
            >
              <Text style={styles.actionText}>حفظ المفتاح</Text>
            </Pressable>
            <Pressable
              disabled={busy || !state.cloud.hasKey}
              style={[styles.actionBtn, { flex: 1, borderColor: Colors.danger }]}
              onPress={() => Alert.alert('حذف المفتاح', 'سيُعاد الوضع إلى "معطّل" إن كان سحابياً. هل تريد المتابعة؟', [
                { text: 'إلغاء', style: 'cancel' },
                { text: 'حذف', style: 'destructive', onPress: () => void run(() => mgr.clearCloudKey(session)) },
              ])}
            >
              <Text style={[styles.actionText, { color: Colors.danger }]}>حذف المفتاح</Text>
            </Pressable>
          </View>

          <Text style={[styles.label, { marginTop: 12 }]}>
            الإقرار (إصدار {AI_CONSENT_VERSION}) {state.cloud.consentValid ? '— ساري' : '— غير ساري'}
          </Text>
          <Text style={styles.muted}>{CONSENT_TEXT}</Text>
          <Pressable
            disabled={busy || !state.cloud.endpoint}
            style={[styles.actionBtn, !state.cloud.endpoint && { opacity: 0.5 }]}
            onPress={() => Alert.alert('الإقرار', CONSENT_TEXT, [
              { text: 'إلغاء', style: 'cancel' },
              { text: 'أقرّ وأوافق', onPress: () => void run(() => mgr.acceptCloudConsent(session)) },
            ])}
          >
            <Text style={styles.actionText}>الإقرار بالشروط</Text>
          </Pressable>

          <Text style={[styles.muted, { marginTop: 8 }]}>
            جاهزية الوضع السحابي: {cloudReady ? 'مكتملة' : 'ناقصة (العنوان، النموذج، المفتاح، الإقرار)'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>الوضع المحلي</Text>
          <Text style={styles.muted}>لم يُدمج محرك ذكاء اصطناعي محلي في هذا الإصدار. لن يعمل الوضع المحلي قبل دمجه.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  iconBtn: { width: 40, height: 40, borderRadius: Radius.md, backgroundColor: Colors.card, alignItems: 'center', justifyContent: 'center' },
  title: { color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.lg },
  scroll: { paddingHorizontal: 16, paddingBottom: 40, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  denied: { color: Colors.danger, fontFamily: Fonts.bold, fontSize: FontSizes.md },
  muted: { color: Colors.textMuted, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'right' },
  warn: { color: Colors.warning, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'right' },
  card: { backgroundColor: Colors.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, padding: 16, gap: 8 },
  sectionTitle: { color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md, textAlign: 'right' },
  statusText: { fontFamily: Fonts.semiBold, fontSize: FontSizes.md, textAlign: 'right' },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeBtn: { flex: 1, height: 44, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.borderLight, alignItems: 'center', justifyContent: 'center' },
  modeBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  modeText: { color: Colors.textSecondary, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm },
  modeTextActive: { color: Colors.textOnPrimary },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  featureLabel: { color: Colors.textPrimary, fontFamily: Fonts.semiBold, fontSize: FontSizes.md, textAlign: 'right' },
  label: { color: Colors.textSecondary, fontFamily: Fonts.medium, fontSize: FontSizes.sm, textAlign: 'right' },
  input: { height: 44, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.borderLight, backgroundColor: Colors.secondary, color: Colors.textPrimary, paddingHorizontal: 12, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'left' },
  row: { flexDirection: 'row', gap: 8 },
  actionBtn: { height: 44, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  actionText: { color: Colors.primaryLight, fontFamily: Fonts.bold, fontSize: FontSizes.sm },
});
SCD_EOF_7
write_file 'tests/ai-foundation.test.ts' <<'SCD_EOF_8'
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
SCD_EOF_8
write_file 'docs/phase11/11.1-ai-foundation.md' <<'SCD_EOF_9'
<!-- SECURECASEDESK_PHASE11_S1 -->
# المرحلة 11 / القسم 11.1 — تأسيس بنية الذكاء الاصطناعي

> نطاق هذا القسم: البنية والخدمات والإعدادات والتحكم بالتفعيل/التعطيل فقط.
> **لا تُنفَّذ أي ميزة ذكاء اصطناعي هنا** (لا بحث ولا تلخيص ولا صياغة)، ولا اتصال شبكي، ولا ردود وهمية.

## 1. المبادئ الحاكمة (من المواصفات)
- التطبيق الأساسي يعمل كاملاً والذكاء الاصطناعي معطّل (هو الوضع الافتراضي).
- لا تعديل ذاتي للسجلات، ولا قرارات قضائية أو أمنية.
- لا إرسال تلقائي لبيانات حساسة إلى خدمة سحابية.
- مراجعة بشرية قبل اعتماد أي محتوى مولَّد.
- الذكاء الاصطناعي لا يوسّع الصلاحيات: لا يصل المستخدم عبره إلا إلى ما يراه أصلاً.

## 2. ما أُضيف

| الملف | الغرض |
|---|---|
| `src/modules/ai/ai-types.ts` | الثوابت والأنواع ورموز الأخطاء (بالعربية) وأسماء أسرار SecureStore |
| `src/modules/ai/ai-settings.ts` | منطق الإعدادات النقي: الافتراضي، القراءة الآمنة، التحقق من العنوان والمفتاح، الإقرار، التعديل |
| `src/modules/ai/ai-policy.ts` | سياسة الوصول والخصوصية: صلاحيات الأنواع، منع الإرسال السحابي، التوفر |
| `src/modules/ai/ai-provider.ts` | واجهة المزوّد + سجل المزوّدات + مزوّدان "صادقان" يُبلغان بأنهما غير جاهزين |
| `src/modules/ai/ai-review.ts` | المراجعة البشرية: المسودة تبدأ "بانتظار المراجعة" ولا تُستعمل إلا بعد اعتماد مستخدم |
| `src/modules/ai/ai-manager.ts` | المنسّق: الحالة، تعديل الإعدادات، المفتاح، الإقرار، وبوابة `authorizeUse` |
| `src/modules/ai/ai-runtime.ts` | محوّل Expo (SecureStore + قاعدة البيانات + سجل التدقيق) |
| `src/app/ai-settings.tsx` | شاشة الإعدادات (مدير النظام فقط) |
| `tests/ai-foundation.test.ts` | 38 اختباراً في Node: `npm run test:ai-foundation` |

وتعديلات صغيرة على: `permissions.ts` (+`ai.use`, `ai.manage`)، `audit-labels.ts` (تسميات عربية)،
`settings.tsx` (زر الدخول للمدير)، `package.json` (سكربت الاختبار)، و`backup-types.ts`/`backup-inventory.ts`
(تصنيف أسرار الذكاء الاصطناعي "مستبعدة" من النسخ الاحتياطي).

## 3. الصلاحيات
| الصلاحية | الأدوار |
|---|---|
| `ai.manage` (الإعدادات والمفتاح والإقرار) | مدير النظام فقط |
| `ai.use` (استعمال الميزات لاحقاً) | مدير النظام، المحقق، مستخدم الاطلاع |
| كلاهما | **مشاهد المحتجزين: لا يملك أيّاً منهما** (عزل كامل) |

الفحص مزدوج: الجلسة أولاً (قبل أي لمس للبيانات)، ثم الدور الحالي من جدول المستخدمين
(حساب معطّل أو دور تغيّر = رفض فوري). صلاحية كل نوع بيانات تُفحص أيضاً (`cases.view`, `memos.view`, `detainees.view`).

## 4. التفعيل والتعطيل
- الأوضاع: `disabled` (افتراضي) | `local` | `cloud`.
- كل ميزة (بحث / تلخيص / صياغة) لها مفتاح تفعيل مستقل، **وكلها مغلقة افتراضياً**، ولا تعمل في وضع "معطّل".
- أي إعداد مخزَّن تالف أو بإصدار مجهول، أو فشل قراءة التخزين = **معطّل** (فشل مغلق).
- التخزين: SecureStore (`securecase_ai_settings_v1`) وهو إعداد خاص بالجهاز.

## 5. الوضع السحابي (اختياري) — شروط مستقلة كلها مطلوبة
1. عنوان **HTTPS** صالح (بلا بيانات اعتماد أو معاملات استعلام أو `localhost` أو عناوين IP أو `.local`).
2. اسم نموذج.
3. مفتاح الخدمة في SecureStore (`securecase_ai_cloud_key_v1`): لا يُعاد للواجهة ولا يُكتب في التدقيق ولا في أي سجل.
4. **إقرار المدير** مرتبط بالعنوان وبإصدار النص: تغيير العنوان يُبطل الإقرار ويُعيد الوضع إلى "معطّل".
5. **تأكيد صريح من المستخدم لكل طلب** (`confirmCloudSend`) — يُفرض عند بناء الميزات في 11.2 وما بعده.
6. تسجيل الطلب في التدقيق قبل الإرسال؛ **فشل التدقيق يمنع الإرسال السحابي**.

**محظور إرساله سحابياً في هذا الإصدار:** بيانات المحتجزين والمرفقات (`CLOUD_BLOCKED_ENTITIES`).

## 6. التدقيق
أحداث جديدة في سجل HMAC: `ai_settings_change`, `ai_consent`, `ai_key_change` (الوجود فقط لا القيمة), `ai_request`
(الميزة والوضع وأنواع البيانات لا المحتوى). فشل تدقيق تغيير إعداد أو مفتاح = تراجع عن التغيير.

## 7. النسخ الاحتياطي
سرّا الذكاء الاصطناعي صُنِّفا **مستبعدين** من النسخ (إعداد جهاز + مفتاح سري). بعد الاستعادة على جهاز آخر
يعود الذكاء الاصطناعي إلى "معطّل" ويلزم إعداده من جديد، وهذا السلوك المقصود.

## 8. ما لم يُنفَّذ ولم يُختبر (صراحةً)
- لا محرك محلي مدمج: الوضع المحلي يُبلغ "غير جاهز". اختيار المحرك (وهل يُدعم على Android) قرار مفتوح.
- لا اتصال سحابي فعلي: صيغة الطلب تتبع الخدمة المختارة وتُحسم في 11.2. لذلك `authorizeUse` يرفض حالياً في كل الأوضاع (المزوّد غير جاهز) وهذا هو السلوك الصحيح.
- الاختبارات تغطي المنطق في Node فقط. **لم تُختبر الشاشة ولا `ai-runtime.ts` على جهاز Android حقيقي**، ويلزم فحص `npx tsc --noEmit`.
- الحماية من حقن التعليمات (prompt injection) وإخفاء الحقول الحساسة قبل الإرسال: تُنفَّذ في 11.5.

## 9. قرارات تحتاج مراجعتك
1. هل يُسمح لمستخدم الاطلاع (viewer) بـ`ai.use`؟ (مفعّل حالياً لأنه يقرأ القضايا أصلاً.)
2. هل تبقى بيانات المحتجزين ممنوعة من السحابة نهائياً؟ (الافتراض: نعم.)
3. أي خدمة سحابية ستُعتمد (لتحديد صيغة الطلب في 11.2)؟
SCD_EOF_9

say "تعديل الملفات الموجودة (مع نسخ احتياطي)"
PATCH_FILE="$(mktemp)"
cat > "$PATCH_FILE" <<'SCD_PATCH_JS'
// تعديلات جراحية على ملفات موجودة. كل تعديل: نص مرجعي يظهر مرة واحدة بالضبط، وعلامة "تمّ" تجعله آمناً لإعادة التشغيل.
const fs = require('fs');
const TS = process.env.TS || 'now';
let failed = false;

function patchFile(file, edits) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { console.log('  ✘ تعذرت قراءة ' + file); failed = true; return; }
  const crlf = raw.includes('\r\n');
  let s = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  let changed = false;
  for (const ed of edits) {
    if (s.includes(ed.done)) { console.log('  · سبق تطبيقه: ' + file + ' [' + ed.name + ']'); continue; }
    const count = s.split(ed.find).length - 1;
    if (count !== 1) {
      console.log('  ✘ ' + file + ' [' + ed.name + ']: النص المرجعي وُجد ' + count + ' مرة (المتوقع 1). لم يُعدَّل الملف.');
      failed = true; return;
    }
    s = s.replace(ed.find, () => ed.replace);
    changed = true;
    console.log('  ✔ ' + file + ' [' + ed.name + ']');
  }
  if (changed) {
    fs.copyFileSync(file, file + '.bak_' + TS);
    fs.writeFileSync(file, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
  }
}

patchFile('src/security/permissions.ts', [
  { name: 'union', find: "  | 'backup.manage';", replace: "  | 'backup.manage'\n  | 'ai.use'\n  | 'ai.manage';", done: "| 'ai.manage'" },
  { name: 'admin', find: "'audit.view', 'audit.verify', 'audit.sync', 'backup.manage',", replace: "'audit.view', 'audit.verify', 'audit.sync', 'backup.manage', 'ai.use', 'ai.manage',", done: "'backup.manage', 'ai.use', 'ai.manage'," },
  { name: 'investigator', find: "'memos.manage', 'detainees.view',", replace: "'memos.manage', 'detainees.view', 'ai.use',", done: "'detainees.view', 'ai.use'," },
  { name: 'viewer', find: "viewer: ['dashboard.view', 'cases.view', 'memos.view', 'detainees.view'],", replace: "viewer: ['dashboard.view', 'cases.view', 'memos.view', 'detainees.view', 'ai.use'],", done: "'detainees.view', 'ai.use']," },
]);

patchFile('src/modules/audit/audit-labels.ts', [
  { name: 'operations', find: "  permission_change: 'تغيير صلاحيات',",
    replace: "  permission_change: 'تغيير صلاحيات',\n  ai_settings_change: 'تغيير إعدادات الذكاء الاصطناعي',\n  ai_consent: 'إقرار إرسال البيانات للخدمة السحابية',\n  ai_key_change: 'تغيير مفتاح الخدمة السحابية',\n  ai_request: 'طلب ذكاء اصطناعي',",
    done: 'ai_settings_change' },
  { name: 'entity', find: "  self_test: 'فحص ذاتي',", replace: "  self_test: 'فحص ذاتي',\n  ai: 'الذكاء الاصطناعي',", done: "  ai: 'الذكاء الاصطناعي'," },
]);

const aiButton = [
  "{can(user?.role, 'ai.manage') && (",
  "          <Pressable",
  "            onPress={() => router.push('/ai-settings' as never)}",
  "            style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: 12, borderWidth: 1, borderColor: Colors.primary, backgroundColor: Colors.card, marginBottom: 12 }, pressed && { opacity: 0.85 }]}",
  "          >",
  "            <Sparkles color={Colors.primary} size={20} />",
  "            <Text style={{ color: Colors.primary, fontFamily: 'Cairo_700Bold', fontSize: 15 }}>إعدادات الذكاء الاصطناعي</Text>",
  "          </Pressable>",
  "        )}",
  "",
  "        {can(user?.role, 'dashboard.view') && (",
].join('\n');
patchFile('src/app/(tabs)/settings.tsx', [
  { name: 'import', find: "import { LogOut, FileText } from 'lucide-react-native';", replace: "import { LogOut, FileText, Sparkles } from 'lucide-react-native'; // SECURECASEDESK_PHASE11_S1", done: 'Sparkles }' },
  { name: 'button', find: "{can(user?.role, 'dashboard.view') && (", replace: aiButton, done: "router.push('/ai-settings'" },
]);

patchFile('src/modules/backup/backup-types.ts', [
  { name: 'secret-names', find: "  apiToken: 'securecase_api_token',",
    replace: "  apiToken: 'securecase_api_token',\n  aiSettings: 'securecase_ai_settings_v1', // SECURECASEDESK_PHASE11_S1\n  aiCloudKey: 'securecase_ai_cloud_key_v1',",
    done: "aiSettings: 'securecase_ai_settings_v1'" },
]);

patchFile('src/modules/backup/backup-inventory.ts', [
  { name: 'secret-specs', find: "    { name: SECRET_NAMES.apiToken, cls: 'excluded',",
    replace: "    { name: SECRET_NAMES.aiSettings, cls: 'excluded',\n      reason: 'إعداد الذكاء الاصطناعي خاص بالجهاز: يعود معطّلاً بعد الاستعادة.' },\n    { name: SECRET_NAMES.aiCloudKey, cls: 'excluded',\n      reason: 'مفتاح خدمة الذكاء الاصطناعي السحابية: سرّ لا يدخل أي نسخة احتياطية.' },\n    { name: SECRET_NAMES.apiToken, cls: 'excluded',",
    done: 'SECRET_NAMES.aiSettings' },
]);

// package.json: تعديل عبر JSON للحفاظ على سلامته.
try {
  const raw = fs.readFileSync('package.json', 'utf8');
  const crlf = raw.includes('\r\n');
  const data = JSON.parse(raw);
  const cmd = 'tsx --tsconfig tests/tsconfig.json --test tests/ai-foundation.test.ts';
  if (data.scripts && data.scripts['test:ai-foundation'] === cmd) {
    console.log('  · سبق تطبيقه: package.json [script]');
  } else {
    data.scripts = data.scripts || {};
    data.scripts['test:ai-foundation'] = cmd;
    fs.copyFileSync('package.json', 'package.json.bak_' + TS);
    let out = JSON.stringify(data, null, 2) + (raw.endsWith('\n') ? '\n' : '');
    if (crlf) out = out.replace(/\n/g, '\r\n');
    fs.writeFileSync('package.json', out, 'utf8');
    console.log('  ✔ package.json [script]');
  }
} catch (e) { console.log('  ✘ package.json: ' + e.message); failed = true; }

process.exit(failed ? 1 : 0);

SCD_PATCH_JS
TS="$TS" node "$PATCH_FILE" || { rm -f "$PATCH_FILE"; die "فشل تعديل الملفات. لم يُمسّ أي ملف فشل تعديله؛ راجع الرسالة أعلاه."; }
rm -f "$PATCH_FILE"

say "التحقق"
node -e "
const fs=require('fs');
const need={
 'src/security/permissions.ts':[\"'ai.manage'\",\"'ai.use'\"],
 'src/modules/audit/audit-labels.ts':['ai_request','ai_settings_change'],
 'src/app/(tabs)/settings.tsx':['/ai-settings','Sparkles'],
 'src/modules/backup/backup-types.ts':['securecase_ai_settings_v1'],
 'package.json':['test:ai-foundation'],
};
let bad=0;
for(const [f,ms] of Object.entries(need)){const s=fs.readFileSync(f,'utf8');for(const m of ms){if(!s.includes(m)){console.log('  ✘ ناقص في '+f+': '+m);bad++;}}}
process.exit(bad?1:0);
" && ok "كل التعديلات موجودة" || die "تعديل ناقص — لا تتابع للقسم التالي."

say "تشغيل اختبارات 11.1"
TEST_LOG="$(mktemp)"
if npm run --silent test:ai-foundation >"$TEST_LOG" 2>&1; then
  TEST_OK=1; grep -E '^# (tests|pass|fail)' "$TEST_LOG" || true; ok "اختبارات الذكاء الاصطناعي ناجحة"
else
  TEST_OK=0; tail -n 25 "$TEST_LOG"
  warn "فشلت اختبارات الذكاء الاصطناعي (ربما node_modules غير مثبّتة: شغّل npm install ثم أعد التشغيل)."
fi
rm -f "$TEST_LOG"

say "إعادة اختبارات النسخ الاحتياطي (التحقق من عدم كسر المرحلة 10)"
BK_OK=1
for t in test:backup-foundation test:backup-snapshot test:backup-package; do
  if npm run --silent "$t" >/dev/null 2>&1; then ok "$t"; else BK_OK=0; warn "$t فشل أو تعذّر تشغيله"; fi
done

say "فحص الأنواع (tsc)"
TSC_LOG="$(mktemp)"
if npx --no-install tsc --noEmit >"$TSC_LOG" 2>&1; then
  ok "tsc: لا أخطاء"
else
  AI_ERRS="$(grep -E 'src/modules/ai/|src/app/ai-settings|tests/ai-foundation|src/security/permissions|audit-labels|backup-types|backup-inventory|\(tabs\)/settings' "$TSC_LOG" || true)"
  if [ -n "$AI_ERRS" ]; then
    warn "أخطاء tsc في ملفات لها علاقة بالقسم 11.1:"; echo "$AI_ERRS" | head -n 30
  else
    ok "لا أخطاء tsc في ملفات 11.1 (قد توجد أخطاء سابقة في ملفات أخرى: $(grep -c 'error TS' "$TSC_LOG") خطأ إجمالاً)"
  fi
fi
rm -f "$TSC_LOG"

say "الخلاصة"
echo "  الملفات الجديدة: src/modules/ai/*  src/app/ai-settings.tsx  tests/ai-foundation.test.ts  docs/phase11/11.1-ai-foundation.md"
echo "  النسخ الاحتياطية للملفات المعدَّلة: *.bak_$TS (مُتجاهَلة في git)"
echo "  لم يُختبر على جهاز Android حقيقي بعد. الذكاء الاصطناعي معطّل افتراضياً ولا توجد أي ميزة منفَّذة (هذا القسم بنية فقط)."
[ "$TEST_OK" = 1 ] && [ "$BK_OK" = 1 ] || { warn "توجد اختبارات لم تنجح — راجعها قبل الانتقال إلى 11.2."; exit 2; }
ok "اكتمل 11.1"
