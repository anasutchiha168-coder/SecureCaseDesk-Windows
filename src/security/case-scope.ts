// SECURECASEDESK_FIX_L1_G1_G2
// نطاق رؤية القضايا حسب القسم. القسم والدور يُقرآن من جدول users نفسه لا من الجلسة (الجلسة تأتي من الواجهة).
// الفشل مغلق: مستخدم مجهول/معطّل/دور غير معروف/محقق بلا قسم = لا يرى أي قضية.
import type { Session } from './guard';
import { normalizeRole } from './permissions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ScopeDb { getFirstAsync(sql: string, params?: any): Promise<any> }

export type CaseScope =
  | { kind: 'all' }
  | { kind: 'department'; departmentId: string }
  | { kind: 'none' };

// الأدوار المقيَّدة بقسمها. لتقييد مستخدم الاطلاع أيضاً أضف 'viewer' هنا فقط.
export const DEPARTMENT_RESTRICTED_ROLES: readonly string[] = ['investigator'];

const NONE: CaseScope = { kind: 'none' };
const ALL: CaseScope = { kind: 'all' };

export async function resolveCaseScope(db: ScopeDb, session: Session | null | undefined): Promise<CaseScope> {
  if (!session || !session.userId) return NONE;
  const row = (await db.getFirstAsync(
    'SELECT role, COALESCE(is_active, 1) AS is_active, department_id FROM users WHERE id = ?', [session.userId]
  )) as { role: string; is_active: number; department_id: string | null } | null;
  if (!row || Number(row.is_active) !== 1) return NONE;
  const role = normalizeRole(row.role);
  if (!role) return NONE;
  if (!DEPARTMENT_RESTRICTED_ROLES.includes(role)) return ALL;
  const dep = String(row.department_id ?? '').trim();
  return dep ? { kind: 'department', departmentId: dep } : NONE;
}

export function caseDepartmentAllowed(scope: CaseScope, departmentId: string | null | undefined): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'none') return false;
  return !!departmentId && departmentId === scope.departmentId;
}

// شرط WHERE على عمود قسم (أسماء الأعمدة ثوابت في الشيفرة، لا مدخلات مستخدم).
export function caseScopeSql(scope: CaseScope, column: string): { sql: string; args: string[] } {
  if (scope.kind === 'all') return { sql: '1 = 1', args: [] };
  if (scope.kind === 'none') return { sql: '1 = 0', args: [] };
  return { sql: column + ' = ?', args: [scope.departmentId] };
}

// المذكرة المرتبطة بقضية قسم آخر محجوبة. المذكرة غير المرتبطة بقضية ليس لها قسم فتبقى كما كانت (لمن يملك memos.view).
export function memoScopeSql(scope: CaseScope, linkedCaseColumn: string): { sql: string; args: string[] } {
  if (scope.kind === 'all') return { sql: '1 = 1', args: [] };
  if (scope.kind === 'none') return { sql: '1 = 0', args: [] };
  return {
    sql: '(' + linkedCaseColumn + ' IS NULL OR ' + linkedCaseColumn + ' IN (SELECT id FROM cases WHERE department_id = ?))',
    args: [scope.departmentId],
  };
}
