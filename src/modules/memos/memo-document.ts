// SECURECASEDESK_MEMO_PRINT
// يبني خطاب المذكرة الرسمي بصيغة HTML (A4، عربي RTL) للتحويل إلى PDF أو للطباعة المباشرة.
// دالة صرفة بلا React Native ليُختبر في Node. الشكل مطابق لورقة الخطاب المعروضة في الشاشة.

import { Identity } from '../../constants/identity';
import { escapeHtml as h } from '../reports/reports-format';

export interface MemoPrintInput {
  memoNumber: string;
  memoDate: number;
  typeName: string;
  recipient: string;
  subject: string;
  body: string | null;
  caseNumber: string | null;
  status: string;
}

const CSS = `
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { direction: rtl; text-align: right; font-family: 'Noto Naskh Arabic','Noto Sans Arabic','Droid Arabic Naskh','Cairo','Tahoma','Arial',sans-serif; font-size: 13pt; color: #111; line-height: 1.9; }
.head { text-align: center; font-weight: 700; line-height: 1.7; }
.head .m { font-size: 16pt; } .head .d { font-size: 14pt; } .head .g { font-size: 13pt; }
.rule1 { border-top: 3px solid #1e3a8a; margin-top: 8px; } .rule2 { border-top: 1px solid #1e3a8a; margin-top: 3px; }
.meta { display: flex; gap: 12px; margin-top: 16px; }
.meta div { flex: 1; border: 1px solid #aaa; background: #f3f3f1; border-radius: 6px; padding: 4px 10px; }
.meta small { display: block; font-size: 9.5pt; color: #555; line-height: 1.4; } .meta b { font-size: 12.5pt; }
.line { margin-top: 8px; font-size: 12.5pt; } .line b { margin-left: 6px; }
.subject { margin-top: 14px; border: 1px solid #bbb; border-right: 5px solid #1e3a8a; background: #efeeea; padding: 6px 12px; border-radius: 4px; }
.subject small { display: block; font-size: 9.5pt; color: #555; line-height: 1.4; } .subject b { font-size: 14pt; }
.body { margin-top: 18px; white-space: pre-wrap; min-height: 90mm; font-size: 13pt; }
.sign { display: flex; justify-content: space-between; margin-top: 30px; page-break-inside: avoid; }
.sign div { width: 44%; text-align: center; font-weight: 700; }
.sign span { display: block; border-bottom: 1px solid #555; height: 60px; margin-top: 6px; }
.foot { margin-top: 26px; text-align: center; font-size: 8.5pt; color: #777; border-top: 1px solid #ccc; padding-top: 4px; }
`;

const arDate = (ts: number) => {
  const d = new Date(ts);
  return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
};

export function renderMemoHtml(m: MemoPrintInput): string {
  return '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/>' +
    '<title>' + h('مذكرة ' + m.memoNumber) + '</title><style>' + CSS + '</style></head><body>' +
    '<div class="head"><div class="m">' + h(Identity.ministry) + '</div><div class="d">' + h(Identity.department) +
    '</div><div class="g">' + h(Identity.governorate) + '</div></div>' +
    '<div class="rule1"></div><div class="rule2"></div>' +
    '<div class="meta"><div><small>رقم المذكرة</small><b>' + h(m.memoNumber) + '</b></div>' +
    '<div><small>التاريخ</small><b>' + h(arDate(m.memoDate)) + '</b></div></div>' +
    '<div class="line"><b>النوع:</b>' + h(m.typeName) + '</div>' +
    '<div class="line"><b>إلى:</b>' + h(m.recipient) + '</div>' +
    (m.caseNumber ? '<div class="line"><b>مرتبطة بالقضية رقم:</b>' + h(m.caseNumber) + '</div>' : '') +
    '<div class="subject"><small>الموضوع</small><b>' + h(m.subject) + '</b></div>' +
    '<div class="body">' + h(m.body || '') + '</div>' +
    '<div class="sign"><div>التوقيع<span></span></div><div>الختم الرسمي<span></span></div></div>' +
    '<div class="foot">' + h(Identity.appName + ' ' + Identity.appVersion) + ' — وثيقة رسمية سرية — ' + h(m.memoNumber) + '</div>' +
    '</body></html>';
}

// اسم ملف آمن: أحرف عربية/لاتينية/أرقام فقط.
export function memoPdfFileName(memoNumber: string): string {
  const base = String(memoNumber).replace(/[^؀-ۿa-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'memo';
  return 'memo_' + base + '.pdf';
}
