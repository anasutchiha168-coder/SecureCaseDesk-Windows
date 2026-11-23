// SECURECASEDESK_PHASE8_S3
// اختبارات تشغيلية حقيقية. اختبارات المزامنة تعمل على قاعدة ذاكرة مؤقتة (بيانات تركيبية)،
// فلا تغيّر حالة الصندوق الصادر الحقيقي. الاختبارات على القاعدة الحقيقية إما تتراجع (rollback)
// أو تترك سجلاً واضح الوسم (unauthorized_access / integration_test) لأن سجل التدقيق لا يُحذف.

import * as SQLite from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb } from '@/database/db';
import { initAuditSchema } from '@/database/audit-schema';
import { can } from '@/security/permissions';
import { ForbiddenError, requirePerm, type Session } from '@/security/guard';
import { listCases } from '@/services/cases.service';
import { listMemos } from '@/services/memos.service';
import { flushAuditQueue } from '@/services/audit.service';
import {
  AUDIT_REQUIRED_TABLES, checkAuditCoverage, drainAuditIntegration,
  installAuditIntegration, recordSystemEvent, resetUnauthorizedThrottle,
} from './audit-integration';
import { ensureOutboxSchema, queueNewAuditRows, syncAuditOutbox } from './audit-outbox';
import { buildAuditVerificationReport } from './audit-report';

type Perm = Parameters<typeof can>[1];

export interface IntegrationTestResult {
  ok: boolean;
  passed: number;
  failed: number;
  lines: string[];
}

const ROLES = ['admin', 'investigator', 'viewer', 'detention_viewer'] as const;

// القيمة المتوقعة لكل (دور، صلاحية). الصلاحيات غير المذكورة ممنوعة افتراضياً.
const MATRIX: Record<string, Perm[]> = {
  admin: [
    'dashboard.view', 'cases.view', 'cases.manage', 'memos.view', 'memos.manage',
    'detainees.view', 'detainees.manage', 'detainees.correct', 'users.manage',
    'audit.view', 'audit.verify', 'audit.sync',
  ],
  investigator: ['dashboard.view', 'cases.view', 'cases.manage', 'memos.view', 'memos.manage', 'detainees.view'],
  viewer: ['dashboard.view', 'cases.view', 'memos.view', 'detainees.view'],
  detention_viewer: ['dashboard.view', 'detainees.view'],
};

const ALL_PERMS: Perm[] = [
  'dashboard.view', 'cases.view', 'cases.manage', 'memos.view', 'memos.manage',
  'detainees.view', 'detainees.manage', 'detainees.correct', 'users.manage',
  'audit.view', 'audit.verify', 'audit.sync',
];

const SENTINEL = '__ROLLBACK_SENTINEL__';

function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

async function memoryDb(rows: number): Promise<SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(':memory:');
  await initAuditSchema(db);
  for (let i = 1; i <= rows; i++) await addRow(db, i);
  return db;
}

async function addRow(db: SQLiteDatabase, seq: number): Promise<void> {
  await db.runAsync(
    `INSERT INTO audit_logs (sequence_no, operation_id, source_event_id, operation_type,
       entity_type, created_at, previous_hash, record_hash, hmac_version)
     VALUES (?, ?, ?, 'test', 'test', ?, ?, ?, 'HMAC-SHA256-v1')`,
    [seq, 'OP-' + seq, 'SRC-' + seq, 1000 + seq, 'prev' + seq, 'hash' + seq]
  );
}

