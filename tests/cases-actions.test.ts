// SECURECASEDESK_PHASE3_COMPLETION — اختبارات المرحلة 3: تعديل/حالة/أرشفة/إسناد/نقل/سجل التعديل/إدارة الأقسام.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NodeDb, uuid } from './helpers/node-env';
import { initAuditSchema } from '../src/database/audit-schema';
import { initSyncSchema, markRecordArchived, markRecordUnarchived } from '../src/database/sync-schema';
import { initCaseHistorySchema } from '../src/modules/cases/cases-schema';
import {
  updateCase, changeStatus, archiveCase, unarchiveCase, assignCase, transferCase, getCaseHistory,
  CaseActionError, type CaseDeps, type CaseErrorCode,
} from '../src/modules/cases/cases-actions';
import { createDepartment, updateDepartment, setDepartmentActive, listDepartments } from '../src/modules/cases/departments-admin';
import { ForbiddenError, type Session } from '../src/security/guard';

const S = (userId: string, role: string): Session => ({ userId, role: role as Session['role'] });
const ADMIN = S('u-admin', 'admin');
const INV1 = S('u-inv1', 'investigator'); // قسم d1
const INV2 = S('u-inv2', 'investigator'); // قسم d2
const VIEWER = S('u-view', 'viewer');
const DET = S('u-det', 'detention_viewer');

let db: NodeDb; let deps: CaseDeps; let clock = 1_000_000;

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) {
    if (e instanceof CaseActionError) return e.code;
    if (e instanceof ForbiddenError) return 'FORBIDDEN';
    throw e;
  }
}
const row = async (sql: string, p: unknown[] = []) => db.getFirstAsync<Record<string, unknown>>(sql, p);
const rows = async (sql: string, p: unknown[] = []) => db.getAllAsync<Record<string, unknown>>(sql, p);

