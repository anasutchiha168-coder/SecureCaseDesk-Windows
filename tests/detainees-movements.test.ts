// SECURECASEDESK_DETAINEES_V22_S6A - exit types, re-detention, person timeline (real SQLite).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDb } from './helpers/node-env';
import { initPersonsSchema } from '../src/database/persons-schema';
import { initAuditSchema } from '../src/database/audit-schema';
import { initSyncSchema } from '../src/database/sync-schema';
import * as core from '../src/modules/detainees/detainees-core';
import { EXIT_TYPES } from '../src/modules/detainees/detainees-lists';
import {
  STATUS_HELD, STATUS_RELEASED, MOVE_ADMISSION, MOVE_RELEASE, REASON_REDETENTION,
} from '../src/modules/detainees/detainees-constants';

const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();
const ADM = new Date(2026, 10, 1).getTime();
const REL = new Date(2026, 10, 8).getTime();
const RE_ADM = new Date(2026, 10, 9).getTime();
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
const exit = (db: NodeDb, detaineeId: string, over: Record<string, unknown> = {}) =>
  core.exitPeriod(db as never, 'u1', { detaineeId, exitDate: REL, exitType: EXIT_TYPES[0], ...over } as never, ctx);
const redetain = (db: NodeDb, personId: string, over: Record<string, unknown> = {}, user = 'u1') =>
  core.redetainPerson(db as never, user, {
    personId, referenceNumber: 'R-2', allegedOffense: 'offense-2', categoryId: 'catB',
    detainingAuthority: 'auth-b', admissionDate: RE_ADM, ...over,
  } as never, ctx);

describe('exitPeriod', () => {
  test('records the typed exit and closes the period', async () => {
    const db = await setup();
    const r = await make(db);
    await exit(db, r.detaineeId, { exitProcedure: 'proc-x', exitDirectiveSource: 'src-x' });
    const d = one(db, 'SELECT * FROM detainees WHERE id = ?', r.detaineeId);
    assert.equal(d.status, STATUS_RELEASED);
    assert.equal(d.release_date, REL);
    assert.equal(d.exit_type, EXIT_TYPES[0]);
    assert.equal(d.exit_procedure, 'proc-x');
    assert.equal(d.exit_directive_source, 'src-x');
    const m = one(db, 'SELECT * FROM detainee_movements WHERE detainee_id = ? AND movement_type = ?', r.detaineeId, MOVE_RELEASE);
    assert.equal(m.movement_date, REL);
    assert.equal(m.previous_authority, 'cat-a - auth-a');
    assert.equal(m.reason, EXIT_TYPES[0] + ': proc-x');
    assert.equal(m.executed_by, 'u1');
  });

  test('all three Excel exit types are accepted; procedure and source are optional', async () => {
    const db = await setup();
    for (let i = 0; i < EXIT_TYPES.length; i++) {
      const r = await make(db, { referenceNumber: 'R-x' + i, fullName: 'p' + i });
      await exit(db, r.detaineeId, { exitType: EXIT_TYPES[i] });
      const d = one(db, 'SELECT * FROM detainees WHERE id = ?', r.detaineeId);
      assert.equal(d.exit_type, EXIT_TYPES[i]);
      assert.equal(d.exit_procedure, null);
      assert.equal(d.exit_directive_source, null);
    }
    assert.equal(EXIT_TYPES.length, 3);
  });

  test('rejections leave the period untouched', async () => {
    const db = await setup();
    const r = await make(db);
    await assert.rejects(exit(db, r.detaineeId, { exitType: 'unknown' }), /VALIDATION:exit_type/);
    await assert.rejects(exit(db, r.detaineeId, { exitType: '' }), /VALIDATION:exit_type/);
    await assert.rejects(exit(db, r.detaineeId, { exitDate: ADM - 86_400_000 }), /DATE_BEFORE_ADMISSION/);
    await assert.rejects(exit(db, r.detaineeId, { exitDate: new Date(2026, 10, 12).getTime() }), /VALIDATION:exit_date_future/);
    await assert.rejects(exit(db, 'nope'), /NOT_FOUND/);
    await assert.rejects(core.exitPeriod(db as never, 'u2', { detaineeId: r.detaineeId, exitDate: REL, exitType: EXIT_TYPES[0] }, ctx), /FORBIDDEN/);
    const d = one(db, 'SELECT * FROM detainees WHERE id = ?', r.detaineeId);
    assert.equal(d.status, STATUS_HELD);
    assert.equal(d.release_date, null);
    assert.equal(d.exit_type, null);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainee_movements WHERE movement_type = ?', MOVE_RELEASE), 0);
  });

  test('a second exit on the same period is rejected', async () => {
    const db = await setup();
    const r = await make(db);
    await exit(db, r.detaineeId);
    await assert.rejects(exit(db, r.detaineeId, { exitType: EXIT_TYPES[1] }), /STATE_CHANGED/);
    assert.equal(one(db, 'SELECT exit_type FROM detainees WHERE id = ?', r.detaineeId).exit_type, EXIT_TYPES[0]);
  });

  test('the legacy releasePeriod still works and leaves the exit fields empty', async () => {
    const db = await setup();
    const r = await make(db);
    await core.releasePeriod(db as never, 'u1', { detaineeId: r.detaineeId, releaseDate: REL }, ctx);
    const d = one(db, 'SELECT * FROM detainees WHERE id = ?', r.detaineeId);
    assert.equal(d.status, STATUS_RELEASED);
    assert.equal(d.exit_type, null);
  });
});

