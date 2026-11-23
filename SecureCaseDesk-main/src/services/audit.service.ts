// SECURECASEDESK_PHASE8_S1+S2
// محرك سجل التدقيق المتسلسل HMAC-SHA256 — يستبدل الملف السابق بالكامل.
// التحقق الكامل انتقل إلى audit-integrity.service.ts، وتبقى verifyAuditChain هنا للتوافق.

import * as Crypto from 'expo-crypto';
import { getDb } from '@/database/db';
import {
  GENESIS_HASH, calculateRowHmac,
} from '@/security/audit-crypto';
import type { AuditLogRow, AuditRowBase } from '@/security/audit-crypto';
import { getSigningKey } from '@/security/audit-keys';
import { assertSafeToAppend, writeCheckpoint } from '@/security/audit-integrity-guard';
import { runAuditIntegritySelfTest } from '@/security/audit-verifier-core';

export type { AuditLogRow } from '@/security/audit-crypto';
export { runAuditIntegritySelfTest } from '@/security/audit-verifier-core';

export interface AuditActor {
  id: string | null;
  username: string | null;
}

export interface AuditEventInput {
  operationType: string;
  entityType: string;
  entityId?: string | null;
  previousValues?: unknown;
  newValues?: unknown;
  reason?: string | null;
  actor?: AuditActor;
  // مفتاح فريد للحدث: إعادة تسجيل نفس المفتاح تُتجاهل (منع تكرار الأحداث).
  eventKey?: string;
}

interface QueueRow {
  queue_seq: number;
  event_key: string;
  actor_user_id: string | null;
  actor_username: string | null;
  operation_type: string;
  entity_type: string;
  entity_id: string | null;
  previous_values: string | null;
  new_values: string | null;
  correction_reason: string | null;
  created_at: number;
}

let flushPromise: Promise<void> | null = null;
let flushRequestedAgain = false;

export async function setAuditActor(actor: AuditActor | null): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO audit_context (id, actor_user_id, actor_username, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       actor_user_id = excluded.actor_user_id,
       actor_username = excluded.actor_username,
       updated_at = excluded.updated_at`,
    [actor?.id ?? null, actor?.username ?? null, Date.now()]
  );
}

export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  const db = await getDb();
  let actor = input.actor;

  if (!actor) {
    const context = await db.getFirstAsync<{
      actor_user_id: string | null; actor_username: string | null;
    }>('SELECT actor_user_id, actor_username FROM audit_context WHERE id = 1');
    actor = {
      id: context?.actor_user_id ?? null,
      username: context?.actor_username ?? null,
    };
  }

  // INSERT OR IGNORE: تكرار eventKey لا ينتج حدثاً ثانياً.
  await db.runAsync(
    `INSERT OR IGNORE INTO audit_event_queue (
       event_key, actor_user_id, actor_username, operation_type,
       entity_type, entity_id, previous_values, new_values,
       correction_reason, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.eventKey ?? Crypto.randomUUID(),
      actor.id, actor.username, input.operationType, input.entityType,
      input.entityId ?? null,
      input.previousValues === undefined ? null : JSON.stringify(input.previousValues),
      input.newValues === undefined ? null : JSON.stringify(input.newValues),
      input.reason ?? null,
      Date.now(),
    ]
  );

  await flushAuditQueue();
}

