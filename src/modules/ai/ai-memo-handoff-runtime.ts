// SECURECASEDESK_PHASE11_S5
// محوّل Expo لتسليم المسودة إلى نموذج المذكرة: يربط الوحدة النقية بقاعدة المستخدمين وسجل التدقيق.
// لا يستورد أي دالة كتابة للمذكرات: الحفظ الفعلي يتم يدوياً من شاشة المذكرات بعد مراجعة المستخدم.
import { getDb } from '@/database/db';
import { recordAuditEvent } from '@/services/audit.service';
import type { Session } from '@/security/guard';
import { createMemoHandoff, type HandoffInput, type MemoHandoff, type MemoPrefill } from './ai-memo-handoff';

let instance: MemoHandoff | null = null;

export function getMemoHandoff(): MemoHandoff {
  if (instance) return instance;
  instance = createMemoHandoff({
    async resolveActiveRole(userId) {
      const db = await getDb();
      const row = await db.getFirstAsync<{ role: string; is_active: number }>(
        'SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?', [userId]
      );
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
    now: () => Date.now(),
  });
  return instance;
}

export function stashMemoPrefill(session: Session | null | undefined, input: HandoffInput): Promise<MemoPrefill> {
  return getMemoHandoff().stash(session, input);
}

export function consumeMemoPrefill(session: Session | null | undefined): Promise<MemoPrefill | null> {
  return getMemoHandoff().consume(session);
}
