// SECURECASEDESK_DETAINEES_V22_S2 — اختبارات فصل الأشخاص عن فترات الاحتجاز (قاعدة SQLite حقيقية).
// المخطط الأساسي القديم يُستخرج من db.ts نفسه، فيُختبر الترحيل على البنية الفعلية.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDb } from './helpers/node-env';
import { initPersonsSchema } from '../src/database/persons-schema';
import { initAuditSchema } from '../src/database/audit-schema';
import { initSyncSchema } from '../src/database/sync-schema';

const DAY = 86_400_000;
const T0 = new Date(2026, 10, 1).getTime();

function baseSchemaBlocks(): string[] {
  const src = readFileSync(join(process.cwd(), 'src/database/db.ts'), 'utf8');
  const start = src.indexOf('export async function initDatabase()');
  const end = src.indexOf('await initCaseHistorySchema(database);');
  assert.ok(start > 0 && end > start, 'تعذر تحديد كتلة المخطط في db.ts');
  return [...src.slice(start, end).matchAll(/execAsync\(`([\s\S]*?)`\)/g)].map((m) => m[1]);
}

async function legacyDb(withRows: boolean) {
  const db = new NodeDb();
  db.raw.exec('PRAGMA foreign_keys = ON;');
  for (const b of baseSchemaBlocks()) db.raw.exec(b);
  db.raw.exec(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','admin','x','admin',1)`);
  db.raw.exec(`INSERT INTO detainee_categories (id, name, created_at) VALUES ('cat1','فئة',1) ON CONFLICT DO NOTHING`);
  const catId = (db.raw.prepare('SELECT id FROM detainee_categories LIMIT 1').get() as { id: string }).id;
  if (withRows) {
    for (let i = 1; i <= 5; i++) {
      const name = i <= 2 ? 'محمد علي' : 'اسم ' + i; // أسماء متطابقة عمداً: يجب ألا تُدمج
      const rel = i === 3 ? String(T0 + (i + 4) * DAY) : 'NULL';
      db.raw.exec(`INSERT INTO detainees (id, reference_number, full_name, category_id, admission_date, release_date, alleged_offense, detaining_authority, status, created_by, created_at, updated_at)
        VALUES ('d${i}','R${i}','${name}','${catId}',${T0 + i * DAY},${rel},'تهمة','حجز','${i === 3 ? 'مفرج عنه' : 'محتجز'}','u1',${T0},${T0})`);
    }
    db.raw.exec(`INSERT INTO detainee_movements (id, movement_number, detainee_id, movement_type, movement_date, executed_by, created_at)
      VALUES ('m1','MOV1','d1','إيداع',${T0},'u1',${T0})`);
  }
  // مشغلات التدقيق والمزامنة قبل وجود person_id = حالة قاعدة قديمة (الحقول تُصفّى بحسب الأعمدة الموجودة)
  await initAuditSchema(db as never);
  await initSyncSchema(db as never);
  return { db, catId };
}

const count = (db: NodeDb, sql: string, ...p: unknown[]) =>
  (db.raw.prepare(sql).get(...(p as never[])) as { c: number }).c;
const trigger = (db: NodeDb, name: string) =>
  (db.raw.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(name) as { sql: string } | undefined)?.sql ?? '';

async function migrate(db: NodeDb) {
  await initPersonsSchema(db as never);
  await initAuditSchema(db as never);
  await initSyncSchema(db as never);
}

describe('ترحيل قاعدة قديمة', () => {
  test('كل سجل قديم يصبح شخصاً مستقلاً دون دمج الأسماء المتطابقة', async () => {
    const { db } = await legacyDb(true);
    await migrate(db);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons'), 5);
    assert.equal(count(db, 'SELECT COUNT(DISTINCT person_id) AS c FROM detainees'), 5);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainees WHERE person_id IS NULL'), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons p JOIN detainees d ON d.person_id = p.id WHERE p.full_name = d.full_name'), 5);
    assert.equal(count(db, `SELECT COUNT(*) AS c FROM persons WHERE full_name = 'محمد علي'`), 2);
  });

  test('البيانات والحركات سليمة ولا ضجيج تدقيق أو مزامنة', async () => {
    const { db } = await legacyDb(true);
    const aq = count(db, 'SELECT COUNT(*) AS c FROM audit_event_queue');
    const so = count(db, 'SELECT COUNT(*) AS c FROM sync_operations');
    await migrate(db);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainees'), 5);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainee_movements'), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM audit_event_queue'), aq);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM sync_operations'), so);
    assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), []);
  });

  test('مشغلات التدقيق تُعاد بالحقول الجديدة وتغطي persons', async () => {
    const { db } = await legacyDb(true);
    assert.ok(!trigger(db, 'audit_detainees_update').includes('person_id'));
    await migrate(db);
    for (const op of ['insert', 'update', 'delete']) {
      assert.ok(trigger(db, 'audit_detainees_' + op).includes('person_id'), op);
      assert.ok(trigger(db, 'audit_persons_' + op).length > 0, op);
    }
    assert.ok(trigger(db, 'trg_sync_persons_ai') && trigger(db, 'trg_sync_detainees_au'));
  });

  test('إعادة التشغيل لا تُضيف أشخاصاً ولا تُكرر شيئاً', async () => {
    const { db } = await legacyDb(true);
    await migrate(db);
    await migrate(db);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons'), 5);
  });

  test('قاعدة جديدة فارغة تعمل', async () => {
    const { db } = await legacyDb(false);
    await migrate(db);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons'), 0);
  });
});

