// SECURECASEDESK_PHASE8_S2
// حارس السلامة: Checkpoints مستقلة، منع الكتابة فوق سلسلة معبوث بها، وتنبيهات.

import * as SecureStore from 'expo-secure-store';
import { getDb } from '@/database/db';
import {
  buildCheckpoint, calculateRowHmac, constantTimeEqual,
  isCheckpointShape, parseVersion,
} from './audit-crypto';
import type { AuditLogRow, CheckpointRecord } from './audit-crypto';
import { detectQueueGaps } from './audit-verifier-core';
import type { Finding } from './audit-verifier-core';
import { getCheckpointKey, loadKey } from './audit-keys';

const LAST_CHECKPOINT_ITEM = 'securecase_audit_checkpoint_last';
const DB_CHECKPOINT_EVERY = 25;

let guardSuspended = false;

// تُستخدم فقط أثناء "قبول الاستعادة" الذي يجريه المدير ويُسجَّل في السلسلة.
export async function withCheckpointGuardSuspended<T>(fn: () => Promise<T>): Promise<T> {
  guardSuspended = true;
  try { return await fn(); } finally { guardSuspended = false; }
}

export async function readExternalCheckpoint(): Promise<{
  state: 'present' | 'missing' | 'corrupt';
  record?: CheckpointRecord;
}> {
  const raw = await SecureStore.getItemAsync(LAST_CHECKPOINT_ITEM);
  if (!raw) return { state: 'missing' };
  try {
    const parsed = JSON.parse(raw);
    return isCheckpointShape(parsed)
      ? { state: 'present', record: parsed }
      : { state: 'corrupt' };
  } catch {
    return { state: 'corrupt' };
  }
}

export async function readDatabaseCheckpoints(): Promise<CheckpointRecord[]> {
  const db = await getDb();
  return db.getAllAsync<CheckpointRecord>(
    `SELECT sequence_no, record_hash, entry_count, created_at, key_version, signature
     FROM audit_checkpoints ORDER BY sequence_no ASC`
  );
}

