// SECURECASEDESK_DETAINEES_V22_S9 - فكّ ضغط حقيقي: أرشيف xlsx مصغّر يُبنى بـ fflate ثم يُقرأ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { readXlsxBytes } from '../src/modules/detainees/xlsx-zip';

test('readXlsxBytes reads a real zipped xlsx package', () => {
  const bytes = zipSync({
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="3"><c r="B3" t="inlineStr"><is><t>zip-name</t></is></c></row></sheetData></worksheet>'),
  });
  const rows = readXlsxBytes(bytes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'zip-name');
});

test('readXlsxBytes rejects bytes that are not a zip', () => {
  assert.throws(() => readXlsxBytes(new Uint8Array([1, 2, 3, 4, 5])), /XLSX_INVALID/);
});
