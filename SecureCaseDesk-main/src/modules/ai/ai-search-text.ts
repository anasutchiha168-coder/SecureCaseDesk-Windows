// SECURECASEDESK_PHASE11_S2
// أدوات النص العربي للبحث الذكي (نقية، بلا Expo، بلا lookbehind ولا \p{} لتعمل على Hermes).
// التطبيع: حذف التشكيل والتطويل، توحيد الألف والياء والتاء المربوطة والهمزات، تحويل الأرقام الهندية إلى لاتينية.

export const MAX_FIELD_CHARS = 20000;

export function normalizeDigits(input: string): string {
  return input
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

export function normalizeArabic(input: unknown): string {
  if (typeof input !== 'string') return '';
  let s = input.length > MAX_FIELD_CHARS ? input.slice(0, MAX_FIELD_CHARS) : input;
  s = s.replace(/[\u064B-\u065F\u0670]/g, '').replace(/\u0640/g, '');
  s = s
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064A');
  return normalizeDigits(s).toLowerCase();
}

// يترك الحروف العربية واللاتينية والأرقام و - و / (لأرقام القضايا مثل 2026/15) ويحوّل الباقي إلى مسافة.
export function tokenize(normalized: string): string[] {
  return normalized
    .replace(/[^0-9a-z\u0621-\u064A\u066E-\u06D3\-/ ]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[-/]+|[-/]+$/g, ''))
    .filter((t) => t.length > 0);
}

// نص البحث المخزَّن للحقل: رموز مفصولة بمسافة واحدة.
export function toHaystack(text: unknown): string {
  return tokenize(normalizeArabic(text)).join(' ');
}

export function stemToken(tok: string): string {
  if (/[0-9]/.test(tok)) return tok;
  if (tok.startsWith('وال') && tok.length > 5) return tok.slice(3);
  if (tok.startsWith('بال') && tok.length > 5) return tok.slice(3);
  if (tok.startsWith('فال') && tok.length > 5) return tok.slice(3);
  if (tok.startsWith('ال') && tok.length > 3) return tok.slice(2);
  if (tok.startsWith('لل') && tok.length > 4) return tok.slice(2);
  return tok;
}

// صيغ المطابقة لكلمة واحدة أو عبارة. الأرقام تُطابَق كما هي بلا تصريف.
export function matchForms(word: string): string[] {
  const w = word.trim();
  if (!w) return [];
  if (w.includes(' ')) {
    return [w.split(' ').filter(Boolean).map(stemToken).join(' ')];
  }
  const stem = stemToken(w);
  if (/[0-9]/.test(stem)) return [stem];
  const forms = [stem];
  const trimmed = stem.replace(/(ات|ان|ين|ون|ه|ا)$/, '');
  if (trimmed !== stem && trimmed.length >= 3) forms.push(trimmed);
  return forms;
}

// الكلمات القصيرة (حتى 3 أحرف) تُطابَق كبداية كلمة فقط (مع أو بدون "ال") لتقليل الضجيج.
export function containsForm(haystack: string, form: string): boolean {
  if (!form || !haystack) return false;
  if (form.length <= 3 && !/[0-9]/.test(form)) {
    const padded = ' ' + haystack;
    return padded.includes(' ' + form) || padded.includes(' ال' + form);
  }
  return haystack.includes(form);
}

// ===== حذف المعرّفات قبل أي إرسال سحابي =====
// يُحذف: البريد، وأي تسلسل أرقام من 9 خانات فأكثر (هويات، هواتف، حسابات). الأسماء لا يمكن كشفها آلياً؛
// لذلك تُعرض النسخة المنقّاة للمستخدم ويؤكدها يدوياً قبل الإرسال.
export interface SanitizedText {
  text: string;
  redactions: number;
}

export function sanitizeForCloud(input: string, maxChars = 300): SanitizedText {
  let t = normalizeDigits(String(input ?? ''));
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/<<<|>>>/g, ' ');
  let redactions = 0;
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => { redactions++; return '[بريد]'; });
  t = t.replace(/(?:\d[ .-]?){9,}/g, () => { redactions++; return '[رقم]'; });
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > maxChars) t = t.slice(0, maxChars);
  return { text: t, redactions };
}

// مقتطف من النص الأصلي حول أول كلمة مطابقة (لا يعيد صياغة النص).
export function snippetFor(original: unknown, wordForms: readonly string[], maxWordsAround = 8): string | null {
  if (typeof original !== 'string' || !original.trim() || wordForms.length === 0) return null;
  const words = original.slice(0, MAX_FIELD_CHARS).split(/\s+/).filter(Boolean);
  const idx = words.findIndex((w) => {
    const h = toHaystack(w);
    return h.length > 0 && wordForms.some((f) => containsForm(h, f));
  });
  if (idx < 0) return null;
  const start = Math.max(0, idx - maxWordsAround);
  const end = Math.min(words.length, idx + maxWordsAround + 4);
  return (start > 0 ? '… ' : '') + words.slice(start, end).join(' ') + (end < words.length ? ' …' : '');
}
