// SECURECASEDESK_REGISTER_EXPORT
// «كشف بأسماء السجناء المحجوزين والمفرج عنهم والمرسلين إلى النيابات» بصيغة PDF (HTML لـ expo-print) على نسق النموذج المعتمد:
// A4 أفقي، ترويسة الجمهورية اليمنية والشعار، جدول 17 عموداً (10 صفوف في الصفحة)، قسم/إدارة لكل جهة إيداع،
// وصفحة أخيرة بالإحصائيات. ترقيم الصفحات يُحسب هنا (لا يعتمد على @page counters التي لا يدعمها كل WebView).

import { escapeHtml as h } from '../reports/reports-format';
import { BISMILLAH_JPEG, REPUBLIC_TITLE_JPEG, EMBLEM_JPEG } from './register-assets';
import {
  fmtDMY, fmtHijri, fmtHijriYmd, weekdayName, type DayRegister, type RegisterRow,
} from './register-data';

export const REGISTER_ROWS_PER_PAGE = 10;
export const REGISTER_PDF_TITLE = 'كشف بأسماء السجناء المحجوزين والمفرج عنهم والمرسلين إلى النيابات';
export const REGISTER_ORG_LINES: readonly string[] = [
  'وزارة الداخلية', 'الإدارة العامة للبحث الجنائي', 'إدارة مباحث محافظة / حجة', 'قسم التسجيل الجنائي',
];

// الأعمدة من اليمين إلى اليسار كما في النموذج.
export const REGISTER_PDF_COLUMNS: readonly string[] = [
  'م', 'الاســـــــم الرباعــــــي', 'العمر', 'العمل', 'السكن الحالي', 'من أهالي محافظة', 'مديرية/عزلة', 'الحالة الاجتماعية',
  'تاريخ الدخول', 'مصدر التوجيه', 'التهمة', 'تاريخ الاحالة', 'رقم الاحالة', 'تاريخ البلاغ', 'رقم البلاغ', 'تاريخ الخروج', 'السبب',
];
const COL_PCT = [3, 15, 3.4, 4.6, 7, 6, 7, 5.4, 7, 7.4, 8.4, 6.6, 3.6, 6.4, 3.4, 6.4, 4.4]; // مجموعها 100

export function registerPdfCells(r: RegisterRow, n: number): string[] {
  return [
    String(n), r.name, r.age, r.occupation, r.residence, r.governorate,
    [r.district, r.subDistrict].filter(Boolean).join(' / '),
    '',                                   // الحالة الاجتماعية: لا حقل لها في المشروع بعد
    fmtDMY(r.admission), r.authority, r.offense,
    fmtDMY(r.referral),
    '',                                   // رقم الاحالة: لا حقل له
    '',                                   // تاريخ البلاغ: لا حقل له
    r.reportNumber || '0',
    fmtHijri(r.exitDate),                 // تاريخ الخروج بالهجري كما في النموذج
    r.exitProcedure || r.exitType,
  ];
}

const CSS = `
@page { size: A4 landscape; margin: 6mm 7mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { direction: rtl; text-align: right; font-family: 'Noto Naskh Arabic','Noto Sans Arabic','Droid Arabic Naskh','Cairo','Tahoma','Arial',sans-serif; color: #000; }
.page { width: 283mm; height: 196mm; display: flex; flex-direction: column; page-break-after: always; overflow: hidden; }
.page:last-child { page-break-after: auto; }
.hd { display: flex; align-items: flex-start; justify-content: space-between; height: 33mm; }
.hd .side { width: 62mm; }
.hd .mid { flex: 1; text-align: center; }
.hd .mid img.b { height: 9mm; display: block; margin: 0 auto 1mm; }
.hd .mid img.e { height: 20mm; display: block; margin: 0 auto; }
.hd .rt { text-align: center; }
.hd .rt img { height: 9.5mm; display: block; margin: 0 auto 1mm; }
.hd .rt div { font-size: 8.5pt; font-weight: 700; line-height: 1.35; }
h1 { margin: 1mm 0 0; font-size: 14pt; font-weight: 700; text-align: right; }
h2 { margin: 0 0 1.5mm; font-size: 14pt; font-weight: 700; text-align: center; }
table.t { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.t th { background: #dce6f1; border: 1px solid #555; font-size: 7pt; font-weight: 700; padding: 1mm 0.5mm; text-align: center; height: 9mm; }
table.t td { border: 1px solid #555; font-size: 7.2pt; padding: 0.6mm 0.8mm; text-align: center; vertical-align: middle; height: 12.4mm; overflow: hidden; word-break: break-word; line-height: 1.25; }
table.t td.r { text-align: right; }
.ft { margin-top: auto; text-align: center; font-size: 8pt; color: #444; padding-top: 2mm; }
.box { display: inline-block; vertical-align: top; margin: 0 0 3mm 3mm; width: 31mm; text-align: center; }
.box .l { background: #c6d9f1; border: 1px solid #555; border-bottom-width: 2px; font-size: 8pt; font-weight: 700; padding: 1mm 0.5mm; min-height: 9mm; display: flex; align-items: center; justify-content: center; }
.box .v { background: #fff; border: 1px solid #555; font-size: 10.5pt; font-weight: 700; padding: 1.2mm 0; }
.blk { margin: 0 0 2mm; }
.blk .tt { font-size: 9pt; font-weight: 700; margin: 0 0 1mm; color: #1f3864; }
`;

