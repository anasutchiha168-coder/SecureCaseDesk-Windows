// SECURECASEDESK_FIX_L1_G1_G2 — اختبارات L1: تقييد المحقق بقسمه. تشغَّل بـ: npm run test:case-scope
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NodeDb } from './helpers/node-env';
import { buildReport, type ReportDeps } from '../src/modules/reports/reports-data';
import { ReportError } from '../src/modules/reports/reports-types';
import { resolveCaseScope, caseScopeSql, memoScopeSql, caseDepartmentAllowed } from '../src/security/case-scope';
import type { Session } from '../src/security/guard';
import { listAttachments, countAttachments, type AttachmentDeps } from '../src/modules/attachments/attachments-repo';
import { AttachmentError } from '../src/modules/attachments/attachments-types';
import { initAttachmentsSchema } from '../src/modules/attachments/attachments-schema';
import { initAuditSchema } from '../src/database/audit-schema';
import { MemoryStorage, nodeCrypto, uuid } from './helpers/node-env';

const NOW = new Date(2026, 10, 21, 12, 0, 0).getTime();
const S = (userId: string, role: string): Session => ({ userId, role: role as Session['role'] });
let db: NodeDb; let deps: ReportDeps;
const text = (d: unknown) => JSON.stringify(d);

beforeEach(async () => {
  db = new NodeDb(); deps = { db, now: () => NOW };
  await db.execAsync(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, is_active INTEGER NOT NULL DEFAULT 1, department_id TEXT);
    CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE cases (id TEXT PRIMARY KEY, case_number TEXT, title TEXT, complainant TEXT, suspects TEXT, case_type TEXT, department_id TEXT, officer_id TEXT,
      registration_date INTEGER, incident_location TEXT, incident_details TEXT, status TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE memo_types (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE memos (id TEXT PRIMARY KEY, memo_number TEXT, memo_type_id TEXT, memo_date INTEGER, recipient_organization TEXT, subject TEXT, body TEXT,
      linked_case_id TEXT, status TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE detainee_categories (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE detainees (id TEXT PRIMARY KEY, reference_number TEXT, full_name TEXT, category_id TEXT, admission_date INTEGER, release_date INTEGER,
      alleged_offense TEXT, offense_details TEXT, detaining_authority TEXT, officer_id TEXT, status TEXT, notes TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    INSERT INTO users VALUES ('u-admin','admin','admin',1,NULL),('u-inv1','inv1','investigator',1,'d1'),('u-inv2','inv2','investigator',1,'d2'),
      ('u-nodep','nodep','investigator',1,NULL),('u-off','off','investigator',0,'d1'),('u-view','view','viewer',1,'d1'),('u-det','det','detention_viewer',1,NULL);
    INSERT INTO departments VALUES ('d1','قسم أ'),('d2','قسم ب');
    INSERT INTO cases VALUES
      ('c1','2026/1','قضية قسم أ','x','y','سرقة','d1',NULL,${NOW},'-','-','جديدة','u-admin',${NOW},${NOW}),
      ('c2','2026/2','قضية قسم ب','x','y','احتيال','d2',NULL,${NOW},'-','-','قيد التحقيق','u-admin',${NOW},${NOW}),
      ('c3','2026/3','قضية بلا قسم','x','y','اعتداء',NULL,NULL,${NOW},'-','-','جديدة','u-admin',${NOW},${NOW});
    INSERT INTO memo_types VALUES ('t1','نوع');
    INSERT INTO memos VALUES
      ('m1','م-1','t1',${NOW},'ج','مذكرة قضية أ','-','c1','مسودة','u-admin',${NOW},${NOW}),
      ('m2','م-2','t1',${NOW},'ج','مذكرة قضية ب','-','c2','مسودة','u-admin',${NOW},${NOW}),
      ('m3','م-3','t1',${NOW},'ج','مذكرة حرة','-',NULL,'مسودة','u-admin',${NOW},${NOW});
  `);
  await initAttachmentsSchema(db as never);
  await initAuditSchema(db as never);
});

describe('resolveCaseScope', () => {
  test('المدير والمطّلع: كل القضايا', async () => {
    assert.deepEqual(await resolveCaseScope(db, S('u-admin', 'admin')), { kind: 'all' });
    assert.deepEqual(await resolveCaseScope(db, S('u-view', 'viewer')), { kind: 'all' });
  });
  test('المحقق: قسمه فقط', async () => {
    assert.deepEqual(await resolveCaseScope(db, S('u-inv1', 'investigator')), { kind: 'department', departmentId: 'd1' });
  });
  test('فشل مغلق: محقق بلا قسم، حساب معطّل، مستخدم غير موجود، جلسة فارغة', async () => {
    for (const s of [S('u-nodep', 'investigator'), S('u-off', 'investigator'), S('ghost', 'investigator'), null, undefined]) {
      assert.deepEqual(await resolveCaseScope(db, s as never), { kind: 'none' });
    }
  });
  test('الدور من قاعدة البيانات لا من الجلسة: محقق يدّعي أنه admin يبقى مقيَّداً', async () => {
    assert.deepEqual(await resolveCaseScope(db, S('u-inv1', 'admin')), { kind: 'department', departmentId: 'd1' });
  });
  test('مقاطع SQL', () => {
    assert.equal(caseScopeSql({ kind: 'none' }, 'x').sql, '1 = 0');
    assert.deepEqual(caseScopeSql({ kind: 'department', departmentId: 'd1' }, 'c.department_id'), { sql: 'c.department_id = ?', args: ['d1'] });
    assert.equal(memoScopeSql({ kind: 'none' }, 'x').sql, '1 = 0');
    assert.equal(caseDepartmentAllowed({ kind: 'department', departmentId: 'd1' }, null), false);
    assert.equal(caseDepartmentAllowed({ kind: 'all' }, null), true);
  });
});

describe('التقارير تلتزم بنطاق القسم', () => {
  test('سجل القضايا: المحقق يرى قضية قسمه فقط (لا قضية قسم آخر ولا القضية بلا قسم)', async () => {
    const t = text(await buildReport(deps, S('u-inv1', 'investigator'), 'cases_list'));
    assert.ok(t.includes('2026/1')); assert.ok(!t.includes('2026/2')); assert.ok(!t.includes('2026/3'));
  });
  test('المدير يرى الثلاث', async () => {
    const t = text(await buildReport(deps, S('u-admin', 'admin'), 'cases_list'));
    for (const n of ['2026/1', '2026/2', '2026/3']) assert.ok(t.includes(n), n);
  });
  test('محقق بلا قسم لا يرى شيئاً', async () => {
    const t = text(await buildReport(deps, S('u-nodep', 'investigator'), 'cases_list'));
    for (const n of ['2026/1', '2026/2', '2026/3']) assert.ok(!t.includes(n), n);
  });
  test('ملف قضية قسم آخر: NOT_FOUND (لا كشف لوجودها)', async () => {
    await assert.rejects(buildReport(deps, S('u-inv1', 'investigator'), 'case_file', { caseId: 'c2' }),
      (e: unknown) => e instanceof ReportError && e.code === 'NOT_FOUND');
    assert.ok(text(await buildReport(deps, S('u-inv1', 'investigator'), 'case_file', { caseId: 'c1' })).includes('قضية قسم أ'));
  });
  test('سجل المذكرات: المرتبطة بقضية قسم آخر محجوبة، والحرة باقية', async () => {
    const t = text(await buildReport(deps, S('u-inv1', 'investigator'), 'memos_list'));
    assert.ok(t.includes('مذكرة قضية أ')); assert.ok(!t.includes('مذكرة قضية ب')); assert.ok(t.includes('مذكرة حرة'));
  });
  test('التقرير الإداري: أعداد المحقق ضمن قسمه', async () => {
    const t = text(await buildReport(deps, S('u-inv1', 'investigator'), 'admin_summary'));
    assert.match(t, /إجمالي القضايا[^]*?"value":"1"/);
    const a = text(await buildReport(deps, S('u-admin', 'admin'), 'admin_summary'));
    assert.match(a, /إجمالي القضايا[^]*?"value":"3"/);
  });
});


describe('المرفقات تلتزم بنطاق القسم', () => {
  const adeps = (): AttachmentDeps => ({ db, storage: new MemoryStorage(), crypto: nodeCrypto, uuid, now: () => NOW,
    async getMasterKey() { throw new Error('unused'); } });
  const notFound = (e: unknown) => e instanceof AttachmentError && e.code === 'ENTITY_NOT_FOUND';
  const inv1 = S('u-inv1', 'investigator');
  test('قضية قسم آخر: القائمة والعدّ مرفوضان كأنها غير موجودة', async () => {
    await assert.rejects(listAttachments(adeps(), inv1, 'case', 'c2'), notFound);
    await assert.rejects(countAttachments(adeps(), inv1, 'case', 'c2'), notFound);
    assert.deepEqual(await listAttachments(adeps(), inv1, 'case', 'c1'), []);
  });
  test('مذكرة مرتبطة بقضية قسم آخر مرفوضة؛ المذكرة الحرة مسموحة', async () => {
    await assert.rejects(listAttachments(adeps(), inv1, 'memo', 'm2'), notFound);
    assert.deepEqual(await listAttachments(adeps(), inv1, 'memo', 'm3'), []);
    await assert.rejects(listAttachments(adeps(), S('u-nodep', 'investigator'), 'memo', 'm3'), notFound);
  });
  test('المدير يصل للكل', async () => {
    assert.deepEqual(await listAttachments(adeps(), S('u-admin', 'admin'), 'case', 'c2'), []);
    assert.deepEqual(await listAttachments(adeps(), S('u-admin', 'admin'), 'memo', 'm2'), []);
  });
});
