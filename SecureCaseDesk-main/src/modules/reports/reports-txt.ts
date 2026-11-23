// SECURECASEDESK_EXPORT_TXT
// نص عادي UTF-8 (مع BOM كي تعرض التطبيقات العربية الترميز صحيحاً). الجداول تُكتب كأسطر "عمود: قيمة".

import { Identity } from '../../constants/identity';
import type { ReportDocument } from './reports-types';
import { fmtDateTime, stripBidiControls } from './reports-format';

export function renderReportTxt(doc: ReportDocument): Uint8Array {
  const L: string[] = [];
  const bar = '='.repeat(48), thin = '-'.repeat(48);
  L.push(Identity.ministry, Identity.department, Identity.governorate, bar, doc.title, bar);
  L.push('رقم المستند: ' + doc.documentNumber, 'التاريخ: ' + fmtDateTime(doc.createdAt), 'أعدّه: ' + doc.createdBy, 'الفلاتر: ' + doc.filtersText, '');
  for (const s of doc.sections) {
    if (s.heading) L.push('## ' + s.heading, thin);
    if (s.type === 'kv') for (const r of s.rows) L.push(r.label + ': ' + r.value);
    else if (s.type === 'text') L.push(s.text);
    else if (!s.rows.length) L.push(s.emptyText ?? 'لا توجد بيانات.');
    else s.rows.forEach((r, i) => {
      L.push('[' + (i + 1) + ']');
      r.forEach((c, ci) => L.push('  ' + (s.columns[ci] ?? '') + ': ' + c));
    });
    L.push('');
  }
  L.push(thin, Identity.appName + ' ' + Identity.appVersion + ' — وثيقة سرية للاستخدام الرسمي');
  const text = stripBidiControls(L.join('\r\n')) + '\r\n';
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(3 + body.length);
  out.set([0xef, 0xbb, 0xbf], 0); out.set(body, 3);
  return out;
}
