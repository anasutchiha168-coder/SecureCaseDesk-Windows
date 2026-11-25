// SECURECASEDESK_REGISTER_EXPORT — اختبارات تصدير معلومية السجناء (Excel) وكشف المحتجزين (PDF/HTML).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDb } from './helpers/node-env';
import { initPersonsSchema } from '../src/database/persons-schema';
import { initAuditSchema } from '../src/database/audit-schema';
import { initSyncSchema } from '../src/database/sync-schema';
import { planImport, runImport, type RawRow } from '../src/modules/detainees/excel-import';
import {
  loadRegisterRows, buildDayRegister, movementsOfDay, fmtHijriYmd, fmtDMY, excelSerial, calendarDays, type RegisterRow,
} from '../src/modules/detainees/register-data';
import { renderRegisterXlsx, REGISTER_HEADERS, REGISTER_SHEETS } from '../src/modules/detainees/register-xlsx';
import { renderRegisterHtml, registerPdfCells, REGISTER_PDF_COLUMNS, registerPdfPageCount } from '../src/modules/detainees/register-html';
import { verifyXlsxPackage } from '../src/modules/reports/reports-export-logic';

const NOW = new Date(2026, 10, 23, 12, 0, 0).getTime();
const EXIT_TYPES = ['تم الافراج عنه', 'تم نقله على القضاء الى سجن اخر', 'تم تسليمه لجهات أخرى'];

