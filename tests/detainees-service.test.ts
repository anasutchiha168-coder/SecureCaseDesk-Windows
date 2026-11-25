// SECURECASEDESK_DETAINEES_V22_S3A - detainees services tests (real SQLite, schema taken from db.ts).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDb } from './helpers/node-env';
import { initPersonsSchema } from '../src/database/persons-schema';
import { initAuditSchema } from '../src/database/audit-schema';
import { initSyncSchema } from '../src/database/sync-schema';
import * as core from '../src/modules/detainees/detainees-core';
import { startOfDay } from '../src/modules/detainees/detainees-validation';
import {
  STATUS_HELD, STATUS_RELEASED, MOVE_ADMISSION, MOVE_RELEASE, MOVE_TRANSFER, MOVE_CORRECTION,
} from '../src/modules/detainees/detainees-constants';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();
const ADM = new Date(2026, 10, 1).getTime();
const REL = new Date(2026, 10, 8).getTime();
const ctx = { now: NOW };

function baseSchemaBlocks(): string[] {
  const src = readFileSync(join(process.cwd(), 'src/database/db.ts'), 'utf8');
  const start = src.indexOf('export async function initDatabase()');
  const end = src.indexOf('await initCaseHistorySchema(database);');
  assert.ok(start > 0 && end > start, 'cannot locate the base schema block in db.ts');
  return [...src.slice(start, end).matchAll(/execAsync\(`([\s\S]*?)`\)/g)].map((m) => m[1]);
}

const count = (db: NodeDb, sql: string, ...p: unknown[]) =>
  (db.raw.prepare(sql).get(...(p as never[])) as { c: number }).c;
const one = (db: NodeDb, sql: string, ...p: unknown[]) =>
  db.raw.prepare(sql).get(...(p as never[])) as Record<string, unknown>;

