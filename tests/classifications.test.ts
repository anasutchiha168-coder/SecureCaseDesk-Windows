// SECURECASEDESK_DETAINEES_V22_S5 - crime classifications: seed, idempotency, link to a detention period.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDb } from './helpers/node-env';
import { initPersonsSchema } from '../src/database/persons-schema';
import { initAuditSchema } from '../src/database/audit-schema';
import { initSyncSchema } from '../src/database/sync-schema';
import { classificationSeedRows } from '../src/database/classifications-schema';
import * as core from '../src/modules/detainees/detainees-core';

const ADM = new Date(2026, 10, 1).getTime();
const ctx = { now: new Date(2026, 10, 10, 12).getTime() };

function baseSchemaBlocks(): string[] {
  const src = readFileSync(join(process.cwd(), 'src/database/db.ts'), 'utf8');
  const start = src.indexOf('export async function initDatabase()');
  const end = src.indexOf('await initCaseHistorySchema(database);');
  assert.ok(start > 0 && end > start);
  return [...src.slice(start, end).matchAll(/execAsync\(`([\s\S]*?)`\)/g)].map((m) => m[1]);
}
const count = (db: NodeDb, sql: string, ...p: unknown[]) =>
  (db.raw.prepare(sql).get(...(p as never[])) as { c: number }).c;

async function setup() {
  const db = new NodeDb();
  db.raw.exec('PRAGMA foreign_keys = ON;');
  for (const b of baseSchemaBlocks()) db.raw.exec(b);
  db.raw.exec(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','admin','x','admin',1)`);
  db.raw.exec(`INSERT INTO detainee_categories (id, name, created_at) VALUES ('catA','cat-a',1) ON CONFLICT DO NOTHING`);
  db.raw.exec(`UPDATE detainee_categories SET is_active = 1 WHERE id = 'catA'`);
  await initPersonsSchema(db as never);
  await initAuditSchema(db as never);
  await initSyncSchema(db as never);
  return db;
}
const input = (over: Record<string, unknown> = {}) => ({
  fullName: 'n1', referenceNumber: 'R-1', allegedOffense: 'x', categoryId: 'catA', admissionDate: ADM, ...over,
});

describe('crime classifications', () => {
  test('seed: 178 rows, 94 grave / 84 light, stable ids, unique names', async () => {
    const db = await setup();
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM crime_classifications'), 178);
    assert.equal(count(db, `SELECT COUNT(*) AS c FROM crime_classifications WHERE severity = 'جسيمة'`), 94);
    assert.equal(count(db, `SELECT COUNT(*) AS c FROM crime_classifications WHERE severity = 'غير جسيم'`), 84);
    assert.equal(count(db, 'SELECT COUNT(DISTINCT sub_category) AS c FROM crime_classifications'), 12);
    assert.equal(count(db, `SELECT COUNT(*) AS c FROM crime_classifications WHERE id IN ('cls-001','cls-178')`), 2);
    assert.equal(new Set(classificationSeedRows().map((r) => r.name)).size, 178);
  });

  test('re-running the init does not duplicate or revive deactivated rows', async () => {
    const db = await setup();
    db.raw.exec(`UPDATE crime_classifications SET is_active = 0 WHERE id = 'cls-001'`);
    await initPersonsSchema(db as never);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM crime_classifications'), 178);
    assert.equal(count(db, `SELECT is_active AS c FROM crime_classifications WHERE id = 'cls-001'`), 0);
  });

  test('createDetention stores the classification; unknown or inactive is rejected atomically', async () => {
    const db = await setup();
    const r = await core.createDetention(db as never, 'u1', input({ classificationId: 'cls-007' }) as never, ctx);
    const row = db.raw.prepare('SELECT classification_id FROM detainees WHERE id = ?').get(r.detaineeId) as { classification_id: string };
    assert.equal(row.classification_id, 'cls-007');

    await assert.rejects(core.createDetention(db as never, 'u1', input({ referenceNumber: 'R-2', classificationId: 'nope' }) as never, ctx), /CLASSIFICATION_NOT_FOUND/);
    db.raw.exec(`UPDATE crime_classifications SET is_active = 0 WHERE id = 'cls-008'`);
    await assert.rejects(core.createDetention(db as never, 'u1', input({ referenceNumber: 'R-3', classificationId: 'cls-008' }) as never, ctx), /CLASSIFICATION_NOT_FOUND/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons'), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainees'), 1);
  });

  test('classification is optional', async () => {
    const db = await setup();
    const r = await core.createDetention(db as never, 'u1', input() as never, ctx);
    const row = db.raw.prepare('SELECT classification_id FROM detainees WHERE id = ?').get(r.detaineeId) as { classification_id: string | null };
    assert.equal(row.classification_id, null);
  });
});
