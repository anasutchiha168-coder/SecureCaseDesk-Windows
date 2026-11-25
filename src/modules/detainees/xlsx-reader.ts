// SECURECASEDESK_DETAINEES_V22_S9 - قارئ xlsx مبسّط: الورقة الأولى فقط، بلا مكتبات ثقيلة.
// هذا الملف نقي (يستقبل دالة قراءة ملفات من الأرشيف)؛ فكّ الضغط في xlsx-zip.ts.
import type { RawRow } from './excel-import';

export type ReadEntry = (path: string) => string | null;

function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function innerText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return unescapeXml(out).replace(/\r\n?/g, '\n');
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(tag);
  return m ? m[1] : null;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyleSet(styles: string | null): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = attr(m[0], 'numFmtId'); const code = attr(m[0], 'formatCode');
    if (id !== null && code !== null) custom.set(Number(id), code);
  }
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\s[^>]*?(?:\/>|>)/g)) {
    const id = Number(attr(m[0], 'numFmtId') ?? '0');
    const code = custom.get(id);
    const isDate = BUILTIN_DATE_FMTS.has(id) ||
      (code !== undefined && /[dmy]/i.test(code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')));
    if (isDate) out.add(i);
    i++;
  }
  return out;
}

function serialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function firstSheetPath(read: ReadEntry): string {
  const wb = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('XLSX_INVALID');
  const sheet = /<sheet\s[^>]*>/.exec(wb)?.[0];
  const rid = sheet ? (attr(sheet, 'r:id') ?? attr(sheet, 'id')) : null;
  if (!rid) throw new Error('XLSX_NO_SHEET');
  for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    if (attr(m[0], 'Id') === rid) {
      const target = attr(m[0], 'Target') ?? '';
      return target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    }
  }
  throw new Error('XLSX_NO_SHEET');
}

/** يعيد خريطة صف ← (عمود ← نص) للخلايا غير الفارغة. التواريخ تُحوَّل إلى YYYY-MM-DD. */
export function readSheetCells(read: ReadEntry): Map<number, Map<number, string>> {
  const sheetXml = read(firstSheetPath(read));
  if (!sheetXml) throw new Error('XLSX_NO_SHEET');
  const sst: string[] = [];
  const sstXml = read('xl/sharedStrings.xml');
  if (sstXml) for (const m of sstXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) sst.push(innerText(m[1]));
  const dateStyles = dateStyleSet(read('xl/styles.xml'));

  const rows = new Map<number, Map<number, string>>();
  for (const rm of sheetXml.matchAll(/<row\s[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNo = Number(attr(rm[0], 'r') ?? '0');
    if (!rowNo || !rm[1]) continue;
    const cells = new Map<number, string>();
    for (const cm of rm[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cm[1]; const body = cm[2] ?? '';
      const ref = attr(head, 'r'); if (!ref) continue;
      const t = attr(head, 't'); const s = Number(attr(head, 's') ?? '0');
      let val: string | null = null;
      if (t === 'inlineStr') val = innerText(body);
      else {
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          if (t === 's') val = sst[Number(v)] ?? null;
          else if (t === 'str' || t === 'e') val = t === 'e' ? null : unescapeXml(v);
          else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
          else if (dateStyles.has(s)) val = serialToIso(Number(v));
          else val = String(Number(v));
        }
      }
      if (val !== null && val.trim() !== '') cells.set(colIndex(ref), val.trim());
    }
    if (cells.size) rows.set(rowNo, cells);
  }
  return rows;
}

/** نفس منطق scripts/import/excel_to_json.py: البيانات من الصف 3، والاسم في العمود B شرط. */
export function rowsToRaw(cells: Map<number, Map<number, string>>): RawRow[] {
  const out: RawRow[] = [];
  const nums = [...cells.keys()].filter((n) => n >= 3).sort((a, b) => a - b);
  for (const n of nums) {
    const r = cells.get(n) as Map<number, string>;
    const c = (i: number): string | null => r.get(i) ?? null;
    if (!c(1)) continue;
    out.push({
      excelRow: n, serial: c(0), name: c(1), age: c(2), idType: c(3), idNumber: c(4), phone: c(5),
      governorate: c(6), district: c(7), subDistrict: c(8), residence: c(9), occupation: c(10), offense: c(11),
      caseRole: c(12), reportNo: c(13), depositAuthority: c(14), admission: c(15), legalStatus: c(16),
      referralDate: c(17), place: c(18), release: c(19), exitType: c(20), exitProcedure: c(21),
      exitSource: c(22), fate: c(23), notes: c(24),
    });
  }
  return out;
}

export function parseXlsxRows(read: ReadEntry): RawRow[] {
  return rowsToRaw(readSheetCells(read));
}
