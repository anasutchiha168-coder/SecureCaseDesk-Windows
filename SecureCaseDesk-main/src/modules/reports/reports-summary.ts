// SECURECASEDESK_REPORT_SUMMARY
// تلخيص التقارير. نقي (بلا Expo) ليُختبر في Node.
//  1) الملخص الآلي: قواعد ثابتة تحسب الجمل من بيانات التقرير نفسه دون أي ذكاء اصطناعي ودون أي معلومة من خارجه.
//  2) حمولة الذكاء الاصطناعي: «خلاصة إحصائية» فقط (أرقام وتوزيعات)، لا صفوف سجلات ولا أسماء أشخاص:
//     أسماء المحتجزين والمتهمين والمشتكين وأسماء الموظفين لا تدخلها أصلاً. ما يُعرض للمستخدم قبل أي إرسال هو الحمولة نفسها.

import type { ReportDocument, ReportKind, ReportSection, ReportSummaryOption } from './reports-types';

export const SUMMARY_MAX_CHARS = 6000;
export const AUTO_SUMMARY_HEADING = 'ملخص آلي';
export const AI_SUMMARY_HEADING = 'ملخص بالذكاء الاصطناعي (راجعه المستخدم واعتمده)';

type Table = Extract<ReportSection, { type: 'table' }>;
type Kv = Extract<ReportSection, { type: 'kv' }>;

const isGroupTable = (s: ReportSection): boolean => s.type === 'table' && s.columns.length === 2 && s.columns[1] === 'العدد';
const toNum = (v: string): number | null => {
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return String(v).trim() !== '' && Number.isFinite(n) && /\d/.test(v) ? n : null;
};
const clip = (v: string, n = 70) => (v.length > n ? v.slice(0, n - 1) + '…' : v);
const kvVal = (s: Kv | undefined, label: string): string | null => s?.rows.find((r) => r.label === label)?.value ?? null;

function dateRange(t: Table): { min: string; max: string } | null {
  const ci = t.columns.findIndex((c) => c.includes('التاريخ'));
  if (ci < 0) return null;
  const ds = t.rows.map((r) => r[ci]).filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d)).map((d) => d.slice(0, 10)).sort();
  return ds.length ? { min: ds[0], max: ds[ds.length - 1] } : null;
}

function durationStats(t: Table): { max: number; avg: number } | null {
  const ci = t.columns.findIndex((c) => c.startsWith('المدة'));
  if (ci < 0) return null;
  const ns = t.rows.map((r) => toNum(r[ci])).filter((n): n is number => n !== null);
  return ns.length ? { max: Math.max(...ns), avg: Math.round(ns.reduce((a, b) => a + b, 0) / ns.length) } : null;
}

function distribution(t: Table, top = 4): string {
  const total = t.rows.reduce((a, r) => a + (toNum(r[1]) ?? 0), 0);
  return t.rows.slice(0, top).map((r) => {
    const n = toNum(r[1]) ?? 0;
    return r[0] + ' (' + n + (total > 0 ? ' — ' + Math.round((n / total) * 100) + '٪' : '') + ')';
  }).join('، ') + (t.rows.length > top ? '، وغيرها (' + (t.rows.length - top) + ')' : '');
}

