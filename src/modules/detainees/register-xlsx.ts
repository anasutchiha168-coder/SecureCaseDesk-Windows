// SECURECASEDESK_REGISTER_EXPORT
// تصدير «معلومية السجناء» إلى Excel بنفس بنية الملف المعتمد: خمس أوراق (معلومية السجناء الاساسية، الدخول والخروج،
// التصنيفات القانونية للجرائم، تعليمات وقوانين، بيانات خاص) من اليمين لليسار، A3 أفقي، صف إحصائيات بمعادلات حيّة.
// مولّد OOXML يدوي بلا اعتماديات (نفس أسلوب reports-xlsx.ts) ويعمل في React Native وNode.

import { escapeXml as x } from '../reports/reports-format';
import { buildZip } from '../reports/reports-zip';
import { CLASSIFICATION_GROUPS } from './classifications-seed';
import { LEGAL_ARTICLES, DATA_GUIDELINES } from './detainees-instructions';
import { ID_TYPES, CASE_ROLES, LEGAL_STATUSES, EXIT_TYPES } from './detainees-lists';
import {
  FATE_HELD, FATE_EXIT, excelSerial, movementsOfDay, type RegisterRow,
} from './register-data';

export const REGISTER_SHEETS = {
  main: 'معلومية السجناء الاساسية',
  moves: 'الدخول والخروج',
  classes: 'التصنيفات القانونية للجرائم',
  rules: 'تعليمات وقوانين',
  lists: 'بيانات خاص',
} as const;

export const REGISTER_HEADERS: readonly string[] = [
  'م', 'الاسم الرباعي مع اللقب ', 'العمر', 'نوع الهوية', 'رقم الهوية', 'رقم الهاتف', 'المحافظة', 'المديرية', 'العزلة',
  ' السكن الحالي', 'العمل', 'القضية', 'صفة السجين في القضية', 'رقم البلاغ', 'جهة الايداع', 'تاريخ الايداع', 'وضع السجين',
  'تاريخ احالة الملف الى النيابة', 'مكان الاحتجاز او السجن', 'تاريخ الخروج', 'نوع الخروج من السجن', 'إجراءات الخروج',
  'مصدر التوجيه بالخروج', 'مصير السجين النهائي بعد الإحالة', 'ملاحظة', 'عدد ايام الحجز',
];
const MAIN_WIDTHS = [7.7, 24.5, 6.7, 9.2, 15.9, 14.7, 8.6, 8.2, 8.8, 8.2, 7.8, 16.9, 9.2, 9.8, 11.9, 11.4, 14.8, 12.6, 21.7, 12.5, 15.2, 17.4, 12.9, 10.5, 9.2, 8.1];

const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const colName = (i: number) => COLS[i];

// أنماط الخلايا (فهرس cellXfs)
const ST = { body: 0, head: 1, date: 2, statTitle: 3, statValue: 4, banner: 5, title: 6, bodyC: 7 } as const;

type Cell = { t: 's' | 'n' | 'f'; v: string | number; s: number; f?: string };
const str = (v: string, s: number = ST.body): Cell => ({ t: 's', v, s });
const num = (v: number, s: number = ST.body): Cell => ({ t: 'n', v, s });
const date = (ts: number | null): Cell | null => (ts ? { t: 'n', v: excelSerial(ts), s: ST.date } : null);

function cellXml(ref: string, c: Cell | null | undefined, fallbackStyle: number): string {
  if (!c) return '<c r="' + ref + '" s="' + fallbackStyle + '"/>';
  if (c.t === 's') return c.v === '' ? '<c r="' + ref + '" s="' + c.s + '"/>' : '<c r="' + ref + '" s="' + c.s + '" t="inlineStr"><is><t xml:space="preserve">' + x(c.v) + '</t></is></c>';
  if (c.t === 'f') return '<c r="' + ref + '" s="' + c.s + '"><f>' + x(c.f ?? '') + '</f><v>' + c.v + '</v></c>';
  return '<c r="' + ref + '" s="' + c.s + '"><v>' + c.v + '</v></c>';
}

