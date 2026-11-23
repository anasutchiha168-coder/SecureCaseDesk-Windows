// SECURECASEDESK_PHASE8_S3
// مزامنة أحداث التدقيق مع الخادم المركزي.
// - السجلات تُحفظ محلياً دائماً (offline-first)؛ الصندوق الصادر جدول تشغيلي منفصل.
// - لا يُعتبر الحدث "مُرسَلاً" إلا بإقرار صريح من الخادم، ولا يُحذف أي صف.
// - مفتاح HMAC لا يغادر الجهاز أبداً؛ الخادم يتحقق من التسلسل وربط السلسلة فقط.
// - التعارض يوقف الإرسال عند ذلك الحدث ويبقى ظاهراً، ولا يُكتب فوقه شيء.

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb } from '@/database/db';
import { requirePerm, type Session } from '@/security/guard';
import { recordAuditEvent, type AuditEventInput } from '@/services/audit.service';

const URL_KEY = 'securecase_api_url';
const TOKEN_KEY = 'securecase_api_token';
const BATCH_SIZE = 50;
const MAX_BATCHES_PER_RUN = 20;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

export type OutboxStatus = 'pending' | 'sent' | 'failed' | 'conflict' | 'rejected';
export type SyncState =
  | 'never' | 'ok' | 'offline' | 'denied' | 'error' | 'conflict' | 'not_configured';

export type SyncRunStatus =
  | 'not_configured' | 'idle' | 'ok' | 'waiting' | 'offline'
  | 'denied' | 'blocked' | 'conflict' | 'error';

export interface SyncRunResult {
  status: SyncRunStatus;
  sent: number;
  failed: number;
  conflicts: number;
  pendingAfter: number;
  message: string;
}

export interface SyncOptions {
  db?: SQLiteDatabase;
  baseUrl?: string | null;
  token?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onEvent?: (event: AuditEventInput) => Promise<void>;
}

const readyDbs = new WeakSet<object>();
let running: Promise<SyncRunResult> | null = null;

