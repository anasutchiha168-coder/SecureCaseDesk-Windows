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
