#!/usr/bin/env bash
# SecureCaseDesk — إكمال المرحلة 3: تعديل/حالة/أرشفة/إسناد/نقل القضايا + سجل التعديل + إدارة الأقسام
# التشغيل من جذر المشروع:  bash apply-phase3.sh      (آمن للتكرار؛ لا يحذف شيئاً)
set -euo pipefail
[ -f package.json ] && [ -f src/database/db.ts ] && [ -f src/database/sync-schema.ts ] || { echo "✗ شغّله من جذر المشروع بعد تطبيق apply-stageB.sh"; exit 1; }
command -v node >/dev/null || { echo "✗ يلزم node"; exit 1; }

echo "== 1/3 كتابة ملفات المرحلة 3 =="
mkdir -p src/modules/cases src/services tests
cat > src/modules/cases/cases-schema.ts <<'SC_EOF_MARK'
// SECURECASEDESK_PHASE3_COMPLETION
// سجل تعديل القضايا: للإلحاق فقط (لا تعديل ولا حذف) بمشغلات مثل correction_history.
export interface CasesSchemaDb { execAsync(sql: string): Promise<void> }

export async function initCaseHistorySchema(db: CasesSchemaDb): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS case_history (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('update','status','archive','unarchive','assign','transfer')),
      field_name TEXT NOT NULL,
      previous_value TEXT,
      new_value TEXT,
      reason TEXT,
      executed_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (case_id) REFERENCES cases(id),
      FOREIGN KEY (executed_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_case_history_case ON case_history(case_id, created_at);
    CREATE TRIGGER IF NOT EXISTS trg_case_history_no_update
    BEFORE UPDATE ON case_history
    BEGIN SELECT RAISE(ABORT, 'سجل تعديل القضايا غير قابل للتعديل'); END;
    CREATE TRIGGER IF NOT EXISTS trg_case_history_no_delete
    BEFORE DELETE ON case_history
    BEGIN SELECT RAISE(ABORT, 'سجل تعديل القضايا غير قابل للحذف'); END;
  `);
}
SC_EOF_MARK
echo "  ✓ src/modules/cases/cases-schema.ts"
cat > src/modules/cases/cases-actions.ts <<'SC_EOF_MARK'
// SECURECASEDESK_PHASE3_COMPLETION
// عمليات القضايا: تعديل، حالة، أرشفة، إسناد، نقل بين الأقسام، وسجل التعديل. كل عملية بمعاملة واحدة
// وبحقن كامل للاعتماديات (يعمل في التطبيق وفي اختبارات Node بالشيفرة نفسها).
// الصلاحية والنطاق يُفحصان قبل أي كتابة. قضية خارج نطاق المستخدم تظهر له كأنها غير موجودة.
import { requirePerm, ForbiddenError, type Session } from '../../security/guard';
import { resolveCaseScope, caseDepartmentAllowed, type CaseScope } from '../../security/case-scope';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface CaseDb {
  getFirstAsync<T>(sql: string, params?: any): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: any): Promise<T[]>;
  runAsync(sql: string, params?: any): Promise<unknown>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface CaseDeps {
  db: CaseDb;
  now(): number;
  uuid(): string;
  // اختياريان: يُستدعيان داخل المعاملة نفسها (ربط الأرشفة بطابور المزامنة).
  onArchive?(caseId: string, userId: string, now: number): Promise<void>;
  onUnarchive?(caseId: string, userId: string, now: number): Promise<void>;
}

export const ARCHIVED_STATUS = 'مؤرشفة';
export const CASE_STATUSES = ['جديدة', 'قيد التحقيق', 'محالة', 'مغلقة'] as const; // المؤرشفة بالأرشفة فقط
export const CLOSED_STATUSES: readonly string[] = ['مغلقة', ARCHIVED_STATUS];

export type CaseErrorCode =
  | 'NOT_FOUND' | 'ARCHIVED' | 'NOT_ARCHIVED' | 'NO_CHANGES' | 'INVALID' | 'REASON_REQUIRED'
  | 'DEPARTMENT_INVALID' | 'OFFICER_INVALID' | 'DUPLICATE_NAME' | 'HAS_OPEN_CASES';

export class CaseActionError extends Error {
  constructor(public readonly code: CaseErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CaseActionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface CaseRow {
  id: string; title: string; complainant: string | null; suspects: string | null; case_type: string;
  department_id: string | null; officer_id: string | null; incident_location: string | null;
  incident_details: string | null; status: string;
}

export const EDITABLE_FIELDS = ['title', 'complainant', 'suspects', 'case_type', 'incident_location', 'incident_details'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];
export type CasePatch = Partial<Record<EditableField, string>>;

export interface CaseHistoryItem {
  id: string; case_id: string; action: string; field_name: string; previous_value: string | null;
  new_value: string | null; reason: string | null; executed_by: string; executed_by_name: string | null; created_at: number;
}

const MAX_TITLE = 200;
const MAX_TEXT = 5000;

function clean(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}
function needReason(reason: string | undefined | null): string {
  const r = clean(reason);
  if (!r) throw new CaseActionError('REASON_REQUIRED');
  return r;
}

// يحمّل القضية داخل نطاق المستخدم. خارج النطاق = NOT_FOUND (لا تسريب لوجودها).
async function loadScoped(deps: CaseDeps, s: Session, caseId: string): Promise<{ row: CaseRow; scope: CaseScope }> {
  const scope = await resolveCaseScope(deps.db, s);
  const row = await deps.db.getFirstAsync<CaseRow>('SELECT * FROM cases WHERE id = ?', [caseId]);
  if (!row || !caseDepartmentAllowed(scope, row.department_id)) throw new CaseActionError('NOT_FOUND');
  return { row, scope };
}

function assertActive(row: CaseRow): void {
  if (row.status === ARCHIVED_STATUS) throw new CaseActionError('ARCHIVED');
}

async function addHistory(
  deps: CaseDeps, caseId: string, action: string, field: string,
  prev: string | null, next: string | null, reason: string | null, userId: string, now: number
): Promise<void> {
  await deps.db.runAsync(
    'INSERT INTO case_history (id, case_id, action, field_name, previous_value, new_value, reason, executed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [deps.uuid(), caseId, action, field, prev, next, reason, userId, now]
  );
}

async function touch(deps: CaseDeps, caseId: string, set: string, args: unknown[], now: number): Promise<void> {
  // set: نص ثابت من الشيفرة فقط (أسماء أعمدة)، لا مدخلات مستخدم.
  await deps.db.runAsync('UPDATE cases SET ' + set + ', updated_at = ? WHERE id = ?', [...args, now, caseId]);
}

export async function updateCase(deps: CaseDeps, session: Session | null | undefined, caseId: string, patch: CasePatch, reason?: string): Promise<void> {
  const s = requirePerm(session, 'cases.manage');
  for (const k of Object.keys(patch)) if (!(EDITABLE_FIELDS as readonly string[]).includes(k)) throw new CaseActionError('INVALID', 'حقل غير قابل للتعديل: ' + k);
  const why = clean(reason);
  await deps.db.withTransactionAsync(async () => {
    const { row } = await loadScoped(deps, s, caseId);
    assertActive(row);
    const now = deps.now();
    const changes: { field: EditableField; prev: string | null; next: string | null }[] = [];
    for (const field of EDITABLE_FIELDS) {
      if (!(field in patch)) continue;
      const next = clean(patch[field]);
      if ((field === 'title' || field === 'case_type') && !next) throw new CaseActionError('INVALID', 'الحقل مطلوب: ' + field);
      if (next && next.length > (field === 'title' ? MAX_TITLE : MAX_TEXT)) throw new CaseActionError('INVALID', 'النص أطول من المسموح: ' + field);
      const prev = clean(row[field]);
      if (prev !== next) changes.push({ field, prev, next });
    }
    if (changes.length === 0) throw new CaseActionError('NO_CHANGES');
    await touch(deps, caseId, changes.map((c) => c.field + ' = ?').join(', '), changes.map((c) => c.next), now);
    for (const c of changes) await addHistory(deps, caseId, 'update', c.field, c.prev, c.next, why, s.userId, now);
  });
}

export async function changeStatus(deps: CaseDeps, session: Session | null | undefined, caseId: string, status: string, reason?: string): Promise<void> {
  const s = requirePerm(session, 'cases.manage');
  if (!(CASE_STATUSES as readonly string[]).includes(status)) throw new CaseActionError('INVALID', 'حالة غير مسموحة');
  const why = clean(reason);
  await deps.db.withTransactionAsync(async () => {
    const { row } = await loadScoped(deps, s, caseId);
    assertActive(row);
    if (row.status === status) throw new CaseActionError('NO_CHANGES');
    const now = deps.now();
    await touch(deps, caseId, 'status = ?', [status], now);
    await addHistory(deps, caseId, 'status', 'status', row.status, status, why, s.userId, now);
  });
}

export async function archiveCase(deps: CaseDeps, session: Session | null | undefined, caseId: string, reason: string): Promise<void> {
  const s = requirePerm(session, 'cases.manage');
  const why = needReason(reason);
  await deps.db.withTransactionAsync(async () => {
    const { row } = await loadScoped(deps, s, caseId);
    assertActive(row);
    const now = deps.now();
    await touch(deps, caseId, 'status = ?', [ARCHIVED_STATUS], now);
    await addHistory(deps, caseId, 'archive', 'status', row.status, ARCHIVED_STATUS, why, s.userId, now);
    if (deps.onArchive) await deps.onArchive(caseId, s.userId, now);
  });
}

// فك الأرشفة للمدير (نطاق كامل) فقط. تُعاد الحالة السابقة من آخر سجل أرشفة.
export async function unarchiveCase(deps: CaseDeps, session: Session | null | undefined, caseId: string, reason: string): Promise<void> {
  const s = requirePerm(session, 'cases.manage');
  const why = needReason(reason);
  await deps.db.withTransactionAsync(async () => {
    const { row, scope } = await loadScoped(deps, s, caseId);
    if (scope.kind !== 'all') throw new ForbiddenError('cases.unarchive');
    if (row.status !== ARCHIVED_STATUS) throw new CaseActionError('NOT_ARCHIVED');
    const last = await deps.db.getFirstAsync<{ previous_value: string | null }>(
      "SELECT previous_value FROM case_history WHERE case_id = ? AND action = 'archive' ORDER BY created_at DESC, rowid DESC LIMIT 1", [caseId]);
    const restored = last?.previous_value && (CASE_STATUSES as readonly string[]).includes(last.previous_value) ? last.previous_value : 'جديدة';
    const now = deps.now();
    await touch(deps, caseId, 'status = ?', [restored], now);
    await addHistory(deps, caseId, 'unarchive', 'status', ARCHIVED_STATUS, restored, why, s.userId, now);
    if (deps.onUnarchive) await deps.onUnarchive(caseId, s.userId, now);
  });
}

export async function assignCase(deps: CaseDeps, session: Session | null | undefined, caseId: string, officerId: string | null, reason?: string): Promise<void> {
  const s = requirePerm(session, 'cases.manage');
  const why = clean(reason);
  await deps.db.withTransactionAsync(async () => {
    const { row } = await loadScoped(deps, s, caseId);
    assertActive(row);
    if ((row.officer_id ?? null) === (officerId ?? null)) throw new CaseActionError('NO_CHANGES');
    if (officerId) {
      const o = await deps.db.getFirstAsync<{ role: string; is_active: number; department_id: string | null }>(
        'SELECT role, is_active, department_id FROM users WHERE id = ?', [officerId]);
      if (!o || Number(o.is_active) !== 1) throw new CaseActionError('OFFICER_INVALID', 'المستخدم غير موجود أو معطّل');
      if (o.role !== 'investigator' && o.role !== 'admin') throw new CaseActionError('OFFICER_INVALID', 'الدور لا يسمح بالإسناد');
      if (o.role === 'investigator' && (!o.department_id || o.department_id !== row.department_id))
        throw new CaseActionError('OFFICER_INVALID', 'المحقق من قسم آخر');
    }
    const now = deps.now();
    await touch(deps, caseId, 'officer_id = ?', [officerId], now);
    await addHistory(deps, caseId, 'assign', 'officer_id', row.officer_id, officerId, why, s.userId, now);
  });
}

// النقل بين الأقسام للمدير (نطاق كامل) فقط، بسبب إلزامي. المحقق المسند من قسم آخر يُزال إسناده في المعاملة نفسها.
export async function transferCase(deps: CaseDeps, session: Session | null | undefined, caseId: string, toDepartmentId: string, reason: string): Promise<void> {
  const s = requirePerm(session, 'cases.manage');
  const why = needReason(reason);
  await deps.db.withTransactionAsync(async () => {
    const { row, scope } = await loadScoped(deps, s, caseId);
    if (scope.kind !== 'all') throw new ForbiddenError('cases.transfer');
    assertActive(row);
    if (row.department_id === toDepartmentId) throw new CaseActionError('NO_CHANGES');
    const d = await deps.db.getFirstAsync<{ id: string; is_active: number }>('SELECT id, is_active FROM departments WHERE id = ?', [toDepartmentId]);
    if (!d || Number(d.is_active) !== 1) throw new CaseActionError('DEPARTMENT_INVALID');
    const now = deps.now();
    await touch(deps, caseId, 'department_id = ?', [toDepartmentId], now);
    await addHistory(deps, caseId, 'transfer', 'department_id', row.department_id, toDepartmentId, why, s.userId, now);
    if (row.officer_id) {
      const o = await deps.db.getFirstAsync<{ role: string; department_id: string | null }>('SELECT role, department_id FROM users WHERE id = ?', [row.officer_id]);
      if (o && o.role === 'investigator' && o.department_id !== toDepartmentId) {
        await touch(deps, caseId, 'officer_id = ?', [null], now);
        await addHistory(deps, caseId, 'assign', 'officer_id', row.officer_id, null, 'إزالة الإسناد تلقائياً بسبب نقل القضية', s.userId, now);
      }
    }
  });
}

export async function getCaseHistory(deps: CaseDeps, session: Session | null | undefined, caseId: string): Promise<CaseHistoryItem[]> {
  const s = requirePerm(session, 'cases.view');
  await loadScoped(deps, s, caseId);
  return deps.db.getAllAsync<CaseHistoryItem>(
    `SELECT h.id, h.case_id, h.action, h.field_name, h.previous_value, h.new_value, h.reason, h.executed_by,
            u.username AS executed_by_name, h.created_at
     FROM case_history h LEFT JOIN users u ON u.id = h.executed_by
     WHERE h.case_id = ? ORDER BY h.created_at, h.rowid`, [caseId]);
}
SC_EOF_MARK
echo "  ✓ src/modules/cases/cases-actions.ts"
cat > src/modules/cases/departments-admin.ts <<'SC_EOF_MARK'
// SECURECASEDESK_PHASE3_COMPLETION
// إدارة الأقسام (للمدير فقط: users.manage). لا حذف؛ تعطيل فقط، ويُمنع إن وُجدت قضايا مفتوحة في القسم.
import { requirePerm, type Session } from '../../security/guard';
import { CaseActionError, CLOSED_STATUSES, type CaseDeps } from './cases-actions';

export interface DepartmentRow { id: string; name: string; description: string | null; is_active: number; created_at: number }

const MAX_NAME = 100;
const MAX_DESC = 500;

function normName(v: string): string {
  const n = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > MAX_NAME) throw new CaseActionError('INVALID', 'اسم القسم بين 2 و100 حرف');
  return n;
}
function normDesc(v: string | null | undefined): string | null {
  const d = String(v ?? '').trim();
  if (d.length > MAX_DESC) throw new CaseActionError('INVALID', 'الوصف طويل');
  return d === '' ? null : d;
}
async function nameTaken(deps: CaseDeps, name: string, exceptId?: string): Promise<boolean> {
  const row = await deps.db.getFirstAsync<{ id: string }>(
    'SELECT id FROM departments WHERE LOWER(name) = LOWER(?) AND id <> ?', [name, exceptId ?? '']);
  return !!row;
}

export async function listDepartments(deps: CaseDeps, session: Session | null | undefined): Promise<DepartmentRow[]> {
  requirePerm(session, 'users.manage');
  return deps.db.getAllAsync<DepartmentRow>(
    'SELECT id, name, description, COALESCE(is_active, 1) AS is_active, created_at FROM departments ORDER BY is_active DESC, name');
}

export async function createDepartment(deps: CaseDeps, session: Session | null | undefined, input: { name: string; description?: string }): Promise<string> {
  requirePerm(session, 'users.manage');
  const name = normName(input.name);
  const description = normDesc(input.description);
  const id = deps.uuid();
  await deps.db.withTransactionAsync(async () => {
    if (await nameTaken(deps, name)) throw new CaseActionError('DUPLICATE_NAME');
    await deps.db.runAsync('INSERT INTO departments (id, name, description, is_active, created_at) VALUES (?, ?, ?, 1, ?)', [id, name, description, deps.now()]);
  });
  return id;
}

export async function updateDepartment(deps: CaseDeps, session: Session | null | undefined, id: string, input: { name?: string; description?: string }): Promise<void> {
  requirePerm(session, 'users.manage');
  await deps.db.withTransactionAsync(async () => {
    const cur = await deps.db.getFirstAsync<DepartmentRow>('SELECT * FROM departments WHERE id = ?', [id]);
    if (!cur) throw new CaseActionError('NOT_FOUND');
    const name = input.name === undefined ? cur.name : normName(input.name);
    const description = input.description === undefined ? cur.description : normDesc(input.description);
    if (name === cur.name && description === cur.description) throw new CaseActionError('NO_CHANGES');
    if (name !== cur.name && (await nameTaken(deps, name, id))) throw new CaseActionError('DUPLICATE_NAME');
    await deps.db.runAsync('UPDATE departments SET name = ?, description = ? WHERE id = ?', [name, description, id]);
  });
}

export async function setDepartmentActive(deps: CaseDeps, session: Session | null | undefined, id: string, active: boolean): Promise<void> {
  requirePerm(session, 'users.manage');
  await deps.db.withTransactionAsync(async () => {
    const cur = await deps.db.getFirstAsync<DepartmentRow>('SELECT * FROM departments WHERE id = ?', [id]);
    if (!cur) throw new CaseActionError('NOT_FOUND');
    if (Number(cur.is_active) === (active ? 1 : 0)) throw new CaseActionError('NO_CHANGES');
    if (!active) {
      const placeholders = CLOSED_STATUSES.map(() => '?').join(', ');
      const open = await deps.db.getFirstAsync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM cases WHERE department_id = ? AND status NOT IN (' + placeholders + ')', [id, ...CLOSED_STATUSES]);
      if (Number(open?.n ?? 0) > 0) throw new CaseActionError('HAS_OPEN_CASES');
    }
    await deps.db.runAsync('UPDATE departments SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
  });
}
SC_EOF_MARK
echo "  ✓ src/modules/cases/departments-admin.ts"
cat > src/services/cases-actions.service.ts <<'SC_EOF_MARK'
// SECURECASEDESK_PHASE3_COMPLETION — ربط عمليات القضايا والأقسام بقاعدة التطبيق. المنطق كله في modules/cases.
import * as Crypto from 'expo-crypto';
import { getDb } from '@/database/db';
import { markRecordArchived, markRecordUnarchived } from '@/database/sync-schema';
import type { Session } from '@/security/guard';
import * as actions from '@/modules/cases/cases-actions';
import * as depts from '@/modules/cases/departments-admin';

export { CaseActionError, CASE_STATUSES, ARCHIVED_STATUS } from '@/modules/cases/cases-actions';
export type { CasePatch, CaseHistoryItem } from '@/modules/cases/cases-actions';
export type { DepartmentRow } from '@/modules/cases/departments-admin';

async function deps(): Promise<actions.CaseDeps> {
  const db = await getDb();
  return {
    db, now: () => Date.now(), uuid: () => Crypto.randomUUID(),
    onArchive: (id, userId, now) => markRecordArchived(db, 'cases', id, userId, now),
    onUnarchive: (id, userId, now) => markRecordUnarchived(db, 'cases', id, userId, now),
  };
}

type S = Session | null | undefined;
export const updateCase = async (s: S, id: string, patch: actions.CasePatch, reason?: string) => actions.updateCase(await deps(), s, id, patch, reason);
export const changeCaseStatus = async (s: S, id: string, status: string, reason?: string) => actions.changeStatus(await deps(), s, id, status, reason);
export const archiveCase = async (s: S, id: string, reason: string) => actions.archiveCase(await deps(), s, id, reason);
export const unarchiveCase = async (s: S, id: string, reason: string) => actions.unarchiveCase(await deps(), s, id, reason);
export const assignCase = async (s: S, id: string, officerId: string | null, reason?: string) => actions.assignCase(await deps(), s, id, officerId, reason);
export const transferCase = async (s: S, id: string, toDepartmentId: string, reason: string) => actions.transferCase(await deps(), s, id, toDepartmentId, reason);
export const getCaseHistory = async (s: S, id: string) => actions.getCaseHistory(await deps(), s, id);

export const listDepartments = async (s: S) => depts.listDepartments(await deps(), s);
export const createDepartment = async (s: S, input: { name: string; description?: string }) => depts.createDepartment(await deps(), s, input);
export const updateDepartment = async (s: S, id: string, input: { name?: string; description?: string }) => depts.updateDepartment(await deps(), s, id, input);
export const setDepartmentActive = async (s: S, id: string, active: boolean) => depts.setDepartmentActive(await deps(), s, id, active);
SC_EOF_MARK
echo "  ✓ src/services/cases-actions.service.ts"
cat > tests/cases-actions.test.ts <<'SC_EOF_MARK'
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
SC_EOF_MARK
echo "  ✓ tests/cases-actions.test.ts"
TAIL_TMP=$(mktemp)
cat > "$TAIL_TMP" <<'SC_EOF_MARK'
// فك الأرشفة: يُلغي علامة الأرشفة ويُدرج عملية update (الإصدار الأساس هو الحالي).
export async function markRecordUnarchived(db: SyncDb, entity: string, recordId: string, userId: string, now: number): Promise<void> {
  const m = await db.getFirstAsync<{ row_version: number }>('SELECT row_version FROM sync_record_meta WHERE entity = ? AND record_id = ?', [entity, recordId]);
  if (!m) throw new Error('سجل غير معروف للمزامنة');
  const v = m.row_version + 1;
  await db.runAsync(
    'UPDATE sync_record_meta SET row_version = ?, archived_at = NULL, archived_by = NULL, last_modified_by = ?, updated_at = ? WHERE entity = ? AND record_id = ?',
    [v, userId, now, entity, recordId]);
  await db.runAsync(
    `INSERT INTO sync_operations (operation_id, idempotency_key, entity, record_id, op_type, base_version, status, created_by, created_at)
     VALUES (${UUID_V4}, ?, ?, ?, 'update', ?, 'pending', ?, ?)`,
    [entity + ':' + recordId + ':' + v, entity, recordId, m.row_version, userId, now]);
}
SC_EOF_MARK
export TAIL_TMP

echo "== 2/3 ربط الملفات الحالية =="
node - <<'NODE'
const fs = require('fs');
const rd = (p) => fs.readFileSync(p, 'utf8');
const wr = (p, s) => fs.writeFileSync(p, s);
const fail = (m) => { console.error('✗ ' + m); process.exit(1); };

// db.ts
let db = rd('src/database/db.ts');
if (db.includes('initCaseHistorySchema')) console.log('  • db.ts مُعدَّل مسبقاً');
else {
  const marker = '  // ===== المرحلة 9 / القسم 1: المرفقات';
  const imp = "import { initSyncSchema } from './sync-schema';";
  if (!db.includes(marker) || !db.includes(imp)) fail('لم أجد نقاط الربط في db.ts');
  fs.copyFileSync('src/database/db.ts', 'src/database/db.ts.pre_phase3');
  db = db.replace(imp, imp + "\nimport { initCaseHistorySchema } from '../modules/cases/cases-schema';");
  db = db.replace(marker, "  // ===== المرحلة 3: سجل تعديل القضايا (للإلحاق فقط) =====\n  await initCaseHistorySchema(database);\n\n" + marker);
  wr('src/database/db.ts', db); console.log('  ✓ db.ts (نسخة قبل التعديل: db.ts.pre_phase3)');
}

// sync-schema.ts
let sy = rd('src/database/sync-schema.ts'), changed = false;
if (!sy.includes("table: 'case_history'")) {
  const line = "  { table: 'correction_history', mutable: false },";
  if (!sy.includes(line)) fail('لم أجد قائمة SYNCABLE_TABLES');
  sy = sy.replace(line, line + "\n  { table: 'case_history', mutable: false },"); changed = true;
}
if (!sy.includes('markRecordUnarchived')) { sy += '\n' + rd(process.env.TAIL_TMP); changed = true; }
if (changed) { wr('src/database/sync-schema.ts', sy); console.log('  ✓ sync-schema.ts'); } else console.log('  • sync-schema.ts مُعدَّل مسبقاً');

// cases.service.ts : إخفاء المؤرشفة افتراضياً
let cs = rd('src/services/cases.service.ts');
if (cs.includes('includeArchived')) console.log('  • cases.service.ts مُعدَّل مسبقاً');
else {
  const a = "  query: string = ''\n): Promise<CaseItem[]> {";
  const b = "  const f = caseScopeSql(scope, 'department_id');\n  const q = query.trim();";
  if (!cs.includes(a) || !cs.includes(b)) fail('لم أجد نقاط التعديل في listCases');
  cs = cs.replace(a, "  query: string = '',\n  includeArchived: boolean = false\n): Promise<CaseItem[]> {");
  cs = cs.replace(b, "  const f0 = caseScopeSql(scope, 'department_id');\n  // الأرشفة: المؤرشفة تُخفى افتراضياً (لا حذف).\n  const f = includeArchived ? f0 : { sql: f0.sql + \" AND status <> 'مؤرشفة'\", args: f0.args };\n  const q = query.trim();");
  wr('src/services/cases.service.ts', cs); console.log('  ✓ cases.service.ts');
}

// package.json
const p = JSON.parse(rd('package.json'));
if (!p.scripts['test:cases-actions']) {
  p.scripts['test:cases-actions'] = 'tsx --tsconfig tests/tsconfig.json --test tests/cases-actions.test.ts';
  wr('package.json', JSON.stringify(p, null, 2) + '\n'); console.log('  ✓ package.json');
} else console.log('  • package.json مُعدَّل مسبقاً');
NODE
rm -f "$TAIL_TMP"
grep -qxF '*.pre_phase3' .gitignore 2>/dev/null || echo '*.pre_phase3' >> .gitignore

echo "== 3/3 الفحص =="
if [ -d node_modules ]; then
  npx tsc --noEmit && echo "  ✓ tsc: 0 أخطاء" || echo "  ✗ tsc فيه أخطاء (أرسلها لي)"
  npm run test:cases-actions 2>&1 | grep -E "^ℹ (tests|pass|fail)|^# (tests|pass|fail)" || true
  npm run test:all 2>&1 | grep -E "^ℹ (tests|pass|fail|todo)|^# (tests|pass|fail|todo)|✖ |not ok" || true
else
  echo "  لا توجد node_modules — شغّل: npm ci"
fi
echo "✓ تم."
