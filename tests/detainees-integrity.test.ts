// SECURECASEDESK_DETAINEES_V22_S8 - end-to-end lifecycle + data integrity invariants (real SQLite).
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
import { STATUS_HELD, STATUS_RELEASED, MOVE_ADMISSION } from '../src/modules/detainees/detainees-constants';

const D = (d: number) => new Date(2026, 10, d).getTime();
const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime();
const ctx = { now: NOW };

function baseSchemaBlocks(): string[] {
  const src = readFileSync(join(process.cwd(), 'src/database/db.ts'), 'utf8');
  const start = src.indexOf('export async function initDatabase()');
  const end = src.indexOf('await initCaseHistorySchema(database);');
  assert.ok(start > 0 && end > start, 'cannot locate the base schema block in db.ts');
  return [...src.slice(start, end).matchAll(/execAsync\(`([\s\S]*?)`\)/g)].map((m) => m[1]);
}
const all = (db: NodeDb, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...(p as never[])) as Record<string, unknown>[];
const num = (db: NodeDb, sql: string, ...p: unknown[]) => (db.raw.prepare(sql).get(...(p as never[])) as { c: number }).c;

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
  categoryId: 'catA', detainingAuthority: 'auth-a', admissionDate: D(1), ...over,
});
const make = (db: NodeDb, over: Record<string, unknown> = {}) =>
  core.createDetention(db as never, 'u1', base(over) as never, ctx);
const exit = (db: NodeDb, detaineeId: string, over: Record<string, unknown> = {}) =>
  core.exitPeriod(db as never, 'u1', { detaineeId, exitDate: D(8), exitType: EXIT_TYPES[0], ...over } as never, ctx);
const redetain = (db: NodeDb, personId: string, over: Record<string, unknown> = {}) =>
  core.redetainPerson(db as never, 'u1', {
    personId, referenceNumber: 'R-2', allegedOffense: 'offense-2', categoryId: 'catB',
    detainingAuthority: 'auth-b', admissionDate: D(9), ...over,
  } as never, ctx);

function assertInvariants(db: NodeDb) {
  assert.equal(all(db, 'PRAGMA integrity_check')[0].integrity_check, 'ok', 'integrity_check');
  assert.equal(all(db, 'PRAGMA foreign_key_check').length, 0, 'foreign_key_check');
  assert.equal(num(db, 'SELECT COUNT(*) AS c FROM detainees WHERE person_id IS NULL'), 0, 'period without person');
  assert.equal(num(db, 'SELECT COUNT(*) AS c FROM persons p WHERE NOT EXISTS (SELECT 1 FROM detainees d WHERE d.person_id = p.id)'), 0, 'person without period');
  assert.equal(num(db, 'SELECT COUNT(*) AS c FROM (SELECT person_id FROM detainees WHERE release_date IS NULL GROUP BY person_id HAVING COUNT(*) > 1)'), 0, 'more than one open period');
  assert.equal(num(db, 'SELECT COUNT(*) AS c FROM (SELECT person_id FROM detainees GROUP BY person_id HAVING MAX(period_no) <> COUNT(*))'), 0, 'period_no gaps');
  assert.equal(num(db, 'SELECT COUNT(*) AS c FROM detainees d WHERE NOT EXISTS (SELECT 1 FROM detainee_movements m WHERE m.detainee_id = d.id AND m.movement_type = ?)', MOVE_ADMISSION), 0, 'period without admission movement');
  assert.equal(num(db, 'SELECT COUNT(*) AS c FROM detainees WHERE (status = ? AND release_date IS NULL) OR (status = ? AND release_date IS NOT NULL)', STATUS_RELEASED, STATUS_HELD), 0, 'status/release_date mismatch');
  assert.equal(num(db, 'SELECT COUNT(*) AS c FROM (SELECT reference_number FROM detainees GROUP BY reference_number HAVING COUNT(*) > 1)'), 0, 'duplicate reference');
  assert.equal(num(db, 'SELECT COUNT(*) AS c FROM v_detention_periods WHERE detention_days < 0'), 0, 'negative detention_days');
}