async function setup() {
  const db = new NodeDb();
  db.raw.exec('PRAGMA foreign_keys = ON;');
  for (const b of baseSchemaBlocks()) db.raw.exec(b);
  assert.equal(count(db, `SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'correction_history'`), 1, 'correction_history is missing from the base schema block');
  db.raw.exec(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','admin','x','admin',1), ('u2','viewer1','x','viewer',1)`);
  db.raw.exec(`INSERT INTO detainee_categories (id, name, created_at) VALUES ('catA','cat-a',1), ('catB','cat-b',1) ON CONFLICT DO NOTHING`);
  db.raw.exec(`UPDATE detainee_categories SET is_active = 1 WHERE id IN ('catA','catB')`);
  await initPersonsSchema(db as never);
  await initAuditSchema(db as never);
  await initSyncSchema(db as never);
  return db;
}

const base = (over: Record<string, unknown> = {}) => ({
  fullName: 'name-one', referenceNumber: 'R-1', allegedOffense: 'offense',
  categoryId: 'catA', detainingAuthority: 'auth-a', admissionDate: ADM, ...over,
});
const make = (db: NodeDb, over: Record<string, unknown> = {}) =>
  core.createDetention(db as never, 'u1', base(over) as never, ctx);

describe('createDetention', () => {
  test('creates person + period + admission movement', async () => {
    const db = await setup();
    const r = await make(db, { person: { id_number: '123', phone: '555' }, period: { case_role: 'role-x', age_at_admission: 30 } });
    const d = one(db, 'SELECT * FROM detainees WHERE id = ?', r.detaineeId);
    assert.equal(d.person_id, r.personId);
    assert.equal(d.period_no, 1);
    assert.equal(d.status, STATUS_HELD);
    assert.equal(d.case_role, 'role-x');
    assert.equal(d.age_at_admission, 30);
    const p = one(db, 'SELECT * FROM persons WHERE id = ?', r.personId);
    assert.equal(p.full_name, 'name-one');
    assert.equal(p.id_number, '123');
    const m = one(db, 'SELECT * FROM detainee_movements WHERE detainee_id = ?', r.detaineeId);
    assert.equal(m.movement_type, MOVE_ADMISSION);
    assert.equal(m.movement_date, ADM);
    assert.equal(m.executed_by, 'u1');
    assert.equal(m.new_authority, 'cat-a - auth-a');
  });

  test('forbidden for viewer and unknown user, nothing written', async () => {
    const db = await setup();
    await assert.rejects(core.createDetention(db as never, 'u2', base() as never, ctx), /FORBIDDEN/);
    await assert.rejects(core.createDetention(db as never, 'nobody', base() as never, ctx), /FORBIDDEN/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons'), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainees'), 0);
  });

  test('validation errors', async () => {
    const db = await setup();
    await assert.rejects(make(db, { fullName: '  ' }), /VALIDATION:full_name/);
    await assert.rejects(make(db, { referenceNumber: '' }), /VALIDATION:reference_number/);
    await assert.rejects(make(db, { allegedOffense: '' }), /VALIDATION:alleged_offense/);
    await assert.rejects(make(db, { admissionDate: new Date(2026, 10, 12).getTime() }), /VALIDATION:admission_date/);
    await assert.rejects(make(db, { categoryId: 'nope' }), /CATEGORY_NOT_FOUND/);
    await assert.rejects(make(db, { person: { full_name: 'x' } }), /VALIDATION:unknown_field/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons'), 0);
  });

  test('duplicate reference number is rejected', async () => {
    const db = await setup();
    await make(db);
    await assert.rejects(make(db, { fullName: 'other' }), /DUPLICATE_REFERENCE/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons'), 1);
  });

  test('atomic: a failure on the movement insert rolls everything back', async () => {
    const db = await setup();
    const wrapped = {
      runAsync: (sql: string, p?: unknown) =>
        sql.includes('INSERT INTO detainee_movements') ? Promise.reject(new Error('boom')) : db.runAsync(sql, p as never),
      getAllAsync: db.getAllAsync.bind(db),
      getFirstAsync: db.getFirstAsync.bind(db),
      withTransactionAsync: db.withTransactionAsync.bind(db),
    };
    await assert.rejects(core.createDetention(wrapped as never, 'u1', base() as never, ctx), /boom/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons'), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainees'), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainee_movements'), 0);
  });
});

describe('read and update', () => {
  test('getPersonWithPeriods returns the person with periods and detention days', async () => {
    const db = await setup();
    const r = await make(db);
    await core.releasePeriod(db as never, 'u1', { detaineeId: r.detaineeId, releaseDate: REL }, ctx);
    const res = await core.getPersonWithPeriods(db as never, 'u1', r.personId);
    assert.equal(res.person.full_name, 'name-one');
    assert.equal(res.periods.length, 1);
    assert.equal(res.periods[0].detention_days, 7);
    await assert.rejects(core.getPersonWithPeriods(db as never, 'u1', 'nope'), /NOT_FOUND/);
  });

  test('updatePerson and updatePeriod change only allowed fields', async () => {
    const db = await setup();
    const r = await make(db);
    await core.updatePerson(db as never, 'u1', r.personId, { phone: '999', governorate: 'gov' }, ctx);
    const p = one(db, 'SELECT * FROM persons WHERE id = ?', r.personId);
    assert.equal(p.phone, '999');
    assert.equal(p.governorate, 'gov');
    assert.equal(p.updated_at, NOW);
    await core.updatePeriod(db as never, 'u1', r.detaineeId, { report_number: 'B-7', age_at_admission: 41 }, ctx);
    const d = one(db, 'SELECT * FROM detainees WHERE id = ?', r.detaineeId);
    assert.equal(d.report_number, 'B-7');
    assert.equal(d.age_at_admission, 41);
    await assert.rejects(core.updatePerson(db as never, 'u1', r.personId, { full_name: 'x' } as never, ctx), /VALIDATION:unknown_field/);
    await assert.rejects(core.updatePeriod(db as never, 'u1', r.detaineeId, { status: 'x' } as never, ctx), /VALIDATION:unknown_field/);
    await assert.rejects(core.updatePerson(db as never, 'u2', r.personId, { phone: '1' }, ctx), /FORBIDDEN/);
    await assert.rejects(core.updatePerson(db as never, 'u1', 'nope', { phone: '1' }, ctx), /NOT_FOUND/);
  });

  test('searchDetainees by name, reference and identity number', async () => {
    const db = await setup();
    await make(db, { person: { id_number: '77001' } });
    await make(db, { fullName: 'second-person', referenceNumber: 'R-2' });
    const s = (q: string) => core.searchDetainees(db as never, 'u1', q);
    assert.equal((await s('')).length, 2);
    assert.equal((await s('name-one')).length, 1);
    assert.equal((await s('R-2')).length, 1);
    assert.equal((await s('77001')).length, 1);
    assert.equal((await s('zzz')).length, 0);
    await assert.rejects(core.searchDetainees(db as never, 'nobody', ''), /FORBIDDEN/);
  });
});

describe('correction', () => {
  test('full_name correction updates both tables, history and a linked movement', async () => {
    const db = await setup();
    const r = await make(db);
    await core.correctPeriodField(db as never, 'u1', { detaineeId: r.detaineeId, field: 'full_name', previous: 'name-one', next: 'name-fixed', reason: 'typo' }, ctx);
    assert.equal(one(db, 'SELECT full_name AS v FROM detainees WHERE id = ?', r.detaineeId).v, 'name-fixed');
    assert.equal(one(db, 'SELECT full_name AS v FROM persons WHERE id = ?', r.personId).v, 'name-fixed');
    const adm = one(db, 'SELECT id FROM detainee_movements WHERE detainee_id = ? AND movement_type = ?', r.detaineeId, MOVE_ADMISSION);
    const mv = one(db, 'SELECT * FROM detainee_movements WHERE detainee_id = ? AND movement_type = ?', r.detaineeId, MOVE_CORRECTION);
    assert.equal(mv.related_movement_id, adm.id);
    assert.equal(mv.movement_date, startOfDay(NOW));
    const h = one(db, 'SELECT * FROM correction_history WHERE detainee_id = ?', r.detaineeId);
    assert.equal(h.field_name, 'full_name');
    assert.equal(h.previous_value, 'name-one');
    assert.equal(h.new_value, 'name-fixed');
    assert.equal(h.reason, 'typo');
    assert.equal(h.related_movement_id, mv.id);
  });

  test('alleged_offense correction, VALUE_CHANGED, reason required, permission', async () => {
    const db = await setup();
    const r = await make(db);
    const c = (over: Record<string, unknown>, user = 'u1') => core.correctPeriodField(db as never, user, {
      detaineeId: r.detaineeId, field: 'alleged_offense', previous: 'offense', next: 'offense-2', reason: 'why', ...over,
    } as never, ctx);
    await assert.rejects(c({ previous: 'wrong' }), /VALUE_CHANGED/);
    await assert.rejects(c({ reason: ' ' }), /VALIDATION:reason/);
    await assert.rejects(c({}, 'u2'), /FORBIDDEN/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM correction_history'), 0);
    await c({});
    assert.equal(one(db, 'SELECT alleged_offense AS v FROM detainees WHERE id = ?', r.detaineeId).v, 'offense-2');
    await assert.rejects(core.correctPeriodField(db as never, 'u1', { detaineeId: 'nope', field: 'full_name', previous: 'a', next: 'b', reason: 'r' }, ctx), /NOT_FOUND/);
  });
});

describe('release and transfer', () => {
  test('release closes the period once and records a movement', async () => {
    const db = await setup();
    const r = await make(db);
    await core.releasePeriod(db as never, 'u1', { detaineeId: r.detaineeId, releaseDate: REL }, ctx);
    const d = one(db, 'SELECT * FROM detainees WHERE id = ?', r.detaineeId);
    assert.equal(d.status, STATUS_RELEASED);
    assert.equal(d.release_date, REL);
    const mv = one(db, 'SELECT * FROM detainee_movements WHERE detainee_id = ? AND movement_type = ?', r.detaineeId, MOVE_RELEASE);
    assert.equal(mv.movement_date, REL);
    assert.equal(mv.previous_authority, 'cat-a - auth-a');
    await assert.rejects(core.releasePeriod(db as never, 'u1', { detaineeId: r.detaineeId, releaseDate: REL }, ctx), /STATE_CHANGED/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainee_movements WHERE detainee_id = ?', r.detaineeId), 2);
  });

  test('release date rules', async () => {
    const db = await setup();
    const r = await make(db);
    const rel = (releaseDate: number, user = 'u1') => core.releasePeriod(db as never, user, { detaineeId: r.detaineeId, releaseDate }, ctx);
    await assert.rejects(rel(ADM - DAY), /DATE_BEFORE_ADMISSION/);
    await assert.rejects(rel(new Date(2026, 10, 12).getTime()), /VALIDATION:release_date/);
    await assert.rejects(rel(REL, 'u2'), /FORBIDDEN/);
    await core.correctPeriodField(db as never, 'u1', { detaineeId: r.detaineeId, field: 'full_name', previous: 'name-one', next: 'n2', reason: 'r' }, ctx);
    await assert.rejects(rel(REL), /DATE_BEFORE_LAST_MOVEMENT/);
    assert.equal(one(db, 'SELECT status AS v FROM detainees WHERE id = ?', r.detaineeId).v, STATUS_HELD);
  });

  test('transfer changes category and authority, and only for held detainees', async () => {
    const db = await setup();
    const r = await make(db);
    const tr = (over: Record<string, unknown> = {}) => core.transferPeriod(db as never, 'u1', {
      detaineeId: r.detaineeId, targetCategoryId: 'catB', newAuthority: 'auth-b', transferDate: REL, ...over,
    } as never, ctx);
    await assert.rejects(tr({ targetCategoryId: 'nope' }), /NO_TARGET/);
    await tr();
    const d = one(db, 'SELECT * FROM detainees WHERE id = ?', r.detaineeId);
    assert.equal(d.category_id, 'catB');
    assert.equal(d.detaining_authority, 'auth-b');
    const mv = one(db, 'SELECT * FROM detainee_movements WHERE detainee_id = ? AND movement_type = ?', r.detaineeId, MOVE_TRANSFER);
    assert.equal(mv.previous_authority, 'cat-a - auth-a');
    assert.equal(mv.new_authority, 'cat-b - auth-b');
    await core.releasePeriod(db as never, 'u1', { detaineeId: r.detaineeId, releaseDate: REL }, ctx);
    await assert.rejects(tr({ targetCategoryId: 'catA' }), /STATE_CHANGED/);
  });
});
