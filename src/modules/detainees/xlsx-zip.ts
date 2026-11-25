// SECURECASEDESK_DETAINEES_V22_S9 - فكّ ضغط ملف xlsx (أرشيف zip) ثم تمريره للقارئ النقي.
import { unzipSync, strFromU8 } from 'fflate';
import type { RawRow } from './excel-import';
import { parseXlsxRows } from './xlsx-reader';

const WANTED = /^(xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/styles\.xml|xl\/worksheets\/[^/]+\.xml)$/;

export function readXlsxBytes(bytes: Uint8Array): RawRow[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => WANTED.test(f.name) });
  } catch {
    throw new Error('XLSX_INVALID');
  }
  const cache = new Map<string, string | null>();
  const read = (p: string): string | null => {
    if (cache.has(p)) return cache.get(p) ?? null;
    const u = files[p];
    const s = u ? strFromU8(u) : null;
    cache.set(p, s);
    return s;
  };
  return parseXlsxRows(read);
}