describe('section 8 - lifecycle and integrity', () => {
  test('full lifecycle keeps every invariant', async () => {
    const db = await setup();
    const r = await make(db, { person: { id_number: '123' } });
    assertInvariants(db);
    await exit(db, r.detaineeId);
    assertInvariants(db);
    const r2 = await redetain(db, r.personId);
    assert.equal(r2.periodNo, 2);
    assertInvariants(db);
    await exit(db, r2.detaineeId, { exitDate: D(10), exitType: EXIT_TYPES[1] });
    assertInvariants(db);
    assert.equal(num(db, 'SELECT COUNT(*) AS c FROM persons'), 1);
    assert.equal(num(db, 'SELECT COUNT(*) AS c FROM detainees WHERE person_id = ?', r.personId), 2);
    const timeline = await core.listPersonMovements(db as never, 'u1', r.personId);
    assert.equal(timeline.length, 4);
  });

  test('same name never merges two people', async () => {
    const db = await setup();
    await make(db, { fullName: 'same-name', referenceNumber: 'A-1' });
    await make(db, { fullName: 'same-name', referenceNumber: 'A-2' });
    assert.equal(num(db, 'SELECT COUNT(*) AS c FROM persons'), 2);
    assertInvariants(db);
  });

  test('database refuses a second open period for one person', async () => {
    const db = await setup();
    const r = await make(db);
    await exit(db, r.detaineeId);
    await redetain(db, r.personId);
    assert.throws(() => db.raw.exec(`UPDATE detainees SET release_date = NULL WHERE id = '${r.detaineeId}'`));
    assertInvariants(db);
  });

  test('movements are append-only', async () => {
    const db = await setup();
    await make(db);
    assert.throws(() => db.raw.exec(`UPDATE detainee_movements SET reason = 'x'`));
    assert.throws(() => db.raw.exec('DELETE FROM detainee_movements'));
    assert.ok(num(db, 'SELECT COUNT(*) AS c FROM detainee_movements') >= 1);
  });

  test('rejected operations leave no partial data', async () => {
    const db = await setup();
    const r = await make(db);
    const before = [num(db, 'SELECT COUNT(*) AS c FROM persons'), num(db, 'SELECT COUNT(*) AS c FROM detainees'), num(db, 'SELECT COUNT(*) AS c FROM detainee_movements')];
    await assert.rejects(make(db, { referenceNumber: 'R-9', categoryId: 'missing' }), /CATEGORY_NOT_FOUND/);
    await assert.rejects(make(db, { referenceNumber: 'R-1', fullName: 'other' }), /DUPLICATE_REFERENCE/);
    await assert.rejects(core.createDetention(db as never, 'u2', base({ referenceNumber: 'R-7' }) as never, ctx), /FORBIDDEN/);
    await assert.rejects(redetain(db, r.personId), /PERSON_ALREADY_HELD/);
    const after = [num(db, 'SELECT COUNT(*) AS c FROM persons'), num(db, 'SELECT COUNT(*) AS c FROM detainees'), num(db, 'SELECT COUNT(*) AS c FROM detainee_movements')];
    assert.deepEqual(after, before);
    assertInvariants(db);
  });

  test('re-detention cannot start before the previous exit', async () => {
    const db = await setup();
    const r = await make(db);
    await exit(db, r.detaineeId);
    await assert.rejects(redetain(db, r.personId, { admissionDate: D(5) }), /DATE_BEFORE_PREVIOUS_EXIT/);
    assertInvariants(db);
  });
  test('place_of_detention is stored on the period and survives exit and re-detention', async () => {
    const db = await setup();
    const r = await make(db, { period: { place_of_detention: 'place-x' } });
    assert.equal(all(db, 'SELECT place_of_detention AS p FROM detainees WHERE id = ?', r.detaineeId)[0].p, 'place-x');
    await exit(db, r.detaineeId, { exitProcedure: 'proc', exitDirectiveSource: 'src' });
    const r2 = await redetain(db, r.personId, { period: { place_of_detention: 'place-y' } });
    assert.equal(all(db, 'SELECT place_of_detention AS p FROM detainees WHERE id = ?', r2.detaineeId)[0].p, 'place-y');
    assert.equal(all(db, 'SELECT place_of_detention AS p FROM detainees WHERE id = ?', r.detaineeId)[0].p, 'place-x');
    assertInvariants(db);
  });
});
