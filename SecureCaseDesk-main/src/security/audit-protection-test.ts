import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { recordAuditEvent, verifyAuditChain } from '@/services/audit.service';

const NOT_BLOCKED = '__NOT_BLOCKED__';

function excerpt(msg: string): string {
  const flat = msg.split('\n').join(' ').trim();
  return flat.length > 110 ? flat.slice(flat.length - 110) : flat;
}

// ينفّذ العبارة داخل transaction يتراجع عنها دائماً، فلا يتغير شيء حتى لو لم تُرفض.
async function attemptBlocked(
  db: SQLiteDatabase,
  sql: string,
  params: (string | number | null)[]
): Promise<{ blocked: boolean; message: string }> {
  try {
    await db.withTransactionAsync(async () => {
      await db.runAsync(sql, params);
      throw new Error(NOT_BLOCKED);
    });
    return { blocked: false, message: '' };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes(NOT_BLOCKED)) return { blocked: false, message: '' };
    return { blocked: true, message: msg };
  }
}

/**
 * اختبار تشغيلي حقيقي (لا تخمين، ولا بيانات وهمية) على محرك سجل التدقيق:
 * 1) إنشاء سجل فعلي عبر المسار الحقيقي (recordAuditEvent) والتأكد من وصوله مرقّماً ومتسلسلاً.
 * 2) التحقق من سلامة توقيعات HMAC لكامل السلسلة (يشمل اختبار المتجه القياسي الداخلي).
 * 3) محاولة فعلية لتعديل/حذف صفوف من audit_logs و audit_event_queue، والتأكد أن قاعدة
 *    البيانات نفسها ترفضها (لا الاعتماد على إخفاء الأزرار في الواجهة فقط).
 * هذا الاختبار لا يُبقي أي أثر على البيانات الحقيقية باستثناء سطر الاختبار نفسه،
 * الذي يُسجَّل بنيّة واضحة ضمن السلسلة نفسها لأن سجل التدقيق غير قابل للحذف أصلاً.
 */
export async function runAuditProtectionTest(userId: string): Promise<string> {
  const db = await getDb();
  await assertUserCan(db, userId, 'audit.view');

  const lines: string[] = [];

  // ===== 1) إنشاء سجل تدقيق حقيقي عبر المحرك الفعلي =====
  const before = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM audit_logs'
  );
  const beforeCount = before?.c ?? 0;

  const marker = 'TEST-' + Date.now();
  await recordAuditEvent({
    operationType: 'protection_test',
    entityType: 'self_test',
    entityId: marker,
    newValues: { marker, by: userId },
    actor: { id: userId, username: 'فحص_حماية_ذاتي' },
  });

  const created = await db.getFirstAsync<{ sequence_no: number }>(
    'SELECT sequence_no FROM audit_logs WHERE entity_id = ? ORDER BY sequence_no DESC LIMIT 1',
    [marker]
  );
  const after = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM audit_logs'
  );
  const afterCount = after?.c ?? 0;

  if (created && afterCount === beforeCount + 1) {
    lines.push('نجح: إنشاء سجل تدقيق جديد عبر المسار الفعلي - رقم التسلسل ' + created.sequence_no);
  } else {
    lines.push('فشل: لم يُنشأ سجل التدقيق كما هو متوقع');
  }

  // ===== 2) سلامة التوقيعات على كامل السلسلة =====
  const verification = await verifyAuditChain(userId);

  lines.push(
    (verification.ok ? 'نجح' : 'فشل') +
    ': التحقق من توقيعات HMAC لكامل السلسلة (' + verification.count + ' سجلاً)' +
    (verification.ok ? '' : ' - ' + verification.code)
  );
  lines.push(
    (verification.selfTest.ok ? 'نجح' : 'فشل') +
    ': اختبار متجه HMAC القياسي وسيناريوهات العبث الداخلية'
  );

  // ===== 3) منع التعديل والحذف من خلال التطبيق - اختبار فعلي لا نظري =====
  const sampleLog = await db.getFirstAsync<{ sequence_no: number }>(
    'SELECT sequence_no FROM audit_logs ORDER BY sequence_no DESC LIMIT 1'
  );

  if (sampleLog) {
    const upd = await attemptBlocked(
      db, 'UPDATE audit_logs SET operation_type = ? WHERE sequence_no = ?',
      ['tampered', sampleLog.sequence_no]
    );
    lines.push(
      (upd.blocked ? 'نجح' : 'فشل') + ': منع تعديل audit_logs' +
      (upd.blocked ? ' - ' + excerpt(upd.message) : ' (لم يُرفض!)')
    );

    const del = await attemptBlocked(
      db, 'DELETE FROM audit_logs WHERE sequence_no = ?',
      [sampleLog.sequence_no]
    );
    lines.push(
      (del.blocked ? 'نجح' : 'فشل') + ': منع حذف audit_logs' +
      (del.blocked ? ' - ' + excerpt(del.message) : ' (لم يُرفض!)')
    );
  } else {
    lines.push('تنبيه: لا توجد سجلات تدقيق لاختبار الحماية عليها');
  }

  const sampleQueue = await db.getFirstAsync<{ queue_seq: number }>(
    'SELECT queue_seq FROM audit_event_queue ORDER BY queue_seq DESC LIMIT 1'
  );

  if (sampleQueue) {
    const upd = await attemptBlocked(
      db, 'UPDATE audit_event_queue SET operation_type = ? WHERE queue_seq = ?',
      ['tampered', sampleQueue.queue_seq]
    );
    lines.push(
      (upd.blocked ? 'نجح' : 'فشل') + ': منع تعديل audit_event_queue' +
      (upd.blocked ? ' - ' + excerpt(upd.message) : ' (لم يُرفض!)')
    );

    const del = await attemptBlocked(
      db, 'DELETE FROM audit_event_queue WHERE queue_seq = ?',
      [sampleQueue.queue_seq]
    );
    lines.push(
      (del.blocked ? 'نجح' : 'فشل') + ': منع حذف audit_event_queue' +
      (del.blocked ? ' - ' + excerpt(del.message) : ' (لم يُرفض!)')
    );
  }

  // ===== 4) التأكد من أن محاولات الفحص لم تغيّر شيئاً فعلياً =====
  const final = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM audit_logs'
  );
  const finalCount = final?.c ?? 0;

  lines.push(
    (finalCount === afterCount ? 'نجح' : 'فشل') +
    ': عدد سجلات التدقيق لم يتغيّر بسبب محاولات الفحص (الحالي: ' + finalCount + ')'
  );

  const report = lines.join('\n');
  console.log('[AuditProtectionTest]\n' + report);
  return report;
}