// يُلحق دفعة واحدة؛ يعيد true إن ألحق شيئاً.
async function flushOnce(): Promise<boolean> {
  const db = await getDb();

  const pending = await db.getAllAsync<QueueRow>(`
    SELECT q.* FROM audit_event_queue q
    LEFT JOIN audit_logs l ON l.source_event_id = q.event_key
    WHERE l.source_event_id IS NULL
    ORDER BY q.queue_seq ASC
  `);
  if (pending.length === 0) return false;

  const latest = await db.getFirstAsync<AuditLogRow>(
    'SELECT * FROM audit_logs ORDER BY sequence_no DESC LIMIT 1'
  );

  // يرفض الإلحاق فوق سلسلة معبوث بها أو مبتورة النهاية.
  await assertSafeToAppend(latest ?? null, pending.map((p) => p.queue_seq));

  const signing = await getSigningKey(latest ?? null);

  await db.withTransactionAsync(async () => {
    const tip = await db.getFirstAsync<{ sequence_no: number; record_hash: string }>(
      'SELECT sequence_no, record_hash FROM audit_logs ORDER BY sequence_no DESC LIMIT 1'
    );
    let sequence = (tip?.sequence_no ?? 0) + 1;
    let previousHash = tip?.record_hash ?? GENESIS_HASH;

    for (const event of pending) {
      const exists = await db.getFirstAsync<{ sequence_no: number }>(
        'SELECT sequence_no FROM audit_logs WHERE source_event_id = ?',
        [event.event_key]
      );
      if (exists) continue;

      const base: AuditRowBase = {
        sequence_no: sequence,
        operation_id: Crypto.randomUUID(),
        source_event_id: event.event_key,
        user_id: event.actor_user_id,
        username: event.actor_username,
        operation_type: event.operation_type,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        previous_values: event.previous_values,
        new_values: event.new_values,
        correction_reason: event.correction_reason,
        created_at: event.created_at,
        previous_hash: previousHash,
        hmac_version: signing.label,
      };
      const hash = calculateRowHmac(signing.key, base);

      await db.runAsync(
        `INSERT INTO audit_logs (
          sequence_no, operation_id, source_event_id, user_id, username,
          operation_type, entity_type, entity_id, previous_values, new_values,
          correction_reason, created_at, previous_hash, record_hash, hmac_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          base.sequence_no, base.operation_id, base.source_event_id,
          base.user_id, base.username, base.operation_type, base.entity_type,
          base.entity_id, base.previous_values, base.new_values,
          base.correction_reason, base.created_at, base.previous_hash,
          hash, base.hmac_version,
        ]
      );

      previousHash = hash;
      sequence += 1;
    }
  });

  return true;
}

async function drainQueue(): Promise<void> {
  // حلقة تصريف: أحداث وصلت أثناء الإلحاق لا تضيع.
  for (let i = 0; i < 50; i++) {
    flushRequestedAgain = false;
    const appended = await flushOnce();
    if (!appended && !flushRequestedAgain) break;
  }
  // Checkpoint بعد كل تصريف (لا يُخفَّض أبداً).
  await writeCheckpoint();
}

export function flushAuditQueue(): Promise<void> {
  if (flushPromise) {
    flushRequestedAgain = true;
    return flushPromise;
  }
  flushPromise = drainQueue().finally(() => { flushPromise = null; });
  return flushPromise;
}

export async function assertAuditAdmin(userId: string): Promise<void> {
  const db = await getDb();
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(users)');
  const hasActive = columns.some((x) => x.name === 'is_active');

  const row = await db.getFirstAsync<{ role: string; is_active: number }>(
    hasActive
      ? 'SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?'
      : 'SELECT role, 1 AS is_active FROM users WHERE id = ?',
    [userId]
  );

  if (!row || Number(row.is_active) !== 1 ||
      String(row.role).toLowerCase() !== 'admin') {
    throw new Error('FORBIDDEN');
  }
}

export interface AuditFilters {
  query?: string; offset?: number; limit?: number;
  from?: number | null; to?: number | null;
}

export async function getAuditLogs(
  userId: string,
  filters: AuditFilters = {}
): Promise<AuditLogRow[]> {
  await assertAuditAdmin(userId);
  await flushAuditQueue();

  const db = await getDb();
  const query = (filters.query ?? '').trim();
  const like = '%' + query + '%';
  const offset = Math.max(0, filters.offset ?? 0);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 30));
  const from = filters.from ?? null;
  const to = filters.to ?? null;

  return db.getAllAsync<AuditLogRow>(
    `SELECT * FROM audit_logs
     WHERE (? = '' OR username LIKE ? OR operation_type LIKE ?
            OR entity_type LIKE ? OR entity_id LIKE ? OR operation_id LIKE ?)
     AND (? IS NULL OR created_at >= ?)
     AND (? IS NULL OR created_at <= ?)
     ORDER BY sequence_no DESC LIMIT ? OFFSET ?`,
    [query, like, like, like, like, like, from, from, to, to, limit, offset]
  );
}

// ---------- واجهة التوافق مع القسم الأول (audit.tsx و audit-protection-test.ts) ----------

export interface AuditVerification {
  ok: boolean;
  count: number;
  code: string;
  badSequence?: number;
}

export async function verifyAuditChain(
  userId: string
): Promise<AuditVerification & { selfTest: ReturnType<typeof runAuditIntegritySelfTest> }> {
  await assertAuditAdmin(userId);

  const selfTest = runAuditIntegritySelfTest();
  if (!selfTest.ok) {
    return { ok: false, count: 0, code: 'SELF_TEST_FAILED', selfTest };
  }

  // استيراد متأخر لتجنب الدورة بين الملفين.
  const { verifyAuditChainFull } = await import('./audit-integrity.service');
  const report = await verifyAuditChainFull(userId);

  const code = report.status === 'VALID'
    ? 'VALID'
    : report.firstFailure?.code ??
      report.findings.find((f) => f.severity === 'unverifiable')?.code ??
      'UNKNOWN';

  return {
    ok: report.ok,
    count: report.count,
    code,
    badSequence: report.firstFailure?.sequence,
    selfTest,
  };
}