function baseSchemaBlocks(): string[] {
  const src = readFileSync(join(process.cwd(), 'src/database/db.ts'), 'utf8');
  const start = src.indexOf('export async function initDatabase()');
  const end = src.indexOf('await initCaseHistorySchema(database);');
  return [...src.slice(start, end).matchAll(/execAsync\(`([\s\S]*?)`\)/g)].map((m) => m[1]);
}
async function setup() {
  const db = new NodeDb();
  db.raw.exec('PRAGMA foreign_keys = ON;');
  for (const b of baseSchemaBlocks()) db.raw.exec(b);
  db.raw.exec(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','admin','x','admin',1)`);
  await initPersonsSchema(db as never); await initAuditSchema(db as never); await initSyncSchema(db as never);
  return db;
}
const raw = (over: Partial<RawRow>): RawRow => ({
  excelRow: 3, serial: '1', name: 'اسم', age: '30', idType: null, idNumber: null, phone: null, governorate: 'حجة', district: 'كشر',
  subDistrict: null, residence: 'بيت', occupation: 'عامل', offense: 'سرقة', caseRole: 'جاني', reportNo: '5', depositAuthority: 'الجزائية',
  admission: '2026-11-01', legalStatus: 'على ذمة النيابة', referralDate: '2026-11-05', place: 'الحجز الاحتياطي', release: null, exitType: null,
  exitProcedure: null, exitSource: null, fate: 'سجين', notes: null, ...over,
});

async function seeded() {
  const db = await setup();
  const rows = [
    raw({ excelRow: 3, name: 'سليم علي حسين جيلان', admission: '2019-07-03' }),
    raw({ excelRow: 4, name: 'مراد يحيى علي صالح', admission: '2026-11-10', depositAuthority: 'البحث الجنائي', legalStatus: 'رهن جمع الاستدلالات' }),
    raw({ excelRow: 5, name: 'خارج اليوم', admission: '2026-11-17', release: '2026-11-23', exitType: 'تم الافراج عنه', exitProcedure: 'بتوجيه من المدير', fate: 'خروج', depositAuthority: 'البحث الجنائي' }),
    raw({ excelRow: 6, name: 'خرج قبل أسبوع', admission: '2026-11-01', release: '2026-11-16', exitType: 'تم الافراج عنه', fate: 'خروج' }),
    raw({ excelRow: 7, name: 'دخل اليوم', admission: '2026-11-23', depositAuthority: 'البحث الجنائي', legalStatus: 'على ذمة المحكمة' }),
  ];
  const plan = planImport(rows, { now: NOW });
  await runImport(db as never, 'u1', plan, { exitTypes: EXIT_TYPES, now: NOW });
  return db;
}

describe('hijri / dates', () => {
  test('الإثنين 2026-11-23 يوافق 1448/06/13 (كما في النموذج المعتمد)', () => {
    assert.equal(fmtHijriYmd(new Date(2026, 10, 23, 12).getTime()), '1448/06/13');
  });
  test('تنسيق التاريخ وأيام الحجز والرقم التسلسلي', () => {
    assert.equal(fmtDMY(new Date(2019, 6, 3, 12).getTime()), '03/07/2019');
    assert.equal(calendarDays(new Date(2026, 10, 17, 9).getTime(), new Date(2026, 10, 23, 1).getTime()), 6);
    assert.equal(excelSerial(new Date(2026, 10, 23, 12).getTime()), 46349);
  });
});

describe('register data', () => {
  test('تحمّل كل الفترات بأعمدتها ومصير مشتق', async () => {
    const db = await seeded();
    const rows = await loadRegisterRows(db as never, NOW);
    assert.equal(rows.length, 5);
    const held = rows.filter((r) => r.fate === 'سجين').length;
    assert.equal(held, 3);
    const out = rows.find((r) => r.name === 'خارج اليوم')!;
    assert.equal(out.fate, 'خروج'); assert.equal(out.exitType, EXIT_TYPES[0]); assert.equal(out.days, 6);
    assert.equal(out.reportNumber, '5'); assert.equal(out.authority.includes('البحث'), true);
  });
  test('كشف اليوم: العدد السابق + الدخول - الخروج = المتبقي', async () => {
    const db = await seeded();
    const rows = await loadRegisterRows(db as never, NOW);
    const reg = buildDayRegister(rows, NOW);
    const s = reg.summary;
    assert.equal(s.entries, 1); assert.equal(s.exits, 1);
    assert.equal(s.previous + s.entries - s.exits, s.remaining);
    assert.equal(s.remaining, 3);
    assert.equal(reg.total, 4); // 3 متبقون + 1 خرج في اليوم
    assert.equal(movementsOfDay(rows, NOW).length, 2);
    assert.ok(!reg.groups.flatMap((g) => g.rows).some((r) => r.name === 'خرج قبل أسبوع'));
  });
});

describe('Excel export', () => {
  test('حزمة سليمة بخمس أوراق وترويسة 26 عموداً ومعادلات حيّة', async () => {
    const db = await seeded();
    const rows = await loadRegisterRows(db as never, NOW);
    const bytes = renderRegisterXlsx({ rows, day: NOW, createdAt: NOW });
    verifyXlsxPackage(bytes);
    assert.equal(REGISTER_HEADERS.length, 26);
    const text = Buffer.from(bytes).toString('latin1');
    // الحزمة STORED: أسماء الأجزاء مقروءة.
    for (let i = 1; i <= 5; i++) assert.ok(text.includes('xl/worksheets/sheet' + i + '.xml'));
    const utf = Buffer.from(bytes).toString('utf8');
    for (const n of Object.values(REGISTER_SHEETS)) assert.ok(utf.includes(n), n);
    assert.ok(utf.includes('COUNTIF($X:$X,&quot;سجين&quot;)') || utf.includes('COUNTIF($X:$X,"سجين")'));
    assert.ok(utf.includes('rightToLeft="1"'));
  });
});

describe('PDF (HTML) export', () => {
  const mk = (n: number, auth = 'الجزائية'): RegisterRow => ({
    serial: n, name: 'اسم ' + n, age: '30', idType: '', idNumber: '', phone: '', governorate: 'حجة', district: 'كشر', subDistrict: 'عزلة', residence: 'بيت',
    occupation: 'عامل', offense: 'سرقة', caseRole: '', reportNumber: '', authority: auth, admission: new Date(2026, 9, n, 9).getTime(), legalStatus: 'على ذمة النيابة',
    referral: null, place: '', exitDate: null, exitType: '', exitProcedure: '', exitSource: '', fate: 'سجين', notes: '', days: 3, classification: 'جرائم المال',
  });
  test('17 عموداً بترتيب النموذج و10 صفوف في الصفحة وصفحة إحصاء أخيرة', () => {
    assert.equal(REGISTER_PDF_COLUMNS.length, 17);
    assert.equal(registerPdfCells(mk(1), 1).length, 17);
    const rows = Array.from({ length: 16 }, (_, i) => mk(i + 1));
    const reg = buildDayRegister(rows, new Date(2026, 10, 23, 12).getTime());
    const html = renderRegisterHtml(reg);
    assert.equal((html.match(/class="page"/g) ?? []).length, registerPdfPageCount(reg));
    assert.equal(registerPdfPageCount(reg), 3); // صفحتا جدول (10 + 6) + إحصاء
    assert.ok(html.includes('صفحة 1 من 3') && html.includes('صفحة 3 من 3'));
    assert.ok(html.includes('ليوم الإثنين الموافق 1448/06/13'));
    assert.ok(html.includes('قســـم / إدارة ( الجزائية )'));
    assert.ok(html.includes('data:image/jpeg;base64,'));
    assert.equal((html.match(/<tr><td>/g) ?? []).length, 16);
  });
  test('كل جهة إيداع في قسم وصفحات مستقلة', () => {
    const rows = [mk(1, 'الجزائية'), mk(2, 'البحث الجنائي'), mk(3, 'الجزائية')];
    const reg = buildDayRegister(rows, new Date(2026, 10, 23, 12).getTime());
    assert.equal(reg.groups.length, 2);
    assert.equal(registerPdfPageCount(reg), 3);
  });
  test('إخراج النصوص الخطرة (HTML/اتجاه) يُهرَّب', () => {
    const r = mk(1); r.name = '<script>x</script>‮abc';
    const html = renderRegisterHtml(buildDayRegister([r], new Date(2026, 10, 23, 12).getTime()));
    assert.ok(!html.includes('<script>x') && !html.includes('‮'));
  });
});
