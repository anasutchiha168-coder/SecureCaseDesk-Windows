// SECURECASEDESK_PHASE11_S4
// أدوات صياغة المستندات النقية (بلا Expo، بلا lookbehind ولا \p{} لتعمل على Hermes):
// القالب الرسمي الآلي (بلا ذكاء اصطناعي)، الفحص الآلي للنص، التحقق من المسودة المولَّدة مقابل ما كتبه المستخدم،
// وتحليل ناتج المراجعة. لا شيء هنا يتصل بشبكة أو بقاعدة بيانات.

import { normalizeArabic, normalizeDigits } from './ai-search-text';
import { verifySummaryAgainstSource } from './ai-summary-text';

export type DraftDocKind = 'memo' | 'report' | 'letter';
export const DOC_KINDS: readonly DraftDocKind[] = ['memo', 'report', 'letter'];
export const DOC_KIND_LABEL: Record<DraftDocKind, string> = {
  memo: 'مذكرة رسمية',
  report: 'تقرير',
  letter: 'خطاب رسمي',
};

export type DraftMode = 'compose' | 'review';
export const DRAFT_MODES: readonly DraftMode[] = ['compose', 'review'];

export type DraftTone = 'formal' | 'brief';
export const DRAFT_TONES: readonly DraftTone[] = ['formal', 'brief'];
export const TONE_LABEL: Record<DraftTone, string> = { formal: 'رسمي مفصّل', brief: 'رسمي مختصر' };

// علامة الفراغ الموحَّدة: ما لا يعرفه النموذج يُترك فراغاً ليملأه المستخدم (لا اختلاق).
export const PLACEHOLDER = '[......]';

export const DRAFT_LIMITS = {
  recipient: 200,
  subject: 300,
  memoType: 150,
  points: 6000,
  existing: 12000,
  caseDetails: 3000,
  minPoints: 10,
  minSubject: 3,
  minExisting: 20,
} as const;
export const MAX_DRAFT_CHARS = 14000;
export const MIN_DRAFT_CHARS = 40;

export interface DraftWarnings {
  // أرقام/تواريخ في المسودة لم ترد فيما كتبه المستخدم.
  unsupportedNumbers: string[];
  // عبارات حكمية/أمنية لم ترد في المدخلات.
  judgmentTerms: string[];
  // أرقام/تواريخ كتبها المستخدم ولم تظهر في المسودة (معلومة قد تكون سقطت).
  droppedNumbers: string[];
  // عدد الفراغات [......] التي ما زالت بانتظار تعبئة.
  placeholders: number;
}

export function emptyWarnings(): DraftWarnings {
  return { unsupportedNumbers: [], judgmentTerms: [], droppedNumbers: [], placeholders: 0 };
}

export function hasDraftWarnings(w: DraftWarnings): boolean {
  return w.unsupportedNumbers.length > 0 || w.judgmentTerms.length > 0 || w.droppedNumbers.length > 0;
}

export function countPlaceholders(text: string): number {
  return (String(text ?? '').match(/\[(?:\.{2,}|\u2026+)\]/g) ?? []).length;
}

function numberTokens(text: string): string[] {
  return normalizeDigits(text).match(/[0-9]+(?:[./:\-][0-9]+)*/g) ?? [];
}

// أرقام المستخدم (3 خانات فأكثر أو ذات فواصل) التي اختفت من المسودة.
export function droppedNumbers(original: string, draft: string): string[] {
  const draftNorm = normalizeDigits(draft);
  const out: string[] = [];
  for (const tok of numberTokens(original)) {
    if (/^[0-9]{1,2}$/.test(tok)) continue;
    if (draftNorm.includes(tok)) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out.slice(0, 20);
}

// sourceText: كل ما أُرسل أو كُتب (يُقارَن به ما اختلقه النموذج)، mustKeep: ما يجب أن يبقى في المسودة.
export function verifyDraft(draft: string, sourceText: string, mustKeep: string): DraftWarnings {
  const base = verifySummaryAgainstSource(draft, sourceText);
  return {
    unsupportedNumbers: base.unsupportedNumbers,
    judgmentTerms: base.judgmentTerms,
    droppedNumbers: droppedNumbers(mustKeep, draft),
    placeholders: countPlaceholders(draft),
  };
}

// ===== القالب الرسمي الآلي (بلا ذكاء اصطناعي): لا يضيف أي واقعة، يرتّب ما كتبه المستخدم فقط =====
export interface TemplateInput {
  docKind: DraftDocKind;
  tone: DraftTone;
  memoTypeName?: string;
  recipient?: string;
  subject?: string;
  points?: string;
  caseRef?: { case_number: string; title: string } | null;
}

function pointLines(points: string | undefined): string[] {
  return String(points ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-•*]|[0-9\u0660-\u0669]+\s*[-.)\u061F])\s*/, '').trim())
    .filter((l) => l.length > 0);
}

