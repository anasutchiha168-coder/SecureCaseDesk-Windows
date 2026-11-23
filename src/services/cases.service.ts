import * as Crypto from 'expo-crypto';
import { getDb } from '@/database/db';
import { requirePerm, ForbiddenError, type Session } from '@/security/guard';
import { resolveCaseScope, caseScopeSql } from '@/security/case-scope'; // SECURECASEDESK_FIX_L1_G1_G2

export interface CaseItem {
  id: string;
  case_number: string;
  title: string;
  complainant: string | null;
  suspects: string | null;
  case_type: string;
  department_id: string | null;
  officer_id: string | null;
  registration_date: number;
  incident_location: string | null;
  incident_details: string | null;
  status: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface CaseOption {
  id: string;
  case_number: string;
  title: string;
}

export interface NewCaseInput {
  caseNumber: string;
  title: string;
  caseType: string;
  complainant: string;
  suspects: string;
  incidentLocation: string;
  incidentDetails: string;
  departmentId: string | null;
}

export class DuplicateCaseError extends Error {
  constructor(public readonly caseNumber: string) {
    super('DUPLICATE_CASE_NUMBER');
    this.name = 'DuplicateCaseError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const DEFAULT_STATUS = 'جديدة';

export async function listCases(
  session: Session | null | undefined,
  query: string = '',
  includeArchived: boolean = false
): Promise<CaseItem[]> {
  const s = requirePerm(session, 'cases.view'); // قبل أي لمس لقاعدة البيانات
  const db = await getDb();
  const scope = await resolveCaseScope(db, s); // L1: المحقق يرى قضايا قسمه فقط
  const f0 = caseScopeSql(scope, 'department_id');
  // الأرشفة: المؤرشفة تُخفى افتراضياً (لا حذف).
  const f = includeArchived ? f0 : { sql: f0.sql + " AND status <> 'مؤرشفة'", args: f0.args };
  const q = query.trim();
  if (q) {
    const like = '%' + q + '%';
    return db.getAllAsync<CaseItem>(
      'SELECT * FROM cases WHERE ' + f.sql + ' AND (case_number LIKE ? OR title LIKE ?) ORDER BY created_at DESC',
      [...f.args, like, like]
    );
  }
  return db.getAllAsync<CaseItem>('SELECT * FROM cases WHERE ' + f.sql + ' ORDER BY created_at DESC', f.args);
}

// لقائمة ربط المذكرات بالقضايا: يتطلب صلاحية عرض القضايا ويلتزم بنطاق القسم
export async function listCaseOptions(
  session: Session | null | undefined
): Promise<CaseOption[]> {
  const s = requirePerm(session, 'cases.view');
  const db = await getDb();
  const scope = await resolveCaseScope(db, s);
  const f = caseScopeSql(scope, 'department_id');
  return db.getAllAsync<CaseOption>(
    'SELECT id, case_number, title FROM cases WHERE ' + f.sql + ' ORDER BY created_at DESC', f.args
  );
}

export async function insertCase(
  session: Session | null | undefined,
  input: NewCaseInput
): Promise<string> {
  const s = requirePerm(session, 'cases.manage');
  const db = await getDb();
  // L1: المحقق لا يسجّل قضية إلا في قسمه، ومن لا قسم له لا يسجّل شيئاً
  const scope = await resolveCaseScope(db, s);
  if (scope.kind === 'none') throw new ForbiddenError('cases.department');
  let departmentId = input.departmentId;
  if (scope.kind === 'department') {
    if (departmentId && departmentId !== scope.departmentId) throw new ForbiddenError('cases.department');
    departmentId = scope.departmentId;
  }
  const id = Crypto.randomUUID();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    const existing = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM cases WHERE case_number = ?',
      [input.caseNumber]
    );
    if (existing) throw new DuplicateCaseError(input.caseNumber);
    await db.runAsync(
      'INSERT INTO cases (id, case_number, title, complainant, suspects, case_type, department_id, officer_id, registration_date, incident_location, incident_details, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        input.caseNumber,
        input.title,
        input.complainant.trim() || null,
        input.suspects.trim() || null,
        input.caseType,
        departmentId,
        null,
        now,
        input.incidentLocation.trim() || null,
        input.incidentDetails.trim() || null,
        DEFAULT_STATUS,
        s.userId,
        now,
        now,
      ]
    );
  });
  return id;
}

export interface DepartmentOption {
  id: string;
  name: string;
}

// قائمة الأقسام لنموذج القضية: تتطلب صلاحية عرض القضايا
export async function listDepartmentOptions(
  session: Session | null | undefined
): Promise<DepartmentOption[]> {
  const s = requirePerm(session, 'cases.view');
  const db = await getDb();
  const scope = await resolveCaseScope(db, s);
  const f = caseScopeSql(scope, 'id'); // المحقق يرى قسمه وحده في النموذج
  return db.getAllAsync<DepartmentOption>(
    'SELECT id, name FROM departments WHERE is_active = 1 AND ' + f.sql + ' ORDER BY name ASC', f.args
  );
}
