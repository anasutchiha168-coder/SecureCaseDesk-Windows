// SECURECASEDESK_PHASE9_S3
// يحوّل ReportDocument إلى HTML عربي RTL جاهز للتحويل إلى PDF (expo-print) وللمعاينة والطباعة لاحقاً.
// الخط يعتمد على خطوط Android العربية المثبتة في النظام؛ تشكيل الحروف واتجاه النص يتولاهما محرك الويب نفسه.

import { Identity } from '../../constants/identity';
import type { ReportDocument, ReportSection } from './reports-types';
import { escapeHtml as h, fmtDateTime } from './reports-format';

const CSS = `
@page { size: A4; margin: 16mm 12mm 18mm 12mm; @bottom-center { content: "صفحة " counter(page) " من " counter(pages); font-size: 9pt; color: #555; } }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { direction: rtl; text-align: right; font-family: 'Noto Naskh Arabic','Noto Sans Arabic','Droid Arabic Naskh','Cairo','Tahoma','Arial',sans-serif; font-size: 11pt; color: #111; line-height: 1.7; }
.head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 12px; }
.org { text-align: center; font-weight: 700; font-size: 13pt; line-height: 1.6; flex: 1; }
.meta { font-size: 10pt; min-width: 150px; }
h1 { text-align: center; font-size: 17pt; margin: 8px 0 4px; }
.sub { text-align: center; color: #444; font-size: 10pt; margin-bottom: 12px; }
h2 { font-size: 13pt; border-right: 4px solid #1d4ed8; padding-right: 8px; margin: 16px 0 6px; page-break-after: avoid; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 9.5pt; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #888; padding: 4px 6px; text-align: right; vertical-align: top; word-break: break-word; }
th { background: #e5e7eb; font-weight: 700; }
td.k { width: 32%; background: #f3f4f6; font-weight: 700; }
p.body { white-space: pre-wrap; border: 1px solid #bbb; padding: 8px; margin: 6px 0; }
.sign { display: flex; justify-content: space-between; gap: 12px; margin-top: 28px; page-break-inside: avoid; }
.sign div { flex: 1; border: 1px solid #888; min-height: 80px; padding: 6px; text-align: center; font-size: 10pt; }
.foot { margin-top: 14px; font-size: 8.5pt; color: #555; text-align: center; border-top: 1px solid #bbb; padding-top: 4px; }
`;

function section(s: ReportSection): string {
  const head = s.heading ? '<h2>' + h(s.heading) + '</h2>' : '';
  if (s.type === 'kv') {
    return head + '<table><tbody>' + s.rows.map((r) => '<tr><td class="k">' + h(r.label) + '</td><td>' + h(r.value) + '</td></tr>').join('') + '</tbody></table>';
  }
  if (s.type === 'text') return head + '<p class="body">' + h(s.text) + '</p>';
  const body = s.rows.length
    ? s.rows.map((r) => '<tr>' + r.map((c) => '<td>' + h(c) + '</td>').join('') + '</tr>').join('')
    : '<tr><td colspan="' + s.columns.length + '" style="text-align:center">' + h(s.emptyText ?? 'لا توجد بيانات.') + '</td></tr>';
  return head + '<table><thead><tr>' + s.columns.map((c) => '<th>' + h(c) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table>';
}

export function renderReportHtml(doc: ReportDocument): string {
  return '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
    '<title>' + h(doc.title) + '</title><style>' + CSS + '</style></head><body>' +
    '<div class="head"><div class="meta">رقم المستند: ' + h(doc.documentNumber) + '<br/>التاريخ: ' + h(fmtDateTime(doc.createdAt)) + '</div>' +
    '<div class="org">' + h(Identity.ministry) + '<br/>' + h(Identity.department) + '<br/>' + h(Identity.governorate) + '</div>' +
    '<div class="meta" style="text-align:left">&nbsp;</div></div>' +
    '<h1>' + h(doc.title) + '</h1>' +
    '<div class="sub">' + h(doc.filtersText) + ' — أعدّه: ' + h(doc.createdBy) + '</div>' +
    doc.sections.map(section).join('') +
    '<div class="sign"><div>التوقيع<br/>&nbsp;</div><div>الاعتماد<br/>&nbsp;</div><div>الختم الرسمي<br/>&nbsp;</div></div>' +
    '<div class="foot">' + h(Identity.appName + ' ' + Identity.appVersion) + ' — وثيقة سرية للاستخدام الرسمي — ' + h(doc.documentNumber) + '</div>' +
    '</body></html>';
}
