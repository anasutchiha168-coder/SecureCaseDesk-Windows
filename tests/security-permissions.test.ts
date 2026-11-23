// SECURECASEDESK_PHASE12_S2
// اختبارات الصلاحيات: الأدوار الأربعة، عزل مشاهد المحتجزين، الرفض عند الفشل (fail-closed)، وطبقة البيانات (assertUserCan).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeDb } from './helpers/node-env';
import {
  ROLES, can, canAccessTab, firstAllowedTab, normalizeRole, assertUserCan,
  type Permission, type Role,
} from '../src/security/permissions';
import { ForbiddenError, onForbidden, requirePerm } from '../src/security/guard';

const ALL_PERMS: Permission[] = [
  'dashboard.view', 'cases.view', 'cases.manage', 'memos.view', 'memos.manage',
  'detainees.view', 'detainees.manage', 'detainees.correct', 'users.manage', 'attachments.admin',
  'audit.view', 'audit.verify', 'audit.sync', 'backup.manage', 'ai.use', 'ai.manage',
];
const allowedFor = (role: Role) => ALL_PERMS.filter((p) => can(role, p));

test('الأدوار الأربعة معرّفة', () => {
  assert.deepEqual(ROLES.map((r) => r.key).sort(), ['admin', 'detention_viewer', 'investigator', 'viewer']);
});

test('مدير النظام يملك كل الصلاحيات', () => {
  assert.deepEqual(allowedFor('admin'), ALL_PERMS);
});

test('المحقق: يدير القضايا والمذكرات ولا يدير المستخدمين أو النسخ أو التصحيحات أو التدقيق', () => {
  for (const p of ['cases.manage', 'memos.manage', 'detainees.view', 'ai.use'] as Permission[]) assert.equal(can('investigator', p), true, p);
  for (const p of ['users.manage', 'backup.manage', 'detainees.correct', 'detainees.manage', 'audit.view', 'audit.verify', 'attachments.admin', 'ai.manage'] as Permission[]) {
    assert.equal(can('investigator', p), false, p);
  }
});

test('مستخدم الاطلاع: قراءة فقط', () => {
  assert.deepEqual(allowedFor('viewer'), ['dashboard.view', 'cases.view', 'memos.view', 'detainees.view', 'ai.use']);
  for (const p of ALL_PERMS.filter((x) => x.endsWith('.manage') || x === 'detainees.correct')) assert.equal(can('viewer', p), false, p);
});

test('مشاهد المحتجزين معزول تماماً: لوحة المحتجزين فقط', () => {
  assert.deepEqual(allowedFor('detention_viewer'), ['dashboard.view', 'detainees.view']);
  for (const p of ['cases.view', 'cases.manage', 'memos.view', 'memos.manage', 'audit.view', 'backup.manage', 'ai.use', 'users.manage'] as Permission[]) {
    assert.equal(can('detention_viewer', p), false, p);
  }
  for (const tab of ['cases', 'memos', 'users', 'audit']) assert.equal(canAccessTab('detention_viewer', tab), false, tab);
  assert.equal(canAccessTab('detention_viewer', 'detainees'), true);
  assert.equal(firstAllowedTab('detention_viewer'), 'index');
});

test('رفض افتراضي: دور غير معروف أو فارغ لا يملك شيئاً', () => {
  for (const r of [null, undefined, '', 'root', 'ADMINISTRATOR', 'admin;DROP']) {
    for (const p of ALL_PERMS) assert.equal(can(r as never, p), false, `${String(r)}:${p}`);
  }
  assert.equal(normalizeRole('Detention-Viewer'), 'detention_viewer');
  assert.equal(normalizeRole(' admin '), 'admin');
  assert.equal(normalizeRole('hacker'), null);
});

test('الحارس requirePerm يفشل مغلقاً ويُبلغ المستمعين', () => {
  const events: { permission: string; userId: string | null }[] = [];
  const off = onForbidden((e) => events.push({ permission: e.permission, userId: e.userId }));
  assert.throws(() => requirePerm(null, 'cases.view'), ForbiddenError);
  assert.throws(() => requirePerm({ userId: '', role: 'admin' }, 'cases.view'), ForbiddenError);
  assert.throws(() => requirePerm({ userId: 'u1', role: 'unknown' as never }, 'cases.view'), ForbiddenError);
  assert.throws(() => requirePerm({ userId: 'u2', role: 'detention_viewer' }, 'memos.view'), ForbiddenError);
  assert.equal(requirePerm({ userId: 'u3', role: 'admin' }, 'users.manage').userId, 'u3');
  off();
  assert.equal(events.length, 4);
  assert.equal(events[3].userId, 'u2');
  // بعد إلغاء الاشتراك لا تصل أحداث جديدة
  assert.throws(() => requirePerm(null, 'cases.view'));
  assert.equal(events.length, 4);
});

test('مستمع يرمي خطأ لا يغيّر قرار الرفض', () => {
  const off = onForbidden(() => { throw new Error('listener boom'); });
  assert.throws(() => requirePerm(null, 'cases.view'), ForbiddenError);
  off();
});

test('طبقة البيانات assertUserCan: تقرأ الدور من الجدول وتتجاهل الحالة الظاهرة', async () => {
  const db = new NodeDb();
  await db.execAsync(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, is_active INTEGER);`);
  await db.runAsync('INSERT INTO users VALUES (?,?,?)', ['a', 'admin', 1]);
  await db.runAsync('INSERT INTO users VALUES (?,?,?)', ['dv', 'detention_viewer', 1]);
  await db.runAsync('INSERT INTO users VALUES (?,?,?)', ['off', 'admin', 0]);
  await db.runAsync('INSERT INTO users VALUES (?,?,?)', ['nul', 'admin', null]); // NULL يُعامل كنشط (COALESCE)
  await db.runAsync('INSERT INTO users VALUES (?,?,?)', ['bad', 'superuser', 1]);
  const d = db as never;

  await assertUserCan(d, 'a', 'users.manage');
  await assertUserCan(d, 'nul', 'cases.view');
  await assertUserCan(d, 'dv', 'detainees.view');
  await assert.rejects(assertUserCan(d, 'dv', 'cases.view'), /FORBIDDEN/);
  await assert.rejects(assertUserCan(d, 'dv', 'memos.view'), /FORBIDDEN/);
  await assert.rejects(assertUserCan(d, 'off', 'cases.view'), /FORBIDDEN/);      // حساب معطّل
  await assert.rejects(assertUserCan(d, 'bad', 'cases.view'), /FORBIDDEN/);      // دور غير معروف
  await assert.rejects(assertUserCan(d, 'ghost', 'cases.view'), /FORBIDDEN/);    // مستخدم غير موجود

  // تغيير الدور في القاعدة يسري فوراً على فحص طبقة البيانات
  await db.runAsync('UPDATE users SET role = ? WHERE id = ?', ['detention_viewer', 'a']);
  await assert.rejects(assertUserCan(d, 'a', 'users.manage'), /FORBIDDEN/);
});