// ================= الملخص الآلي =================
export function buildAutoSummaryLines(doc: ReportDocument): string[] {
  const L: string[] = [];
  const kvs = doc.sections.filter((s): s is Kv => s.type === 'kv');
  const tables = doc.sections.filter((s): s is Table => s.type === 'table');

  if (doc.kind === 'case_file') {
    const k = kvs[0];
    L.push('القضية رقم ' + (kvVal(k, 'رقم القضية') ?? '—') + ' من نوع «' + (kvVal(k, 'نوع القضية') ?? '—') + '»، حالتها الحالية: ' + (kvVal(k, 'الحالة') ?? '—') +
      '، سُجّلت بتاريخ ' + (kvVal(k, 'تاريخ التسجيل') ?? '—') + ' لدى ' + (kvVal(k, 'القسم المختص') ?? '—') + '.');
    for (const t of tables) {
      if (t.heading === 'المذكرات المرتبطة') L.push(t.rows.length ? 'يرتبط بالقضية ' + t.rows.length + ' مذكرة، آخرها بتاريخ ' + (dateRange(t)?.max ?? '—') + '.' : 'لا توجد مذكرات مرتبطة بالقضية.');
      if (t.heading === 'المرفقات') L.push(t.rows.length ? 'يوجد ' + t.rows.length + ' مرفق فعّال في ملف القضية.' : 'لا توجد مرفقات في ملف القضية.');
    }
  } else {
    L.push('يعرض هذا التقرير «' + doc.title + '» (' + doc.filtersText + ').');
    for (const k of kvs) {
      const rows = k.rows.slice(0, 8).map((r) => r.label + ': ' + clip(r.value, 40));
      if (rows.length) L.push((k.heading ? k.heading + ' — ' : '') + rows.join('، ') + '.');
    }
    for (const t of tables) {
      if (isGroupTable(t)) {
        if (t.rows.length) L.push('توزيع «' + (t.heading ?? t.columns[0]) + '»: ' + distribution(t) + '.');
        continue;
      }
      if (!t.rows.length) { L.push((t.heading ?? 'الجدول') + ': ' + (t.emptyText ?? 'لا توجد بيانات.')); continue; }
      let line = (t.heading ?? 'الجدول') + ': ' + t.rows.length + ' سجل';
      const dr = dateRange(t); if (dr) line += '، تمتد التواريخ من ' + dr.min + ' إلى ' + dr.max;
      const ds = durationStats(t); if (ds) line += '، أطول مدة ' + ds.max + ' يوماً ومتوسطها ' + ds.avg + ' يوماً';
      L.push(line + '.');
    }
  }
  L.push('أُعدّ هذا الملخص آلياً بقواعد ثابتة من بيانات التقرير نفسه، دون ذكاء اصطناعي ودون أي معلومة من خارجه.');
  return L;
}

export function buildAutoSummaryText(doc: ReportDocument): string {
  return buildAutoSummaryLines(doc).map((l) => '• ' + l).join('\n');
}

// ================= إدراج الملخص في المستند =================
export function sanitizeSummaryText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/\r/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length < 5) return null;
  return t.length > SUMMARY_MAX_CHARS ? t.slice(0, SUMMARY_MAX_CHARS) : t;
}

// يضع الملخص في أول المستند. يعيد مستنداً جديداً دون تعديل الأصل. يرمي 'SUMMARY_INVALID' عبر null عند نص ذكاء فارغ.
export function applyReportSummary(doc: ReportDocument, opt: ReportSummaryOption | undefined): ReportDocument | null {
  if (!opt || opt.mode === 'none') return doc;
  if (opt.mode === 'auto') {
    return { ...doc, sections: [{ type: 'text', heading: AUTO_SUMMARY_HEADING, text: buildAutoSummaryText(doc) }, ...doc.sections] };
  }
  const t = sanitizeSummaryText(opt.text);
  if (!t) return null;
  return { ...doc, sections: [{ type: 'text', heading: AI_SUMMARY_HEADING, text: t }, ...doc.sections] };
}

// ================= حمولة الذكاء الاصطناعي (خلاصة إحصائية بلا أسماء) =================
const WITHHELD_KV = new Set(['المشتكي / المجني عليه', 'المتهمون والأطراف', 'سجّلها', 'الضابط المسؤول', 'مكان الحادثة']);
const WITHHELD_GROUP_COLUMNS = new Set(['المستخدم', 'الضابط المسؤول']);
const CATEGORICAL_COLUMNS = new Set(['الحالة', 'النوع', 'القسم', 'الفئة', 'جهة الحجز', 'العملية', 'الجهة', 'نوع الحركة', 'نوع المذكرة']);

