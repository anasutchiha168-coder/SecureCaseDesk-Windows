// SECURECASEDESK_PHASE11_S3
// أدوات التلخيص النقية (بلا Expo، بلا lookbehind ولا \p{} لتعمل على Hermes):
// تنقية المصدر، التقطيع للمستندات الطويلة، رمز تغيّر الحمولة، الاستخراج الآلي (بدون ذكاء اصطناعي)،
// والتحقق من الملخص المولَّد مقابل المصدر (أرقام/عبارات حكمية لم ترد فيه).

import { normalizeArabic, normalizeDigits } from './ai-search-text';

// سقف ما يُلخَّص من مستند واحد: ما زاد يُقتطع مع إبلاغ المستخدم صراحةً (لا اقتطاع صامت).
export const MAX_SOURCE_CHARS = 42000;
// حد صلب لعدد أجزاء التلخيص (أي مستند يُقتطع عند هذا العدد مع إعلان الاقتطاع): يضمن سقف الاستدعاءات = أجزاء + دمج واحد.
export const MAX_CHUNKS = 8;
export const CHUNK_CHARS = 6000;
export const SINGLE_PASS_CHARS = 7000;
export const MAX_FIELD_CHARS = 20000;
export const MAX_SUMMARY_CHARS = 6000;
export const MIN_SUMMARY_CHARS = 20;

export interface CleanedText {
  text: string;
  redactions: number;
}

// يحذف محارف التحكم والاتجاه الخفية (قد تُخفي تعليمات)، وعلامتَي الفصل <<< >>> (منع كسر حدود البيانات).
// عند redact=true: يحذف البريد والروابط وأي تسلسل أرقام من 9 خانات فأكثر (هويات، هواتف، حسابات).
// الأسماء لا تُكشف آلياً؛ لذلك يرى المستخدم الحمولة كاملة ويؤكدها يدوياً قبل أي إرسال سحابي.
export function cleanSourceText(input: unknown, redact: boolean, maxChars: number = MAX_FIELD_CHARS): CleanedText {
  let t = typeof input === 'string' ? input : '';
  if (t.length > maxChars) t = t.slice(0, maxChars);
  // eslint-disable-next-line no-control-regex
  t = t.replace(/\r/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  t = t.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
  t = t.replace(/<<<|>>>/g, ' ');
  let redactions = 0;
  if (redact) {
    t = normalizeDigits(t);
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => { redactions++; return '[بريد]'; });
    t = t.replace(/https?:\/\/\S+/gi, () => { redactions++; return '[رابط]'; });
    t = t.replace(/(?:\d[ .-]?){9,}/g, () => { redactions++; return '[رقم]'; });
  }
  t = t.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: t, redactions };
}

// رمز تغيّر الحمولة (FNV-1a): يربط تأكيد المستخدم بالنص الذي رآه تحديداً.
// ليس تشفيراً؛ غايته كشف أي تغيير بين المعاينة والإرسال.
export function payloadToken(payload: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + '-' + payload.length.toString(16);
}

export interface ChunkResult {
  chunks: string[];
  truncated: boolean;
}

// تقطيع عند حدود الفقرات/الجمل؛ الجملة الأطول من الحد تُقطَّع قسراً.
export function chunkText(text: string, size: number = CHUNK_CHARS, maxTotal: number = MAX_SOURCE_CHARS): ChunkResult {
  const truncated = text.length > maxTotal;
  const body = truncated ? text.slice(0, maxTotal) : text;
  if (body.length <= size) return { chunks: body ? [body] : [], truncated };
  const pieces = body.match(/[^.!؟?\n]+[.!؟?]*\n*|\n+/g) ?? [body];
  const chunks: string[] = [];
  let cur = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (const piece of pieces) {
    if (piece.length > size) {
      flush();
      for (let i = 0; i < piece.length; i += size) chunks.push(piece.slice(i, i + size).trim());
      continue;
    }
    if (cur.length + piece.length > size) flush();
    cur += piece;
  }
  flush();
  const nonEmpty = chunks.filter((c) => c.length > 0);
  if (nonEmpty.length > MAX_CHUNKS) return { chunks: nonEmpty.slice(0, MAX_CHUNKS), truncated: true };
  return { chunks: nonEmpty, truncated };
}

