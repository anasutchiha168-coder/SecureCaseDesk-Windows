// SECURECASEDESK_REPORT_AI_SUMMARY — محوّل Expo لتلخيص التقارير بالذكاء الاصطناعي.
// يبني مستند التقرير عبر buildReport (فيفرض صلاحيات التقرير والنطاق) ثم يمرّره لمنسّق الذكاء.
// ⚠️ لم يُختبر على جهاز Android حقيقي بعد.

import * as Crypto from 'expo-crypto';
import { getDb } from '@/database/db';
import type { Session } from '@/security/guard';
import type { DbLike } from '@/modules/attachments/attachments-repo';
import { recordAuditEvent } from '@/services/audit.service';
import { getAiManager } from '@/modules/ai/ai-runtime';
import { createReportAi, type ReportAi, type ReportAiPrepare, type ReportAiResult } from '@/modules/ai/ai-report-summary';
import type { AiDraft } from '@/modules/ai/ai-review';
import { buildReport } from '@/modules/reports/reports-data';
import type { ReportFilters } from '@/modules/reports/reports-types';

export type { ReportAiPrepare, ReportAiResult, AiDraft };

let instance: ReportAi | null = null;
function ai(): ReportAi {
  if (instance) return instance;
  instance = createReportAi({
    manager: getAiManager(),
    async resolveActiveRole(userId) {
      const db = await getDb();
      const row = await db.getFirstAsync<{ role: string; is_active: number }>('SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?', [userId]);
      return row && Number(row.is_active) === 1 ? String(row.role) : null;
    },
    async audit(event) {
      const db = await getDb();
      const u = await db.getFirstAsync<{ username: string }>('SELECT username FROM users WHERE id = ?', [event.actorUserId]);
      await recordAuditEvent({
        operationType: event.operationType, entityType: event.entityType, entityId: event.entityId,
        previousValues: event.previousValues, newValues: event.newValues, reason: event.reason,
        actor: { id: event.actorUserId, username: u?.username ?? null },
      });
    },
    newId: () => Crypto.randomUUID(),
    now: () => Date.now(),
  });
  return instance;
}

async function doc(session: Session | null | undefined, kind: string, filters: ReportFilters) {
  const db = (await getDb()) as unknown as DbLike;
  return buildReport({ db, now: () => Date.now() }, session, kind, filters);
}

export async function prepareReportAi(session: Session | null | undefined, kind: string, filters: ReportFilters = {}): Promise<ReportAiPrepare> {
  return ai().prepare(session, await doc(session, kind, filters));
}

export async function summarizeReportAi(
  session: Session | null | undefined, kind: string, filters: ReportFilters,
  opts: { confirmCloud?: boolean; confirmedToken?: string }, signal?: AbortSignal
): Promise<ReportAiResult> {
  return ai().summarize(session, await doc(session, kind, filters), opts, signal);
}

export async function reviewReportAi(
  session: Session | null | undefined, kind: string, filters: ReportFilters,
  draft: AiDraft, decision: 'accept' | 'reject', editedText?: string
): Promise<{ draft: AiDraft; finalText: string | null }> {
  return ai().reviewDraft(session, draft, await doc(session, kind, filters), decision, editedText);
}
