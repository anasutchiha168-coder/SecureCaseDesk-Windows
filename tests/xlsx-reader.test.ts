// SECURECASEDESK_DETAINEES_V22_S9 - قارئ xlsx (نقي) + نصوص التعليمات.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseXlsxRows, firstSheetPath } from '../src/modules/detainees/xlsx-reader';
import { LEGAL_ARTICLES, DATA_GUIDELINES } from '../src/modules/detainees/detainees-instructions';
import { LEGAL_STATUSES } from '../src/modules/detainees/detainees-lists';

const WB = '<workbook><sheets><sheet name="s1" sheetId="1" r:id="rId7"/><sheet name="s2" sheetId="2" r:id="rId8"/></sheets></workbook>';
const RELS = '<Relationships><Relationship Id="rId8" Target="worksheets/sheet2.xml"/><Relationship Id="rId7" Target="worksheets/sheet1.xml"/></Relationships>';
const SST = '<sst><si><t>name-a</t></si><si><r><t>part-1 </t></r><r><t>&amp; part-2</t></r></si><si><t>jani</t></si></sst>';
const STYLES = '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>'
  + '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>';
const SHEET = '<worksheet><sheetData>'
  + '<row r="1"><c r="A1" t="inlineStr"><is><t>title</t></is></c></row>'
  + '<row r="2"><c r="A2" t="s"><v>0</v></c></row>'
  + '<row r="3"><c r="A3"><v>7</v></c><c r="B3" t="s"><v>0</v></c><c r="C3"><v>24</v></c><c r="L3" t="s"><v>1</v></c>'
  + '<c r="M3" t="s"><v>2</v></c><c r="P3" s="1"><v>46023</v></c><c r="R3" s="2"><v>46054</v></c><c r="Z3"><f>1+1</f><v>2</v></c></row>'
  + '<row r="4"><c r="A4"><v>8</v></c><c r="B4"/></row>'
  + '<row r="5"><c r="B5" t="inlineStr"><is><t>name-b</t></is></c><c r="U5" t="str"><f>x</f><v>text-result</v></c></row>'
  + '</sheetData></worksheet>';
const FILES: Record<string, string> = {
  'xl/workbook.xml': WB, 'xl/_rels/workbook.xml.rels': RELS, 'xl/sharedStrings.xml': SST,
  'xl/styles.xml': STYLES, 'xl/worksheets/sheet1.xml': SHEET,
};
const read = (p: string) => FILES[p] ?? null;

describe('xlsx reader', () => {
  test('finds the first sheet through the relationships file', () => {
    assert.equal(firstSheetPath(read), 'xl/worksheets/sheet1.xml');
  });

  test('maps columns like the Python converter: data from row 3, name (B) required', () => {
    const rows = parseXlsxRows(read);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].excelRow, 3);
    assert.equal(rows[0].serial, '7');
    assert.equal(rows[0].name, 'name-a');
    assert.equal(rows[0].age, '24');
    assert.equal(rows[0].offense, 'part-1 & part-2');
    assert.equal(rows[0].caseRole, 'jani');
    assert.equal(rows[1].excelRow, 5);
    assert.equal(rows[1].name, 'name-b');
    assert.equal(rows[1].exitType, 'text-result');
  });

  test('date cells (builtin and custom formats) become ISO dates; plain numbers stay numbers', () => {
    const r = parseXlsxRows(read)[0];
    assert.equal(r.admission, '2026-01-01');
    assert.equal(r.referralDate, '2026-02-01');
    assert.equal(r.age, '24');
  });

  test('a broken package is rejected', () => {
    assert.throws(() => parseXlsxRows(() => null), /XLSX_INVALID/);
  });
});

describe('instructions and lists', () => {
  test('legal articles and guidelines come from the Excel sheet', () => {
    assert.equal(LEGAL_ARTICLES.length, 11);
    assert.equal(DATA_GUIDELINES.length, 10);
    assert.ok(LEGAL_ARTICLES[0].text.includes('186'));
    assert.ok(LEGAL_ARTICLES.every((a) => a.text.length > 20));
  });
  test('legal statuses include the convicted status found in the real data', () => {
    assert.ok(LEGAL_STATUSES.includes('محكوم'));
    assert.equal(LEGAL_STATUSES.length, 4);
  });
});
