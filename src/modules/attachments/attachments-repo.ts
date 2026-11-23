// SECURECASEDESK_PHASE9_S1
// منطق المرفقات (صلاحيات + تحقق + تشفير + قاعدة بيانات + تخزين) بالحقن الكامل للاعتماديات
// (قاعدة البيانات، التخزين، التشفير، التدقيق) ليعمل في التطبيق وفي اختبارات Node بالكود نفسه.

import { can, type Permission } from '../../security/permissions';
import { requirePerm, ForbiddenError, type Session } from '../../security/guard';
import { resolveCaseScope, caseDepartmentAllowed } from '../../security/case-scope'; // SECURECASEDESK_FIX_L1_G1_G2
import {
  AttachmentError, MAX_ATTACHMENTS_PER_ENTITY, MIN_DELETE_REASON_LENGTH,
  type AttachmentEntityType, type AttachmentInfo, type AttachmentRecord, type AttachmentSource,
} from './attachments-types';
import { validateAttachment } from './attachments-validation';
import {
  decryptAttachment, encryptAttachment, ENC_VERSION, type AttachmentCryptoProvider,
} from './attachments-crypto';

export interface DbLike {
  runAsync(sql: string, params?: unknown[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export interface BlobStorage {
  write(name: string, bytes: Uint8Array): Promise<void>; // ذرّي: لا يظهر ملف ناقص
  read(name: string): Promise<Uint8Array>;                // يرمي عند الغياب
  delete(name: string): Promise<void>;                    // لا يرمي إن غاب
  exists(name: string): Promise<boolean>;
  list(): Promise<string[]>;
}

export interface AuditHookEvent {
  operationType: string;
  entityType: string;
  entityId: string;
  newValues?: unknown;
  reason?: string | null;
}

export interface AttachmentDeps {
  db: DbLike;
  storage: BlobStorage;
  crypto: AttachmentCryptoProvider;
  getMasterKey(allowCreate: boolean): Promise<Uint8Array>;
  uuid(): string;
  now(): number;
  audit?(session: Session, event: AuditHookEvent): Promise<void>;
}

const VIEW_PERM: Record<AttachmentEntityType, Permission> = {
  case: 'cases.view', memo: 'memos.view', detainee: 'detainees.view',
};
const MANAGE_PERM: Record<AttachmentEntityType, Permission> = {
  case: 'cases.manage', memo: 'memos.manage', detainee: 'detainees.manage',
};
const ENTITY_TABLE: Record<AttachmentEntityType, string> = {
  case: 'cases', memo: 'memos', detainee: 'detainees',
};

// فحص مزدوج: الجلسة (قبل أي لمس للبيانات) ثم الدور الحالي من جدول المستخدمين (حساب معطّل = رفض).
async function authorize(deps: AttachmentDeps, session: Session | null | undefined, perm: Permission): Promise<Session> {
  const s = requirePerm(session, perm);
  const row = await deps.db.getFirstAsync<{ role: string; is_active: number }>(
    'SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?', [s.userId]
  );
  if (!row || Number(row.is_active) !== 1 || !can(row.role, perm)) throw new ForbiddenError(perm);
  return s;
}

// L1: مرفقات قضية (أو مذكرة مرتبطة بقضية) قسم آخر غير مرئية للمحقق؛ تُعامل كأنها غير موجودة.
async function assertEntityInScope(deps: AttachmentDeps, s: Session, entityType: AttachmentEntityType, entityId: string): Promise<void> {
  if (entityType === 'detainee') return;
  const scope = await resolveCaseScope(deps.db, s);
  if (scope.kind === 'all') return;
  let caseId: string | null = entityId;
  if (entityType === 'memo') {
    const m = await deps.db.getFirstAsync<{ linked_case_id: string | null }>('SELECT linked_case_id FROM memos WHERE id = ?', [entityId]);
    if (!m) throw new AttachmentError('ENTITY_NOT_FOUND');
    caseId = m.linked_case_id;
    if (!caseId) {
      if (scope.kind === 'none') throw new AttachmentError('ENTITY_NOT_FOUND');
      return;
    }
  }
  const c = await deps.db.getFirstAsync<{ department_id: string | null }>('SELECT department_id FROM cases WHERE id = ?', [caseId]);
  if (!c || !caseDepartmentAllowed(scope, c.department_id)) throw new AttachmentError('ENTITY_NOT_FOUND');
}

async function safeAudit(deps: AttachmentDeps, s: Session, event: AuditHookEvent): Promise<void> {
  try { await deps.audit?.(s, event); } catch { /* فشل التدقيق الإضافي لا يُفشل القراءة */ }
}

const COLUMNS = `id, entity_type, entity_id, original_name, extension, mime_type, size_bytes,
  sha256_plain, sha256_cipher, enc_version, storage_name, status, created_by, created_at,
  deleted_by, deleted_at, reason`;

type Row = AttachmentRecord & { storage_name: string };

async function getRow(deps: AttachmentDeps, id: string): Promise<Row> {
  const row = await deps.db.getFirstAsync<Row>('SELECT ' + COLUMNS + ' FROM attachments WHERE id = ?', [id]);
  if (!row) throw new AttachmentError('NOT_FOUND');
  return row;
}

export async function addAttachment(
  deps: AttachmentDeps, session: Session | null | undefined,
  entityType: AttachmentEntityType, entityId: string, source: AttachmentSource
): Promise<AttachmentInfo> {
  if (!Object.prototype.hasOwnProperty.call(MANAGE_PERM, entityType)) throw new AttachmentError('ENTITY_NOT_FOUND');
  const s = await authorize(deps, session, MANAGE_PERM[entityType]);

  const file = validateAttachment(source);

  const exists = await deps.db.getFirstAsync<{ id: string }>(
    'SELECT id FROM ' + ENTITY_TABLE[entityType] + ' WHERE id = ?', [entityId]);
  if (!exists) throw new AttachmentError('ENTITY_NOT_FOUND');
  await assertEntityInScope(deps, s, entityType, entityId);

  const sha256Plain = deps.crypto.sha256Hex(source.bytes);

  // المفتاح الرئيسي يُنشأ فقط إن لم توجد أي مرفقات سابقة؛ وإلا فغيابه خطأ لا يُعالَج بمفتاح جديد.
  const any = await deps.db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM attachments');
  let master: Uint8Array;
  try { master = await deps.getMasterKey(Number(any?.c ?? 0) === 0); }
  catch { throw new AttachmentError('KEY_MISSING'); }

  const id = deps.uuid();
  const storageName = id + '.enc';
  const { blob, sha256Cipher } = encryptAttachment(deps.crypto, master, id, source.bytes);

  const checkRules = async () => {
    const dup = await deps.db.getFirstAsync<{ id: string }>(
      `SELECT id FROM attachments WHERE entity_type = ? AND entity_id = ? AND sha256_plain = ? AND status = 'active'`,
      [entityType, entityId, sha256Plain]);
    if (dup) throw new AttachmentError('DUPLICATE');
    const cnt = await deps.db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM attachments WHERE entity_type = ? AND entity_id = ? AND status = 'active'`,
      [entityType, entityId]);
    if (Number(cnt?.c ?? 0) >= MAX_ATTACHMENTS_PER_ENTITY) throw new AttachmentError('LIMIT_REACHED');
  };
  await checkRules(); // فحص مبكر رخيص قبل كتابة الملف

  try {
    await deps.storage.write(storageName, blob);
  } catch (e) {
    await deps.storage.delete(storageName).catch(() => undefined);
    // يُحفظ سبب الفشل الحقيقي (كان يُبتلع سابقاً فيستحيل تشخيص "تعذر حفظ الملف").
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[Attachments] فشل حفظ الملف المشفر:', detail);
    throw new AttachmentError('STORAGE_FAILED', detail);
  }

  const createdAt = deps.now();
  try {
    await deps.db.withTransactionAsync(async () => {
      await checkRules();
      await deps.db.runAsync(
        `INSERT INTO attachments (id, entity_type, entity_id, original_name, extension, mime_type, size_bytes,
           sha256_plain, sha256_cipher, enc_version, storage_name, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [id, entityType, entityId, file.name, file.extension, file.mime, file.size,
         sha256Plain, sha256Cipher, ENC_VERSION, storageName, s.userId, createdAt]);
    });
  } catch (e) {
    await deps.storage.delete(storageName).catch(() => undefined); // لا يبقى ملف يتيم
    throw e;
  }

  return {
    id, entity_type: entityType, entity_id: entityId, original_name: file.name,
    extension: file.extension, mime_type: file.mime, size_bytes: file.size,
    sha256_plain: sha256Plain, sha256_cipher: sha256Cipher, enc_version: ENC_VERSION,
    created_by: s.userId, created_at: createdAt, created_by_name: null,
  };
}

export async function listAttachments(
  deps: AttachmentDeps, session: Session | null | undefined,
  entityType: AttachmentEntityType, entityId: string
): Promise<AttachmentInfo[]> {
  if (!Object.prototype.hasOwnProperty.call(VIEW_PERM, entityType)) throw new AttachmentError('ENTITY_NOT_FOUND');
  const sv = await authorize(deps, session, VIEW_PERM[entityType]);
  await assertEntityInScope(deps, sv, entityType, entityId);
  return deps.db.getAllAsync<AttachmentInfo>(
    `SELECT a.id, a.entity_type, a.entity_id, a.original_name, a.extension, a.mime_type, a.size_bytes,
            a.sha256_plain, a.sha256_cipher, a.enc_version, a.created_by, a.created_at,
            u.username AS created_by_name
     FROM attachments a LEFT JOIN users u ON u.id = a.created_by
     WHERE a.entity_type = ? AND a.entity_id = ? AND a.status = 'active'
     ORDER BY a.created_at DESC`, [entityType, entityId]);
}

export async function countAttachments(
  deps: AttachmentDeps, session: Session | null | undefined,
  entityType: AttachmentEntityType, entityId: string
): Promise<number> {
  const sv = await authorize(deps, session, VIEW_PERM[entityType]);
  await assertEntityInScope(deps, sv, entityType, entityId);
  const r = await deps.db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM attachments WHERE entity_type = ? AND entity_id = ? AND status = 'active'`,
    [entityType, entityId]);
  return Number(r?.c ?? 0);
}

export interface ReadResult { info: AttachmentInfo; bytes: Uint8Array }

async function decryptVerified(deps: AttachmentDeps, s: Session, row: Row): Promise<Uint8Array> {
  const fail = async (code: 'INTEGRITY_FAILED' | 'FILE_MISSING' | 'KEY_MISSING' | 'DECRYPT_FAILED') => {
    if (code === 'INTEGRITY_FAILED' || code === 'DECRYPT_FAILED') {
      await safeAudit(deps, s, { operationType: 'attachment_integrity_failure', entityType: 'attachments',
        entityId: row.id, reason: code });
    }
    throw new AttachmentError(code);
  };
  if (row.status !== 'active') throw new AttachmentError('ALREADY_DELETED');

  let blob: Uint8Array;
  try { blob = await deps.storage.read(row.storage_name); }
  catch { return fail('FILE_MISSING'); }

  if (deps.crypto.sha256Hex(blob) !== row.sha256_cipher) return fail('INTEGRITY_FAILED');

  let master: Uint8Array;
  try { master = await deps.getMasterKey(false); } catch { return fail('KEY_MISSING'); }

  let plain: Uint8Array;
  try { plain = decryptAttachment(deps.crypto, master, row.id, blob); }
  catch { return fail('DECRYPT_FAILED'); }

  if (plain.length !== row.size_bytes || deps.crypto.sha256Hex(plain) !== row.sha256_plain) {
    return fail('INTEGRITY_FAILED');
  }
  return plain;
}

export async function readAttachment(
  deps: AttachmentDeps, session: Session | null | undefined, id: string
): Promise<ReadResult> {
  const row = await getRow(deps, id);
  const s = await authorize(deps, session, VIEW_PERM[row.entity_type]);
  await assertEntityInScope(deps, s, row.entity_type, row.entity_id);
  const bytes = await decryptVerified(deps, s, row);
  await safeAudit(deps, s, { operationType: 'attachment_view', entityType: 'attachments', entityId: id,
    newValues: { name: row.original_name, entity_type: row.entity_type, entity_id: row.entity_id } });
  const { storage_name: _s, status: _st, deleted_by: _d, deleted_at: _da, reason: _r, ...rest } = row;
  return { info: { ...rest, created_by_name: null }, bytes };
}

export async function deleteAttachment(
  deps: AttachmentDeps, session: Session | null | undefined, id: string, reason: string
): Promise<void> {
  const s = await authorize(deps, session, 'attachments.admin');
  const why = String(reason ?? '').trim();
  if (why.length < MIN_DELETE_REASON_LENGTH) throw new AttachmentError('REASON_REQUIRED');

  const row = await getRow(deps, id);
  if (row.status === 'deleted') throw new AttachmentError('ALREADY_DELETED');

  // الحذف منطقي: يبقى السجل (الاسم والبصمة والسبب والمنفذ) ويُزال الملف المشفر فقط.
  await deps.db.withTransactionAsync(async () => {
    await deps.db.runAsync(
      `UPDATE attachments SET status = 'deleted', deleted_by = ?, deleted_at = ?, reason = ?
       WHERE id = ? AND status = 'active'`, [s.userId, deps.now(), why, id]);
  });
  await deps.storage.delete(row.storage_name).catch(() => undefined); // الفحص الدوري ينظف أي بقايا
}

export interface VerifyResult { id: string; ok: boolean; problem: 'FILE_MISSING' | 'INTEGRITY_FAILED' | 'DECRYPT_FAILED' | null }

export async function verifyAttachment(
  deps: AttachmentDeps, session: Session | null | undefined, id: string
): Promise<VerifyResult> {
  const row = await getRow(deps, id);
  const s = await authorize(deps, session, VIEW_PERM[row.entity_type]);
  await assertEntityInScope(deps, s, row.entity_type, row.entity_id);
  try {
    await decryptVerified(deps, s, row);
    return { id, ok: true, problem: null };
  } catch (e) {
    if (e instanceof AttachmentError &&
        (e.code === 'FILE_MISSING' || e.code === 'INTEGRITY_FAILED' || e.code === 'DECRYPT_FAILED')) {
      return { id, ok: false, problem: e.code };
    }
    throw e;
  }
}

export interface MaintenanceReport {
  checked: number; healthy: number; missing: string[]; corrupted: string[];
  orphansRemoved: number;
}

// صيانة (للمدير): تفحص بصمة كل ملف مشفر دون فك تشفيره، وتزيل الملفات اليتيمة
// (ملفات بلا سجل نشط، مثل بقايا انقطاع التيار أو حذف لم يكتمل).
export async function runAttachmentMaintenance(
  deps: AttachmentDeps, session: Session | null | undefined
): Promise<MaintenanceReport> {
  await authorize(deps, session, 'attachments.admin');
  const rows = await deps.db.getAllAsync<{ id: string; storage_name: string; sha256_cipher: string }>(
    `SELECT id, storage_name, sha256_cipher FROM attachments WHERE status = 'active'`);
  const report: MaintenanceReport = { checked: rows.length, healthy: 0, missing: [], corrupted: [], orphansRemoved: 0 };
  const known = new Set(rows.map((r) => r.storage_name));

  for (const r of rows) {
    if (!(await deps.storage.exists(r.storage_name))) { report.missing.push(r.id); continue; }
    const blob = await deps.storage.read(r.storage_name);
    if (deps.crypto.sha256Hex(blob) !== r.sha256_cipher) report.corrupted.push(r.id);
    else report.healthy++;
  }
  for (const name of await deps.storage.list()) {
    if (!known.has(name)) { await deps.storage.delete(name); report.orphansRemoved++; }
  }
  return report;
}
