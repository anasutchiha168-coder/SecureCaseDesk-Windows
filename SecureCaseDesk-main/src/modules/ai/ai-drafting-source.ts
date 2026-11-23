// SECURECASEDESK_PHASE11_S4
// بناء بيانات الصياغة من مدخلات المستخدم فقط (+ سياق قضية اختياري منظَّم). لا يلمس قاعدة البيانات.
// لا تُدرج أسماء المدّعي والمتهمين آلياً أبداً (محلياً أو سحابياً)؛ ما يكتبه المستخدم بنفسه يراه كاملاً في المعاينة السحابية.
// السحابي: تُحذف الهويات والأرقام الطويلة والبريد والروابط من كل نص.

import { cleanSourceText } from './ai-summary-text';
import { fmtDay, type SummaryCaseRow } from './ai-summary-source';
import {
  DOC_KIND_LABEL, DRAFT_LIMITS, TONE_LABEL,
  type DraftDocKind, type DraftMode, type DraftTone,
} from './ai-drafting-text';

export type DraftCaseRow = Pick<SummaryCaseRow,
  'id' | 'case_number' | 'title' | 'case_type' | 'status' | 'registration_date' | 'incident_location' | 'incident_details'>;

export interface DraftingInput {
  mode: DraftMode;
  docKind: DraftDocKind;
  tone: DraftTone;
  memoTypeName?: string;
  recipient?: string;
  subject?: string;
  points?: string;
  existingText?: string;
  caseRow?: DraftCaseRow | null;
  includeCaseDetails?: boolean;
}

export interface DraftingSource {
  title: string;
  // سطور البيانات (تُوضع لاحقاً بين <<< و >>>).
  dataText: string;
  // كل نص كُتب أو سُحب من القضية (لمقارنة ما اختلقه النموذج).
  inputText: string;
  // ما يجب ألا يضيع من الأرقام في الناتج.
  mustKeep: string;
  redactions: number;
  caseLinked: boolean;
}

export function buildDraftingSource(input: DraftingInput, forCloud: boolean): DraftingSource {
  let redactions = 0;
  const lines: string[] = [];
  const typed: string[] = [];

  const one = (value: unknown, max: number): string => {
    const c = cleanSourceText(value, forCloud, max);
    redactions += c.redactions;
    return c.text.replace(/\n+/g, ' ');
  };
  const multi = (value: unknown, max: number): string => {
    const c = cleanSourceText(value, forCloud, max);
    redactions += c.redactions;
    return c.text;
  };

  const title = DOC_KIND_LABEL[input.docKind] + (input.mode === 'review' ? ' — مراجعة' : ' — صياغة');
  lines.push('نوع المستند: ' + DOC_KIND_LABEL[input.docKind]);

  if (input.mode === 'review') {
    const existing = multi(input.existingText, DRAFT_LIMITS.existing);
    lines.push('النص المطلوب مراجعته:\n' + existing);
    typed.push(existing);
    return { title, dataText: lines.join('\n'), inputText: typed.join('\n'), mustKeep: existing, redactions, caseLinked: false };
  }

  lines.push('الأسلوب: ' + TONE_LABEL[input.tone]);
  if (input.docKind === 'memo' && input.memoTypeName) {
    const t = one(input.memoTypeName, DRAFT_LIMITS.memoType);
    if (t) { lines.push('نوع المذكرة: ' + t); typed.push(t); }
  }
  const recipient = one(input.recipient, DRAFT_LIMITS.recipient);
  if (recipient) { lines.push('الجهة الموجّهة إليها: ' + recipient); typed.push(recipient); }
  const subject = one(input.subject, DRAFT_LIMITS.subject);
  if (subject) { lines.push('الموضوع: ' + subject); typed.push(subject); }
  const points = multi(input.points, DRAFT_LIMITS.points);
  if (points) { lines.push('النقاط المطلوب تضمينها:\n' + points); typed.push(points); }

  let caseLinked = false;
  const c = input.caseRow;
  if (c) {
    caseLinked = true;
    const ctx: string[] = [];
    const add = (label: string, v: unknown, max = 300) => {
      const s = one(v, max);
      if (s) ctx.push(label + ': ' + s);
    };
    add('رقم القضية', c.case_number, 100);
    add('عنوان القضية', c.title, 300);
    add('نوع القضية', c.case_type, 100);
    add('حالة القضية', c.status, 60);
    const day = fmtDay(c.registration_date);
    if (day) ctx.push('تاريخ تسجيل القضية: ' + day);
    add('مكان الحادث', c.incident_location, 300);
    if (input.includeCaseDetails === true) {
      const det = multi(c.incident_details, DRAFT_LIMITS.caseDetails);
      if (det) ctx.push('تفاصيل الحادث:\n' + det);
    }
    if (ctx.length > 0) {
      lines.push('بيانات القضية المرتبطة (للاسترشاد فقط؛ لا تضف منها إلا ما يلزم الموضوع):\n' + ctx.join('\n'));
      typed.push(ctx.join('\n'));
    }
  }
  // الأرقام التي كتبها المستخدم بنفسه يجب أن تبقى؛ بيانات القضية للاسترشاد فلا تُلزَم.
  const mustKeep = [subject, points, recipient].filter((x) => x).join('\n');
  return { title, dataText: lines.join('\n'), inputText: typed.join('\n'), mustKeep, redactions, caseLinked };
}
