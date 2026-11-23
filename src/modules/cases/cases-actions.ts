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
