// SECURECASEDESK_PHASE9_S3
// مولّد DOCX يدوي (OOXML) يدعم العربية وRTL: فقرات bidi، نصوص rtl، جداول bidiVisual،
// ترقيم صفحات حقيقي في التذييل (PAGE / NUMPAGES). بلا اعتماديات خارجية.

import { Identity } from '../../constants/identity';
import type { ReportDocument, ReportSection } from './reports-types';
import { escapeXml as x, fmtDateTime } from './reports-format';
import { buildZip } from './reports-zip';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const FONT = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/>';

function run(text: string, o: { bold?: boolean; size?: number; color?: string } = {}): string {
  return '<w:r><w:rPr>' + FONT + (o.bold ? '<w:b/><w:bCs/>' : '') + (o.color ? '<w:color w:val="' + o.color + '"/>' : '') +
    '<w:sz w:val="' + (o.size ?? 22) + '"/><w:szCs w:val="' + (o.size ?? 22) + '"/><w:rtl/><w:lang w:bidi="ar-SA"/></w:rPr>' +
    '<w:t xml:space="preserve">' + x(text) + '</w:t></w:r>';
}

function para(text: string, o: { bold?: boolean; size?: number; align?: 'center' | 'start'; color?: string; style?: string; after?: number } = {}): string {
  // في الفقرات ثنائية الاتجاه (bidi) تعني القيمة start الحافة اليمنى.
  const lines = text.split('\n');
  const runs = lines.map((l, i) => (i ? '<w:r><w:br/></w:r>' : '') + run(l, o)).join('');
  return '<w:p><w:pPr>' + (o.style ? '<w:pStyle w:val="' + o.style + '"/>' : '') + '<w:bidi/><w:spacing w:before="0" w:after="' + (o.after ?? 80) + '"/>' +
    '<w:jc w:val="' + (o.align === 'center' ? 'center' : 'start') + '"/></w:pPr>' + runs + '</w:p>';
}

function tcell(text: string, width: number, o: { bold?: boolean; fill?: string; header?: boolean } = {}): string {
  return '<w:tc><w:tcPr><w:tcW w:w="' + width + '" w:type="dxa"/>' + (o.fill ? '<w:shd w:val="clear" w:color="auto" w:fill="' + o.fill + '"/>' : '') + '</w:tcPr>' +
    para(text, { bold: o.bold, size: 19, after: 0 }) + '</w:tc>';
}

function table(columns: string[] | null, rows: string[][], totalWidth: number, kv = false): string {
  const n = columns ? columns.length : 2;
  const widths = kv ? [Math.round(totalWidth * 0.32), totalWidth - Math.round(totalWidth * 0.32)] : columns!.map(() => Math.floor(totalWidth / n));
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => '<w:' + b + ' w:val="single" w:sz="4" w:space="0" w:color="888888"/>').join('');
  const grid = '<w:tblGrid>' + widths.map((w) => '<w:gridCol w:w="' + w + '"/>').join('') + '</w:tblGrid>';
  let out = '<w:tbl><w:tblPr><w:tblW w:w="' + totalWidth + '" w:type="dxa"/><w:bidiVisual/><w:tblBorders>' + borders + '</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="70" w:type="dxa"/><w:right w:w="70" w:type="dxa"/></w:tblCellMar></w:tblPr>' + grid;
  if (columns) out += '<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>' + columns.map((c, i) => tcell(c, widths[i], { bold: true, fill: 'E5E7EB' })).join('') + '</w:tr>';
  for (const r of rows) {
    out += '<w:tr><w:trPr><w:cantSplit/></w:trPr>' + r.map((c, i) => tcell(c, widths[i], kv && i === 0 ? { bold: true, fill: 'F3F4F6' } : {})).join('') + '</w:tr>';
  }
  return out + '</w:tbl>' + para('', { size: 8, after: 60 });
}

function sectionXml(s: ReportSection, width: number): string {
  const head = s.heading ? para(s.heading, { bold: true, size: 26, color: '1D4ED8', style: 'Heading2', after: 60 }) : '';
  if (s.type === 'kv') return head + table(null, s.rows.map((r) => [r.label, r.value]), width, true);
  if (s.type === 'text') return head + para(s.text, { size: 21 });
  if (!s.rows.length) return head + table(null, [[s.emptyText ?? 'لا توجد بيانات.', '']].map((r) => [r[0], '—']), width, true);
  return head + table(s.columns, s.rows, width);
}

export function renderReportDocx(doc: ReportDocument): Uint8Array {
  const wide = doc.sections.some((s) => s.type === 'table' && s.columns.length >= 7);
  const pageW = wide ? 16838 : 11906; const pageH = wide ? 11906 : 16838;
  const margin = 850; const width = pageW - margin * 2;

  const body =
    para(Identity.ministry, { bold: true, size: 28, align: 'center', after: 0 }) +
    para(Identity.department, { bold: true, size: 26, align: 'center', after: 0 }) +
    para(Identity.governorate, { bold: true, size: 26, align: 'center', after: 120 }) +
    para('رقم المستند: ' + doc.documentNumber + '    التاريخ: ' + fmtDateTime(doc.createdAt), { size: 20, after: 120 }) +
    para(doc.title, { bold: true, size: 36, align: 'center', style: 'Title', after: 40 }) +
    para(doc.filtersText + ' — أعدّه: ' + doc.createdBy, { size: 20, align: 'center', color: '444444', after: 160 }) +
    doc.sections.map((s) => sectionXml(s, width)).join('') +
    table(null, [['التوقيع', ''], ['الاعتماد', ''], ['الختم الرسمي', '']], width, true) +
    '<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="' + pageW + '" w:h="' + pageH + '"' + (wide ? ' w:orient="landscape"' : '') + '/>' +
    '<w:pgMar w:top="1000" w:right="' + margin + '" w:bottom="1000" w:left="' + margin + '" w:header="500" w:footer="500" w:gutter="0"/><w:bidi/></w:sectPr>';

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + NS + '><w:body>' + body + '</w:body></w:document>';

  const fld = (instr: string) =>
    '<w:r><w:rPr>' + FONT + '<w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:rPr>' + FONT + '<w:sz w:val="18"/></w:rPr><w:instrText xml:space="preserve"> ' + instr + ' </w:instrText></w:r>' +
    '<w:r><w:rPr>' + FONT + '<w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:rPr>' + FONT + '<w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r>' +
    '<w:r><w:rPr>' + FONT + '<w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>';
  const footerXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ' + NS + '><w:p><w:pPr><w:bidi/><w:jc w:val="center"/></w:pPr>' +
    run(Identity.appName + ' ' + Identity.appVersion + ' — ' + doc.documentNumber + ' — صفحة ', { size: 18 }) + fld('PAGE') + run(' من ', { size: 18 }) + fld('NUMPAGES') + '</w:p></w:ftr>';

  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ' + NS + '><w:docDefaults><w:rPrDefault><w:rPr>' + FONT +
    '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="ar-SA" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:bidi/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>';
  const iso = new Date(doc.createdAt).toISOString().replace(/\.\d+Z$/, 'Z');
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>' + x(doc.title) + '</dc:title><dc:creator>' + x(Identity.appName) + '</dc:creator><dc:language>ar-SA</dc:language>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:created></cp:coreProperties>';

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: stylesXml },
    { name: 'word/footer1.xml', data: footerXml },
    { name: 'docProps/core.xml', data: core },
  ], new Date(doc.createdAt));
}
