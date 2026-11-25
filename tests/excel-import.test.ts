// SECURECASEDESK_DETAINEES_V22_S1_IMPORT - Excel import tests (real SQLite, schema taken from db.ts).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDb } from './helpers/node-env';
import { initPersonsSchema } from '../src/database/persons-schema';
import { initAuditSchema } from '../src/database/audit-schema';
import { initSyncSchema } from '../src/database/sync-schema';
import {
  planImport, runImport, mapCategory, classifyExit, resolveExitType, dateToTs, IMPORT_SOURCE, type RawRow,
} from '../src/modules/detainees/excel-import';

const NOW = new Date(2026, 10, 25, 12, 0, 0).getTime();
const EXIT_TYPES = ['تم الافراج عنه', 'تم نقله على القضاء الى سجن اخر', 'تم تسليمه لجهات أخرى'];

function baseSchemaBlocks(): string[] {
  const src = readFileSync(join(process.cwd(), 'src/database/db.ts'), 'utf8');
  const start = src.indexOf('export async function initDatabase()');
  const end = src.indexOf('await initCaseHistorySchema(database);');
  assert.ok(start > 0 && end > start, 'cannot locate the base schema block in db.ts');
  return [...src.slice(start, end).matchAll(/execAsync\(`([\s\S]*?)`\)/g)].map((m) => m[1]);
}
const count = (db: NodeDb, sql: string, ...p: unknown[]) => (db.raw.prepare(sql).get(...(p as never[])) as { c: number }).c;
const one = (db: NodeDb, sql: string, ...p: unknown[]) => db.raw.prepare(sql).get(...(p as never[])) as Record<string, unknown>;