export function buildTemplate(input: TemplateInput): string {
  const val = (v: string | undefined) => (v && v.trim() ? v.trim() : PLACEHOLDER);
  const pts = pointLines(input.points);
  const numbered = pts.length > 0 ? pts.map((p, i) => (i + 1) + '- ' + p) : [PLACEHOLDER];
  const caseLine = input.caseRef ? 'مرجع القضية: رقم ' + input.caseRef.case_number + ' — ' + input.caseRef.title : null;
  const lines: string[] = [];

  if (input.docKind === 'report') {
    lines.push('تقرير');
    lines.push('التاريخ: ' + PLACEHOLDER);
    lines.push('الموضوع: ' + val(input.subject));
    if (caseLine) lines.push(caseLine);
    lines.push('', 'أولاً: المقدمة', PLACEHOLDER);
    lines.push('', 'ثانياً: الوقائع', ...numbered);
    lines.push('', 'ثالثاً: الملاحظات', PLACEHOLDER);
    lines.push('', 'رابعاً: الخلاصة', PLACEHOLDER);
    lines.push('', 'معدّ التقرير: ' + PLACEHOLDER, 'التوقيع: ' + PLACEHOLDER);
    return lines.join('\n');
  }

  const head = input.docKind === 'memo'
    ? 'مذكرة رسمية' + (input.memoTypeName && input.memoTypeName.trim() ? ' — ' + input.memoTypeName.trim() : '')
    : 'خطاب رسمي';
  lines.push(head);
  lines.push('الرقم: ' + PLACEHOLDER);
  lines.push('التاريخ: ' + PLACEHOLDER);
  lines.push('إلى: ' + val(input.recipient));
  lines.push('الموضوع: ' + val(input.subject));
  if (caseLine) lines.push(caseLine);
  lines.push('', 'تحية طيبة وبعد،');
  if (input.tone === 'formal') lines.push('بخصوص الموضوع أعلاه، نبيّن ما يلي:');
  lines.push(...numbered);
  lines.push('', 'وتفضلوا بقبول فائق الاحترام والتقدير،،');
  lines.push('الاسم والصفة: ' + PLACEHOLDER, 'التوقيع: ' + PLACEHOLDER);
  return lines.join('\n');
}

// ===== الفحص الآلي للنص (بلا ذكاء اصطناعي) =====
export interface RuleFinding { code: string; message: string }

export function ruleCheck(text: string, docKind: DraftDocKind): RuleFinding[] {
  const out: RuleFinding[] = [];
  const t = String(text ?? '');
  const n = normalizeArabic(t);

  const ph = countPlaceholders(t);
  if (ph > 0) out.push({ code: 'placeholders', message: 'يوجد ' + ph + ' فراغ بانتظار التعبئة ' + PLACEHOLDER + '.' });

  if (docKind !== 'report') {
    if (!/الموضوع/.test(n)) out.push({ code: 'no_subject', message: 'لا يظهر سطر "الموضوع".' });
    if (!/الاحترام|التقدير|وتفضلوا|والسلام|تحيه/.test(n)) out.push({ code: 'no_closing', message: 'لا تظهر عبارة ختام رسمية.' });
    if (!/(^|\s)(الرقم|رقم)(\s|:|$)/.test(n)) out.push({ code: 'no_number', message: 'لا يظهر رقم المستند.' });
  }
  if (!/التاريخ|[0-9]{4}[/-][0-9]{1,2}[/-][0-9]{1,2}/.test(n)) out.push({ code: 'no_date', message: 'لا يظهر تاريخ المستند.' });

  const hasIndic = /[\u0660-\u0669]/.test(t);
  const hasLatin = /[0-9]/.test(t);
  if (hasIndic && hasLatin) out.push({ code: 'mixed_digits', message: 'خلط بين الأرقام الهندية والأرقام اللاتينية؛ وحّد نمط الأرقام.' });

  const long = t.split(/[.!؟?\n]+/).filter((s) => s.trim().split(/\s+/).length > 60).length;
  if (long > 0) out.push({ code: 'long_sentence', message: long + ' جملة تتجاوز 60 كلمة؛ يُفضَّل تقسيمها.' });

  if (/(^|\s)(\S{3,})\s+\2(?=\s|$|[.,،؛!؟?])/.test(t)) out.push({ code: 'repeated_word', message: 'توجد كلمة مكررة متتالية.' });
  if (/ {2,}/.test(t)) out.push({ code: 'double_space', message: 'توجد مسافات زائدة متتالية.' });

  const terms = verifySummaryAgainstSource(t, '').judgmentTerms;
  if (terms.length > 0) out.push({ code: 'judgment', message: 'عبارات حكمية/أمنية تستلزم تدقيقاً: ' + terms.join('، ') + '.' });
  return out;
}

// ===== تحليل ناتج المراجعة =====
export const REVIEW_REVISED_MARKER = 'المسودة المنقحة:';
export const REVIEW_NOTES_MARKER = 'ملاحظات المراجعة:';

export interface ParsedReview { revised: string; notes: string | null; wellFormed: boolean }

export function parseReviewOutput(text: string): ParsedReview {
  let t = String(text ?? '').trim();
  const ni = t.indexOf(REVIEW_NOTES_MARKER);
  let notes: string | null = null;
  if (ni >= 0) {
    notes = t.slice(ni + REVIEW_NOTES_MARKER.length).trim() || null;
    t = t.slice(0, ni).trim();
  }
  const ri = t.indexOf(REVIEW_REVISED_MARKER);
  const hadRevised = ri >= 0;
  if (hadRevised) t = t.slice(ri + REVIEW_REVISED_MARKER.length).trim();
  return { revised: t, notes, wellFormed: hadRevised && ni >= 0 };
}
