// SECURECASEDESK_PHASE8_S2
// التحقق الكامل من السلسلة، تدوير المفاتيح، قبول الاستعادة، وفحص عدم قابلية التعديل.

import { getDb } from '@/database/db';
import {
  KEY_ROTATION_ENTITY, KEY_ROTATION_OPERATION, parseVersion, sha256Hex,
} from '@/security/audit-crypto';
import type { AuditLogRow } from '@/security/audit-crypto';
import { ChainVerifier } from '@/security/audit-verifier-core';
import type { CheckpointInput, VerificationReport, FindingCode } from '@/security/audit-verifier-core';
import {
  createRotationKey, getActiveVersion, getCheckpointKey, loadFingerprints,
  loadKeysFor, registerKey, setActiveVersion,
} from '@/security/audit-keys';
import {
  findQueueGaps, raiseIntegrityAlerts, readDatabaseCheckpoints,
  readExternalCheckpoint, withCheckpointGuardSuspended, writeCheckpoint,
} from '@/security/audit-integrity-guard';
import {
  assertAuditAdmin, flushAuditQueue, recordAuditEvent,
} from './audit.service';

const FIRST_SEQUENCE = Number.MIN_SAFE_INTEGER; // حتى لا تُخفى سجلات برقم صفر/سالب

export const AUDIT_FINDING_MESSAGES_AR: Record<FindingCode, string> = {
  SEQUENCE_GAP: 'تم اكتشاف سجل محذوف أو مفقود داخل السلسلة.',
  OUT_OF_ORDER: 'تم اكتشاف سجل مكرر أو مُعاد ترتيبه.',
  BROKEN_LINK: 'تم اكتشاف انقطاع في رابط السجل السابق.',
  INVALID_HMAC: 'تم اكتشاف تغيير في محتويات أحد السجلات.',
  UNKNOWN_VERSION: 'إصدار توقيع غير معروف.',
  KEY_VERSION_REGRESSION: 'تم اكتشاف رجوع إلى إصدار مفتاح أقدم بعد التدوير.',
  UNAUTHORIZED_KEY_SWITCH: 'تم اكتشاف تبديل مفتاح دون سجل تدوير موثّق.',
  KEY_UNAVAILABLE: 'مفتاح أحد الإصدارات غير متوفر على هذا الجهاز؛ تعذّر التحقق منه.',
  KEY_FINGERPRINT_MISMATCH: 'بصمة المفتاح لا تطابق المسجّلة.',
  TIME_REGRESSION: 'تحذير: طابع زمني أقدم من السجل السابق.',
  TAIL_TRUNCATED: 'تم اكتشاف حذف في نهاية السجل.',
  CHECKPOINT_MISMATCH: 'نقطة التحقق لا تطابق السجل الفعلي.',
  CHECKPOINT_SIGNATURE_INVALID: 'توقيع نقطة التحقق غير صالح.',
  CHECKPOINT_KEY_UNAVAILABLE: 'مفتاح نقاط التحقق غير متوفر؛ تعذّر فحصها.',
  CHECKPOINT_MISSING: 'تحذير: لا توجد نقطة تحقق خارجية بعد.',
  CHECKPOINT_CORRUPT: 'نقطة التحقق الخارجية تالفة.',
  QUEUE_EVENT_MISSING_FROM_CHAIN: 'أحداث مسجّلة في الطابور لا يقابلها سجل في السلسلة (حذف).',
};

export type FullVerificationReport = VerificationReport & {
  flushError: string | null;
  queueGapCount: number;
};

