// SECURECASEDESK_PHASE9_S3
// دوال تنسيق مشتركة (تواريخ، مدد، هروب النصوص). تواريخ ميلادية بأرقام لاتينية كما في بقية المشروع.

const p2 = (n: number) => String(n).padStart(2, '0');

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return fmtDate(ts) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

const DAY = 86400000;

// مدة الاحتجاز بالأيام: من الإيداع حتى الإفراج، أو حتى الآن إن لم يُفرج عنه. لا تقل عن صفر.
export function durationDays(admission: number, release: number | null | undefined, now: number): number {
  const end = release && release > 0 ? release : now;
  return Math.max(0, Math.floor((end - admission) / DAY));
}

export function startOfDay(ts: number): number {
  const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime();
}
export function endOfDay(ts: number): number {
  const d = new Date(ts); d.setHours(23, 59, 59, 999); return d.getTime();
}

// SECURECASEDESK_FIX_L1_G1_G2 — تزييف اتجاه النص (مثل اسم ملف أو متهم يبدو مختلفاً عمّا هو عليه) يُمنع عند التصدير.
export const BIDI_OVERRIDE_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
export function stripBidiControls(s: string): string {
  return s.replace(BIDI_OVERRIDE_CONTROLS, '');
}

export function escapeHtml(s: unknown): string {
  return stripBidiControls(String(s ?? ''))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// يحذف المحارف غير المسموحة في XML 1.0 ثم يهرب الرموز.
export function escapeXml(s: unknown): string {
  return stripBidiControls(String(s ?? ''))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' بايت';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' ك.ب';
  return (bytes / (1024 * 1024)).toFixed(1) + ' م.ب';
}

export function cell(v: unknown): string {
  const s = v === null || v === undefined || v === '' ? '—' : String(v);
  return s;
}

export function safeFileName(title: string, ts: number): string {
  const base = title.replace(/[^\u0600-\u06FFa-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'report';
  const d = new Date(ts);
  return base + '_' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}

// يقرأ YYYY-MM-DD (يقبل الأرقام العربية الهندية). فارغ => undefined، غير صالح => null.
export function parseDateInput(raw: string): number | undefined | null {
  const t = raw.trim().replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
  if (!t) return undefined;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt.getTime();
}