describe('redetainPerson', () => {
  test('opens period 2 for the same person, linked to the previous exit movement', async () => {
    const db = await setup();
    const r = await make(db, { person: { id_number: '123' } });
    await exit(db, r.detaineeId);
    const prevExit = one(db, 'SELECT id FROM detainee_movements WHERE detainee_id = ? AND movement_type = ?', r.detaineeId, MOVE_RELEASE);
    const n = await redetain(db, r.personId, { period: { case_role: 'role-2' } });
    assert.equal(n.periodNo, 2);
    assert.equal(n.personId, r.personId);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons'), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainees WHERE person_id = ?', r.personId), 2);
    const d = one(db, 'SELECT * FROM detainees WHERE id = ?', n.detaineeId);
    assert.equal(d.period_no, 2);
    assert.equal(d.full_name, 'name-one');
    assert.equal(d.status, STATUS_HELD);
    assert.equal(d.release_date, null);
    assert.equal(d.case_role, 'role-2');
    assert.equal(d.category_id, 'catB');
    const m = one(db, 'SELECT * FROM detainee_movements WHERE id = ?', n.movementId);
    assert.equal(m.movement_type, MOVE_ADMISSION);
    assert.equal(m.movement_date, RE_ADM);
    assert.equal(m.related_movement_id, prevExit.id);
    assert.equal(m.reason, REASON_REDETENTION + '2');
    assert.equal(m.new_authority, 'cat-b - auth-b');
    // the first period is untouched
    const first = one(db, 'SELECT * FROM detainees WHERE id = ?', r.detaineeId);
    assert.equal(first.status, STATUS_RELEASED);
    assert.equal(first.release_date, REL);
  });

  test('same-day re-admission is allowed; earlier than the previous exit is not', async () => {
    const db = await setup();
    const r = await make(db);
    await exit(db, r.detaineeId);
    await assert.rejects(redetain(db, r.personId, { admissionDate: REL - 86_400_000 }), /DATE_BEFORE_PREVIOUS_EXIT/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainees'), 1);
    const n = await redetain(db, r.personId, { admissionDate: REL });
    assert.equal(n.periodNo, 2);
  });

  test('blocked while the person is still held, nothing written', async () => {
    const db = await setup();
    const r = await make(db);
    await assert.rejects(redetain(db, r.personId), /PERSON_ALREADY_HELD/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainees'), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainee_movements'), 1);
  });

  test('validation, permissions and references', async () => {
    const db = await setup();
    const r = await make(db);
    await exit(db, r.detaineeId);
    await assert.rejects(redetain(db, 'nope'), /NOT_FOUND/);
    await assert.rejects(redetain(db, r.personId, {}, 'u2'), /FORBIDDEN/);
    await assert.rejects(redetain(db, r.personId, { referenceNumber: 'R-1' }), /DUPLICATE_REFERENCE/);
    await assert.rejects(redetain(db, r.personId, { referenceNumber: ' ' }), /VALIDATION:reference_number/);
    await assert.rejects(redetain(db, r.personId, { allegedOffense: '' }), /VALIDATION:alleged_offense/);
    await assert.rejects(redetain(db, r.personId, { categoryId: 'nope' }), /CATEGORY_NOT_FOUND/);
    await assert.rejects(redetain(db, r.personId, { classificationId: 'nope' }), /CLASSIFICATION_NOT_FOUND/);
    await assert.rejects(redetain(db, r.personId, { admissionDate: new Date(2026, 10, 12).getTime() }), /VALIDATION:admission_date_future/);
    await assert.rejects(redetain(db, r.personId, { period: { full_name: 'x' } as never }), /VALIDATION:unknown_field/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainees'), 1);
  });

  test('a third period gets number 3 and the history stays intact', async () => {
    const db = await setup();
    const r = await make(db);
    await exit(db, r.detaineeId);
    const p2 = await redetain(db, r.personId);
    await core.exitPeriod(db as never, 'u1', { detaineeId: p2.detaineeId, exitDate: NOW, exitType: EXIT_TYPES[2] }, ctx);
    const p3 = await redetain(db, r.personId, { referenceNumber: 'R-3', admissionDate: NOW });
    assert.equal(p3.periodNo, 3);
    const res = await core.getPersonWithPeriods(db as never, 'u1', r.personId);
    assert.deepEqual(res.periods.map((p) => p.period_no), [1, 2, 3]);
  });

  test('a corrected name carries into the next period', async () => {
    const db = await setup();
    const r = await make(db);
    await exit(db, r.detaineeId);
    await core.correctPeriodField(db as never, 'u1',
      { detaineeId: r.detaineeId, field: 'full_name', previous: 'name-one', next: 'name-fixed', reason: 'typo' }, ctx);
    const n = await redetain(db, r.personId);
    assert.equal(one(db, 'SELECT full_name FROM detainees WHERE id = ?', n.detaineeId).full_name, 'name-fixed');
  });

  test('atomic: a failure on the movement insert rolls the new period back', async () => {
    const db = await setup();
    const r = await make(db);
    await exit(db, r.detaineeId);
    const wrapped = {
      runAsync: (sql: string, p?: unknown) =>
        sql.includes('INSERT INTO detainee_movements') ? Promise.reject(new Error('boom')) : db.runAsync(sql, p as never),
      getAllAsync: db.getAllAsync.bind(db),
      getFirstAsync: db.getFirstAsync.bind(db),
      withTransactionAsync: db.withTransactionAsync.bind(db),
    };
    await assert.rejects(core.redetainPerson(wrapped as never, 'u1',
      { personId: r.personId, referenceNumber: 'R-2', allegedOffense: 'o', categoryId: 'catA', admissionDate: RE_ADM }, ctx), /boom/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainees'), 1);
  });
});

describe('listPersonMovements', () => {
  test('returns the movements of all periods in date order with the period number', async () => {
    const db = await setup();
    const r = await make(db);
    await exit(db, r.detaineeId);
    await redetain(db, r.personId);
    const list = await core.listPersonMovements(db as never, 'u2', r.personId);
    assert.deepEqual(list.map((m) => m.movement_type), [MOVE_ADMISSION, MOVE_RELEASE, MOVE_ADMISSION]);
    assert.deepEqual(list.map((m) => m.period_no), [1, 1, 2]);
    await assert.rejects(core.listPersonMovements(db as never, 'u1', 'nope'), /NOT_FOUND/);
    await assert.rejects(core.listPersonMovements(db as never, 'nobody', r.personId), /FORBIDDEN/);
  });
});
