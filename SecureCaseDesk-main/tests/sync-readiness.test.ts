// SECURECASEDESK_PHASE16_STAGE_B — اختبارات جاهزية المزامنة المحلية (لا خادم، لا محاكاة).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NodeDb } from './helpers/node-env';
import { initAuditSchema } from '../src/database/audit-schema';
import { initSyncSchema, listDueOperations, markOperationFailed, markRecordArchived, nextRetryDelayMs } from '../src/database/sync-schema';
import { UnavailableSyncService } from '../src/services/sync-service';
import { escapeHtml, escapeXml, stripBidiControls } from '../src/modules/reports/reports-format';

async function setup() {
  const db = new NodeDb();
  await db.execAsync(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE cases (id TEXT PRIMARY KEY, title TEXT, department_id TEXT, officer_id TEXT, status TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    INSERT INTO cases (id, title) VALUES ('old-1', 'قديمة');
  `);
  await initAuditSchema(db as never);
  await initSyncSchema(db as never);
  return db;
}

describe('G1: محارف تجاوز الاتجاه', () => {
  const evil = 'a\u202Eb\u202Ac\u2066d\u2069e';
  test('تُحذف من HTML وXML وstripBidiControls', () => {
    assert.equal(stripBidiControls(evil), 'abcde');
    assert.equal(escapeHtml(evil), 'abcde');
    assert.equal(escapeXml(evil), 'abcde');
  });
  test('لا تُحذف علامات الاتجاه المشروعة (RLM/LRM)', () => {
    assert.equal(escapeHtml('x\u200Fy'), 'x\u200Fy');
  });
});

describe('جاهزية المزامنة (16.2)', () => {
  test('إدراج سجل: إصدار 1 وعملية create بمعرّف UUID ومفتاح idempotency', async () => {
    const db = await setup();
    await db.runAsync(`INSERT INTO cases (id, title) VALUES ('c1', 'قضية')`);
    const m = await db.getFirstAsync<{ row_version: number; last_modified_by: string }>(`SELECT * FROM sync_record_meta WHERE record_id = 'c1'`);
    assert.equal(m?.row_version, 1);
    const op = await db.getFirstAsync<{ operation_id: string; idempotency_key: string; op_type: string; base_version: number; status: string }>(`SELECT * FROM sync_operations WHERE record_id = 'c1'`);
    assert.match(op!.operation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(op!.idempotency_key, 'cases:c1:1');
    assert.equal(op!.op_type, 'create'); assert.equal(op!.base_version, 0); assert.equal(op!.status, 'pending');
  });
  test('تعديل: يزيد الإصدار ويُنشئ update بإصدار أساس صحيح، ومعرّفات العمليات فريدة', async () => {
    const db = await setup();
    await db.runAsync(`INSERT INTO cases (id, title) VALUES ('c1', 'a')`);
    await db.runAsync(`UPDATE cases SET title = 'b' WHERE id = 'c1'`);
    await db.runAsync(`UPDATE cases SET title = 'c' WHERE id = 'c1'`);
    const m = await db.getFirstAsync<{ row_version: number }>(`SELECT row_version FROM sync_record_meta WHERE record_id = 'c1'`);
    assert.equal(m?.row_version, 3);
    const ops = await db.getAllAsync<{ operation_id: string; op_type: string; base_version: number; idempotency_key: string }>(`SELECT * FROM sync_operations WHERE record_id = 'c1' ORDER BY rowid`);
    assert.deepEqual(ops.map((o) => [o.op_type, o.base_version, o.idempotency_key]), [['create', 0, 'cases:c1:1'], ['update', 1, 'cases:c1:2'], ['update', 2, 'cases:c1:3']]);
    assert.equal(new Set(ops.map((o) => o.operation_id)).size, 3);
  });
  test('آخر مستخدم عدّل يؤخذ من سياق التدقيق', async () => {
    const db = await setup();
    await db.runAsync(`INSERT OR REPLACE INTO audit_context (id, actor_user_id, actor_username, updated_at) VALUES (1, 'u-7', 'x', 1)`);
    await db.runAsync(`INSERT INTO cases (id, title) VALUES ('c2', 'a')`);
    const m = await db.getFirstAsync<{ last_modified_by: string }>(`SELECT last_modified_by FROM sync_record_meta WHERE record_id = 'c2'`);
    assert.equal(m?.last_modified_by, 'u-7');
  });
  test('السجلات القديمة تحصل على إصدار 1 بلا عمليات، وإعادة التهيئة لا تكرر شيئاً', async () => {
    const db = await setup();
    const before = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM sync_operations`);
    assert.equal(before?.n, 0);
    await initSyncSchema(db as never);
    const meta = await db.getAllAsync(`SELECT * FROM sync_record_meta WHERE record_id = 'old-1'`);
    assert.equal(meta.length, 1);
  });
  test('إعادة محاولة: backoff أسّي، وفشل العملية يحفظ البيانات الوصفية ويؤجل الموعد', async () => {
    const db = await setup();
    await db.runAsync(`INSERT INTO cases (id, title) VALUES ('c3', 'a')`);
    const [op] = await listDueOperations(db as never, 1000);
    await markOperationFailed(db as never, op.operation_id, 'network', 1000);
    assert.equal((await listDueOperations(db as never, 1000)).length, 0);
    assert.equal((await listDueOperations(db as never, 1000 + nextRetryDelayMs(1))).length, 1);
    const row = await db.getFirstAsync<{ attempt_count: number; status: string; last_error: string }>(`SELECT * FROM sync_operations WHERE operation_id = ?`, [op.operation_id]);
    assert.deepEqual([row?.attempt_count, row?.status, row?.last_error], [1, 'failed', 'network']);
    assert.ok(nextRetryDelayMs(2) === 2 * nextRetryDelayMs(1));
  });
  test('أرشفة ناعمة: السجل يبقى وتُدرج عملية archive', async () => {
    const db = await setup();
    await db.runAsync(`INSERT INTO cases (id, title) VALUES ('c4', 'a')`);
    await markRecordArchived(db as never, 'cases', 'c4', 'u-1', 5000);
    assert.equal((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM cases WHERE id = 'c4'`))?.n, 1);
    const m = await db.getFirstAsync<{ archived_at: number; row_version: number }>(`SELECT * FROM sync_record_meta WHERE record_id = 'c4'`);
    assert.deepEqual([m?.archived_at, m?.row_version], [5000, 2]);
    assert.equal((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM sync_operations WHERE record_id = 'c4' AND op_type = 'archive'`))?.n, 1);
  });
  test('الخدمة غير متاحة ولا تُحاكي نجاحاً', async () => {
    const s = new UnavailableSyncService();
    assert.deepEqual(await s.getStatus(), { available: false, reason: 'not_configured' });
    await assert.rejects(() => s.synchronize());
  });
});