describe('قواعد السلامة', () => {
  async function ready() {
    const { db, catId } = await legacyDb(true);
    await migrate(db);
    const personOf = (id: string) => (db.raw.prepare('SELECT person_id AS p FROM detainees WHERE id = ?').get(id) as { p: string }).p;
    const period = (id: string, pid: string, no: number, rel: string) => db.raw.exec(
      `INSERT INTO detainees (id, person_id, period_no, reference_number, full_name, category_id, admission_date, release_date, alleged_offense, detaining_authority, status, created_by, created_at, updated_at)
       VALUES ('${id}','${pid}',${no},'R-${id}','س','${catId}',${T0 + 20 * DAY},${rel},'ت','ج','${rel === 'NULL' ? 'محتجز' : 'مفرج عنه'}','u1',1,1)`);
    return { db, catId, personOf, period };
  }

  test('لا فترة احتجاز بلا شخص، ولا فصل فترة عن شخصها', async () => {
    const { db, catId } = await ready();
    assert.throws(() => db.raw.exec(
      `INSERT INTO detainees (id, reference_number, full_name, category_id, admission_date, alleged_offense, detaining_authority, created_by, created_at, updated_at)
       VALUES ('x','RX','س','${catId}',1,'ت','ج','u1',1,1)`), /بلا شخص/);
    assert.throws(() => db.raw.exec(`UPDATE detainees SET person_id = NULL WHERE id = 'd1'`), /فصل فترة/);
  });

  test('الشخص الواحد: فترات متعددة، وفترة مفتوحة واحدة فقط، وأرقام فترات غير مكررة', async () => {
    const { db, personOf, period } = await ready();
    const p = personOf('d3'); // فترته الأولى مغلقة (مفرج عنه)
    period('d6', p, 2, 'NULL');
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainees WHERE person_id = ?', p), 2);
    assert.throws(() => period('d7', p, 3, 'NULL'), /UNIQUE/);
    assert.throws(() => period('d8', p, 2, String(T0 + 25 * DAY)), /UNIQUE/);
  });

  test('تصحيح الاسم على الفترة ينعكس على الشخص', async () => {
    const { db } = await ready();
    db.raw.exec(`UPDATE detainees SET full_name = 'اسم مصحح', updated_at = 99 WHERE id = 'd1'`);
    const n = db.raw.prepare(`SELECT p.full_name AS n FROM persons p JOIN detainees d ON d.person_id = p.id WHERE d.id = 'd1'`).get() as { n: string };
    assert.equal(n.n, 'اسم مصحح');
  });

  test('أيام الاحتجاز بالأيام التقويمية: يوم الدخول لا يُحسب ونفس اليوم = 0', async () => {
    const { db } = await ready();
    const days = (id: string) => (db.raw.prepare('SELECT detention_days AS n FROM v_detention_periods WHERE id = ?').get(id) as { n: number }).n;
    assert.equal(days('d3'), 4); // دخول t0+3 وخروج t0+7
    db.raw.exec(`UPDATE detainees SET admission_date = ${T0 + 3 * DAY}, release_date = ${T0 + 3 * DAY + 3_600_000 * 20} WHERE id = 'd3'`);
    assert.equal(days('d3'), 0);
    assert.ok(days('d4') >= 0);
  });
});
