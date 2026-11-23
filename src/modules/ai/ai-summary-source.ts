// SECURECASEDESK_PHASE11_S3
// بناء نص المصدر للتلخيص من صفوف سبق للطبقة المخوِّلة تمريرها (لا يلمس قاعدة البيانات).
// الوضع السحابي: تُحجب أسماء المدّعي والمتهمين من الحقول المنظَّمة، وتُحذف الهويات والبريد والروابط،
// ولا تُضمَّن بيانات محتجزين ولا مرفقات إطلاقاً (ممنوعة سحابياً بسياسة 11.1).

import { cleanSourceText, MAX_SOURCE_CHARS, type Fact } from './ai-summary-text';

// سقف الحقل السردي أعلى قليلاً من سقف المستند كي يُكتشف الاقتطاع ويُعلَن (لا اقتطاع صامت).
const NARRATIVE_CAP = MAX_SOURCE_CHARS + 1000;

export type SummaryKind = 'case' | 'memo';

export interface SummaryCaseRow {
  id: string; case_number: string; title: string; complainant: string | null; suspects: string | null;
  case_type: string; registration_date: number; incident_location: string | null;
  incident_details: string | null; status: string;
}
export interface SummaryMemoRow {
  id: string; memo_number: string; memo_type_id: string; memo_date: number; recipient_organization: string;
  subject: string; body: string | null; linked_case_id: string | null; status: string;
}

export interface SourceInput {
  kind: SummaryKind;
  caseRow?: SummaryCaseRow;
  memoRow?: SummaryMemoRow;
  memoTypeName?: string;
  // مذكرات مرتبطة بالقضية (تُمرَّر فقط إن كان المستخدم يملك memos.view وطلب تضمينها).
  linkedMemos?: readonly SummaryMemoRow[];
  // قضية مرتبطة بالمذكرة (تُمرَّر فقط إن كان المستخدم يملك cases.view وطلب تضمينها).
  linkedCase?: Pick<SummaryCaseRow, 'case_number' | 'title' | 'case_type' | 'status'> | null;
}

export interface SourceDoc {
  title: string;
  text: string;              // النص الكامل المُرسَل للمزوّد (مقسَّم لاحقاً)
  facts: Fact[];             // بيانات منظَّمة للاستخراج الآلي (محلي فقط)
  narrative: string;         // النص السردي الحر (تفاصيل الحادث/نص المذكرة)
  redactions: number;
  withheldFields: string[];  // حقول حُجبت من الحمولة السحابية
  linkedCount: number;
}

const MAX_LINKED_MEMOS = 20;
const LINKED_BODY_CHARS = 1500;

function p2(n: number): string { return n < 10 ? '0' + n : String(n); }
export function fmtDay(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate());
}

function one(value: unknown, redact: boolean, max = 400): { v: string; r: number } {
  const c = cleanSourceText(value, redact, max);
  return { v: c.text.replace(/\n+/g, ' '), r: c.redactions };
}

export function buildSourceDoc(input: SourceInput, forCloud: boolean): SourceDoc {
  let redactions = 0;
  const withheld: string[] = [];
  const lines: string[] = [];
  const facts: Fact[] = [];
  let narrative = '';
  let linkedCount = 0;

  const line = (label: string, value: unknown, max = 400, fact = true) => {
    const { v, r } = one(value, forCloud, max);
    redactions += r;
    if (!v) return;
    lines.push(label + ': ' + v);
    if (fact) facts.push({ label, value: v });
  };

  if (input.kind === 'case') {
    const c = input.caseRow;
    if (!c) throw new Error('caseRow مطلوب');
    lines.push('نوع المستند: قضية');
    line('رقم القضية', c.case_number, 100);
    line('العنوان', c.title, 300);
    line('نوع القضية', c.case_type, 100);
    line('الحالة', c.status, 60);
    const day = fmtDay(c.registration_date);
    if (day) { lines.push('تاريخ التسجيل: ' + day); facts.push({ label: 'تاريخ التسجيل', value: day }); }
    if (forCloud) {
      if (c.complainant && c.complainant.trim()) { lines.push('المدّعي: [محجوب]'); withheld.push('المدّعي'); }
      if (c.suspects && c.suspects.trim()) { lines.push('المتهمون: [محجوب]'); withheld.push('المتهمون'); }
    } else {
      line('المدّعي', c.complainant, 300);
      line('المتهمون', c.suspects, 500);
    }
    line('مكان الحادث', c.incident_location, 300);
    const det = cleanSourceText(c.incident_details, forCloud, NARRATIVE_CAP);
    redactions += det.redactions;
    narrative = det.text;
    if (det.text) lines.push('تفاصيل الحادث:\n' + det.text);

    const memos = (input.linkedMemos ?? []).slice(0, MAX_LINKED_MEMOS);
    if (memos.length > 0) {
      linkedCount = memos.length;
      lines.push('المذكرات المرتبطة (' + memos.length + '):');
      for (const m of memos) {
        const subj = one(m.subject, forCloud, 300); redactions += subj.r;
        const rec = one(m.recipient_organization, forCloud, 200); redactions += rec.r;
        const body = cleanSourceText(m.body, forCloud, LINKED_BODY_CHARS); redactions += body.redactions;
        lines.push('- مذكرة ' + m.memo_number + ' بتاريخ ' + fmtDay(m.memo_date) + ' إلى ' + rec.v + ' — الموضوع: ' + subj.v +
          (body.text ? '\n  النص: ' + body.text.replace(/\n+/g, ' ') : ''));
        if (body.text) narrative += (narrative ? '\n' : '') + body.text;
      }
    }
    return { title: 'قضية ' + c.case_number, text: lines.join('\n'), facts, narrative, redactions, withheldFields: withheld, linkedCount };
  }

  const m = input.memoRow;
  if (!m) throw new Error('memoRow مطلوب');
  lines.push('نوع المستند: مذكرة رسمية');
  line('رقم المذكرة', m.memo_number, 100);
  if (input.memoTypeName) line('نوع المذكرة', input.memoTypeName, 150);
  const day = fmtDay(m.memo_date);
  if (day) { lines.push('التاريخ: ' + day); facts.push({ label: 'التاريخ', value: day }); }
  line('الجهة الموجّهة إليها', m.recipient_organization, 300);
  line('الموضوع', m.subject, 400);
  line('الحالة', m.status, 60);
  if (input.linkedCase) {
    linkedCount = 1;
    const lc = input.linkedCase;
    const t = one(lc.title, forCloud, 300); redactions += t.r;
    lines.push('القضية المرتبطة: ' + lc.case_number + ' — ' + t.v + ' (' + lc.case_type + '، ' + lc.status + ')');
    facts.push({ label: 'القضية المرتبطة', value: lc.case_number + ' — ' + t.v });
  }
  const body = cleanSourceText(m.body, forCloud, NARRATIVE_CAP);
  redactions += body.redactions;
  narrative = body.text;
  if (body.text) lines.push('نص المذكرة:\n' + body.text);
  return { title: 'مذكرة ' + m.memo_number, text: lines.join('\n'), facts, narrative, redactions, withheldFields: withheld, linkedCount };
}