// ===== الاستخراج الآلي (لا ذكاء اصطناعي، لا اتصال، مقتطفات حرفية فقط) =====
export interface Fact { label: string; value: string }

function splitSentences(text: string): string[] {
  return (text.match(/[^.!؟?\n]+[.!؟?]*/g) ?? []).map((s) => s.trim()).filter((s) => s.length >= 8);
}

export function buildExtractiveSummary(facts: readonly Fact[], narrative: string, maxExcerptChars = 1200): string {
  const lines: string[] = ['بيانات أساسية:'];
  for (const f of facts) if (f.value && f.value.trim()) lines.push('- ' + f.label + ': ' + f.value.trim());
  const sentences = splitSentences(narrative);
  if (sentences.length > 0) {
    const picked = new Set<number>([0]);
    if (sentences.length > 1) picked.add(1);
    sentences.forEach((s, i) => { if (picked.size < 6 && /[0-9\u0660-\u0669]/.test(s)) picked.add(i); });
    const ordered = [...picked].sort((a, b) => a - b);
    const out: string[] = [];
    let used = 0;
    for (const i of ordered) {
      const s = sentences[i];
      if (used + s.length > maxExcerptChars && out.length > 0) break;
      out.push('- ' + (s.length > maxExcerptChars ? s.slice(0, maxExcerptChars) + '…' : s));
      used += s.length;
    }
    lines.push('', 'مقتطفات حرفية من النص (' + out.length + ' من ' + sentences.length + ' جملة):', ...out);
  }
  return lines.join('\n');
}

// ===== التحقق من الملخص المولَّد =====
// عبارات حكمية/أمنية لا يجوز أن يستنتجها الملخص من عنده (قاعدة: لا قرارات قضائية أو أمنية).
const JUDGMENT_TERMS: readonly string[] = [
  'مدان', 'ادانه', 'مذنب', 'بريء', 'براءه', 'ثبتت', 'يجب القبض', 'يوصي بالقبض', 'يوصى بالقبض', 'يستحق العقوبه', 'عقوبته',
];

export interface SummaryWarnings {
  unsupportedNumbers: string[];
  judgmentTerms: string[];
}

function numberTokens(text: string): string[] {
  const norm = normalizeDigits(text);
  return norm.match(/[0-9]+(?:[./:\-][0-9]+)*/g) ?? [];
}

// يقارن الملخص بالنص الذي أُرسل فعلاً: أي رقم/تاريخ في الملخص لم يرد في المصدر يُعلَّم للمراجع.
// الأرقام من خانة أو خانتين (ترقيم القوائم) تُهمل لأنها غالباً ترقيم لا وقائع.
export function verifySummaryAgainstSource(summary: string, sourceText: string): SummaryWarnings {
  const srcNorm = normalizeDigits(sourceText);
  const srcTokens = new Set(numberTokens(sourceText));
  const unsupported: string[] = [];
  for (const tok of numberTokens(summary)) {
    if (/^[0-9]{1,2}$/.test(tok)) continue;
    if (srcTokens.has(tok) || srcNorm.includes(tok)) continue;
    if (!unsupported.includes(tok)) unsupported.push(tok);
  }
  const sumNorm = normalizeArabic(summary);
  const srcArabic = normalizeArabic(sourceText);
  const terms: string[] = [];
  for (const term of JUDGMENT_TERMS) {
    if (sumNorm.includes(term) && !srcArabic.includes(term)) terms.push(term);
  }
  return { unsupportedNumbers: unsupported.slice(0, 20), judgmentTerms: terms };
}

export function hasWarnings(w: SummaryWarnings): boolean {
  return w.unsupportedNumbers.length > 0 || w.judgmentTerms.length > 0;
}

// تنظيف ناتج النموذج: حذف علامات الفصل وأسوار الشيفرة وإزالة الفراغ الزائد.
export function cleanModelOutput(text: string): string {
  return String(text ?? '')
    .replace(/<<<|>>>/g, ' ')
    .replace(/```[a-z]*/gi, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
