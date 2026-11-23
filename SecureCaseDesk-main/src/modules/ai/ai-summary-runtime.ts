// SECURECASEDESK_PHASE11_S3
// محوّل Expo للتلخيص الذكي: يربط المنسّق بقاعدة البيانات عبر خدمات القضايا والمذكرات الموجودة
// (وهي تفرض requirePerm بنفسها)، وبمنسّق الذكاء الاصطناعي وسجل التدقيق.
// ⚠️ لم يُختبر على جهاز Android حقيقي بعد.

import * as Crypto from 'expo-crypto';
import { getDb } from '@/database/db';
import { recordAuditEvent } from '@/services/audit.service';
import { listCases } from '@/services/cases.service';
import { listMemoTypes, listMemos } from '@/services/memos.service';
import { getAiManager } from './ai-runtime';
import { createAiSummary, type AiSummary } from './ai-summary';

let instance: AiSummary | null = null;

export function getAiSummary(): AiSummary {
  if (instance) return instance;
  instance = createAiSummary({
    manager: getAiManager(),
    async resolveActiveRole(userId) {
      const db = await getDb();
      const row = await db.getFirstAsync<{ role: string; is_active: number }>(
        'SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?', [userId]
      );
      return row && Number(row.is_active) === 1 ? String(row.role) : null;
    },
    loadCases: (s) => listCases(s),
    loadMemos: (s) => listMemos(s),
    loadMemoTypes: (s) => listMemoTypes(s),
    async audit(event) {
      const db = await getDb();
      const u = await db.getFirstAsync<{ username: string }>(
        'SELECT username FROM users WHERE id = ?', [event.actorUserId]
      );
      await recordAuditEvent({
        operationType: event.operationType,
        entityType: event.entityType,
        entityId: event.entityId,
        previousValues: event.previousValues,
        newValues: event.newValues,
        reason: event.reason,
        actor: { id: event.actorUserId, username: u?.username ?? null },
      });
    },
    newId: () => Crypto.randomUUID(),
    now: () => Date.now(),
  });
  return instance;
}