export async function verifyAuditChainFull(
  userId: string,
  options: { pageSize?: number; recordResult?: boolean; ignoreCheckpoints?: boolean } = {}
): Promise<FullVerificationReport> {
  await assertAuditAdmin(userId);

  const db = await getDb();
  const pageSize = Math.min(2000, Math.max(50, options.pageSize ?? 500));

  // 1) فحص فجوات الطابور قبل أي flush (لأن flush قد يعيد إلحاق حدث محذوف).
  const queueGaps = await findQueueGaps();

  let flushError: string | null = null;
  try {
    await flushAuditQueue();
  } catch (e) {
    flushError = String((e as Error)?.message ?? e);
  }

  // 2) المفاتيح والبصمات.
  const versionRows = await db.getAllAsync<{ hmac_version: string }>(
    'SELECT DISTINCT hmac_version FROM audit_logs'
  );
  const versions = versionRows
    .map((r) => parseVersion(r.hmac_version))
    .filter((v): v is number => v !== null);
  const keys = await loadKeysFor(versions);
  const fingerprints = await loadFingerprints();

  // 3) نقاط التحقق.
  const checkpoints: CheckpointInput[] = [];
  let externalState: 'present' | 'missing' | 'corrupt' | 'ignored' = 'ignored';
  let checkpointKey: Uint8Array | null = null;

  if (!options.ignoreCheckpoints) {
    const ext = await readExternalCheckpoint();
    externalState = ext.state;
    if (ext.state === 'present' && ext.record) {
      checkpoints.push({ source: 'external', record: ext.record });
    }
    for (const record of await readDatabaseCheckpoints()) {
      checkpoints.push({ source: 'database', record });
    }
    if (checkpoints.length > 0) {
      try { checkpointKey = await getCheckpointKey(false); }
      catch { checkpointKey = null; }
    }
  }

  // 4) المرور على السلسلة كاملة على دفعات.
  const verifier = new ChainVerifier({
    resolveKey: (v) => keys.get(v) ?? null,
    fingerprints,
    checkpoints,
    checkpointKey,
    externalState,
  });

  let after = FIRST_SEQUENCE;
  for (;;) {
    const rows = await db.getAllAsync<AuditLogRow>(
      'SELECT * FROM audit_logs WHERE sequence_no > ? ORDER BY sequence_no ASC LIMIT ?',
      [after, pageSize]
    );
    if (rows.length === 0) break;
    verifier.feed(rows);
    after = rows[rows.length - 1].sequence_no;
    if (rows.length < pageSize) break;
  }

  const report = verifier.finish({ queueGapCount: queueGaps.length });

  await raiseIntegrityAlerts(report.findings);

  if (options.recordResult !== false) {
    try {
      await recordAuditEvent({
        operationType: 'audit_verify',
        entityType: 'audit_logs',
        newValues: {
          status: report.status,
          count: report.count,
          critical: report.findings.filter((f) => f.severity === 'critical').length,
          checkpoint: report.checkpoint,
        },
      });
    } catch { /* السلسلة المعبوث بها قد ترفض الإلحاق: التنبيه سُجّل أعلاه */ }
  }

  return { ...report, flushError, queueGapCount: queueGaps.length };
}

// ---------- تدوير المفتاح (للمدير فقط) ----------

export async function rotateAuditKey(
  userId: string,
  reason: string
): Promise<{ from: number; to: number }> {
  await assertAuditAdmin(userId);
  if (!reason || !reason.trim()) throw new Error('REASON_REQUIRED');

  // لا نُدوّر فوق سلسلة معبوث بها.
  const report = await verifyAuditChainFull(userId, { recordResult: false });
  if (report.status === 'COMPROMISED') throw new Error('AUDIT_CHAIN_TAMPERED');

  const from = await getActiveVersion();
  const to = from + 1;

  // 1) المفتاح الجديد يُخزَّن أولاً. 2) سجل التدوير يُوقَّع بالمفتاح القديم.
  const newKey = await createRotationKey(to);

  await recordAuditEvent({
    operationType: KEY_ROTATION_OPERATION,
    entityType: KEY_ROTATION_ENTITY,
    entityId: String(to),
    newValues: { from, to, fingerprint: sha256Hex(newKey) },
    reason: reason.trim(),
  });

  // 3) كل سجل بعده يُوقَّع تلقائياً بالإصدار الجديد (getSigningKey يقرأ سجل التدوير).
  const db = await getDb();
  const marker = await db.getFirstAsync<{ sequence_no: number }>(
    `SELECT sequence_no FROM audit_logs
     WHERE operation_type = ? AND entity_id = ?
     ORDER BY sequence_no DESC LIMIT 1`,
    [KEY_ROTATION_OPERATION, String(to)]
  );

  await registerKey(to, newKey, marker?.sequence_no ?? null);
  await setActiveVersion(to);
  await writeCheckpoint({ force: true, reason: 'key-rotation' });

  return { from, to };
}

