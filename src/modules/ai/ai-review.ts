// SECURECASEDESK_PHASE11_S1
// المراجعة البشرية الإلزامية. أي نص يولّده الذكاء الاصطناعي يبدأ "بانتظار المراجعة"،
// ولا يجوز لأي كود كتابته في سجل حقيقي إلا عبر assertDraftAccepted بعد اعتماد مستخدم فعلي.
// لا تعديل ذاتي للسجلات: هذه الوحدة لا تعرف شيئاً عن قاعدة البيانات أصلاً.

import { AiError, type AiFeatureId } from './ai-types';
import type { AiProviderId } from './ai-provider';

export type AiDraftStatus = 'pending_review' | 'accepted' | 'rejected';

export interface AiDraft {
  readonly id: string;
  readonly feature: AiFeatureId;
  readonly providerId: AiProviderId;
  readonly generatedText: string;
  // النص النهائي بعد تحرير المراجع (يساوي المولَّد إن لم يُحرَّر).
  readonly finalText: string;
  readonly status: AiDraftStatus;
  readonly requestedBy: string;
  readonly createdAt: number;
  readonly reviewedBy: string | null;
  readonly reviewedAt: number | null;
  readonly edited: boolean;
}

export function createAiDraft(input: {
  id: string; feature: AiFeatureId; providerId: AiProviderId;
  text: string; requestedBy: string; now: number;
}): AiDraft {
  if (!input.id || !input.requestedBy) throw new AiError('REVIEW_INVALID');
  return Object.freeze({
    id: input.id, feature: input.feature, providerId: input.providerId,
    generatedText: input.text, finalText: input.text,
    status: 'pending_review' as const,
    requestedBy: input.requestedBy, createdAt: input.now,
    reviewedBy: null, reviewedAt: null, edited: false,
  });
}

function review(draft: AiDraft, status: 'accepted' | 'rejected', reviewerId: string, now: number, editedText?: string): AiDraft {
  if (draft.status !== 'pending_review') throw new AiError('REVIEW_INVALID', 'already-reviewed');
  if (!reviewerId) throw new AiError('REVIEW_INVALID', 'reviewer');
  const finalText = status === 'accepted' && typeof editedText === 'string' ? editedText : draft.generatedText;
  if (status === 'accepted' && finalText.trim().length === 0) throw new AiError('REVIEW_INVALID', 'empty');
  return Object.freeze({
    ...draft,
    status,
    finalText: status === 'accepted' ? finalText : draft.finalText,
    edited: status === 'accepted' && finalText !== draft.generatedText,
    reviewedBy: reviewerId,
    reviewedAt: now,
  });
}

export function acceptAiDraft(draft: AiDraft, reviewerId: string, now: number, editedText?: string): AiDraft {
  return review(draft, 'accepted', reviewerId, now, editedText);
}

export function rejectAiDraft(draft: AiDraft, reviewerId: string, now: number): AiDraft {
  return review(draft, 'rejected', reviewerId, now);
}

// الحارس الذي يجب أن يمر منه أي كود يريد استعمال نص مولَّد: يعيد النص النهائي المعتمد فقط.
export function assertDraftAccepted(draft: AiDraft): string {
  if (draft.status !== 'accepted' || !draft.reviewedBy || draft.reviewedAt === null) {
    throw new AiError('REVIEW_REQUIRED');
  }
  return draft.finalText;
}
