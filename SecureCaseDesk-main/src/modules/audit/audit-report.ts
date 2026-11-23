// SECURECASEDESK_PHASE8_S3
import { getDb } from '@/database/db';
import { requirePerm, type Session } from '@/security/guard';
import { flushAuditQueue, verifyAuditChain } from '@/services/audit.service';
import { chainCodeLabel, auditEntityLabel, auditOperationLabel } from './audit-labels';
import {
  AUDIT_REQUIRED_TABLES, checkAuditCoverage, drainAuditIntegration,
  recordSystemEvent, type AuditCoverage,
} from './audit-integration';
import { getOutboxSummary, type OutboxSummary } from './audit-outbox';

export interface CountItem { key: string; count: number }

export interface AuditVerificationReport {
  generatedAt: number;
  generatedBy: string;
  chain: {
    ok: boolean; count: number; code: string; label: string;
    badSequence: number | null; selfTestOk: boolean;
  };
  totals: { logs: number; firstAt: number | null; lastAt: number | null };
  byOperation: CountItem[];
  byEntity: CountItem[];
  byUser: CountItem[];
  security: {
    unauthorizedTotal: number;
    unauthorizedLast24h: number;
    failedLogins: number;
    topUnauthorizedUsers: CountItem[];
  };
  coverage: AuditCoverage & { missingRequired: string[] };
  sync: OutboxSummary;
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return 'غير متوفر';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export async function buildAuditVerificationReport(
  session: Session | null | undefined
): Promise<AuditVerificationReport> {
  const s = requirePerm(session, 'audit.verify');
  await drainAuditIntegration();
  await flushAuditQueue();

  const db = await getDb();

  let chain: AuditVerificationReport['chain'];
  try {
    const v = await verifyAuditChain(s.userId);
    chain = {
      ok: v.ok, count: v.count, code: v.code, label: chainCodeLabel(v.code),
      badSequence: v.badSequence ?? null, selfTestOk: v.selfTest.ok,
    };
  } catch (e) {
    const code = String((e as Error)?.message ?? 'UNKNOWN');
    if (code === 'FORBIDDEN') throw e;
    chain = {
      ok: false, count: 0, code, label: chainCodeLabel(code),
      badSequence: null, selfTestOk: false,
    };
  }

  const totals = await db.getFirstAsync<{ c: number; a: number | null; b: number | null }>(
    'SELECT COUNT(*) AS c, MIN(created_at) AS a, MAX(created_at) AS b FROM audit_logs'
  );
  const group = (col: string, limit: number) => db.getAllAsync<CountItem>(
    `SELECT COALESCE(${col}, 'غير معروف') AS "key", COUNT(*) AS count
     FROM audit_logs GROUP BY ${col} ORDER BY count DESC LIMIT ?`, [limit]
  );
  const [byOperation, byEntity, byUser] = await Promise.all([
    group('operation_type', 10), group('entity_type', 10), group('username', 10),
  ]);

  const since = Date.now() - 24 * 3600 * 1000;
  const unauthorized = await db.getFirstAsync<{ t: number; d: number }>(
    `SELECT COUNT(*) AS t, COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS d
     FROM audit_logs WHERE operation_type = 'unauthorized_access'`, [since]
  );
  const failed = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM audit_logs WHERE operation_type = 'failed_login'`
  );
  const topUnauthorizedUsers = await db.getAllAsync<CountItem>(
    `SELECT COALESCE(username, user_id, 'غير معروف') AS "key", COUNT(*) AS count
     FROM audit_logs WHERE operation_type = 'unauthorized_access'
     GROUP BY COALESCE(username, user_id, 'غير معروف') ORDER BY count DESC LIMIT 5`
  );

  const coverage = await checkAuditCoverage(db);
  const missingRequired = AUDIT_REQUIRED_TABLES.filter((t) => !coverage.covered.includes(t));
  const sync = await getOutboxSummary({ db });

  const userRow = await db.getFirstAsync<{ username: string }>(
    'SELECT username FROM users WHERE id = ?', [s.userId]
  );

  const report: AuditVerificationReport = {
    generatedAt: Date.now(),
    generatedBy: userRow?.username ?? s.userId,
    chain,
    totals: { logs: totals?.c ?? 0, firstAt: totals?.a ?? null, lastAt: totals?.b ?? null },
    byOperation, byEntity, byUser,
    security: {
      unauthorizedTotal: unauthorized?.t ?? 0,
      unauthorizedLast24h: unauthorized?.d ?? 0,
      failedLogins: failed?.c ?? 0,
      topUnauthorizedUsers,
    },
    coverage: { ...coverage, missingRequired },
    sync,
  };

  // يُسجَّل إنشاء التقرير بعد بنائه، فلا يدخل في أرقامه.
  await recordSystemEvent(s, 'audit.verify', {
    operationType: 'verification_report',
    entityType: 'audit',
    newValues: { chainOk: chain.ok, code: chain.code, logs: report.totals.logs },
  });

  return report;
}

export async function recordReportExport(session: Session | null | undefined): Promise<void> {
  await recordSystemEvent(session, 'audit.verify', {
    operationType: 'report_export',
    entityType: 'audit',
    newValues: { channel: 'share' },
  });
}

const SYNC_LABELS: Record<string, string> = {
  never: 'لم تبدأ بعد', ok: 'سليمة', offline: 'دون اتصال', denied: 'مرفوضة من الخادم',
  error: 'خطأ', conflict: 'متوقفة بسبب تعارض', not_configured: 'غير مهيأة',
};

export function syncStateLabel(v: string): string {
  return SYNC_LABELS[v] ?? v;
}

function lines(title: string, items: CountItem[], label: (k: string) => string): string[] {
  if (items.length === 0) return [];
  return ['', title, ...items.map((i) => '  - ' + label(i.key) + ': ' + i.count)];
}

export function formatReportArabic(r: AuditVerificationReport): string {
  const out: string[] = [
    'وزارة الداخلية',
    'إدارة المباحث الجنائية',
    'م/ حجة',
    '',
    'تقرير التحقق من سلامة سجل التدقيق',
    'تاريخ الإنشاء: ' + formatTime(r.generatedAt),
    'أنشأه: ' + r.generatedBy,
    '',
    'نتيجة التحقق: ' + (r.chain.ok ? 'سليم' : 'غير سليم'),
    'التفصيل: ' + r.chain.label,
    'عدد السجلات المفحوصة: ' + r.chain.count,
    'الاختبار الذاتي للتوقيع: ' + (r.chain.selfTestOk ? 'ناجح' : 'فاشل'),
  ];
  if (r.chain.badSequence !== null) out.push('أول سجل مشتبه به: ' + r.chain.badSequence);

  out.push(
    '', 'إجمالي السجلات: ' + r.totals.logs,
    'أول سجل: ' + formatTime(r.totals.firstAt),
    'آخر سجل: ' + formatTime(r.totals.lastAt),
    '', 'الأمن',
    '  - محاولات وصول غير مصرح بها (الإجمالي): ' + r.security.unauthorizedTotal,
    '  - آخر 24 ساعة: ' + r.security.unauthorizedLast24h,
    '  - محاولات دخول فاشلة: ' + r.security.failedLogins,
  );
  out.push(...lines('أكثر المستخدمين محاولةً غير مصرح بها', r.security.topUnauthorizedUsers, (k) => k));
  out.push(...lines('حسب نوع العملية', r.byOperation, auditOperationLabel));
  out.push(...lines('حسب الوحدة', r.byEntity, auditEntityLabel));
  out.push(...lines('حسب المستخدم', r.byUser, (k) => k));

  out.push('', 'تغطية التدقيق',
    '  - جداول مغطاة: ' + r.coverage.covered.length,
    '  - جداول ناقصة التغطية: ' + (r.coverage.partial.concat(r.coverage.uncovered).join('، ') || 'لا يوجد'),
    '  - جداول مطلوبة غير مغطاة: ' + (r.coverage.missingRequired.join('، ') || 'لا يوجد'),
  );

  out.push('', 'المزامنة',
    '  - الحالة: ' + syncStateLabel(r.sync.lastResult),
    '  - بانتظار الإرسال: ' + (r.sync.counts.pending + r.sync.counts.failed),
    '  - تمت مزامنتها: ' + r.sync.counts.sent,
    '  - تعارضات/مرفوضة: ' + (r.sync.counts.conflict + r.sync.counts.rejected),
    '  - آخر مزامنة ناجحة: ' + formatTime(r.sync.lastSuccessAt),
    '',
    'ملاحظة: التحقق من التوقيعات يتم على هذا الجهاز بمفتاح محفوظ فيه؛ ' +
    'والخادم لا يملك المفتاح ويتحقق من التسلسل وربط السلسلة فقط.'
  );
  return out.join('\n');
}