async function setup() {
  const db = new NodeDb();
  db.raw.exec('PRAGMA foreign_keys = ON;');
  for (const b of baseSchemaBlocks()) db.raw.exec(b);
  db.raw.exec(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','admin','x','admin',1), ('u2','viewer1','x','viewer',1)`);
  await initPersonsSchema(db as never);
  await initAuditSchema(db as never);
  await initSyncSchema(db as never);
  return db;
}

const raw = (over: Partial<RawRow> = {}): RawRow => ({
  excelRow: 3, serial: '10', name: 'اسم أول', age: '30', idType: null, idNumber: null, phone: null,
  governorate: 'حجة', district: 'كشر', subDistrict: null, residence: 'بيت', occupation: 'عامل',
  offense: 'سرقة', caseRole: 'جاني', reportNo: null, depositAuthority: 'الجزائية', admission: '2026-11-01',
  legalStatus: 'رهن التحقيق', referralDate: null, place: 'الحجز الاحتياطي', release: null, exitType: null,
  exitProcedure: null, exitSource: null, fate: 'سجين', notes: null, ...over,
});
const plan = (rows: RawRow[]) => planImport(rows, { now: NOW });
const run = (db: NodeDb, p: ReturnType<typeof plan>, user = 'u1', extra: object = {}) =>
  runImport(db as never, user, p, { exitTypes: EXIT_TYPES, now: NOW, ...extra });

describe('mapping helpers', () => {
  test('category mapping: direct, prosecution prefix, new authority, empty', () => {
    assert.equal(mapCategory('الجزائية'), 'النيابة الجزائية');
    assert.equal(mapCategory(' الابتدائية '), 'النيابة الابتدائية');
    assert.equal(mapCategory('البحث الجنائي'), 'قيد التحقيق الأولي');
    assert.equal(mapCategory('نيابة المحابشة'), 'نيابات المديريات');
    assert.equal(mapCategory('مكافحة المخدرات'), 'مكافحة المخدرات');
    assert.equal(mapCategory(null), 'غير محدد');
  });
  test('exit classification and resolution against the configured list', () => {
    assert.equal(classifyExit('تم اطلاقة بحسب توجيهات مدير البحث'), 'released');
    assert.equal(classifyExit('تم نقلة الى السجن المركزي م/ حجة'), 'transferred');
    assert.equal(classifyExit('تم تسليمه لجهات اخرى'), 'handed_over');
    assert.equal(classifyExit('هروب من مكتب التحقيق'), null);
    assert.equal(classifyExit(null), null);
    assert.equal(resolveExitType('released', EXIT_TYPES), EXIT_TYPES[0]);
    assert.equal(resolveExitType('transferred', EXIT_TYPES), EXIT_TYPES[1]);
    assert.equal(resolveExitType('handed_over', EXIT_TYPES), EXIT_TYPES[2]);
    assert.equal(resolveExitType(null, EXIT_TYPES), null);
  });
  test('dates are stored at midday Yemen time so the calendar day is stable', () => {
    assert.equal(dateToTs('2026-11-01'), Date.UTC(2026, 10, 1, 9));
    assert.equal(dateToTs('bad'), null);
    assert.equal(dateToTs(null), null);
  });
});

describe('planImport', () => {
  test('skips invalid rows with a reason and never throws', () => {
    const p = plan([
      raw({ excelRow: 3 }),
      raw({ excelRow: 4, name: null, serial: '11' }),
      raw({ excelRow: 5, serial: '12', admission: null }),
      raw({ excelRow: 6, serial: '13', admission: '2026-11-05', release: '2026-11-01', fate: 'خروج' }),
      raw({ excelRow: 7, serial: '14', admission: '2026-12-30' }),
      raw({ excelRow: 8, serial: '15', fate: 'سجين', release: '2026-11-03' }),
      raw({ excelRow: 9, serial: '16', fate: 'خروج', release: null }),
    ]);
    assert.equal(p.summary.imported, 1);
    assert.equal(p.summary.skipped.length, 6);
    assert.ok(p.summary.skipped.every((s) => s.reason.length > 0));
  });
  test('field mapping: legal status, id type, zero phone, original text kept', () => {
    const p = plan([
      raw({ idType: 'عسكرية', idNumber: '77', phone: '0', reportNo: '0', legalStatus: 'رهن المحاكمة' }),
      raw({ excelRow: 4, serial: '11', legalStatus: 'محكوم', idType: 'شخصية' }),
    ]);
    const a = p.records[0]; const b = p.records[1];
    assert.equal(a.legalStatus, 'على ذمة المحكمة');
    assert.equal(a.person.idType, 'أخرى');
    assert.ok(a.person.notes?.includes('عسكرية'));
    assert.equal(a.person.phone, null); assert.equal(a.reportNo, null);
    assert.equal(b.legalStatus, 'محكوم'); assert.equal(b.person.idType, 'شخصية');
    assert.equal(a.caseRole, 'جاني');
  });
  test('same serial gets /2; same name is flagged, never merged; overlap detected', () => {
    const p = plan([
      raw({ excelRow: 3, serial: '5', name: 'مكرر', admission: '2026-10-01', release: '2026-10-20', fate: 'خروج', exitType: 'تم اطلاقة' }),
      raw({ excelRow: 4, serial: '5', name: 'مكرر', admission: '2026-10-10' }),
      raw({ excelRow: 5, serial: '6', name: 'مكرر', admission: '2026-11-01' }),
    ]);
    assert.deepEqual(p.records.map((r) => r.reference).sort(), ['5', '5/2', '6']);
    assert.equal(p.summary.duplicateNames, 1);
    assert.equal(p.summary.overlaps, 2); // 5 مع 5/2، و5/2 (مفتوحة) مع 6
    assert.ok(p.records.every((r) => r.flags.some((f) => f.includes('اسم مطابق'))));
    assert.ok(p.records.some((r) => r.flags.some((f) => f.includes('تداخل'))));
  });
  test('exit fields only on released rows; unclassified exit is kept as text', () => {
    const p = plan([
      raw({ excelRow: 3, serial: '1', release: '2026-11-03', fate: 'خروج', exitType: 'تم تسليمه لجهات اخرى', exitSource: 'فلان' }),
      raw({ excelRow: 4, serial: '2', release: '2026-11-03', fate: 'خروج', exitType: 'هروب من مكتب التحقيق', exitProcedure: 'هروب من مكتب التحقيق' }),
    ]);
    assert.equal(p.records[0].exitKind, 'handed_over'); assert.equal(p.records[0].exitSource, 'فلان');
    assert.equal(p.records[1].exitKind, null); assert.equal(p.records[1].exitProcedure, 'هروب من مكتب التحقيق');
    assert.equal(p.summary.exitUnclassified, 1);
  });
});

describe('runImport', () => {
  const rows = () => [
    raw({ excelRow: 3, serial: '1', name: 'محتجز', depositAuthority: 'الجزائية' }),
    raw({ excelRow: 4, serial: '2', name: 'مفرج', depositAuthority: 'مكافحة المخدرات', admission: '2026-10-01', release: '2026-10-11',
      fate: 'خروج', exitType: 'تم اطلاقة من قبل النيابة', exitProcedure: 'تم اطلاقة من قبل النيابة', exitSource: 'عبدالله', legalStatus: 'محكوم' }),
    raw({ excelRow: 5, serial: '2', name: 'مفرج', admission: '2026-11-02', depositAuthority: 'نيابة كشر' }),
  ];

  test('writes persons, periods and movements with correct values', async () => {
    const db = await setup();
    const r = await run(db, plan(rows()));
    assert.deepEqual([r.persons, r.periods, r.movements], [3, 3, 4]);
    assert.ok(r.categoriesCreated.includes('مكافحة المخدرات') && r.categoriesCreated.includes('النيابة الجزائية'));
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons'), 3);
    assert.equal(count(db, `SELECT COUNT(*) AS c FROM detainees WHERE status = 'محتجز' AND release_date IS NULL`), 2);
    const d = one(db, `SELECT * FROM detainees WHERE reference_number = '2'`);
    assert.equal(d.exit_type, EXIT_TYPES[0]); assert.equal(d.exit_procedure, 'تم اطلاقة من قبل النيابة');
    assert.equal(d.exit_directive_source, 'عبدالله'); assert.equal(d.legal_status, 'محكوم');
    assert.equal(d.legacy_serial, '2'); assert.equal(d.period_no, 1); assert.equal(d.case_role, 'جاني');
    assert.equal(count(db, `SELECT COUNT(*) AS c FROM detainee_movements WHERE source = ?`, IMPORT_SOURCE), 4);
    assert.equal(count(db, `SELECT COUNT(*) AS c FROM detainee_movements WHERE movement_type = 'إفراج' AND detainee_id = ?`, d.id), 1);
    assert.equal(count(db, `SELECT COUNT(DISTINCT person_id) AS c FROM detainees`), 3);
    assert.equal(one(db, `SELECT detention_days AS c FROM v_detention_periods WHERE reference_number = '2'`).c, 10);
    assert.equal(count(db, `SELECT COUNT(*) AS c FROM detainees WHERE reference_number = '2/2'`), 1);
  });

  test('a second run is refused, collisions abort with nothing written', async () => {
    const db = await setup();
    await run(db, plan(rows()));
    await assert.rejects(() => run(db, plan(rows())), /IMPORT_ALREADY_DONE/);
    const db2 = await setup();
    await run(db2, plan([raw({ serial: '9' })]));
    await assert.rejects(() => run(db2, plan([raw({ serial: '9', name: 'x' })]), 'u1', { allowRerun: true }), /IMPORT_REFERENCE_COLLISION:9/);
    assert.equal(count(db2, 'SELECT COUNT(*) AS c FROM persons'), 1);
  });

  test('forbidden for a viewer and empty plan is refused; nothing written', async () => {
    const db = await setup();
    await assert.rejects(() => run(db, plan(rows()), 'u2'), /FORBIDDEN/);
    await assert.rejects(() => run(db, plan([])), /IMPORT_EMPTY/);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM persons'), 0);
  });

  test('atomic: a failure midway rolls everything back, categories included', async () => {
    const db = await setup();
    const before = count(db, 'SELECT COUNT(*) AS c FROM detainee_categories');
    let n = 0;
    const wrapped = {
      runAsync: async (sql: string, p?: unknown[]) => {
        if (sql.includes('INSERT INTO detainee_movements') && ++n === 3) throw new Error('boom');
        return db.runAsync(sql, p as never);
      },
      getAllAsync: (sql: string, p?: unknown[]) => db.getAllAsync(sql, p as never),
      getFirstAsync: (sql: string, p?: unknown[]) => db.getFirstAsync(sql, p as never),
      withTransactionAsync: (t: () => Promise<void>) => db.withTransactionAsync(t),
    };
    await assert.rejects(() => runImport(wrapped as never, 'u1', plan(rows()), { exitTypes: EXIT_TYPES, now: NOW }), /boom/);
    for (const t of ['persons', 'detainees', 'detainee_movements']) assert.equal(count(db, `SELECT COUNT(*) AS c FROM ${t}`), 0, t);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM detainee_categories'), before);
  });
});