export async function ensureOutboxSchema(db: SQLiteDatabase): Promise<void> {
  if (readyDbs.has(db)) return;

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS audit_sync_outbox (
      sequence_no INTEGER PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','sent','failed','conflict','rejected')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at INTEGER,
      next_retry_at INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER,
      queued_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_id TEXT NOT NULL,
      last_result TEXT NOT NULL DEFAULT 'never',
      last_attempt_at INTEGER,
      last_success_at INTEGER,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_outbox_status
      ON audit_sync_outbox(status, sequence_no);

    CREATE TRIGGER IF NOT EXISTS trg_audit_outbox_no_delete
    BEFORE DELETE ON audit_sync_outbox
    BEGIN
      SELECT RAISE(ABORT, 'صندوق مزامنة التدقيق غير قابل للحذف');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_outbox_keys_immutable
    BEFORE UPDATE OF sequence_no, operation_id, queued_at ON audit_sync_outbox
    BEGIN
      SELECT RAISE(ABORT, 'مفاتيح صندوق المزامنة غير قابلة للتعديل');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_outbox_sent_final
    BEFORE UPDATE OF status ON audit_sync_outbox
    WHEN OLD.status = 'sent' AND NEW.status <> 'sent'
    BEGIN
      SELECT RAISE(ABORT, 'لا يُعاد فتح حدث تمت مزامنته');
    END;
  `);

  readyDbs.add(db);
}

// يضيف إلى الصندوق كل سجل تدقيق جديد (idempotent): التكرار لا ينشئ صفوفاً مضاعفة.
export async function queueNewAuditRows(db: SQLiteDatabase, now: number): Promise<number> {
  await ensureOutboxSchema(db);
  const result = await db.runAsync(
    `INSERT OR IGNORE INTO audit_sync_outbox (sequence_no, operation_id, status, queued_at)
     SELECT l.sequence_no, l.operation_id, 'pending', ?
     FROM audit_logs l
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_sync_outbox o WHERE o.sequence_no = l.sequence_no
     )
     ORDER BY l.sequence_no ASC`,
    [now]
  );
  return result.changes;
}

async function getState(db: SQLiteDatabase, now: number): Promise<{
  device_id: string; last_result: SyncState;
  last_attempt_at: number | null; last_success_at: number | null; last_error: string | null;
}> {
  const existing = await db.getFirstAsync<{
    device_id: string; last_result: SyncState;
    last_attempt_at: number | null; last_success_at: number | null; last_error: string | null;
  }>('SELECT * FROM audit_sync_state WHERE id = 1');
  if (existing) return existing;

  const deviceId = Crypto.randomUUID();
  await db.runAsync(
    `INSERT OR IGNORE INTO audit_sync_state (id, device_id, last_result, last_attempt_at)
     VALUES (1, ?, 'never', ?)`,
    [deviceId, now]
  );
  const created = await db.getFirstAsync<{
    device_id: string; last_result: SyncState;
    last_attempt_at: number | null; last_success_at: number | null; last_error: string | null;
  }>('SELECT * FROM audit_sync_state WHERE id = 1');
  if (!created) throw new Error('SYNC_STATE_UNAVAILABLE');
  return created;
}

async function setState(
  db: SQLiteDatabase,
  result: SyncState,
  now: number,
  error: string | null,
  success: boolean
): Promise<void> {
  await db.runAsync(
    `UPDATE audit_sync_state SET
       last_result = ?, last_attempt_at = ?, last_error = ?,
       last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END
     WHERE id = 1`,
    [result, now, error, success ? 1 : 0, now]
  );
}

export async function readSyncConfig(): Promise<{ baseUrl: string | null; token: string | null }> {
  const envUrl = process.env.EXPO_PUBLIC_API_URL ?? null;
  const [storedUrl, token] = await Promise.all([
    SecureStore.getItemAsync(URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  return { baseUrl: storedUrl || envUrl, token: token || null };
}

function isSecureUrl(url: string): boolean {
  return /^https:\/\/[^\s/]+/i.test(url);
}

function backoff(retry: number): number {
  return Math.min(MAX_BACKOFF_MS, 5000 * 2 ** Math.min(retry, 10));
}

interface OutboxRow {
  sequence_no: number;
  operation_id: string;
  status: OutboxStatus;
  retry_count: number;
  next_retry_at: number;
}

interface ServerReceipt {
  accepted?: number[];
  duplicates?: number[];
  conflicts?: { sequence_no: number; reason?: string }[];
  rejected?: { sequence_no: number; reason?: string }[];
}

async function markRows(
  db: SQLiteDatabase,
  seqs: number[],
  status: OutboxStatus,
  now: number,
  error: string | null,
  retryDelay: number | null
): Promise<void> {
  if (seqs.length === 0) return;
  await db.withTransactionAsync(async () => {
    for (const seq of seqs) {
      await db.runAsync(
        `UPDATE audit_sync_outbox SET
           status = ?, last_error = ?, last_attempt_at = ?,
           retry_count = retry_count + CASE WHEN ? IN ('failed') THEN 1 ELSE 0 END,
           next_retry_at = ?,
           sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
         WHERE sequence_no = ? AND status <> 'sent'`,
        [status, error, now, status, retryDelay === null ? 0 : now + retryDelay, status, now, seq]
      );
    }
  });
}

async function countPending(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM audit_sync_outbox WHERE status IN ('pending','failed')`
  );
  return row?.c ?? 0;
}

