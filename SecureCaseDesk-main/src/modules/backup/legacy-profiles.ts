// SECURECASEDESK_PHASE10_S7
// سجل إصدارات قواعد البيانات القديمة المدعومة.
//
// ⚠️ فارغ عمداً: لا يوجد هنا أي افتراض عن مخطط القاعدة القديمة. المتطلب الخارجي المفقود هو
// ملف القاعدة القديمة الفعلي. بعد الحصول عليه:
//   1) شغّل inspectLegacyDatabase عليه لاستخراج الجداول والأعمدة وuser_version.
//   2) أضف هنا LegacyProfile واحداً لكل إصدار: detect (بالأعمدة لا بالأسماء فقط) و migrate
//      (يستخدم ctx.insertOnce لكل صف و ctx.resolveId لترجمة المفاتيح الأجنبية، بترتيب الجداول الأم أولاً).
//   3) اختبره على نسخة من القاعدة الفعلية قبل أي استعمال.
import type { LegacyProfile } from './legacy-migration';

export const LEGACY_PROFILES: LegacyProfile[] = [];
