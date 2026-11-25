// SECURECASEDESK_DETAINEES_V22_S4
// بناء مدخلات تسجيل الاحتجاز من قيم النموذج مع التحقق (دالة نقية بلا قاعدة بيانات، قابلة للاختبار).
import type { CreateDetentionInput } from './detainees-core';
import { NO_ID_TYPES } from './detainees-lists';

export interface DateParts { d: string; m: string; y: string }

export interface DetentionFormValues {
  fullName: string;
  refNumber: string;
  offense: string;
  authority: string;
  categoryId: string | null;
  admission: DateParts;
  idType: string | null;
  idNumber: string;
  phone: string;
  age: string;
  governorate: string;
  district: string;
  subDistrict: string;
  residence: string;
  occupation: string;
  caseRole: string | null;
  reportNumber: string;
  legalStatus: string | null;
  referral: DateParts;
  notes: string;
}

export type FormResult = { ok: true; input: CreateDetentionInput } | { ok: false; error: string };

const AR = '٠١٢٣٤٥٦٧٨٩';
const FA = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (c) => String(AR.indexOf(c)))
    .replace(/[۰-۹]/g, (c) => String(FA.indexOf(c)));
}

function parseDate(p: DateParts): number | null {
  const d = normalizeDigits(p.d.trim());
  const m = normalizeDigits(p.m.trim());
  const y = normalizeDigits(p.y.trim());
  if (!/^[0-9]{1,2}$/.test(d) || !/^[0-9]{1,2}$/.test(m) || !/^[0-9]{4}$/.test(y)) return null;
  const dd = Number(d), mm = Number(m), yy = Number(y);
  if (yy < 1900 || yy > 2100) return null;
  const dt = new Date(yy, mm - 1, dd);
  if (dt.getFullYear() !== yy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  return dt.getTime();
}

const isBlank = (p: DateParts) => !p.d.trim() && !p.m.trim() && !p.y.trim();
const fail = (error: string): FormResult => ({ ok: false, error });

export function buildDetentionInput(v: DetentionFormValues, now: number = Date.now()): FormResult {
  const name = v.fullName.trim();
  const ref = normalizeDigits(v.refNumber.trim());
  const alleged = v.offense.trim();
  if (!name) return fail('الاسم الكامل مطلوب');
  if (!ref) return fail('الرقم المرجعي مطلوب');
  if (!alleged) return fail('التهمة المنسوبة مطلوبة');
  if (!v.categoryId) return fail('اختر فئة المحتجز');

  const endToday = new Date(now);
  endToday.setHours(23, 59, 59, 999);
  const admission = parseDate(v.admission);
  if (admission === null) return fail('تاريخ الدخول غير صحيح، تأكد من اليوم والشهر والسنة');
  if (admission > endToday.getTime()) return fail('تاريخ الدخول لا يمكن أن يكون في المستقبل');

  let referral: number | null = null;
  if (!isBlank(v.referral)) {
    referral = parseDate(v.referral);
    if (referral === null) return fail('تاريخ إحالة الملف إلى النيابة غير صحيح');
    if (referral > endToday.getTime()) return fail('تاريخ الإحالة لا يمكن أن يكون في المستقبل');
    if (referral < new Date(new Date(admission).setHours(0, 0, 0, 0)).getTime()) {
      return fail('تاريخ الإحالة لا يسبق تاريخ الدخول');
    }
  }

  let age: number | null = null;
  const ageText = normalizeDigits(v.age.trim());
  if (ageText) {
    if (!/^[0-9]{1,3}$/.test(ageText) || Number(ageText) < 1 || Number(ageText) > 120) return fail('العمر غير صحيح');
    age = Number(ageText);
  }

  const phone = normalizeDigits(v.phone.replace(/[\s-]/g, ''));
  if (phone && !/^\+?[0-9]{6,15}$/.test(phone)) return fail('رقم الهاتف غير صحيح');

  const idNumber = normalizeDigits(v.idNumber.trim());
  if (idNumber && !v.idType) return fail('اختر نوع الهوية');
  if (v.idType && !NO_ID_TYPES.includes(v.idType) && !idNumber) return fail('رقم الهوية مطلوب للنوع المختار');

  return {
    ok: true,
    input: {
      fullName: name,
      referenceNumber: ref,
      allegedOffense: alleged,
      categoryId: v.categoryId,
      detainingAuthority: v.authority.trim(),
      admissionDate: admission,
      person: {
        id_type: v.idType, id_number: idNumber, phone,
        governorate: v.governorate, district: v.district, sub_district: v.subDistrict,
        current_residence: v.residence, occupation: v.occupation,
      },
      period: {
        age_at_admission: age, case_role: v.caseRole, report_number: normalizeDigits(v.reportNumber.trim()),
        legal_status: v.legalStatus, prosecution_referral_date: referral, notes: v.notes,
      },
    },
  };
}