beforeEach(async () => {
  db = new NodeDb(); clock = 1_000_000;
  deps = {
    db, now: () => ++clock, uuid,
    onArchive: (id, u, n) => markRecordArchived(db as never, 'cases', id, u, n),
    onUnarchive: (id, u, n) => markRecordUnarchived(db as never, 'cases', id, u, n),
  };
  await db.execAsync(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, is_active INTEGER NOT NULL DEFAULT 1, department_id TEXT);
    CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE cases (id TEXT PRIMARY KEY, case_number TEXT UNIQUE NOT NULL, title TEXT NOT NULL, complainant TEXT, suspects TEXT, case_type TEXT NOT NULL,
      department_id TEXT, officer_id TEXT, registration_date INTEGER NOT NULL, incident_location TEXT, incident_details TEXT, status TEXT NOT NULL DEFAULT 'جديدة',
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO users VALUES ('u-admin','admin','admin',1,NULL),('u-inv1','inv1','investigator',1,'d1'),('u-inv1b','inv1b','investigator',1,'d1'),
      ('u-inv2','inv2','investigator',1,'d2'),('u-off','off','investigator',0,'d1'),('u-view','view','viewer',1,'d1'),('u-det','det','detention_viewer',1,NULL);
    INSERT INTO departments VALUES ('d1','قسم أ',NULL,1,1),('d2','قسم ب',NULL,1,1),('d3','قسم معطل',NULL,0,1);
    INSERT INTO cases VALUES
      ('c1','2026/1','قضية أ','س','ص','سرقة','d1',NULL,1,'موقع','تفاصيل','جديدة','u-admin',1,1),
      ('c2','2026/2','قضية ب','س','ص','احتيال','d2',NULL,1,NULL,NULL,'قيد التحقيق','u-admin',1,1);
  `);
  await initCaseHistorySchema(db as never);
  await initAuditSchema(db as never);
  await initSyncSchema(db as never);
});

describe('updateCase', () => {
  test('يعدّل الحقول المتغيرة فقط ويسجل القيم السابقة والجديدة والسبب', async () => {
    await updateCase(deps, INV1, 'c1', { title: 'عنوان جديد', complainant: 'س', incident_location: '' }, 'تصحيح');
    const c = await row('SELECT * FROM cases WHERE id = ?', ['c1']);
    assert.equal(c?.title, 'عنوان جديد'); assert.equal(c?.incident_location, null); assert.ok(Number(c?.updated_at) > 1);
    const h = await rows('SELECT field_name, previous_value, new_value, reason, executed_by, action FROM case_history ORDER BY rowid');
    assert.deepEqual(h.map((x) => [x.field_name, x.previous_value, x.new_value]), [['title', 'قضية أ', 'عنوان جديد'], ['incident_location', 'موقع', null]]);
    assert.ok(h.every((x) => x.reason === 'تصحيح' && x.executed_by === 'u-inv1' && x.action === 'update'));
  });
  test('لا تغيير = NO_CHANGES ولا سجل', async () => {
    assert.equal(await code(updateCase(deps, ADMIN, 'c1', { title: ' قضية أ ' })), 'NO_CHANGES');
    assert.equal((await row('SELECT COUNT(*) n FROM case_history'))?.n, 0);
  });
  test('رقم القضية والحقول غير القابلة للتعديل مرفوضة، والحقول المطلوبة لا تُفرَّغ', async () => {
    assert.equal(await code(updateCase(deps, ADMIN, 'c1', { case_number: 'x' } as never)), 'INVALID');
    assert.equal(await code(updateCase(deps, ADMIN, 'c1', { status: 'x' } as never)), 'INVALID');
    assert.equal(await code(updateCase(deps, ADMIN, 'c1', { title: '  ' })), 'INVALID');
    assert.equal(await code(updateCase(deps, ADMIN, 'c1', { title: 'ع'.repeat(201) })), 'INVALID');
  });
  test('الصلاحيات: مطّلع ومشاهد المحتجزين وجلسة فارغة ممنوعون', async () => {
    for (const s of [VIEWER, DET, null, undefined]) assert.equal(await code(updateCase(deps, s as never, 'c1', { title: 'x' })), 'FORBIDDEN');
  });
  test('النطاق: المحقق لا يعدّل قضية قسم آخر ويراها غير موجودة', async () => {
    assert.equal(await code(updateCase(deps, INV1, 'c2', { title: 'x' })), 'NOT_FOUND');
    assert.equal(await code(updateCase(deps, INV1, 'ghost', { title: 'x' })), 'NOT_FOUND');
    assert.equal((await row('SELECT title FROM cases WHERE id = ?', ['c2']))?.title, 'قضية ب');
  });
});

describe('changeStatus', () => {
  test('يغيّر الحالة ويسجل، ويرفض المؤرشفة والمجهولة والمكررة', async () => {
    await changeStatus(deps, INV1, 'c1', 'قيد التحقيق');
    assert.equal((await row('SELECT status FROM cases WHERE id = ?', ['c1']))?.status, 'قيد التحقيق');
    const h = await row("SELECT previous_value p, new_value n, action a FROM case_history WHERE case_id = 'c1'");
    assert.deepEqual([h?.p, h?.n, h?.a], ['جديدة', 'قيد التحقيق', 'status']);
    assert.equal(await code(changeStatus(deps, INV1, 'c1', 'مؤرشفة')), 'INVALID');
    assert.equal(await code(changeStatus(deps, INV1, 'c1', 'هراء')), 'INVALID');
    assert.equal(await code(changeStatus(deps, INV1, 'c1', 'قيد التحقيق')), 'NO_CHANGES');
    assert.equal(await code(changeStatus(deps, VIEWER, 'c1', 'مغلقة')), 'FORBIDDEN');
  });
});

describe('الأرشفة', () => {
  test('السبب إلزامي، والقضية تبقى ولا تُحذف، والتعديلات عليها ممنوعة', async () => {
    assert.equal(await code(archiveCase(deps, INV1, 'c1', '  ')), 'REASON_REQUIRED');
    await archiveCase(deps, INV1, 'c1', 'انتهت');
    assert.equal((await row('SELECT status FROM cases WHERE id = ?', ['c1']))?.status, 'مؤرشفة');
    assert.equal(await code(archiveCase(deps, INV1, 'c1', 'مرة أخرى')), 'ARCHIVED');
    assert.equal(await code(updateCase(deps, ADMIN, 'c1', { title: 'x' })), 'ARCHIVED');
    assert.equal(await code(changeStatus(deps, ADMIN, 'c1', 'مغلقة')), 'ARCHIVED');
    assert.equal(await code(assignCase(deps, ADMIN, 'c1', 'u-inv1')), 'ARCHIVED');
    assert.equal(await code(transferCase(deps, ADMIN, 'c1', 'd2', 'x')), 'ARCHIVED');
  });
  test('تُسجَّل الأرشفة في المزامنة (علامة + عملية archive)', async () => {
    await archiveCase(deps, ADMIN, 'c1', 'سبب');
    const m = await row("SELECT archived_at, archived_by FROM sync_record_meta WHERE entity='cases' AND record_id='c1'");
    assert.ok(m?.archived_at); assert.equal(m?.archived_by, 'u-admin');
    assert.equal((await row("SELECT COUNT(*) n FROM sync_operations WHERE record_id='c1' AND op_type='archive'"))?.n, 1);
  });
  test('فك الأرشفة للمدير فقط ويعيد الحالة السابقة', async () => {
    await changeStatus(deps, ADMIN, 'c1', 'قيد التحقيق');
    await archiveCase(deps, INV1, 'c1', 'سبب');
    assert.equal(await code(unarchiveCase(deps, INV1, 'c1', 'رجوع')), 'FORBIDDEN');
    assert.equal(await code(unarchiveCase(deps, ADMIN, 'c1', '')), 'REASON_REQUIRED');
    await unarchiveCase(deps, ADMIN, 'c1', 'رجوع');
    assert.equal((await row('SELECT status FROM cases WHERE id = ?', ['c1']))?.status, 'قيد التحقيق');
    assert.equal(await code(unarchiveCase(deps, ADMIN, 'c1', 'x')), 'NOT_ARCHIVED');
    assert.equal((await row("SELECT archived_at FROM sync_record_meta WHERE record_id='c1'"))?.archived_at, null);
  });
  test('فشل الربط داخل المعاملة يتراجع عن الأرشفة بالكامل', async () => {
    deps.onArchive = async () => { throw new Error('sync down'); };
    await assert.rejects(() => archiveCase(deps, ADMIN, 'c1', 'سبب'));
    assert.equal((await row('SELECT status FROM cases WHERE id = ?', ['c1']))?.status, 'جديدة');
    assert.equal((await row('SELECT COUNT(*) n FROM case_history'))?.n, 0);
  });
});

describe('الإسناد', () => {
  test('محقق من القسم نفسه ينجح، والإلغاء بـ null، والتكرار NO_CHANGES', async () => {
    await assignCase(deps, INV1, 'c1', 'u-inv1b', 'توزيع');
    assert.equal((await row('SELECT officer_id FROM cases WHERE id = ?', ['c1']))?.officer_id, 'u-inv1b');
    assert.equal(await code(assignCase(deps, INV1, 'c1', 'u-inv1b')), 'NO_CHANGES');
    await assignCase(deps, INV1, 'c1', null);
    assert.equal((await row('SELECT officer_id FROM cases WHERE id = ?', ['c1']))?.officer_id, null);
    assert.equal((await row("SELECT COUNT(*) n FROM case_history WHERE action='assign'"))?.n, 2);
  });
  test('يُرفض: معطّل، دور مطّلع، محقق من قسم آخر، مستخدم غير موجود', async () => {
    for (const o of ['u-off', 'u-view', 'u-inv2', 'ghost', 'u-det']) assert.equal(await code(assignCase(deps, ADMIN, 'c1', o)), 'OFFICER_INVALID', o);
  });
  test('المطّلع لا يُسند', async () => {
    assert.equal(await code(assignCase(deps, VIEWER, 'c1', 'u-inv1')), 'FORBIDDEN');
  });
});

describe('النقل بين الأقسام', () => {
  test('للمدير فقط وبسبب إلزامي', async () => {
    assert.equal(await code(transferCase(deps, INV1, 'c1', 'd2', 'x')), 'FORBIDDEN');
    assert.equal(await code(transferCase(deps, ADMIN, 'c1', 'd2', '')), 'REASON_REQUIRED');
    await transferCase(deps, ADMIN, 'c1', 'd2', 'اختصاص');
    assert.equal((await row('SELECT department_id FROM cases WHERE id = ?', ['c1']))?.department_id, 'd2');
    // بعد النقل: محقق القسم الجديد يراها ومحقق القسم القديم لا يراها
    assert.equal(await code(getCaseHistory(deps, INV2, 'c1')), 'OK');
    assert.equal(await code(getCaseHistory(deps, INV1, 'c1')), 'NOT_FOUND');
  });
  test('قسم معطّل أو غير موجود أو نفس القسم مرفوض', async () => {
    assert.equal(await code(transferCase(deps, ADMIN, 'c1', 'd3', 'x')), 'DEPARTMENT_INVALID');
    assert.equal(await code(transferCase(deps, ADMIN, 'c1', 'nope', 'x')), 'DEPARTMENT_INVALID');
    assert.equal(await code(transferCase(deps, ADMIN, 'c1', 'd1', 'x')), 'NO_CHANGES');
  });
  test('يُزال إسناد المحقق من القسم القديم ويُسجَّل', async () => {
    await assignCase(deps, ADMIN, 'c1', 'u-inv1');
    await transferCase(deps, ADMIN, 'c1', 'd2', 'اختصاص');
    assert.equal((await row('SELECT officer_id FROM cases WHERE id = ?', ['c1']))?.officer_id, null);
    const actions = (await rows('SELECT action FROM case_history WHERE case_id = ? ORDER BY rowid', ['c1'])).map((x) => x.action);
    assert.deepEqual(actions, ['assign', 'transfer', 'assign']);
  });
  test('ذرّية: فشل كتابة السجل يتراجع عن النقل', async () => {
    await db.execAsync(`CREATE TRIGGER t_fail BEFORE INSERT ON case_history WHEN NEW.action = 'transfer' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    await assert.rejects(() => transferCase(deps, ADMIN, 'c1', 'd2', 'x'));
    assert.equal((await row('SELECT department_id FROM cases WHERE id = ?', ['c1']))?.department_id, 'd1');
  });
});

