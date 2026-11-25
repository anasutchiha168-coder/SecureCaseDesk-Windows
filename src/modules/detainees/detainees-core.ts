// SECURECASEDESK_DETAINEES_V22_S3A
// Detainees services core: persons + detention periods. Takes the db as a parameter
// so it can be tested on a real SQLite database. Not wired into the screen yet (section 3b).
import { can } from '../../security/permissions';
import {
  STATUS_HELD, STATUS_RELEASED, MOVE_ADMISSION, MOVE_RELEASE, MOVE_TRANSFER, MOVE_CORRECTION,
  REASON_ADMISSION, REASON_RELEASE, REASON_TRANSFER, FIELD_LABELS, authorityLabel,
} from './detainees-constants';
import {
  requireText, optionalText, optionalInt, requireTimestamp, startOfDay,
} from './detainees-validation';

export interface CoreDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runAsync(sql: string, params?: any): Promise<{ changes: number }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAllAsync<T>(sql: string, params?: any): Promise<T[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getFirstAsync<T>(sql: string, params?: any): Promise<T | null>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export interface Ctx {
  now?: number;
  newId?: () => string;
}

type Perm = Parameters<typeof can>[1];

export const PERSON_TEXT_FIELDS = [
  'id_type', 'id_number', 'phone', 'governorate', 'district', 'sub_district',
  'current_residence', 'occupation', 'notes',
] as const;
export const PERIOD_TEXT_FIELDS = ['case_role', 'report_number', 'legal_status', 'legacy_serial'] as const;
export const PERIOD_INT_FIELDS = ['age_at_admission', 'prosecution_referral_date'] as const;

export type PersonPatch = Partial<Record<(typeof PERSON_TEXT_FIELDS)[number], string | null>>;
export type PeriodPatch = Partial<
  Record<(typeof PERIOD_TEXT_FIELDS)[number], string | null> &
    Record<(typeof PERIOD_INT_FIELDS)[number], number | null>
>;

function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return h() + h() + '-' + h() + '-4' + h().slice(1) + '-a' + h().slice(1) + '-' + h() + h() + h();
}

function movementNumber(now: number): string {
  return 'MOV-' + now + '-' + Math.floor(1000 + Math.random() * 9000);
}

async function assertCan(db: CoreDb, userId: string, perm: Perm): Promise<void> {
  const row = await db.getFirstAsync<{ role: string | null }>('SELECT role FROM users WHERE id = ?', [userId]);
  if (!row || !can(row.role, perm)) throw new Error('FORBIDDEN:' + String(perm));
}

function buildPatch(
  input: Record<string, unknown> | undefined,
  text: readonly string[],
  ints: readonly string[]
): { cols: string[]; vals: unknown[] } {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(input ?? {})) {
    if (v === undefined) continue;
    if (text.includes(k)) { cols.push(k); vals.push(optionalText(v)); }
    else if (ints.includes(k)) { cols.push(k); vals.push(optionalInt(v, k)); }
    else throw new Error('VALIDATION:unknown_field:' + k);
  }
  return { cols, vals };
}