async function runSync(options: SyncOptions): Promise<SyncRunResult> {
  const db = options.db ?? (await getDb());
  const now = options.now ?? Date.now;
  const fetchFn = options.fetchImpl ?? fetch;
  const emit = options.onEvent ?? recordAuditEvent;

  await ensureOutboxSchema(db);
  await queueNewAuditRows(db, now());
  const state = await getState(db, now());

  const config = options.baseUrl !== undefined || options.token !== undefined
    ? { baseUrl: options.baseUrl ?? null, token: options.token ?? null }
    : await readSyncConfig();

  const result: SyncRunResult = {
    status: 'idle', sent: 0, failed: 0, conflicts: 0, pendingAfter: 0, message: '',
  };

  const finish = async (
    status: SyncRunStatus, message: string
  ): Promise<SyncRunResult> => {
    result.status = status;
    result.message = message;
    result.pendingAfter = await countPending(db);
    return result;
  };

  if (!config.baseUrl || !config.token) {
    await setState(db, 'not_configured', now(), null, false);
    return finish('not_configured', 'المزامنة غير مهيأة: لم يُضبط عنوان الخادم أو رمز الجهاز');
  }
  if (!isSecureUrl(config.baseUrl)) {
    await setState(db, 'error', now(), 'INSECURE_URL', false);
    return finish('error', 'مرفوض: عنوان الخادم يجب أن يبدأ بـ https');
  }

  const blocked = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM audit_sync_outbox WHERE status IN ('conflict','rejected')`
  );
  if ((blocked?.c ?? 0) > 0) {
    return finish('blocked', 'المزامنة متوقفة بسبب تعارض يحتاج إلى مراجعة مدير النظام');
  }

  const previous = state.last_result;
  const endpoint = config.baseUrl.replace(/\/+$/, '') + '/api/v1/audit/events/batch';

  for (let batchNo = 0; batchNo < MAX_BATCHES_PER_RUN; batchNo++) {
    const rows = await db.getAllAsync<OutboxRow>(
      `SELECT sequence_no, operation_id, status, retry_count, next_retry_at
       FROM audit_sync_outbox WHERE status IN ('pending','failed')
       ORDER BY sequence_no ASC LIMIT ?`,
      [BATCH_SIZE]
    );
    if (rows.length === 0) {
      // لا نغيّر الحالة إن لم يحدث اتصال فعلي بالخادم في هذه الدورة.
      if (result.sent > 0) {
        await setState(db, 'ok', now(), null, true);
        if (['offline', 'denied', 'error'].includes(previous)) {
          await emit({
            operationType: 'sync_completed',
            entityType: 'sync',
            newValues: { sent: result.sent, previousState: previous },
            actor: { id: null, username: 'النظام' },
          }).catch(() => undefined);
        }
      }
      return finish(result.sent > 0 ? 'ok' : 'idle',
        result.sent > 0 ? 'تمت مزامنة ' + result.sent + ' سجل' : 'لا توجد سجلات بانتظار المزامنة');
    }

    // الترتيب مهم: إن كان أول حدث ينتظر مهلة إعادة المحاولة فلا نتجاوزه.
    if (rows[0].next_retry_at > now()) {
      return finish('waiting', 'بانتظار موعد إعادة المحاولة');
    }

    const seqs = rows.map((r) => r.sequence_no);
    const placeholders = seqs.map(() => '?').join(',');
    const events = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM audit_logs WHERE sequence_no IN (${placeholders}) ORDER BY sequence_no ASC`,
      seqs
    );

    const first = seqs[0];
    const last = seqs[seqs.length - 1];
    let response: Response;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + config.token,
          'Idempotency-Key': state.device_id + ':' + first + '-' + last,
          'X-Device-Id': state.device_id,
        },
        body: JSON.stringify({ device_id: state.device_id, events }),
        signal: controller?.signal,
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      const delay = backoff(rows[0].retry_count);
      await markRows(db, seqs, 'failed', now(), 'OFFLINE', delay);
      await setState(db, 'offline', now(), String((e as Error)?.message ?? e), false);
      result.failed += seqs.length;
      return finish('offline', 'لا يوجد اتصال بالخادم: السجلات محفوظة محلياً وستُرسل لاحقاً');
    }
    if (timer) clearTimeout(timer);

    if (response.status === 401 || response.status === 403) {
      await markRows(db, seqs, 'failed', now(), 'AUTH_DENIED', backoff(rows[0].retry_count));
      await setState(db, 'denied', now(), 'HTTP_' + response.status, false);
      result.failed += seqs.length;
      if (previous !== 'denied') {
        await emit({
          operationType: 'sync_denied',
          entityType: 'sync',
          newValues: { httpStatus: response.status },
          actor: { id: null, username: 'النظام' },
        }).catch(() => undefined);
      }
      return finish('denied', 'رفض الخادم الجهاز أو الحساب: لن تُرسل السجلات حتى تتجدد الصلاحية');
    }

    if (response.status >= 500 || (response.status >= 400 && response.status !== 409)) {
      await markRows(db, seqs, 'failed', now(), 'HTTP_' + response.status, backoff(rows[0].retry_count));
      await setState(db, 'error', now(), 'HTTP_' + response.status, false);
      result.failed += seqs.length;
      return finish('error', 'خطأ من الخادم (' + response.status + ')، ستُعاد المحاولة تلقائياً');
    }

    let receipt: ServerReceipt;
    try {
      receipt = (await response.json()) as ServerReceipt;
    } catch {
      await markRows(db, seqs, 'failed', now(), 'BAD_RESPONSE', backoff(rows[0].retry_count));
      await setState(db, 'error', now(), 'BAD_RESPONSE', false);
      result.failed += seqs.length;
      return finish('error', 'رد غير صالح من الخادم، ستُعاد المحاولة');
    }

    const acked = new Set<number>([...(receipt.accepted ?? []), ...(receipt.duplicates ?? [])]);
    const conflictSeqs = (receipt.conflicts ?? []).map((c) => c.sequence_no);
    const rejectedSeqs = (receipt.rejected ?? []).map((c) => c.sequence_no);

    const sentSeqs = seqs.filter((s) => acked.has(s));
    const toConflict = seqs.filter((s) => conflictSeqs.includes(s));
    const toRejected = seqs.filter((s) => rejectedSeqs.includes(s));
    // بعد أول تعارض لا يعالج الخادم ما يليه؛ تبقى تلك السجلات معلّقة دون تغيير.
    const stopAt = Math.min(...conflictSeqs, ...rejectedSeqs, Number.POSITIVE_INFINITY);
    const unacked = seqs.filter(
      (s) => s < stopAt && !acked.has(s) && !conflictSeqs.includes(s) && !rejectedSeqs.includes(s)
    );

    await markRows(db, sentSeqs, 'sent', now(), null, null);
    await markRows(db, toConflict, 'conflict', now(), 'CONFLICT', null);
    await markRows(db, toRejected, 'rejected', now(), 'REJECTED', null);
    // لا نفترض أبداً أن حدثاً وصل دون إقرار صريح.
    await markRows(db, unacked, 'failed', now(), 'NO_ACK', backoff(rows[0].retry_count));

    result.sent += sentSeqs.length;
    result.failed += unacked.length;
    result.conflicts += toConflict.length + toRejected.length;

    if (toConflict.length + toRejected.length > 0) {
      await setState(db, 'conflict', now(), 'CONFLICT', false);
      await emit({
        operationType: 'sync_conflict',
        entityType: 'sync',
        newValues: { conflicts: toConflict, rejected: toRejected },
        reason: 'تعارض في المزامنة مع الخادم',
        actor: { id: null, username: 'النظام' },
      }).catch(() => undefined);
      return finish('conflict', 'تعارض في المزامنة: أُوقفت عند السجل ' + [...toConflict, ...toRejected][0]);
    }

    if (unacked.length > 0) {
      await setState(db, 'error', now(), 'NO_ACK', false);
      return finish('error', 'لم يُقرّ الخادم بعض السجلات، ستُعاد المحاولة');
    }
  }

  await setState(db, 'ok', now(), null, true);
  return finish('ok', 'تمت مزامنة ' + result.sent + ' سجل، والباقي في الدورة التالية');
}

