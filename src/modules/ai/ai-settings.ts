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
