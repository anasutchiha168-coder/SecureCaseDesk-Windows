// SECURECASEDESK_PHASE8_S3
// ربط سجل التدقيق بوحدات المشروع. لا يُلقي أبداً من مسارات الرفض: فشل التسجيل لا يغيّر قرار المنع.

import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb } from '@/database/db';
import { onForbidden, requirePerm, type Session } from '@/security/guard';
import { recordAuditEvent } from '@/services/audit.service';

const THROTTLE_MS = 2000;
const recent = new Map<string, number>();
let pending: Promise<void> = Promise.resolve();
let unsubscribe: (() => void) | null = null;

export interface UnauthorizedAccessInput {
  userId: string | null;
  username?: string | null;
  role?: string | null;
  resource: string; // مثال: permission:cases.manage أو tab:audit
  detail?: string;
}

export function resetUnauthorizedThrottle(): void {
  recent.clear();
}

// يسمح باستكمال التسجيلات المعلّقة (يُستخدم في الاختبارات وقبل التقارير).
export function drainAuditIntegration(): Promise<void> {
  return pending;
}

async function lookupUsername(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ username: string }>(
      'SELECT username FROM users WHERE id = ?',
      [userId]
    );
    return row?.username ?? null;
  } catch {
    return null;
  }
}

export function recordUnauthorizedAccess(input: UnauthorizedAccessInput): Promise<void> {
  const key = (input.userId ?? '-') + '|' + input.resource;
  const now = Date.now();
  const last = recent.get(key);
  if (last !== undefined && now - last < THROTTLE_MS) return pending;
  recent.set(key, now);

  // تسلسل التسجيلات حتى لا تتزاحم المعاملات على الاتصال نفسه.
  pending = pending.then(async () => {
    try {
      const username = input.username ?? (await lookupUsername(input.userId));
      await recordAuditEvent({
        operationType: 'unauthorized_access',
        entityType: 'access',
        entityId: input.resource,
        newValues: {
          role: input.role ?? null,
          detail: input.detail ?? null,
          attemptedAt: now,
        },
        reason: 'محاولة وصول غير مصرح بها',
        actor: { id: input.userId, username },
      });
    } catch (e) {
      // الحدث محفوظ في الطابور إن وصل إليه، وسيُدمج في السلسلة عند أول تفريغ ناجح.
      console.error('[Audit] تعذر تسجيل محاولة وصول غير مصرح بها:', e);
    }
  });
  return pending;
}

// يُستدعى مرة واحدة عند إقلاع التطبيق. آمن للتكرار.
export function installAuditIntegration(): void {
  if (unsubscribe) return;
  unsubscribe = onForbidden((event) => {
    void recordUnauthorizedAccess({
      userId: event.userId,
      role: event.role,
      resource: 'permission:' + event.permission,
      detail: 'رُفض الطلب في طبقة الخدمات',
    });
  });
}

export function uninstallAuditIntegration(): void {
  unsubscribe?.();
  unsubscribe = null;
}

export interface SystemEventInput {
  operationType: string; // مثل backup_create, attachment_add, permission_change
  entityType: string;
  entityId?: string | null;
  previousValues?: unknown;
  newValues?: unknown;
  reason?: string | null;
}

// للعمليات التي لا تمسّ جدولاً مراقَباً (نسخ احتياطي، تصدير، مرفقات...).
// strict=true: فشل التسجيل يُفشل العملية (للعمليات الحساسة كالاستعادة).
export async function recordSystemEvent(
  session: Session | null | undefined,
  permission: Parameters<typeof requirePerm>[1],
  event: SystemEventInput,
  strict = false
): Promise<void> {
  const s = requirePerm(session, permission);
  try {
    const username = await lookupUsername(s.userId);
    await recordAuditEvent({ ...event, actor: { id: s.userId, username } });
  } catch (e) {
    console.error('[Audit] تعذر تسجيل حدث النظام:', e);
    if (strict) throw e;
  }
}

export interface AuditCoverage {
  covered: string[];
  partial: string[];
  uncovered: string[];
}

const REQUIRED_TABLES = [
  'users', 'departments', 'cases', 'memos', 'memo_types',
  'persons', 'detainees', 'detainee_categories', 'crime_classifications', 'detainee_movements', 'correction_history',
  'attachments',
];

export const AUDIT_REQUIRED_TABLES: readonly string[] = REQUIRED_TABLES;

// يفحص أن كل جدول بيانات له مشغلات الإدراج والتعديل والحذف.
export async function checkAuditCoverage(database?: SQLiteDatabase): Promise<AuditCoverage> {
  const db = database ?? (await getDb());
  const tables = await db.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'audit_%'
     ORDER BY name`
  );
  const triggers = await db.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'audit\\_%' ESCAPE '\\'`
  );
  const names = new Set(triggers.map((t) => t.name));

  const result: AuditCoverage = { covered: [], partial: [], uncovered: [] };
  for (const { name } of tables) {
    const count = ['insert', 'update', 'delete']
      .filter((x) => names.has('audit_' + name + '_' + x)).length;
    if (count === 3) result.covered.push(name);
    else if (count > 0) result.partial.push(name);
    else result.uncovered.push(name);
  }
  return result;
}