// تشغيل واحد في كل مرة؛ الاستدعاءات المتزامنة تنتظر النتيجة نفسها.
export function syncAuditOutbox(options: SyncOptions = {}): Promise<SyncRunResult> {
  if (running) return running;
  running = runSync(options).finally(() => {
    running = null;
  });
  return running;
}

export async function syncAuditNow(session: Session | null | undefined): Promise<SyncRunResult> {
  requirePerm(session, 'audit.sync');
  return syncAuditOutbox();
}

export interface OutboxSummary {
  counts: Record<OutboxStatus, number>;
  lastResult: SyncState;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  deviceId: string;
  configured: boolean;
  serverHost: string | null;
  attention: {
    sequence_no: number; status: OutboxStatus; retry_count: number;
    last_error: string | null; last_attempt_at: number | null;
  }[];
}

export async function getOutboxSummary(options: { db?: SQLiteDatabase } = {}): Promise<OutboxSummary> {
  const db = options.db ?? (await getDb());
  await ensureOutboxSchema(db);
  await queueNewAuditRows(db, Date.now());
  const state = await getState(db, Date.now());

  const counts: Record<OutboxStatus, number> = {
    pending: 0, sent: 0, failed: 0, conflict: 0, rejected: 0,
  };
  const grouped = await db.getAllAsync<{ status: OutboxStatus; c: number }>(
    'SELECT status, COUNT(*) AS c FROM audit_sync_outbox GROUP BY status'
  );
  for (const g of grouped) counts[g.status] = g.c;

  const attention = await db.getAllAsync<OutboxSummary['attention'][number]>(
    `SELECT sequence_no, status, retry_count, last_error, last_attempt_at
     FROM audit_sync_outbox WHERE status <> 'sent' AND status <> 'pending'
     ORDER BY sequence_no ASC LIMIT 20`
  );

  const config = await readSyncConfig();
  let host: string | null = null;
  if (config.baseUrl) {
    const m = /^https?:\/\/([^/]+)/i.exec(config.baseUrl);
    host = m ? m[1] : null;
  }

  return {
    counts,
    lastResult: state.last_result,
    lastAttemptAt: state.last_attempt_at,
    lastSuccessAt: state.last_success_at,
    lastError: state.last_error,
    deviceId: state.device_id,
    configured: !!(config.baseUrl && config.token),
    serverHost: host,
    attention,
  };
}

export async function getAuditSyncStatus(
  session: Session | null | undefined
): Promise<OutboxSummary> {
  requirePerm(session, 'audit.sync');
  return getOutboxSummary();
}

// حلقة المزامنة التلقائية: عند الرجوع للتطبيق وكل دقيقة. لا ترمي أخطاء.
export function startAuditSyncLoop(intervalMs = 60000): () => void {
  const tick = () => {
    syncAuditOutbox().catch((e) => console.error('[AuditSync] فشل الدورة:', e));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  const sub = AppState.addEventListener('change', (s) => {
    if (s === 'active') tick();
  });
  return () => {
    clearInterval(timer);
    sub.remove();
  };
}