describe('سجل التعديل', () => {
  test('للإلحاق فقط: لا تعديل ولا حذف حتى بـ SQL مباشر', async () => {
    await changeStatus(deps, ADMIN, 'c1', 'مغلقة');
    await assert.rejects(() => db.runAsync("UPDATE case_history SET reason = 'x'"), /غير قابل للتعديل/);
    await assert.rejects(() => db.runAsync('DELETE FROM case_history'), /غير قابل للحذف/);
  });
  test('القراءة: مرتبة، تحمل اسم المنفّذ، والمشاهد والمحتجزون محجوبون عن غير المسموح', async () => {
    await changeStatus(deps, ADMIN, 'c1', 'قيد التحقيق'); await archiveCase(deps, ADMIN, 'c1', 'x');
    const h = await getCaseHistory(deps, VIEWER, 'c1');
    assert.deepEqual(h.map((x) => x.action), ['status', 'archive']); assert.equal(h[0].executed_by_name, 'admin');
    assert.equal(await code(getCaseHistory(deps, DET, 'c1')), 'FORBIDDEN');
    assert.equal(await code(getCaseHistory(deps, INV1, 'c2')), 'NOT_FOUND');
  });
  test('كل تعديل يزيد إصدار السجل ويُدرج عملية مزامنة (جاهزية 16.2)', async () => {
    await updateCase(deps, ADMIN, 'c1', { title: 'جديد' });
    const m = await row("SELECT row_version v FROM sync_record_meta WHERE entity='cases' AND record_id='c1'");
    assert.ok(Number(m?.v) >= 2);
    assert.ok(Number((await row("SELECT COUNT(*) n FROM sync_operations WHERE record_id='c1' AND op_type='update'"))?.n) >= 1);
  });
});