// ---------- قبول حالة مستعادة من نسخة احتياطية (للمدير فقط) ----------
// الاستعادة المشروعة تُرجع السلسلة إلى نقطة أقدم فتبدو "حذفاً في النهاية".
// هذه الدالة تتحقق أن السلسلة المستعادة سليمة داخلياً، ثم تسجّل القبول داخل السلسلة نفسها
// (بما فيه نقطة التحقق السابقة) قبل خفض نقطة التحقق.

export async function acceptRestoredState(
  userId: string,
  reason: string
): Promise<{ restoredLastSequence: number; previousCheckpointSequence: number | null }> {
  await assertAuditAdmin(userId);
  if (!reason || !reason.trim()) throw new Error('REASON_REQUIRED');

  const report = await verifyAuditChainFull(userId, {
    ignoreCheckpoints: true, recordResult: false,
  });
  if (report.status !== 'VALID') throw new Error('AUDIT_CHAIN_TAMPERED');

  const ext = await readExternalCheckpoint();
  const previous = ext.state === 'present' && ext.record ? ext.record : null;

  await withCheckpointGuardSuspended(async () => {
    await recordAuditEvent({
      operationType: 'audit_restore_accepted',
      entityType: 'audit_logs',
      previousValues: previous
        ? {
            checkpoint_sequence: previous.sequence_no,
            checkpoint_hash: previous.record_hash,
            checkpoint_created_at: previous.created_at,
          }
        : null,
      newValues: {
        restored_last_sequence: report.lastSequence,
        restored_count: report.count,
      },
      reason: reason.trim(),
    });
    await writeCheckpoint({ allowLower: true, force: true, reason: 'restore-accepted' });
  });

  return {
    restoredLastSequence: report.lastSequence,
    previousCheckpointSequence: previous?.sequence_no ?? null,
  };
}

// ---------- فحص حيّ لمنع التعديل والحذف على الجهاز ----------
// يحاول تعديل/حذف سجل حقيقي؛ المتوقع أن ترفضه المشغّلات (لا يتغير شيء إن رُفض).

export async function probeAuditImmutability(userId: string): Promise<{
  tested: boolean;
  updateBlocked: boolean;
  deleteBlocked: boolean;
  checkpointDeleteBlocked: boolean | null;
}> {
  await assertAuditAdmin(userId);
  const db = await getDb();

  const first = await db.getFirstAsync<{ sequence_no: number }>(
    'SELECT MIN(sequence_no) AS sequence_no FROM audit_logs'
  );
  if (!first || first.sequence_no === null || first.sequence_no === undefined) {
    return { tested: false, updateBlocked: false, deleteBlocked: false, checkpointDeleteBlocked: null };
  }

  const blocked = async (sql: string, params: (string | number)[]) => {
    try { await db.runAsync(sql, params); return false; }
    catch { return true; }
  };

  const updateBlocked = await blocked(
    'UPDATE audit_logs SET username = username WHERE sequence_no = ?', [first.sequence_no]
  );
  const deleteBlocked = await blocked(
    'DELETE FROM audit_logs WHERE sequence_no = ?', [first.sequence_no]
  );

  const cp = await db.getFirstAsync<{ sequence_no: number }>(
    'SELECT MIN(sequence_no) AS sequence_no FROM audit_checkpoints'
  );
  const checkpointDeleteBlocked =
    cp && cp.sequence_no !== null && cp.sequence_no !== undefined
      ? await blocked('DELETE FROM audit_checkpoints WHERE sequence_no = ?', [cp.sequence_no])
      : null;

  return { tested: true, updateBlocked, deleteBlocked, checkpointDeleteBlocked };
}
