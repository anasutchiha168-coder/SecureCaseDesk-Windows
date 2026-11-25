// SECURECASEDESK_REGISTER_EXPORT
// بيانات «معلومية السجناء» و«كشف المحتجزين اليومي» للتصدير (Excel / PDF). دوال نقية قابلة للاختبار في Node.
// الأعمدة تطابق ورقة «معلومية السجناء الاساسية» في ملف Excel المعتمد (26 عموداً).

import type { DbLike } from '../attachments/attachments-repo';
import { STATUS_HELD } from './detainees-constants';

export interface RegisterRow {
  serial: number;               // م (تسلسل في الملف المُصدَّر)
  name: string;                 // الاسم الرباعي مع اللقب
  age: string;
  idType: string;
  idNumber: string;
  phone: string;
  governorate: string;
  district: string;
  subDistrict: string;          // العزلة
  residence: string;            // السكن الحالي
  occupation: string;           // العمل
  offense: string;              // القضية
  caseRole: string;             // صفة السجين في القضية
  reportNumber: string;         // رقم البلاغ
  authority: string;            // جهة الإيداع
  admission: number;            // تاريخ الإيداع
  legalStatus: string;          // وضع السجين
  referral: number | null;      // تاريخ إحالة الملف إلى النيابة
  place: string;                // مكان الاحتجاز أو السجن
  exitDate: number | null;      // تاريخ الخروج
  exitType: string;             // نوع الخروج من السجن
  exitProcedure: string;        // إجراءات الخروج
  exitSource: string;           // مصدر التوجيه بالخروج
  fate: 'سجين' | 'خروج';        // مصير السجين النهائي بعد الإحالة (مشتق من الحالة)
  notes: string;                // ملاحظة
  days: number;                 // عدد أيام الحجز
  classification: string;       // التبويب الفرعي للتصنيف القانوني (للإحصاء)
}

export const FATE_HELD: RegisterRow['fate'] = 'سجين';
export const FATE_EXIT: RegisterRow['fate'] = 'خروج';

interface DbRow {
  id: string; full_name: string; age_at_admission: number | null; id_type: string | null; id_number: string | null; phone: string | null;
  governorate: string | null; district: string | null; sub_district: string | null; current_residence: string | null; occupation: string | null;
  alleged_offense: string; case_role: string | null; report_number: string | null; detaining_authority: string | null;
  admission_date: number; legal_status: string | null; prosecution_referral_date: number | null; place_of_detention: string | null;
  release_date: number | null; exit_type: string | null; exit_procedure: string | null; exit_directive_source: string | null;
  status: string; notes: string | null; sub_category: string | null;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const DAY = 86400000;

// أيام تقويمية (يوم الدخول لا يُحسب، ونفس اليوم = 0) بالتوقيت المحلي، كما في v_detention_periods.
export function calendarDays(fromTs: number, toTs: number): number {
  const a = new Date(fromTs); const b = new Date(toTs);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((db - da) / DAY));
}

export async function loadRegisterRows(db: DbLike, now: number): Promise<RegisterRow[]> {
  const rows = await db.getAllAsync<DbRow>(
    `SELECT d.id, d.full_name, d.age_at_admission, p.id_type, p.id_number, p.phone, p.governorate, p.district, p.sub_district,
            p.current_residence, p.occupation, d.alleged_offense, d.case_role, d.report_number, d.detaining_authority,
            d.admission_date, d.legal_status, d.prosecution_referral_date, d.place_of_detention, d.release_date, d.exit_type,
            d.exit_procedure, d.exit_directive_source, d.status, d.notes, k.sub_category
       FROM detainees d
       LEFT JOIN persons p ON p.id = d.person_id
       LEFT JOIN crime_classifications k ON k.id = d.classification_id
      ORDER BY d.admission_date ASC, d.created_at ASC, d.id ASC`,
    []
  );
  return rows.map((r, i): RegisterRow => {
    const held = r.status === STATUS_HELD && r.release_date === null;
    return {
      serial: i + 1,
      name: s(r.full_name), age: r.age_at_admission ? String(r.age_at_admission) : '',
      idType: s(r.id_type), idNumber: s(r.id_number), phone: s(r.phone),
      governorate: s(r.governorate), district: s(r.district), subDistrict: s(r.sub_district),
      residence: s(r.current_residence), occupation: s(r.occupation),
      offense: s(r.alleged_offense), caseRole: s(r.case_role), reportNumber: s(r.report_number),
      authority: s(r.detaining_authority), admission: r.admission_date, legalStatus: s(r.legal_status),
      referral: r.prosecution_referral_date ?? null, place: s(r.place_of_detention),
      exitDate: r.release_date ?? null, exitType: s(r.exit_type), exitProcedure: s(r.exit_procedure), exitSource: s(r.exit_directive_source),
      fate: held ? FATE_HELD : FATE_EXIT, notes: s(r.notes),
      days: calendarDays(r.admission_date, r.release_date ?? now),
      classification: s(r.sub_category),
    };
  });
}

// ===== التاريخ الهجري (أم القرى عبر Intl إن توفر، وإلا الحساب الجدولي) =====
const WEEKDAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export const weekdayName = (ts: number) => WEEKDAYS[new Date(ts).getDay()];
const p2 = (n: number) => String(n).padStart(2, '0');