function chunk<T>(a: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

function header(day: number): string {
  return '<div class="hd">' +
    '<div class="rt side"><img src="' + REPUBLIC_TITLE_JPEG + '"/>' + REGISTER_ORG_LINES.map((l) => '<div>' + h(l) + '</div>').join('') + '</div>' +
    '<div class="mid"><img class="b" src="' + BISMILLAH_JPEG + '"/><img class="e" src="' + EMBLEM_JPEG + '"/></div>' +
    '<div class="side"></div></div>' +
    '<h1>' + h(REGISTER_PDF_TITLE + ' ليوم ' + weekdayName(day) + ' الموافق ' + fmtHijriYmd(day)) + '</h1>';
}

function tableHtml(rows: readonly RegisterRow[], startNo: number): string {
  const th = REGISTER_PDF_COLUMNS.map((c) => '<th>' + h(c) + '</th>').join('');
  const colgroup = '<colgroup>' + COL_PCT.map((p) => '<col style="width:' + p + '%"/>').join('') + '</colgroup>';
  const body = rows.map((r, i) => '<tr>' + registerPdfCells(r, startNo + i).map((c, ci) => '<td' + (ci === 1 || ci === 10 ? ' class="r"' : '') + '>' + h(c) + '</td>').join('') + '</tr>').join('');
  return '<table class="t">' + colgroup + '<thead><tr>' + th + '</tr></thead><tbody>' + body + '</tbody></table>';
}

const BOX_PER_ROW = 8;
const BLOCK_ROW_MM = 14;
const SUMMARY_FIRST_MM = 130;   // الارتفاع المتاح للصناديق بعد الترويسة وتذييل الصفحة

interface Block { html: string; mm: number }
function boxBlocks(title: string, items: readonly (readonly [string, number])[]): Block[] {
  const out: Block[] = [];
  // كتلة واحدة بحد أقصى 3 صفوف كي لا تتجاوز الصفحة؛ الزائد يكمل في كتلة تالية بنفس العنوان.
  for (const part of chunk(items, BOX_PER_ROW * 3)) {
    const rows = Math.ceil(part.length / BOX_PER_ROW);
    out.push({
      mm: rows * BLOCK_ROW_MM + 6,
      html: '<div class="blk"><div class="tt">' + h(title) + '</div>' +
        part.map(([l, v]) => '<div class="box"><div class="l">' + h(l) + '</div><div class="v">' + v + '</div></div>').join('') + '</div>',
    });
  }
  return out;
}

function summaryBlocks(s: DayRegister['summary']): Block[] {
  return [
    ...boxBlocks('الحركة اليومية', [['العدد السابق', s.previous], ['الدخـــول', s.entries], ['الافـــراج', s.exits], ['المتبقي', s.remaining]]),
    ...boxBlocks('حسب وضع السجين', s.byLegalStatus),
    ...boxBlocks('حسب جهة الإيداع', s.byAuthority),
    ...boxBlocks('حسب نوع القضية', s.byClassification),
    ...boxBlocks('حسب المديرية', s.byDistrict),
    ...boxBlocks('الإجمالي', [['الاجمالي', s.remaining]]),
  ];
}

function summaryPages(reg: DayRegister): string[] {
  const pages: string[] = []; let cur = ''; let used = 0;
  for (const b of summaryBlocks(reg.summary)) {
    if (used + b.mm > SUMMARY_FIRST_MM && cur) { pages.push(cur); cur = ''; used = 0; }
    cur += b.html; used += b.mm;
  }
  if (cur) pages.push(cur);
  return pages.map((c) => header(reg.day) + c);
}

export function renderRegisterHtml(reg: DayRegister): string {
  const pages: string[] = [];
  for (const g of reg.groups) {
    chunk(g.rows, REGISTER_ROWS_PER_PAGE).forEach((rows, ci) => {
      pages.push(header(reg.day) + '<h2>قســـم / إدارة ( ' + h(g.authority) + ' )</h2>' + tableHtml(rows, ci * REGISTER_ROWS_PER_PAGE + 1));
    });
  }
  pages.push(...summaryPages(reg));
  const total = pages.length;
  const body = pages.map((p, i) => '<div class="page">' + p + '<div class="ft">صفحة ' + (i + 1) + ' من ' + total + '</div></div>').join('');
  return '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/><title>' + h(REGISTER_PDF_TITLE) + '</title><style>' + CSS + '</style></head><body>' + body + '</body></html>';
}

export function registerPdfPageCount(reg: DayRegister): number {
  return reg.groups.reduce((n, g) => n + Math.ceil(g.rows.length / REGISTER_ROWS_PER_PAGE), 0) + summaryPages(reg).length;
}
