// SECURECASEDESK_PHASE11_S5
// تسليم مسودة إلى نموذج المذكرة (زر «أنشئ مذكرة من المسودة»).
// القاعدة: هذه الوحدة لا تكتب أي سجل. تضع نصاً في الذاكرة فقط ليفتح به نموذج المذكرة «معبّأً دون حفظ»،
// والمستخدم هو من يراجع الحقول ويضغط «حفظ» بنفسه (وعندها تمر المذكرة بكل فحوص insertMemo المعتادة).
//
// الضمانات:
//  - الذاكرة فقط (لا SecureStore ولا قاعدة بيانات ولا ملف ولا معاملات مسار)؛ تُستهلك مرة واحدة ثم تُمسح.
//  - مرتبطة بالمستخدم الذي أنشأها وبصلاحيته الحالية في الجدول (memos.manage)، وتنتهي خلال 10 دقائق.
//  - نص مولَّد بالذكاء الاصطناعي لا يُقبل إلا إن كان مسودة معتمدة بشرياً (assertDraftAccepted).
//  - رقم المذكرة لا يُملأ أبداً (يكتبه المستخدم)، والفراغات [......] تبقى ظاهرة وتُحصى للتنبيه.
//  - يُسجَّل في التدقيق حدث بلا نص: المصدر، عدد الأحرف، عدد الفراغات، هل رُبطت قضية.

import { can } from '../../security/permissions';
import { ForbiddenError, requirePerm, type Session } from '../../security/guard';
import { AiError } from './ai-types';
import { assertDraftAccepted, type AiDraft } from './ai-review';
import { DRAFT_LIMITS, MAX_DRAFT_CHARS, PLACEHOLDER, countPlaceholders } from './ai-drafting-text';
import type { AiAuditEvent } from './ai-manager';

export const HANDOFF_TTL_MS = 10 * 60 * 1000;
export const HANDOFF_PERMISSION = 'memos.manage' as const;

export type HandoffOrigin = 'template' | 'ai_accepted';

export interface MemoPrefill {
  userId: string;
  origin: HandoffOrigin;
  recipient: string;
  subject: string;
  body: string;
  memoTypeName: string;
  caseId: string | null;
  placeholders: number;
  createdAt: number;
}

export interface HandoffInput {
  // template: نص القالب الآلي (من كتابة المستخدم). ai_accepted: يجب تمرير المسودة المعتمدة.
  origin: HandoffOrigin;
  text?: string;
  draft?: AiDraft;
  recipient?: string;
  subject?: string;
  memoTypeName?: string;
  caseId?: string | null;
}

export interface HandoffDeps {
  resolveActiveRole(userId: string): Promise<string | null>;
  audit(event: AiAuditEvent): Promise<void>;
  now(): number;
}

export interface MemoHandoff {
  stash(session: Session | null | undefined, input: HandoffInput): Promise<MemoPrefill>;
  consume(session: Session | null | undefined): Promise<MemoPrefill | null>;
  peekExists(): boolean;
  clear(): void;
}

// ===== تحليل النص (نقي) =====
const TITLE_RE = /^مذكرة(?:\s|—|-|$)/;
const NUMBER_RE = /^الرقم\s*[:：]/;
const DATE_RE = /^التاريخ\s*[:：]/;
const TO_RE = /^إلى\s*[:：]\s*(.*)$/;
const SUBJECT_RE = /^الموضوع\s*[:：]\s*(.*)$/;

function cleanValue(v: string, max: number): string {
  const t = v.trim();
  if (t.length === 0) return '';
  // قيمة كلها فراغ [......] = لا قيمة (يملؤها المستخدم بنفسه).
  if (countPlaceholders(t) > 0 && t.replace(/\[(?:\.{2,}|\u2026+)\]/g, '').trim().length === 0) return '';
  return t.slice(0, max);
}

export interface SplitMemoText { recipient: string; subject: string; body: string; headerLines: number }