export interface AiDigest { text: string; withheldFields: string[]; recordsSummarized: number }

export function buildAiDigest(doc: ReportDocument): AiDigest {
  const withheld = new Set<string>();
  const L: string[] = ['نوع التقرير: ' + doc.title, 'النطاق: ' + doc.filtersText];
  let records = 0;
  for (const s of doc.sections) {
    if (s.type === 'text') continue; // تفاصيل نصية حرة (مثل وصف الحادثة) لا تدخل الخلاصة
    L.push('', '## ' + (s.heading ?? 'بيانات'));
    if (s.type === 'kv') {
      for (const r of s.rows) {
        if (WITHHELD_KV.has(r.label)) { withheld.add(r.label); continue; }
        L.push('- ' + r.label + ': ' + clip(r.value, 80));
      }
      continue;
    }
    if (isGroupTable(s)) {
      if (WITHHELD_GROUP_COLUMNS.has(s.columns[0])) { withheld.add(s.columns[0]); L.push('- (محجوب: يتضمن أسماء موظفين) عدد الفئات: ' + s.rows.length); continue; }
      for (const r of s.rows.slice(0, 20)) L.push('- ' + r[0] + ': ' + r[1]);
      continue;
    }
    // جدول سجلات: العدد + توزيعات الأعمدة التصنيفية + نطاق التواريخ + المدد فقط. لا قيم خلايا أخرى.
    records += s.rows.length;
    L.push('- عدد السجلات: ' + s.rows.length);
    const hiddenCols = s.columns.filter((c) => !CATEGORICAL_COLUMNS.has(c) && !c.includes('التاريخ') && !c.startsWith('المدة'));
    hiddenCols.forEach((c) => withheld.add(c));
    s.columns.forEach((c, ci) => {
      if (!CATEGORICAL_COLUMNS.has(c)) return;
      const m = new Map<string, number>();
      for (const r of s.rows) m.set(r[ci], (m.get(r[ci]) ?? 0) + 1);
      const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ' (' + v + ')');
      if (top.length) L.push('- توزيع ' + c + ': ' + top.join('، '));
    });
    const dr = dateRange(s); if (dr) L.push('- نطاق التواريخ: من ' + dr.min + ' إلى ' + dr.max);
    const ds = durationStats(s); if (ds) L.push('- المدة بالأيام: الأطول ' + ds.max + '، المتوسط ' + ds.avg);
  }
  const text = L.join('\n').replace(/<<<|>>>/g, ' ').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
  return { text, withheldFields: [...withheld], recordsSummarized: records };
}

// أنواع السجلات التي تمسّها الخلاصة (لفحص الصلاحيات وسياسة الخصوصية: المحتجزون لا يغادرون الجهاز).
export type DigestEntity = 'case' | 'memo' | 'detainee';
export function digestEntities(doc: ReportDocument): DigestEntity[] {
  const byKind: Partial<Record<ReportKind, DigestEntity[]>> = {
    case_file: ['case', 'memo'], cases_list: ['case'], memos_list: ['memo'],
    detainees_current: ['detainee'], detainees_admissions_releases: ['detainee'], detainees_stats: ['detainee'],
    detainee_movements: ['detainee'], correction_history: ['detainee'], operations: [],
  };
  if (doc.kind !== 'admin_summary') return byKind[doc.kind] ?? [];
  const heads = doc.sections.map((s) => s.heading ?? '');
  const out: DigestEntity[] = [];
  if (heads.some((h) => h.includes('القضايا') || h === 'أداء الأقسام')) out.push('case');
  if (heads.some((h) => h.includes('المذكرات'))) out.push('memo');
  if (heads.some((h) => h.includes('المحتجزون') || h.includes('الحاليون حسب الفئة'))) out.push('detainee');
  return out;
}