// لا يُخفَّض الـ Checkpoint أبداً إلا بقرار صريح (allowLower) أثناء قبول الاستعادة.
export async function writeCheckpoint(
  opts: { force?: boolean; allowLower?: boolean; reason?: string } = {}
): Promise<CheckpointRecord | null> {
  const db = await getDb();
  const last = await db.getFirstAsync<{
    sequence_no: number; record_hash: string; hmac_version: string;
  }>(
    'SELECT sequence_no, record_hash, hmac_version FROM audit_logs ORDER BY sequence_no DESC LIMIT 1'
  );
  if (!last) return null;

  const ext = await readExternalCheckpoint();

  if (!opts.allowLower) {
    if (ext.state === 'corrupt') return null; // نحافظ على الدليل ولا نكتب فوقه
    if (ext.state === 'present' && ext.record &&
        ext.record.sequence_no >= last.sequence_no) {
      return ext.record;
    }
  }

  const key = await getCheckpointKey(true);
  if (!key) return null;

  const record = buildCheckpoint(
    key,
    {
      sequence_no: last.sequence_no,
      record_hash: last.record_hash,
      key_version: parseVersion(last.hmac_version) ?? 0,
    },
    Date.now()
  );

  await SecureStore.setItemAsync(LAST_CHECKPOINT_ITEM, JSON.stringify(record));

  if (opts.force || last.sequence_no % DB_CHECKPOINT_EVERY === 0) {
    await db.runAsync(
      `INSERT OR IGNORE INTO audit_checkpoints
        (sequence_no, record_hash, entry_count, key_version, created_at, signature, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.sequence_no, record.record_hash, record.entry_count,
        record.key_version, record.created_at, record.signature,
        opts.reason ?? null,
      ]
    );
  }
  return record;
}

// ---------- فحص الفجوات في الطابور (يعمل قبل أي flush) ----------

export async function findQueueGaps(): Promise<number[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ queue_seq: number }>(
    `SELECT q.queue_seq FROM audit_event_queue q
     LEFT JOIN audit_logs l ON l.source_event_id = q.event_key
     WHERE l.source_event_id IS NULL
       AND q.queue_seq < COALESCE((
         SELECT MAX(q2.queue_seq) FROM audit_event_queue q2
         JOIN audit_logs l2 ON l2.source_event_id = q2.event_key
       ), 0)
     ORDER BY q.queue_seq LIMIT 100`
  );
  return rows.map((r) => r.queue_seq);
}

// ---------- تنبيهات السلامة ----------

export async function raiseIntegrityAlerts(findings: Finding[]): Promise<void> {
  const db = await getDb();
  for (const f of findings) {
    if (f.severity !== 'critical') continue;
    await db.runAsync(
      `INSERT OR IGNORE INTO audit_integrity_alerts
        (alert_key, code, severity, sequence_no, detail, detected_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [f.code + ':' + (f.sequence ?? 0), f.code, f.severity,
       f.sequence ?? null, f.detail, Date.now()]
    );
  }
}

async function alertAndThrow(code: Finding['code'], detail: string, seq?: number): Promise<never> {
  try {
    await raiseIntegrityAlerts([{ code, severity: 'critical', sequence: seq, detail }]);
  } catch { /* لا نخفي الخطأ الأصلي */ }
  throw new Error('AUDIT_CHAIN_TAMPERED');
}

// تُستدعى داخل flush قبل أي إلحاق: ترفض الإضافة فوق سلسلة معبوث بها.
export async function assertSafeToAppend(
  latest: AuditLogRow | null,
  pendingQueueSeqs: number[]
): Promise<void> {
  const db = await getDb();

  // 1) حذف سابق في الطابور: حدث قديم بلا سجل بينما حدث أحدث منه مسجّل.
  const maxFlushed = await db.getFirstAsync<{ m: number | null }>(
    `SELECT MAX(q.queue_seq) AS m FROM audit_event_queue q
     JOIN audit_logs l ON l.source_event_id = q.event_key`
  );
  const gaps = detectQueueGaps(pendingQueueSeqs, maxFlushed?.m ?? null);
  if (gaps.length > 0) {
    await alertAndThrow('QUEUE_EVENT_MISSING_FROM_CHAIN', gaps.length + ' queue event(s) missing');
  }

  if (!latest) {
    const ext = await readExternalCheckpoint();
    if (!guardSuspended && ext.state === 'present') {
      await alertAndThrow('TAIL_TRUNCATED', 'chain is empty but a checkpoint exists');
    }
    return;
  }

  // 2) توقيع آخر سجل سليم (فحص O(1)).
  const version = parseVersion(latest.hmac_version);
  const key = version ? await loadKey(version) : null;
  if (key) {
    const { record_hash, ...base } = latest;
    if (!constantTimeEqual(calculateRowHmac(key, base), record_hash)) {
      await alertAndThrow('INVALID_HMAC', 'latest record signature invalid', latest.sequence_no);
    }
  }

  // 3) الـ Checkpoint الخارجي لا يجوز أن يسبق السلسلة أو يخالفها.
  if (guardSuspended) return;
  const ext = await readExternalCheckpoint();
  if (ext.state === 'corrupt') {
    await alertAndThrow('CHECKPOINT_CORRUPT', 'external checkpoint unreadable');
  }
  if (ext.state === 'present' && ext.record) {
    if (ext.record.sequence_no > latest.sequence_no) {
      await alertAndThrow('TAIL_TRUNCATED', 'checkpoint ahead of chain', ext.record.sequence_no);
    }
    if (ext.record.sequence_no === latest.sequence_no &&
        !constantTimeEqual(ext.record.record_hash, latest.record_hash)) {
      await alertAndThrow('CHECKPOINT_MISMATCH', 'checkpoint hash differs', latest.sequence_no);
    }
  }
}