// يفصل ترويسة المذكرة (العنوان/الرقم/التاريخ/إلى/الموضوع) عن المتن حتى لا تتكرر في الطباعة؛ المتن يبقى حرفياً.
export function splitMemoText(text: string): SplitMemoText {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let recipient = '';
  let subject = '';
  let header = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && TITLE_RE.test(lines[i].trim())) { i++; header++; }
  while (i < lines.length) {
    const l = lines[i].trim();
    if (l === '') { if (header > 0) { i++; continue; } break; }
    const to = TO_RE.exec(l);
    const sub = SUBJECT_RE.exec(l);
    if (to) { recipient = cleanValue(to[1], DRAFT_LIMITS.recipient); i++; header++; continue; }
    if (sub) { subject = cleanValue(sub[1], DRAFT_LIMITS.subject); i++; header++; continue; }
    if (NUMBER_RE.test(l) || DATE_RE.test(l)) { i++; header++; continue; }
    break;
  }
  return { recipient, subject, body: lines.slice(i).join('\n').trim(), headerLines: header };
}

export function createMemoHandoff(deps: HandoffDeps): MemoHandoff {
  let slot: MemoPrefill | null = null;

  async function activeRole(userId: string): Promise<string | null> {
    try { return await deps.resolveActiveRole(userId); } catch { return null; }
  }

  return {
    async stash(session, input) {
      const s = requirePerm(session, HANDOFF_PERMISSION);
      const role = await activeRole(s.userId);
      if (!role || !can(role, HANDOFF_PERMISSION)) throw new ForbiddenError(HANDOFF_PERMISSION);

      let text: string;
      if (input.origin === 'ai_accepted') {
        if (!input.draft) throw new AiError('REVIEW_REQUIRED');
        text = assertDraftAccepted(input.draft); // يرفض أي مسودة لم تُعتمد (REVIEW_REQUIRED)
        // الاعتماد والطلب من المستخدم نفسه: لا تسليم مسودة طلبها أو اعتمدها غيره.
        if (input.draft.requestedBy !== s.userId || input.draft.reviewedBy !== s.userId) throw new AiError('REVIEW_INVALID', 'owner');
      } else if (input.origin === 'template') {
        text = typeof input.text === 'string' ? input.text : '';
      } else {
        throw new AiError('REVIEW_INVALID', 'origin');
      }
      if (text.trim().length === 0 || text.length > MAX_DRAFT_CHARS) throw new AiError('DRAFTING_INPUT_INVALID', 'handoff');

      const parts = splitMemoText(text);
      const prefill: MemoPrefill = {
        userId: s.userId,
        origin: input.origin,
        recipient: parts.recipient || cleanValue(String(input.recipient ?? ''), DRAFT_LIMITS.recipient),
        subject: parts.subject || cleanValue(String(input.subject ?? ''), DRAFT_LIMITS.subject),
        body: parts.body,
        memoTypeName: String(input.memoTypeName ?? '').trim().slice(0, DRAFT_LIMITS.memoType),
        caseId: typeof input.caseId === 'string' && input.caseId.length > 0 && input.caseId.length <= 64 ? input.caseId : null,
        placeholders: countPlaceholders(text),
        createdAt: deps.now(),
      };

      // التدقيق قبل التسليم: فشله يمنع التسليم (لا مسودة بلا أثر). لا نص في السجل.
      try {
        await deps.audit({
          operationType: 'ai_memo_prefill', entityType: 'ai', entityId: 'memo_prefill',
          newValues: { origin: prefill.origin, chars: text.length, placeholders: prefill.placeholders, caseLinked: prefill.caseId !== null },
          reason: 'فتح نموذج مذكرة معبّأً من مسودة (دون حفظ)', actorUserId: s.userId,
        });
      } catch {
        throw new AiError('AUDIT_FAILED');
      }
      slot = prefill;
      return { ...prefill };
    },

    async consume(session) {
      const taken = slot;
      slot = null; // مرة واحدة دائماً، حتى لو فشل أي فحص بعدها
      if (!taken || !session) return null;
      if (taken.userId !== session.userId) return null;
      if (deps.now() - taken.createdAt > HANDOFF_TTL_MS || deps.now() < taken.createdAt) return null;
      const role = await activeRole(session.userId);
      if (!role || !can(role, HANDOFF_PERMISSION)) return null;
      return taken;
    },

    peekExists() { return slot !== null; },
    clear() { slot = null; },
  };
}

export { PLACEHOLDER };