async function insertMovement(
  db: CoreDb,
  m: {
    id: string; detaineeId: string; type: string; date: number;
    previous: string | null; next: string | null; by: string;
    reason: string | null; related: string | null; now: number;
  }
): Promise<void> {
  await db.runAsync(
    `INSERT INTO detainee_movements
       (id, movement_number, detainee_id, movement_type, movement_date,
        previous_authority, new_authority, executed_by, reason, related_movement_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, movementNumber(m.now), m.detaineeId, m.type, m.date,
      m.previous, m.next, m.by, m.reason, m.related, m.now]
  );
}

async function lastMovementDate(db: CoreDb, detaineeId: string): Promise<number | null> {
  const r = await db.getFirstAsync<{ last_date: number | null }>(
    'SELECT MAX(movement_date) AS last_date FROM detainee_movements WHERE detainee_id = ?',
    [detaineeId]
  );
  return r?.last_date ?? null;
}

interface DetailRow {
  id: string;
  admission_date: number;
  detaining_authority: string | null;
  category_name: string | null;
}

async function loadDetail(db: CoreDb, detaineeId: string): Promise<DetailRow> {
  const d = await db.getFirstAsync<DetailRow>(
    `SELECT d.id, d.admission_date, d.detaining_authority, c.name AS category_name
       FROM detainees d LEFT JOIN detainee_categories c ON c.id = d.category_id
      WHERE d.id = ?`,
    [detaineeId]
  );
  if (!d) throw new Error('NOT_FOUND');
  return d;
}

// ---------- create ----------
export interface CreateDetentionInput {
  fullName: string;
  referenceNumber: string;
  allegedOffense: string;
  categoryId: string;
  detainingAuthority?: string;
  admissionDate: number;
  person?: PersonPatch;
  period?: PeriodPatch;
}

export async function createDetention(
  db: CoreDb, userId: string, input: CreateDetentionInput, ctx: Ctx = {}
): Promise<{ personId: string; detaineeId: string; movementId: string }> {
  const now = ctx.now ?? Date.now();
  const nid = ctx.newId ?? defaultId;
  const out = { personId: nid(), detaineeId: nid(), movementId: nid() };

  await db.withTransactionAsync(async () => {
    await assertCan(db, userId, 'detainees.manage');
    const name = requireText(input.fullName, 'full_name');
    const ref = requireText(input.referenceNumber, 'reference_number');
    const alleged = requireText(input.allegedOffense, 'alleged_offense');
    const categoryId = requireText(input.categoryId, 'category_id');
    const admission = requireTimestamp(input.admissionDate, 'admission_date', now);
    const authority = (input.detainingAuthority ?? '').trim();
    const pp = buildPatch(input.person as Record<string, unknown> | undefined, PERSON_TEXT_FIELDS, []);
    const dp = buildPatch(input.period as Record<string, unknown> | undefined, PERIOD_TEXT_FIELDS, PERIOD_INT_FIELDS);

    const cat = await db.getFirstAsync<{ id: string; name: string }>(
      'SELECT id, name FROM detainee_categories WHERE id = ? AND is_active = 1', [categoryId]
    );
    if (!cat) throw new Error('CATEGORY_NOT_FOUND');
    const dup = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM detainees WHERE reference_number = ?', [ref]
    );
    if (dup) throw new Error('DUPLICATE_REFERENCE');

    const pCols = ['id', 'full_name', ...pp.cols, 'created_by', 'created_at', 'updated_at'];
    await db.runAsync(
      `INSERT INTO persons (${pCols.join(', ')}) VALUES (${pCols.map(() => '?').join(', ')})`,
      [out.personId, name, ...pp.vals, userId, now, now]
    );

    const dCols = [
      'id', 'person_id', 'period_no', 'reference_number', 'full_name', 'category_id',
      'admission_date', 'alleged_offense', 'detaining_authority', 'status',
      ...dp.cols, 'created_by', 'created_at', 'updated_at',
    ];
    await db.runAsync(
      `INSERT INTO detainees (${dCols.join(', ')}) VALUES (${dCols.map(() => '?').join(', ')})`,
      [out.detaineeId, out.personId, 1, ref, name, categoryId, admission, alleged, authority,
        STATUS_HELD, ...dp.vals, userId, now, now]
    );

    await insertMovement(db, {
      id: out.movementId, detaineeId: out.detaineeId, type: MOVE_ADMISSION, date: admission,
      previous: null, next: authorityLabel(cat.name, authority) || null, by: userId,
      reason: REASON_ADMISSION, related: null, now,
    });
  });
  return out;
}

// ---------- read ----------
export async function getPersonWithPeriods(
  db: CoreDb, userId: string, personId: string
): Promise<{ person: Record<string, unknown>; periods: Record<string, unknown>[] }> {
  await assertCan(db, userId, 'detainees.view');
  const person = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM persons WHERE id = ?', [personId]);
  if (!person) throw new Error('NOT_FOUND');
  const periods = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM v_detention_periods WHERE person_id = ? ORDER BY period_no ASC', [personId]
  );
  return { person, periods };
}

export interface SearchRow {
  id: string; person_id: string | null; period_no: number | null; reference_number: string;
  full_name: string; admission_date: number; release_date: number | null;
  status: string; category_name: string | null;
}

export async function searchDetainees(db: CoreDb, userId: string, query: string): Promise<SearchRow[]> {
  await assertCan(db, userId, 'detainees.view');
  const base = `SELECT d.id, d.person_id, d.period_no, d.reference_number, d.full_name,
       d.admission_date, d.release_date, d.status, c.name AS category_name
     FROM detainees d
     LEFT JOIN persons p ON p.id = d.person_id
     LEFT JOIN detainee_categories c ON c.id = d.category_id`;
  const order = ' ORDER BY d.admission_date DESC, d.created_at DESC';
  const term = query.trim();
  if (!term) return db.getAllAsync<SearchRow>(base + order);
  const like = '%' + term + '%';
  return db.getAllAsync<SearchRow>(
    base + ' WHERE d.full_name LIKE ? OR d.reference_number LIKE ? OR p.full_name LIKE ? OR p.id_number LIKE ?' + order,
    [like, like, like, like]
  );
}

// ---------- update (non-name data) ----------
export async function updatePerson(
  db: CoreDb, userId: string, personId: string, patch: PersonPatch, ctx: Ctx = {}
): Promise<void> {
  const now = ctx.now ?? Date.now();
  await db.withTransactionAsync(async () => {
    await assertCan(db, userId, 'detainees.manage');
    const p = buildPatch(patch as Record<string, unknown>, PERSON_TEXT_FIELDS, []);
    if (p.cols.length === 0) throw new Error('VALIDATION:empty_patch');
    const res = await db.runAsync(
      `UPDATE persons SET ${p.cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`,
      [...p.vals, now, personId]
    );
    if (res.changes === 0) throw new Error('NOT_FOUND');
  });
}

export async function updatePeriod(
  db: CoreDb, userId: string, detaineeId: string, patch: PeriodPatch, ctx: Ctx = {}
): Promise<void> {
  const now = ctx.now ?? Date.now();
  await db.withTransactionAsync(async () => {
    await assertCan(db, userId, 'detainees.manage');
    const p = buildPatch(patch as Record<string, unknown>, PERIOD_TEXT_FIELDS, PERIOD_INT_FIELDS);
    if (p.cols.length === 0) throw new Error('VALIDATION:empty_patch');
    const res = await db.runAsync(
      `UPDATE detainees SET ${p.cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`,
      [...p.vals, now, detaineeId]
    );
    if (res.changes === 0) throw new Error('NOT_FOUND');
  });
}

// ---------- correction (name / alleged offense) ----------
export interface CorrectionInput {
  detaineeId: string;
  field: 'full_name' | 'alleged_offense';
  previous: string;
  next: string;
  reason: string;
}

export async function correctPeriodField(
  db: CoreDb, userId: string, input: CorrectionInput, ctx: Ctx = {}
): Promise<void> {
  const now = ctx.now ?? Date.now();
  const nid = ctx.newId ?? defaultId;
  await db.withTransactionAsync(async () => {
    await assertCan(db, userId, 'detainees.correct');
    const field = input.field;
    if (field !== 'full_name' && field !== 'alleged_offense') throw new Error('VALIDATION:field');
    const next = requireText(input.next, 'next');
    const reason = requireText(input.reason, 'reason');

    const cur = await db.getFirstAsync<{ value: string | null; person_id: string | null }>(
      `SELECT ${field} AS value, person_id FROM detainees WHERE id = ?`, [input.detaineeId]
    );
    if (!cur) throw new Error('NOT_FOUND');
    if ((cur.value ?? '') !== input.previous) throw new Error('VALUE_CHANGED');
    if (next === input.previous) throw new Error('VALIDATION:no_change');

    if (field === 'full_name' && cur.person_id) {
      await db.runAsync('UPDATE persons SET full_name = ?, updated_at = ? WHERE id = ?', [next, now, cur.person_id]);
    }
    const res = await db.runAsync(
      `UPDATE detainees SET ${field} = ?, updated_at = ? WHERE id = ?`, [next, now, input.detaineeId]
    );
    if (res.changes === 0) throw new Error('NOT_FOUND');

    const original = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM detainee_movements
        WHERE detainee_id = ? AND movement_type = ?
        ORDER BY movement_date ASC, created_at ASC, rowid ASC LIMIT 1`,
      [input.detaineeId, MOVE_ADMISSION]
    );
    const last = await lastMovementDate(db, input.detaineeId);
    const moveDate = Math.max(startOfDay(now), last ?? 0);
    const movementId = nid();
    await insertMovement(db, {
      id: movementId, detaineeId: input.detaineeId, type: MOVE_CORRECTION, date: moveDate,
      previous: null, next: null, by: userId,
      reason: MOVE_CORRECTION + ' ' + FIELD_LABELS[field] + ': ' + reason,
      related: original?.id ?? null, now,
    });
    await db.runAsync(
      `INSERT INTO correction_history
         (id, detainee_id, field_name, previous_value, new_value, reason,
          executed_by, related_movement_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nid(), input.detaineeId, field, input.previous, next, reason, userId, movementId, now]
    );
  });
}

// ---------- release ----------
export interface ReleaseInput { detaineeId: string; releaseDate: number; reason?: string }

export async function releasePeriod(
  db: CoreDb, userId: string, input: ReleaseInput, ctx: Ctx = {}
): Promise<void> {
  const now = ctx.now ?? Date.now();
  const nid = ctx.newId ?? defaultId;
  await db.withTransactionAsync(async () => {
    await assertCan(db, userId, 'detainees.manage');
    const ts = requireTimestamp(input.releaseDate, 'release_date', now);
    const detail = await loadDetail(db, input.detaineeId);
    if (ts < detail.admission_date) throw new Error('DATE_BEFORE_ADMISSION');
    const last = await lastMovementDate(db, input.detaineeId);
    if (last !== null && ts < last) throw new Error('DATE_BEFORE_LAST_MOVEMENT');

    const res = await db.runAsync(
      `UPDATE detainees SET status = ?, release_date = ?, updated_at = ?
        WHERE id = ? AND status = ? AND release_date IS NULL`,
      [STATUS_RELEASED, ts, now, input.detaineeId, STATUS_HELD]
    );
    if (res.changes === 0) throw new Error('STATE_CHANGED');

    await insertMovement(db, {
      id: nid(), detaineeId: input.detaineeId, type: MOVE_RELEASE, date: ts,
      previous: authorityLabel(detail.category_name, detail.detaining_authority) || null, next: null,
      by: userId, reason: optionalText(input.reason) ?? REASON_RELEASE, related: null, now,
    });
  });
}

// ---------- transfer ----------
export interface TransferInput {
  detaineeId: string;
  targetCategoryId: string;
  newAuthority?: string;
  transferDate: number;
  reason?: string;
}

export async function transferPeriod(
  db: CoreDb, userId: string, input: TransferInput, ctx: Ctx = {}
): Promise<void> {
  const now = ctx.now ?? Date.now();
  const nid = ctx.newId ?? defaultId;
  await db.withTransactionAsync(async () => {
    await assertCan(db, userId, 'detainees.manage');
    const ts = requireTimestamp(input.transferDate, 'transfer_date', now);
    const target = await db.getFirstAsync<{ id: string; name: string }>(
      'SELECT id, name FROM detainee_categories WHERE id = ? AND is_active = 1', [input.targetCategoryId]
    );
    if (!target) throw new Error('NO_TARGET');
    const detail = await loadDetail(db, input.detaineeId);
    if (ts < detail.admission_date) throw new Error('DATE_BEFORE_ADMISSION');
    const last = await lastMovementDate(db, input.detaineeId);
    if (last !== null && ts < last) throw new Error('DATE_BEFORE_LAST_MOVEMENT');
    const newAuthority = (input.newAuthority ?? '').trim();

    const res = await db.runAsync(
      `UPDATE detainees SET category_id = ?, detaining_authority = ?, updated_at = ?
        WHERE id = ? AND status = ?`,
      [target.id, newAuthority, now, input.detaineeId, STATUS_HELD]
    );
    if (res.changes === 0) throw new Error('STATE_CHANGED');

    await insertMovement(db, {
      id: nid(), detaineeId: input.detaineeId, type: MOVE_TRANSFER, date: ts,
      previous: authorityLabel(detail.category_name, detail.detaining_authority) || null,
      next: authorityLabel(target.name, newAuthority) || null,
      by: userId, reason: optionalText(input.reason) ?? REASON_TRANSFER, related: null, now,
    });
  });
}