describe('إدارة الأقسام', () => {
  test('للمدير فقط (users.manage)', async () => {
    for (const s of [INV1, VIEWER, DET, null]) {
      assert.equal(await code(createDepartment(deps, s as never, { name: 'قسم جديد' })), 'FORBIDDEN');
      assert.equal(await code(listDepartments(deps, s as never)), 'FORBIDDEN');
    }
  });
  test('إنشاء وتعديل مع منع تكرار الاسم (بلا حساسية للحالة) والتحقق من الطول', async () => {
    const id = await createDepartment(deps, ADMIN, { name: '  قسم   جديد ', description: 'وصف' });
    assert.equal((await row('SELECT name, is_active FROM departments WHERE id = ?', [id]))?.name, 'قسم جديد');
    assert.equal(await code(createDepartment(deps, ADMIN, { name: 'قسم جديد' })), 'DUPLICATE_NAME');
    assert.equal(await code(createDepartment(deps, ADMIN, { name: 'قسم أ' })), 'DUPLICATE_NAME');
    assert.equal(await code(createDepartment(deps, ADMIN, { name: 'أ' })), 'INVALID');
    await updateDepartment(deps, ADMIN, id, { description: 'وصف آخر' });
    assert.equal(await code(updateDepartment(deps, ADMIN, id, { description: 'وصف آخر' })), 'NO_CHANGES');
    assert.equal(await code(updateDepartment(deps, ADMIN, id, { name: 'قسم ب' })), 'DUPLICATE_NAME');
    assert.equal(await code(updateDepartment(deps, ADMIN, 'ghost', { name: 'سسس' })), 'NOT_FOUND');
  });
  test('التعطيل ممنوع مع قضايا مفتوحة، ومسموح بعد إغلاقها أو أرشفتها، وإعادة التفعيل', async () => {
    assert.equal(await code(setDepartmentActive(deps, ADMIN, 'd1', false)), 'HAS_OPEN_CASES');
    await changeStatus(deps, ADMIN, 'c1', 'مغلقة');
    await setDepartmentActive(deps, ADMIN, 'd1', false);
    assert.equal((await row('SELECT is_active FROM departments WHERE id = ?', ['d1']))?.is_active, 0);
    assert.equal(await code(setDepartmentActive(deps, ADMIN, 'd1', false)), 'NO_CHANGES');
    await setDepartmentActive(deps, ADMIN, 'd1', true);
    assert.equal((await row('SELECT is_active FROM departments WHERE id = ?', ['d1']))?.is_active, 1);
    await archiveCase(deps, ADMIN, 'c2', 'x');
    await setDepartmentActive(deps, ADMIN, 'd2', false);
  });
  test('القائمة تشمل المعطّل للمدير', async () => {
    const l = await listDepartments(deps, ADMIN);
    assert.equal(l.length, 3); assert.equal(l[l.length - 1].name, 'قسم معطل');
  });
});

describe('تماسك السجلات التاريخية', () => {
  test('تدقيق HMAC يلتقط تعديلات القضايا عبر المشغلات الموجودة', async () => {
    await updateCase(deps, ADMIN, 'c1', { title: 'تدقيق' });
    const q = await row("SELECT COUNT(*) n FROM audit_event_queue WHERE entity_type = 'cases' AND operation_type = 'update'");
    assert.ok(Number(q?.n) >= 1);
  });
});
