// SECURECASEDESK_PHASE11_S5
// فحص الخصوصية والصلاحيات للذكاء الاصطناعي: دالة نقية تحوّل حالة الإعدادات الحالية + حقائق التصميم إلى تقرير صريح.
// لا تتصل بشبكة ولا تقرأ أسراراً ولا تكتب شيئاً. «ok» لا تعني ضماناً مطلقاً: هي فحص لما يمكن التحقق منه محلياً فقط.

import { ROLES, can, type Role } from '../../security/permissions';
import type { SecretSpec } from '../backup/backup-types';
import { CLOUD_BLOCKED_ENTITIES, ENTITY_READ_PERMISSION } from './ai-policy';
import { AI_FEATURES, AI_MANAGE_PERMISSION, AI_USE_PERMISSION, type AiFeatureId, type AiMode } from './ai-types';

export type FindingLevel = 'ok' | 'warn' | 'fail';

export interface PrivacyFinding {
  id: string;
  level: FindingLevel;
  title: string;
  detail: string;
}

export interface PrivacyState {
  mode: AiMode;
  features: Record<AiFeatureId, boolean>;
  cloud: { endpoint: string | null; model: string | null; hasKey: boolean; consentValid: boolean };
  settingsRecovered: boolean;
}

export interface PrivacyInputs {
  state: PrivacyState;
  backupSecretSpecs: readonly SecretSpec[];
}

export interface PrivacyReport {
  overall: FindingLevel;
  findings: PrivacyFinding[];
  counts: { ok: number; warn: number; fail: number };
}

const AI_SECRET_FILE_NAMES = ['securecase_ai_settings_v1', 'securecase_ai_cloud_key_v1'] as const;

export function buildPrivacyReport(input: PrivacyInputs): PrivacyReport {
  const { state } = input;
  const f: PrivacyFinding[] = [];
  const add = (id: string, level: FindingLevel, title: string, detail: string) => f.push({ id, level, title, detail });

  // 1) الوضع الحالي وأين تذهب البيانات
  if (state.mode === 'disabled') {
    add('mode', 'ok', 'الذكاء الاصطناعي معطّل', 'لا تُعالَج أي بيانات بالذكاء الاصطناعي ولا يخرج شيء من الجهاز. البدائل الآلية المحلية تعمل.');
  } else if (state.mode === 'local') {
    add('mode', 'ok', 'الوضع المحلي', 'كل المعالجة على الجهاز ولا إرسال خارجه. (المحرك المحلي غير مدمج في هذا الإصدار، فتعمل البدائل الآلية.)');
  } else {
    const enabled = AI_FEATURES.filter((x) => state.features[x.id]).map((x) => x.label);
    add('mode', 'warn', 'الوضع السحابي مفعّل',
      'نص ما تطلبه يُرسل إلى الخدمة السحابية بعد تأكيدك لكل طلب ومعاينتك للحمولة.' +
      (enabled.length ? ' الميزات المفعّلة: ' + enabled.join('، ') + '.' : ' لا ميزة مفعّلة حالياً.'));
    if (!state.cloud.endpoint || !state.cloud.model || !state.cloud.hasKey) {
      add('cloud-config', 'fail', 'إعداد سحابي ناقص', 'العنوان أو النموذج أو المفتاح غير مكتمل؛ لن يُرسل شيء حتى يكتمل.');
    } else if (!/^https:\/\//i.test(state.cloud.endpoint)) {
      add('cloud-https', 'fail', 'عنوان الخدمة ليس HTTPS', 'يجب أن يكون العنوان HTTPS حصراً.');
    } else {
      add('cloud-config', 'ok', 'إعداد سحابي مكتمل وبـ HTTPS', 'العنوان والنموذج والمفتاح موجودة، والمفتاح مخزَّن في المخزن الآمن للجهاز.');
    }
    if (state.cloud.consentValid) add('consent', 'ok', 'إقرار الإرسال ساريّ', 'الإقرار مرتبط بعنوان الخدمة الحالي وبإصدار النص الحالي.');
    else add('consent', 'fail', 'لا إقرار ساريّ', 'تغيّر العنوان أو إصدار الإقرار أو لم يُسجَّل إقرار؛ الإرسال السحابي مرفوض.');
  }

  // 2) ما لا يغادر الجهاز أبداً
  const blocked = new Set<string>(CLOUD_BLOCKED_ENTITIES);
  if (blocked.has('detainee') && blocked.has('attachment')) {
    add('blocked-entities', 'ok', 'بيانات المحتجزين والمرفقات ممنوعة سحابياً', 'تُرفض في الطبقة المركزية قبل أي إرسال، مهما كانت الإعدادات.');
  } else {
    add('blocked-entities', 'fail', 'سياسة المنع السحابي ناقصة', 'يجب منع المحتجزين والمرفقات من الإرسال السحابي.');
  }

  // 3) النسخ الاحتياطي لا يحمل أسرار الذكاء
  const byName = new Map(input.backupSecretSpecs.map((s) => [s.name, s.cls]));
  const leaking = AI_SECRET_FILE_NAMES.filter((n) => byName.get(n) !== 'excluded');
  if (leaking.length === 0) add('backup-secrets', 'ok', 'مفتاح الخدمة وإعدادات الذكاء خارج النسخ الاحتياطية', 'تُصنَّف «مستبعدة» ولا تدخل أي نسخة، وبعد الاستعادة يعود الذكاء معطّلاً.');
  else add('backup-secrets', 'fail', 'أسرار الذكاء غير مستبعدة من النسخ الاحتياطي', leaking.join('، '));

  // 4) مصفوفة الأدوار (حية من جدول الصلاحيات)
  const roles = ROLES.map((r) => r.key as Role);
  const dv = roles.includes('detention_viewer') ? 'detention_viewer' : null;
  if (dv && !can(dv, AI_USE_PERMISSION) && !can(dv, AI_MANAGE_PERMISSION) && !can(dv, ENTITY_READ_PERMISSION.case) && !can(dv, ENTITY_READ_PERMISSION.memo)) {
    add('role-detention-viewer', 'ok', 'مشاهد المحتجزين معزول عن الذكاء', 'لا يملك صلاحية استخدام الذكاء ولا قراءة القضايا والمذكرات.');
  } else {
    add('role-detention-viewer', 'fail', 'عزل مشاهد المحتجزين غير مكتمل', 'راجع جدول الصلاحيات.');
  }
  const managers = roles.filter((r) => can(r, AI_MANAGE_PERMISSION));
  if (managers.length === 1 && managers[0] === 'admin') add('role-manage', 'ok', 'إدارة الذكاء لمدير النظام وحده', 'الإعدادات والمفتاح والإقرار محصورة بصلاحية ai.manage.');
  else add('role-manage', 'warn', 'إدارة الذكاء ليست لمدير النظام وحده', 'الأدوار: ' + managers.join('، '));

  // 5) سلامة الإعدادات المخزَّنة
  if (state.settingsRecovered) add('settings-recovered', 'warn', 'أُعيدت الإعدادات إلى الافتراضي', 'كانت الإعدادات المخزَّنة تالفة أو غير مقروءة فعاد الذكاء معطّلاً (فشل مغلق). راجعها.');
  else add('settings-integrity', 'ok', 'الإعدادات المخزَّنة سليمة', 'قُرئت وتحقق منها دون أخطاء.');

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const x of f) counts[x.level]++;
  const overall: FindingLevel = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'ok';
  return { overall, findings: f, counts };
}