export interface DateParts3 { y: number; m: number; d: number }

function tabularHijri(y: number, m: number, d: number): DateParts3 {
  const jd = Math.floor((1461 * (y + 4800 + Math.floor((m - 14) / 12))) / 4) +
    Math.floor((367 * (m - 2 - 12 * Math.floor((m - 14) / 12))) / 12) -
    Math.floor((3 * Math.floor((y + 4900 + Math.floor((m - 14) / 12)) / 100)) / 4) + d - 32075;
  let l = jd - 1948440 + 10632;
  const n = Math.floor((l - 1) / 10631);
  l = l - 10631 * n + 354;
  const j = Math.floor((10985 - l) / 5316) * Math.floor((50 * l) / 17719) + Math.floor(l / 5670) * Math.floor((43 * l) / 15238);
  l = l - Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50) - Math.floor(j / 16) * Math.floor((15238 * j) / 43) + 29;
  const mm = Math.floor((24 * l) / 709);
  const dd = l - Math.floor((709 * mm) / 24);
  return { y: 30 * n + j - 30, m: mm, d: dd };
}

export function hijriParts(ts: number): DateParts3 {
  const dt = new Date(ts);
  try {
    const f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
    // نمرّر منتصف اليوم المحلي كـ UTC كي لا يتغير اليوم بفارق التوقيت.
    const parts = f.formatToParts(new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate(), 12)));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const y = get('year'); const m = get('month'); const d = get('day');
    if (y > 1300 && y < 1700 && m >= 1 && m <= 12 && d >= 1 && d <= 30) return { y, m, d };
  } catch { /* Intl بلا تقويم هجري */ }
  return tabularHijri(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

export function fmtHijri(ts: number | null | undefined, sep = '/'): string {
  if (!ts) return '';
  const h = hijriParts(ts);
  return p2(h.d) + sep + p2(h.m) + sep + h.y;
}
export function fmtHijriYmd(ts: number): string {
  const h = hijriParts(ts);
  return h.y + '/' + p2(h.m) + '/' + p2(h.d);
}
export function fmtDMY(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear();
}

// رقم تسلسلي لـ Excel (أيام منذ 1899-12-30) للتاريخ التقويمي المحلي.
export function excelSerial(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY + 25569;
}

// ===== كشف اليوم =====
export const startOfDayTs = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const endOfDayTs = (ts: number) => { const d = new Date(ts); d.setHours(23, 59, 59, 999); return d.getTime(); };

export interface DaySummary {
  previous: number;                         // العدد السابق: المحتجزون عند بداية اليوم
  entries: number;                          // الدخول خلال اليوم
  exits: number;                            // الإفراج/الخروج خلال اليوم
  remaining: number;                        // المتبقي في نهاية اليوم
  byLegalStatus: [string, number][];
  byAuthority: [string, number][];
  byClassification: [string, number][];
  byDistrict: [string, number][];
}
export interface DayGroup { authority: string; rows: RegisterRow[] }
export interface DayRegister { day: number; groups: DayGroup[]; summary: DaySummary; total: number }

function tally(values: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const v of values) { const k = v.trim() || 'غير مبين'; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ar'));
}

export function isHeldAt(r: RegisterRow, ts: number): boolean {
  return r.admission <= ts && (r.exitDate === null || r.exitDate > ts);
}

export function buildDayRegister(all: readonly RegisterRow[], day: number): DayRegister {
  const start = startOfDayTs(day); const end = endOfDayTs(day);
  // يظهر في الكشف: كل من كان محتجزاً في أي لحظة من اليوم (المتبقون + من خرجوا في اليوم نفسه).
  const listed = all.filter((r) => r.admission <= end && (r.exitDate === null || r.exitDate >= start));
  const groupsMap = new Map<string, RegisterRow[]>();
  for (const r of listed) {
    const k = r.authority.trim() || 'غير محدد';
    (groupsMap.get(k) ?? groupsMap.set(k, []).get(k)!).push(r);
  }
  const groups: DayGroup[] = [...groupsMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'ar'))
    .map(([authority, rows]) => ({ authority, rows: rows.slice().sort((x, y) => x.admission - y.admission || x.serial - y.serial) }));
  const remainingRows = all.filter((r) => isHeldAt(r, end));
  const summary: DaySummary = {
    previous: all.filter((r) => isHeldAt(r, start - 1)).length,
    entries: all.filter((r) => r.admission >= start && r.admission <= end).length,
    exits: all.filter((r) => r.exitDate !== null && r.exitDate >= start && r.exitDate <= end).length,
    remaining: remainingRows.length,
    byLegalStatus: tally(remainingRows.map((r) => r.legalStatus)),
    byAuthority: tally(remainingRows.map((r) => r.authority)),
    byClassification: tally(remainingRows.map((r) => r.classification)),
    byDistrict: tally(remainingRows.map((r) => r.district)),
  };
  return { day, groups, summary, total: listed.length };
}

// يوم الحركة (الدخول/الخروج) لورقة «الدخول والخروج».
export function movementsOfDay(all: readonly RegisterRow[], day: number): RegisterRow[] {
  const start = startOfDayTs(day); const end = endOfDayTs(day);
  return all.filter((r) => (r.admission >= start && r.admission <= end) || (r.exitDate !== null && r.exitDate >= start && r.exitDate <= end));
}