interface SheetSpec {
  rows: (Cell | null)[][];
  widths: number[];
  merges?: string[];
  heights?: Record<number, number>;
  freezeRow?: number;                 // عدد الصفوف المجمّدة
  filter?: string;                    // نطاق الفلتر التلقائي
  printTitleRow?: number;
  landscape?: boolean;
  paper?: number;                     // 8 = A3
  rtl?: boolean;
}

function sheetXml(sp: SheetSpec): string {
  const cols = '<cols>' + sp.widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>';
  const data = sp.rows.map((r, ri) => {
    const h = sp.heights?.[ri + 1];
    return '<row r="' + (ri + 1) + '"' + (h ? ' ht="' + h + '" customHeight="1"' : '') + '>' +
      r.map((c, ci) => cellXml(colName(ci) + (ri + 1), c, ST.body)).join('') + '</row>';
  }).join('');
  const pane = sp.freezeRow
    ? '<pane ySplit="' + sp.freezeRow + '" topLeftCell="A' + (sp.freezeRow + 1) + '" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>'
    : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    '<sheetViews><sheetView ' + (sp.rtl === false ? '' : 'rightToLeft="1" ') + 'workbookViewId="0">' + pane + '</sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' + cols +
    '<sheetData>' + data + '</sheetData>' +
    (sp.filter ? '<autoFilter ref="' + sp.filter + '"/>' : '') +
    (sp.merges?.length ? '<mergeCells count="' + sp.merges.length + '">' + sp.merges.map((m) => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' : '') +
    '<pageMargins left="0.2" right="0.2" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>' +
    '<pageSetup paperSize="' + (sp.paper ?? 9) + '" orientation="' + (sp.landscape === false ? 'portrait' : 'landscape') + '" fitToWidth="1" fitToHeight="0"/>' +
    '</worksheet>';
}

// صف بيانات واحد (26 خلية).
function dataRow(r: RegisterRow, i: number): (Cell | null)[] {
  return [
    num(i + 1), str(r.name), str(r.age), str(r.idType), str(r.idNumber), str(r.phone), str(r.governorate), str(r.district), str(r.subDistrict),
    str(r.residence), str(r.occupation), str(r.offense), str(r.caseRole), str(r.reportNumber), str(r.authority), date(r.admission), str(r.legalStatus),
    date(r.referral), str(r.place), date(r.exitDate), str(r.exitType), str(r.exitProcedure), str(r.exitSource), str(r.fate), str(r.notes), num(r.days),
  ];
}

// عدّ يطابق COUNTIF/COUNTIFS في Excel (المعيار "" يطابق الخلية الفارغة).
const cnt = (rows: readonly RegisterRow[], f: (r: RegisterRow) => boolean) => rows.filter(f).length;

function statRow(rows: readonly RegisterRow[], title: string): (Cell | null)[] {
  const L = (v: string): Cell => str(v, ST.statTitle);
  const F = (f: string, v: number): Cell => ({ t: 'f', f, v, s: ST.statValue });
  const blank = (): Cell => str('', ST.statTitle);
  const noExit = (r: RegisterRow) => r.exitType === '';
  const row: (Cell | null)[] = new Array(26).fill(null);
  row[0] = str(title, ST.banner); for (let i = 1; i <= 5; i++) row[i] = str('', ST.banner);
  row[6] = L('إحصائية بعدد السجناء'); row[7] = blank();
  row[8] = L('عدد السجناء لازالوا في الحجز'); row[9] = blank();
  row[10] = F('COUNTIF($X:$X,"' + FATE_HELD + '")', cnt(rows, (r) => r.fate === FATE_HELD));
  row[11] = L('عدد منهم على رهن جمع الاستدلالات'); row[12] = blank();
  row[13] = F('COUNTIFS($Q:$Q,"' + LEGAL_STATUSES[0] + '",$U:$U,"")', cnt(rows, (r) => r.legalStatus === LEGAL_STATUSES[0] && noExit(r)));
  row[14] = L('عدد محبوسين على ذمة النيابة');
  row[15] = F('COUNTIFS($Q:$Q,"' + LEGAL_STATUSES[1] + '",$U:$U,"")', cnt(rows, (r) => r.legalStatus === LEGAL_STATUSES[1] && noExit(r)));
  row[16] = L('عدد على ذمة المحكمة'); row[17] = blank();
  row[18] = F('COUNTIFS($Q:$Q,"' + LEGAL_STATUSES[2] + '",$T:$T,"")', cnt(rows, (r) => r.legalStatus === LEGAL_STATUSES[2] && r.exitDate === null));
  row[19] = L('عدد من قد تم الافراج عنهم'); row[20] = blank();
  row[21] = F('COUNTIF($X:$X,"' + FATE_EXIT + '")', cnt(rows, (r) => r.fate === FATE_EXIT));
  row[22] = L('عدد من تم نقله على القضاء الى سجن اخر');
  row[23] = F('COUNTIF($U:$U,"' + EXIT_TYPES[1] + '")', cnt(rows, (r) => r.exitType === EXIT_TYPES[1]));
  row[24] = L('عدد تم تسليمهم للجهات الأخرى');
  row[25] = F('COUNTIF($U:$U,"' + EXIT_TYPES[2] + '")', cnt(rows, (r) => r.exitType === EXIT_TYPES[2]));
  return row;
}

function detaineesSheet(rows: readonly RegisterRow[], title: string): string {
  const all: (Cell | null)[][] = [
    statRow(rows, title),
    REGISTER_HEADERS.map((h) => str(h, ST.head)),
    ...rows.map((r, i) => dataRow(r, i)),
  ];
  return sheetXml({
    rows: all, widths: MAIN_WIDTHS, heights: { 1: 57.75, 2: 57 },
    merges: ['A1:F1', 'G1:H1', 'I1:J1', 'L1:M1', 'Q1:R1', 'T1:U1'],
    freezeRow: 2, filter: 'A2:Z' + Math.max(2, rows.length + 2), printTitleRow: 2, paper: 8,
  });
}

function classesSheet(): string {
  const rows: (Cell | null)[][] = [
    [str('التصنيفات القانونية للجرائم التي يتم السجن عليها', ST.title)],
    ['م', 'نوع الجريمة او الحادث', 'جسيم او غير جسيم', 'التبويب الفرعي', 'التبويب الرئيسي', 'استنادا الى'].map((h) => str(h, ST.head)),
  ];
  let n = 0;
  for (const g of CLASSIFICATION_GROUPS) {
    for (const [name, grave] of g.items) {
      n++;
      rows.push([num(n), str(name), str(grave ? 'جسيمة' : 'غير جسيم'), str(g.sub), str(g.main), str(g.basis)]);
    }
  }
  return sheetXml({ rows, widths: [6, 46, 16, 36, 40, 26], merges: ['A1:F1'], freezeRow: 2, filter: 'A2:F' + (rows.length), paper: 8, landscape: false });
}

function rulesSheet(): string {
  const rows: (Cell | null)[][] = [
    [str('تعليمات', ST.title)],
    [str('م', ST.head), str('المواد القانونية تنظم أماكن الحجز والسجون', ST.head), str('م', ST.head), str('تعليمات ونقاط هامــه عند رفع ومتابعة معلومية السجناء', ST.head)],
  ];
  const n = Math.max(LEGAL_ARTICLES.length, DATA_GUIDELINES.length);
  for (let i = 0; i < n; i++) {
    const a = LEGAL_ARTICLES[i]; const g = DATA_GUIDELINES[i];
    rows.push([a ? num(a.no, ST.bodyC) : null, a ? str(a.text) : null, g ? num(g.no, ST.bodyC) : null, g ? str(g.text) : null]);
  }
  return sheetXml({ rows, widths: [5, 70, 5, 70], merges: ['A1:D1'], landscape: false });
}

function listsSheet(): string {
  const cols = [ID_TYPES, CASE_ROLES, LEGAL_STATUSES, EXIT_TYPES];
  const n = Math.max(...cols.map((c) => c.length));
  const rows: (Cell | null)[][] = [];
  for (let i = 0; i < n; i++) rows.push([null, ...cols.map((c) => (c[i] ? str(c[i]) : null))]);
  return sheetXml({ rows, widths: [4, 26, 16, 22, 34], landscape: false });
}

export interface RegisterXlsxOptions { rows: readonly RegisterRow[]; day: number; createdAt?: number }

export function renderRegisterXlsx(opt: RegisterXlsxOptions): Uint8Array {
  const sheets: { name: string; xml: string }[] = [
    { name: REGISTER_SHEETS.main, xml: detaineesSheet(opt.rows, 'معلومية السجناء الأساسية') },
    { name: REGISTER_SHEETS.moves, xml: detaineesSheet(movementsOfDay(opt.rows, opt.day), 'الدخول والخروج') },
    { name: REGISTER_SHEETS.classes, xml: classesSheet() },
    { name: REGISTER_SHEETS.rules, xml: rulesSheet() },
    { name: REGISTER_SHEETS.lists, xml: listsSheet() },
  ];
  const n = sheets.length;
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
    '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  // الفلتر التلقائي وعناوين الطباعة للورقتين الأوليين.
  const q = (name: string) => "'" + name + "'";
  const defined: string[] = [];
  [0, 1].forEach((i) => {
    const last = i === 0 ? opt.rows.length : movementsOfDay(opt.rows, opt.day).length;
    defined.push('<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">' + x(q(sheets[i].name)) + '!$A$2:$Z$' + Math.max(2, last + 2) + '</definedName>');
    defined.push('<definedName name="_xlnm.Print_Titles" localSheetId="' + i + '">' + x(q(sheets[i].name)) + '!$2:$2</definedName>');
  });
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    sheets.map((s, i) => '<sheet name="' + x(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' +
    '<definedNames>' + defined.join('') + '</definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
    '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';

  const thin = (c: string) => '<left style="thin"><color rgb="' + c + '"/></left><right style="thin"><color rgb="' + c + '"/></right><top style="thin"><color rgb="' + c + '"/></top><bottom style="thin"><color rgb="' + c + '"/></bottom><diagonal/>';
  const thick = '<left style="medium"><color rgb="FF000000"/></left><right style="medium"><color rgb="FF000000"/></right><top style="medium"><color rgb="FF000000"/></top><bottom style="medium"><color rgb="FF000000"/></bottom><diagonal/>';
  const al = (h: string, extra = '') => '<alignment horizontal="' + h + '" vertical="center" wrapText="1" readingOrder="2"' + extra + '/>';
  const fill = (rgb: string) => '<fill><patternFill patternType="solid"><fgColor rgb="' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>';
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>' +
    '<fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Arial"/></font><font><b/><sz val="14"/><name val="Arial"/></font><font><b/><sz val="16"/><name val="Arial"/></font><font><b/><sz val="13"/><name val="Arial"/></font></fonts>' +
    '<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' + fill('FFFFFFCC') + fill('FFBDD7EE') + fill('FFFFA7A7') + fill('FFFFFF00') + '</fills>' +
    '<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border>' + thin('FF000000') + '</border><border>' + thick + '</border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="8">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' + al('right') + '</xf>' +                                   // 0 body
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' + al('center') + '</xf>' + // 1 head
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' + al('right') + '</xf>' +        // 2 date
    '<xf numFmtId="0" fontId="3" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' + al('center') + '</xf>' + // 3 stat title
    '<xf numFmtId="0" fontId="2" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' + al('center') + '</xf>' + // 4 stat value
    '<xf numFmtId="0" fontId="3" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' + al('center') + '</xf>' + // 5 banner
    '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' + al('center') + '</xf>' +                                  // 6 title
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' + al('center') + '</xf>' +                                // 7 body centered
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: styles },
    ...sheets.map((s, i) => ({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: s.xml })),
  ], new Date(opt.createdAt ?? Date.now()));
}
