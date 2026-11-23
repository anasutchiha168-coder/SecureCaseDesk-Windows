import * as Crypto from 'expo-crypto';
import { getDb } from '@/database/db';
import { requirePerm, ForbiddenError, type Session } from '@/security/guard';
import { resolveCaseScope, memoScopeSql, caseDepartmentAllowed } from '@/security/case-scope'; // SECURECASEDESK_FIX_L1_G1_G2

export interface MemoItem {
  id: string;
  memo_number: string;
  memo_type_id: string;
  memo_date: number;
  recipient_organization: string;
  subject: string;
  body: string | null;
  linked_case_id: string | null;
  status: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface MemoTypeItem {
  id: string;
  name: string;
}

export interface NewMemoInput {
  memoNumber: string;
  memoTypeId: string;
  memoDate: number;
  recipientOrganization: string;
  subject: string;
  body: string;
  linkedCaseId: string | null;
}

export class DuplicateMemoError extends Error {
  constructor(public readonly memoNumber: string) {
    super('DUPLICATE_MEMO_NUMBER');
    this.name = 'DuplicateMemoError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class MemoServiceError extends Error {
  constructor(public readonly code: 'INVALID_STATUS' | 'NOT_FOUND') {
    super('MEMO_' + code);
    this.name = 'MemoServiceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const DEFAULT_STATUS = 'مسودة';
export const MEMO_STATUSES: readonly string[] = ['مسودة', 'مرسلة', 'مؤرشفة'];

export async function listMemos(session: Session | null | undefined): Promise<MemoItem[]> {
  const s = requirePerm(session, 'memos.view');
  const db = await getDb();
  const scope = await resolveCaseScope(db, s); // L1: لا مذكرات مرتبطة بقضايا أقسام أخرى
  const f = memoScopeSql(scope, 'm.linked_case_id');
  return db.getAllAsync<MemoItem>('SELECT m.* FROM memos m WHERE ' + f.sql + ' ORDER BY m.created_at DESC', f.args);
}

export async function listMemoTypes(session: Session | null | undefined): Promise<MemoTypeItem[]> {
  requirePerm(session, 'memos.view');
  const db = await getDb();
  return db.getAllAsync<MemoTypeItem>(
    'SELECT id, name FROM memo_types WHERE is_active = 1 ORDER BY name ASC'
  );
}

export async function insertMemo(
  session: Session | null | undefined,
  input: NewMemoInput
): Promise<string> {
  const s = requirePerm(session, 'memos.manage');
  // لا يجوز ربط مذكرة بقضية لا يملك المستخدم صلاحية رؤيتها
  if (input.linkedCaseId) requirePerm(s, 'cases.view');
  const db = await getDb();
  if (input.linkedCaseId) {
    const scope = await resolveCaseScope(db, s);
    const c = await db.getFirstAsync<{ department_id: string | null }>(
      'SELECT department_id FROM cases WHERE id = ?', [input.linkedCaseId]
    );
    if (!c || !caseDepartmentAllowed(scope, c.department_id)) throw new ForbiddenError('cases.department');
  }
  const id = Crypto.randomUUID();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    const existing = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM memos WHERE memo_number = ?',
      [input.memoNumber]
    );
    if (existing) throw new DuplicateMemoError(input.memoNumber);
    await db.runAsync(
      'INSERT INTO memos (id, memo_number, memo_type_id, memo_date, recipient_organization, subject, body, linked_case_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        input.memoNumber,
        input.memoTypeId,
        input.memoDate,
        input.recipientOrganization,
        input.subject,
        input.body.trim() || null,
        input.linkedCaseId,
        DEFAULT_STATUS,
        s.userId,
        now,
        now,
      ]
    );
  });
  return id;
}

// يعيد وقت التحديث ليعرضه الواجهة
export async function changeMemoStatus(
  session: Session | null | undefined,
  memoId: string,
  newStatus: string
): Promise<number> {
  const s = requirePerm(session, 'memos.manage');
  if (!MEMO_STATUSES.includes(newStatus)) throw new MemoServiceError('INVALID_STATUS');
  const db = await getDb();
  const memo = await db.getFirstAsync<{ linked_case_id: string | null }>(
    'SELECT linked_case_id FROM memos WHERE id = ?', [memoId]
  );
  if (!memo) throw new MemoServiceError('NOT_FOUND');
  if (memo.linked_case_id) {
    const scope = await resolveCaseScope(db, s);
    const c = await db.getFirstAsync<{ department_id: string | null }>(
      'SELECT department_id FROM cases WHERE id = ?', [memo.linked_case_id]
    );
    if (!c || !caseDepartmentAllowed(scope, c.department_id)) throw new MemoServiceError('NOT_FOUND');
  }
  const now = Date.now();
  const res = await db.runAsync(
    'UPDATE memos SET status = ?, updated_at = ? WHERE id = ?',
    [newStatus, now, memoId]
  );
  if (res.changes === 0) throw new MemoServiceError('NOT_FOUND');
  return now;
}