async function statusOf(db: SQLiteDatabase): Promise<Record<string, number>> {
  const rows = await db.getAllAsync<{ status: string; c: number }>(
    'SELECT status, COUNT(*) AS c FROM audit_sync_outbox GROUP BY status'
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.c;
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(handler: (n: number, init: RequestInit) => Response | Error) {
  const calls: RequestInit[] = [];
  const fn = (async (_url: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    const r = handler(calls.length, init ?? {});
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function spy() {
  const events: string[] = [];
  return {
    events,
    emit: async (e: { operationType: string }) => { events.push(e.operationType); },
  };
}

export async function runAuditIntegrationTests(
  session: Session | null | undefined
): Promise<IntegrationTestResult> {
  const s = requirePerm(session, 'audit.verify');
  installAuditIntegration();

  const lines: string[] = [];
  let passed = 0;
  let failed = 0;

  const check = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      passed++;
      lines.push('نجح: ' + name);
    } catch (e) {
      failed++;
      lines.push('فشل: ' + name + ' — ' + String((e as Error)?.message ?? e));
    }
  };

  // ===== الصلاحيات =====
  await check('مصفوفة الصلاحيات للأدوار الأربعة', () => {
    for (const role of ROLES) {
      for (const perm of ALL_PERMS) {
        const expected = MATRIX[role].includes(perm);
        expect(can(role, perm) === expected,
          role + ' / ' + perm + ': المتوقع ' + (expected ? 'السماح' : 'المنع'));
      }
    }
  });

  await check('دور مجهول أو فارغ لا يملك أي صلاحية', () => {
    for (const role of ['hacker', '', null, undefined, 'ADMINISTRATOR']) {
      for (const perm of ALL_PERMS) {
        expect(!can(role as string, perm), 'دور غير معروف حصل على ' + perm);
      }
    }
  });

  await check('مشاهد المحتجزين ممنوع من القضايا والمذكرات في طبقة الخدمات', async () => {
    const dv: Session = { userId: 'integration-test-user', role: 'detention_viewer' };
    for (const fn of [() => listCases(dv), () => listMemos(dv)]) {
      let blocked = false;
      try { await fn(); } catch (e) { blocked = e instanceof ForbiddenError; }
      expect(blocked, 'لم يُرفض الطلب بخطأ FORBIDDEN');
    }
  });

  await check('تسجيل محاولة وصول غير مصرح بها في السلسلة', async () => {
    resetUnauthorizedThrottle();
    const started = Date.now();
    const fake: Session = { userId: 'integration-test-user', role: 'viewer' };
    let blocked = false;
    try { requirePerm(fake, 'audit.sync'); } catch (e) { blocked = e instanceof ForbiddenError; }
    expect(blocked, 'لم يُرفض الطلب');
    await drainAuditIntegration();
    await flushAuditQueue();
    const db = await getDb();
    const row = await db.getFirstAsync<{ sequence_no: number; user_id: string }>(
      `SELECT sequence_no, user_id FROM audit_logs
       WHERE operation_type = 'unauthorized_access' AND entity_id = ?
         AND created_at >= ? ORDER BY sequence_no DESC LIMIT 1`,
      ['permission:audit.sync', started]
    );
    expect(!!row, 'لم يظهر سجل unauthorized_access');
    expect(row?.user_id === 'integration-test-user', 'نُسب السجل لمستخدم خاطئ');
  });

  await check('تقييد تكرار محاولات الرفض المتطابقة خلال ثانيتين', async () => {
    resetUnauthorizedThrottle();
    const db = await getDb();
    const fake: Session = { userId: 'integration-test-user', role: 'viewer' };
    const count = async () => (await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM audit_event_queue
       WHERE operation_type = 'unauthorized_access' AND entity_id = 'permission:users.manage'`
    ))?.c ?? 0;
    const before = await count();
    for (let i = 0; i < 5; i++) { try { requirePerm(fake, 'users.manage'); } catch { /* متوقع */ } }
    await drainAuditIntegration();
    expect((await count()) - before === 1, 'سُجّلت أكثر من محاولة واحدة لنفس الطلب');
  });

  // ===== التغطية والتقاط العمليات =====
  await check('تغطية كل جداول البيانات المطلوبة بمشغلات التدقيق', async () => {
    const c = await checkAuditCoverage();
    const missing = AUDIT_REQUIRED_TABLES.filter((t) => !c.covered.includes(t));
    expect(missing.length === 0, 'غير مغطاة: ' + missing.join('، '));
  });

  await check('التقاط عملية حقيقية بالمشغل ثم التراجع الكامل (دون أثر)', async () => {
    const db = await getDb();
    const q = async () => (await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM audit_event_queue WHERE entity_type = 'departments'`
    ))?.c ?? 0;
    const before = await q();
    let seen = -1;
    try {
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          'INSERT INTO departments (id, name, created_at) VALUES (?, ?, ?)',
          ['rollback-test-dept', '__اختبار_تدقيق__', Date.now()]
        );
        seen = await q();
        throw new Error(SENTINEL);
      });
    } catch (e) {
      if (!String((e as Error)?.message).includes(SENTINEL)) throw e;
    }
    expect(seen === before + 1, 'المشغل لم يلتقط الإدراج');
    expect((await q()) === before, 'لم يتراجع الحدث مع المعاملة');
  });

  // ===== الحماية من العبث في جداول المزامنة =====
  await check('منع تعديل/حذف سجلات التدقيق وحذف الصندوق الصادر', async () => {
    const db = await memoryDb(2);
    await ensureOutboxSchema(db);
    await queueNewAuditRows(db, 1);
    const attempts: [string, (string | number)[]][] = [
      ['UPDATE audit_logs SET username = ? WHERE sequence_no = 1', ['x']],
      ['DELETE FROM audit_logs WHERE sequence_no = 1', []],
      ['DELETE FROM audit_sync_outbox WHERE sequence_no = 1', []],
      ['UPDATE audit_sync_outbox SET operation_id = ? WHERE sequence_no = 1', ['x']],
    ];
    for (const [sql, params] of attempts) {
      let blocked = false;
      try { await db.runAsync(sql, params); } catch { blocked = true; }
      expect(blocked, 'لم تُرفض: ' + sql);
    }
    await db.closeAsync();
  });

  // ===== المزامنة (قاعدة ذاكرة مؤقتة) =====
  await check('الإضافة للصندوق الصادر متكررة الأمان (لا صفوف مضاعفة)', async () => {
    const db = await memoryDb(3);
    const a = await queueNewAuditRows(db, 1);
    const b = await queueNewAuditRows(db, 2);
    expect(a === 3 && b === 0, 'المضاف ' + a + ' ثم ' + b);
    await db.closeAsync();
  });

  await check('انقطاع الاتصال: لا فقدان، ثم عودة الاتصال وإرسال مرة واحدة', async () => {
    const db = await memoryDb(3);
    let t = 1_000_000;
    const sp = spy();
    const down = mockFetch(() => new TypeError('Network request failed'));
    const base = { db, baseUrl: 'https://srv.test', token: 'tok', now: () => t, onEvent: sp.emit };

    const r1 = await syncAuditOutbox({ ...base, fetchImpl: down.fn });
    expect(r1.status === 'offline', 'الحالة ' + r1.status);
    expect((await statusOf(db)).failed === 3, 'السجلات لم تبقَ بانتظار الإرسال');

    const r2 = await syncAuditOutbox({ ...base, fetchImpl: down.fn });
    expect(r2.status === 'waiting' && down.calls.length === 1, 'لم تُحترم مهلة إعادة المحاولة');

    t += 20 * 60_000;
    const up = mockFetch((_n, init) => {
      const body = JSON.parse(String(init.body));
      return json({ accepted: body.events.map((e: { sequence_no: number }) => e.sequence_no) });
    });
    const r3 = await syncAuditOutbox({ ...base, fetchImpl: up.fn });
    expect(r3.status === 'ok' && r3.sent === 3, 'لم تكتمل المزامنة: ' + r3.status);
    expect((await statusOf(db)).sent === 3, 'ليست كل الصفوف sent');

    const headers = up.calls[0].headers as Record<string, string>;
    expect(!!headers['Idempotency-Key'], 'مفتاح Idempotency مفقود');
    const body = JSON.parse(String(up.calls[0].body));
    expect(body.events.length === 3 && !!body.events[0].record_hash, 'حمولة غير مكتملة');
    expect(!JSON.stringify(body).toLowerCase().includes('hmac_key'), 'المفتاح ضمن الحمولة!');

    await addRow(db, 4);
    await syncAuditOutbox({ ...base, fetchImpl: up.fn });
    expect(sp.events.filter((x) => x === 'sync_completed').length === 1,
      'حدث الاستئناف سُجّل ' + sp.events.length + ' مرات (خطر حلقة تسجيل)');
    await db.closeAsync();
  });

  await check('الأحداث المكررة (duplicates) تُعتبر مُقَرّة', async () => {
    const db = await memoryDb(2);
    const f = mockFetch(() => json({ accepted: [], duplicates: [1, 2] }));
    const r = await syncAuditOutbox({
      db, baseUrl: 'https://srv.test', token: 'tok', fetchImpl: f.fn, onEvent: spy().emit,
    });
    expect(r.status === 'ok' && (await statusOf(db)).sent === 2, 'لم تُعتبر مُقَرّة');
    await db.closeAsync();
  });

  await check('عدم اعتبار أي حدث مُرسَلاً دون إقرار صريح من الخادم', async () => {
    const db = await memoryDb(2);
    const f = mockFetch(() => json({}));
    const r = await syncAuditOutbox({
      db, baseUrl: 'https://srv.test', token: 'tok', fetchImpl: f.fn, onEvent: spy().emit,
    });
    const st = await statusOf(db);
    expect(r.status === 'error' && !st.sent && st.failed === 2, 'اعتُبر الإرسال ناجحاً دون إقرار');
    await db.closeAsync();
  });

  await check('التعارض: يُحفظ ويوقف الإرسال ولا يُكتب فوقه شيء', async () => {
    const db = await memoryDb(3);
    const sp = spy();
    const f = mockFetch(() => json(
      { accepted: [1], conflicts: [{ sequence_no: 2, reason: 'fork' }] }, 409));
    const base = { db, baseUrl: 'https://srv.test', token: 'tok', onEvent: sp.emit };
    const r = await syncAuditOutbox({ ...base, fetchImpl: f.fn });
    const st = await statusOf(db);
    expect(r.status === 'conflict' && st.sent === 1 && st.conflict === 1 && st.pending === 1,
      'حالات غير متوقعة: ' + JSON.stringify(st));
    const r2 = await syncAuditOutbox({ ...base, fetchImpl: f.fn });
    expect(r2.status === 'blocked' && f.calls.length === 1, 'لم يتوقف الإرسال بعد التعارض');
    expect(sp.events.filter((x) => x === 'sync_conflict').length === 1, 'حدث التعارض لم يُسجَّل مرة واحدة');
    await db.closeAsync();
  });

  await check('رفض الخادم (401): السجلات محفوظة والحدث يُسجَّل عند الانتقال فقط', async () => {
    const db = await memoryDb(2);
    let t = 5_000_000;
    const sp = spy();
    const f = mockFetch(() => json({ code: 'ACCOUNT_DISABLED' }, 401));
    const base = { db, baseUrl: 'https://srv.test', token: 'tok', now: () => t, onEvent: sp.emit, fetchImpl: f.fn };
    const r = await syncAuditOutbox(base);
    expect(r.status === 'denied' && (await statusOf(db)).failed === 2, 'الحالة ' + r.status);
    t += 60 * 60_000;
    await syncAuditOutbox(base);
    expect(sp.events.filter((x) => x === 'sync_denied').length === 1, 'تكرر تسجيل الرفض');
    await db.closeAsync();
  });

  await check('رفض العنوان غير الآمن وعدم الإرسال دون تهيئة', async () => {
    const db = await memoryDb(1);
    const f = mockFetch(() => json({ accepted: [1] }));
    const a = await syncAuditOutbox({ db, baseUrl: 'http://srv.test', token: 't', fetchImpl: f.fn });
    const b = await syncAuditOutbox({ db, baseUrl: null, token: null, fetchImpl: f.fn });
    expect(a.status === 'error' && b.status === 'not_configured' && f.calls.length === 0,
      'أُرسل طلب رغم عدم الأمان/التهيئة');
    await db.closeAsync();
  });

  // ===== التقرير على القاعدة الحقيقية =====
  await check('تقرير التحقق على القاعدة الحقيقية: السلسلة سليمة والتغطية كاملة', async () => {
    const report = await buildAuditVerificationReport(s);
    expect(report.chain.ok, 'السلسلة غير سليمة: ' + report.chain.label);
    expect(report.coverage.missingRequired.length === 0, 'تغطية ناقصة');
    expect(report.totals.logs === report.chain.count, 'عدد السجلات لا يطابق المفحوص');
  });

  const ok = failed === 0;
  await recordSystemEvent(s, 'audit.verify', {
    operationType: 'integration_test',
    entityType: 'audit',
    newValues: { passed, failed },
  }).catch(() => undefined);

  return { ok, passed, failed, lines };
}
