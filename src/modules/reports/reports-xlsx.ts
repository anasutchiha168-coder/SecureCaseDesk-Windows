// SECURECASEDESK_EXPORT_XLSX
// مولّد XLSX يدوي (OOXML) بلا اعتماديات: ورقة لكل قسم جدولي، الاتجاه من اليمين لليسار (rightToLeft)،
// نصوص مضمّنة (inlineStr) كي لا نحتاج sharedStrings. يعمل في React Native وNode بالكود نفسه.

import { Identity } from '../../constants/identity';
import type { ReportDocument, ReportSection } from './reports-types';
import { escapeXml as x, fmtDateTime } from './reports-format';
import { buildZip } from './reports-zip';

const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function colName(i: number): string {
  let n = i, s = '';
  do { s = COLS[n % 26] + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// صفوف الورقة: كل خلية { v, s } حيث s = رقم النمط (0 عادي، 1 عنوان عريض، 2 رأس جدول).
type Cell = { v: string; s: number };
type Row = Cell[];

function sheetXml(rows: Row[], widths: number[]): string {
  const cols = '<cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>';
  const data = rows.map((r, ri) =>
    '<row r="' + (ri + 1) + '">' + r.map((c, ci) =>
      '<c r="' + colName(ci) + (ri + 1) + '" t="inlineStr" s="' + c.s + '"><is><t xml:space="preserve">' + x(c.v) + '</t></is></c>').join('') + '</row>'
  ).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="18"/>' + cols +
    '<sheetData>' + data + '</sheetData></worksheet>';
}

// اسم ورقة صالح: بلا \ / ? * [ ] : وبحد أقصى 31 حرفاً، وفريد.
function sheetName(raw: string, used: Set<string>, fallback: string): string {
  let base = raw.replace(/[\\/?*\[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || fallback;
  let name = base, n = 2;
  while (used.has(name.toLowerCase())) { name = base.slice(0, 27) + ' ' + n++; }
  used.add(name.toLowerCase());
  return name;
}

function sectionRows(s: ReportSection): { rows: Row[]; widths: number[] } {
  if (s.type === 'kv') {
    return {
      rows: s.rows.map((r) => [{ v: r.label, s: 2 }, { v: r.value, s: 0 }]),
      widths: [30, 60],
    };
  }
  if (s.type === 'text') {
    return { rows: s.text.split('\n').map((l) => [{ v: l, s: 0 }]), widths: [100] };
  }
  const widths = s.columns.map(() => 22);
  const rows: Row[] = [s.columns.map((c) => ({ v: c, s: 2 }))];
  if (!s.rows.length) rows.push([{ v: s.emptyText ?? 'لا توجد بيانات.', s: 0 }]);
  else for (const r of s.rows) rows.push(r.map((c) => ({ v: c, s: 0 })));
  return { rows, widths };
}

export function renderReportXlsx(doc: ReportDocument): Uint8Array {
  const used = new Set<string>();
  const sheets: { name: string; xml: string }[] = [];

  // الورقة الأولى: ترويسة المستند + الأقسام غير الجدولية (kv/text) متتابعة.
  const head: Row[] = [
    [{ v: Identity.ministry, s: 1 }], [{ v: Identity.department, s: 1 }], [{ v: Identity.governorate, s: 1 }], [],
    [{ v: doc.title, s: 1 }],
    [{ v: 'رقم المستند', s: 2 }, { v: doc.documentNumber, s: 0 }],
    [{ v: 'التاريخ', s: 2 }, { v: fmtDateTime(doc.createdAt), s: 0 }],
    [{ v: 'أعدّه', s: 2 }, { v: doc.createdBy, s: 0 }],
    [{ v: 'الفلاتر', s: 2 }, { v: doc.filtersText, s: 0 }],
  ];
  const tables: { s: Extract<ReportSection, { type: 'table' }>; idx: number }[] = [];
  doc.sections.forEach((s, idx) => {
    if (s.type === 'table') { tables.push({ s, idx }); return; }
    head.push([]);
    if (s.heading) head.push([{ v: s.heading, s: 1 }]);
    head.push(...sectionRows(s).rows);
  });
  sheets.push({ name: sheetName('الملخص', used, 'Summary'), xml: sheetXml(head, [30, 60, 22]) });

  tables.forEach(({ s, idx }, i) => {
    const { rows, widths } = sectionRows(s);
    sheets.push({ name: sheetName(s.heading ?? 'جدول ' + (i + 1), used, 'Sheet' + (idx + 1)), xml: sheetXml(rows, widths) });
  });

  const n = sheets.length;
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
    '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((s, i) => '<sheet name="' + x(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>';
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
    '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
  // الأنماط: 0 عادي، 1 عنوان عريض كبير، 2 رأس جدول (عريض + خلفية رمادية + حدود).
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="3"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="13"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF888888"/></left><right style="thin"><color rgb="FF888888"/></right><top style="thin"><color rgb="FF888888"/></top><bottom style="thin"><color rgb="FF888888"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="top" wrapText="1" readingOrder="2"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" readingOrder="2"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top" wrapText="1" readingOrder="2"/></xf>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: styles },
    ...sheets.map((s, i) => ({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: s.xml })),
  ], new Date(doc.createdAt));
}
