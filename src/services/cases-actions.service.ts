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
