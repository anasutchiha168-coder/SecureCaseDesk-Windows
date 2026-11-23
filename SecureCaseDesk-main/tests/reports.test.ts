// اختبارات المرحلة 9 / القسم 3 — التقارير والمستندات. تشغَّل بـ: npm run test:reports
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { NodeDb } from './helpers/node-env';
import { buildReport, type ReportDeps } from '../src/modules/reports/reports-data';
import { renderReportHtml } from '../src/modules/reports/reports-html';
import { renderReportDocx } from '../src/modules/reports/reports-docx';
import { buildZip, crc32 } from '../src/modules/reports/reports-zip';
import { REPORT_CATALOG, ReportError, type ReportDocument } from '../src/modules/reports/reports-types';
import { durationDays, escapeXml, fmtDate, safeFileName, parseDateInput } from '../src/modules/reports/reports-format';
import { ForbiddenError, type Session } from '../src/security/guard';

const DAY = 86400000;
const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();
const at = (daysAgo: number) => NOW - daysAgo * DAY;
const forbidden = (e: unknown) => e instanceof ForbiddenError;
const rcode = (c: string) => (e: unknown) => e instanceof ReportError && e.code === c;

let db: NodeDb; let deps: ReportDeps;
const S = (userId: string, role: string): Session => ({ userId, role: role as Session['role'] });
const admin = S('u-admin', 'admin'), inv = S('u-inv', 'investigator'), view = S('u-view', 'viewer'), det = S('u-det', 'detention_viewer'), off = S('u-off', 'admin');

beforeEach(async () => {
  db = new NodeDb();
  deps = { db, now: () => NOW };
  await db.execAsync(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE cases (id TEXT PRIMARY KEY, case_number TEXT, title TEXT, complainant TEXT, suspects TEXT, case_type TEXT, department_id TEXT, officer_id TEXT,
      registration_date INTEGER, incident_location TEXT, incident_details TEXT, status TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE memo_types (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE memos (id TEXT PRIMARY KEY, memo_number TEXT, memo_type_id TEXT, memo_date INTEGER, recipient_organization TEXT, subject TEXT, body TEXT,
      linked_case_id TEXT, status TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE detainee_categories (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE detainees (id TEXT PRIMARY KEY, reference_number TEXT, full_name TEXT, category_id TEXT, admission_date INTEGER, release_date INTEGER,
      alleged_offense TEXT, offense_details TEXT, detaining_authority TEXT, officer_id TEXT, status TEXT, notes TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE detainee_movements (id TEXT PRIMARY KEY, movement_number TEXT, detainee_id TEXT, movement_type TEXT, movement_date INTEGER, previous_authority TEXT,
      new_authority TEXT, executed_by TEXT, reason TEXT, source TEXT, related_movement_id TEXT, created_at INTEGER);
    CREATE TABLE correction_history (id TEXT PRIMARY KEY, detainee_id TEXT, field_name TEXT, previous_value TEXT, new_value TEXT, reason TEXT, executed_by TEXT,
      related_movement_id TEXT, created_at INTEGER);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, original_name TEXT, extension TEXT, size_bytes INTEGER, sha256_plain TEXT,
      status TEXT, created_at INTEGER);
    CREATE TABLE audit_logs (sequence_no INTEGER PRIMARY KEY, username TEXT, operation_type TEXT, entity_type TEXT, previous_values TEXT, new_values TEXT, created_at INTEGER);

    INSERT INTO users VALUES ('u-admin','admin','admin',1),('u-inv','khaled','investigator',1),('u-view','viewer','viewer',1),('u-det','det','detention_viewer',1),('u-off','off','admin',0);
    ALTER TABLE users ADD COLUMN department_id TEXT;
    UPDATE users SET department_id = 'd2' WHERE id = 'u-inv';
    INSERT INTO departments VALUES ('d1','قسم الجرائم الإلكترونية'),('d2','قسم مكافحة السرقات');
    INSERT INTO cases VALUES
      ('c1','2026/1','قضية سرقة <b>منزل</b>','المشتكي أ','متهم ب','سرقة','d2','u-inv',${at(10)},'حجة','تفاصيل الحادثة الكاملة','قيد التحقيق','u-admin',${at(10)},${at(2)}),
      ('c2','2026/2','قضية احتيال','المشتكي ج','متهم د','احتيال','d1','u-inv',${at(40)},'حجة','—','مغلقة','u-admin',${at(40)},${at(30)}),
      ('c3','2026/3','قضية قديمة','x','y','اعتداء','d1','u-inv',${at(400)},'حجة','—','جديدة','u-admin',${at(400)},${at(400)});
    INSERT INTO memo_types VALUES ('t1','مذكرة إلى النيابة'),('t2','أوامر وتكليفات');
    INSERT INTO memos VALUES ('m1','م-1','t1',${at(5)},'النيابة','طلب إجراء','نص','c1','مسودة','u-admin',${at(5)},${at(5)}),
                             ('m2','م-2','t2',${at(3)},'القسم','تكليف','نص',NULL,'معتمدة','u-admin',${at(3)},${at(3)});
    INSERT INTO detainee_categories VALUES ('k1','النيابة الجزائية'),('k2','الاستخبارات الشرطية');
    INSERT INTO detainees VALUES
      ('p1','R-1','محتجز أول','k1',${at(45)},NULL,'سرقة','','أمن المديرية','u-inv','محتجز','',  'u-admin',${at(45)},${at(45)}),
      ('p2','R-2','محتجز ثان','k2',${at(5)},NULL,'احتيال','','النيابة','u-inv','محتجز','','u-admin',${at(5)},${at(5)}),
      ('p3','R-3','مفرج عنه','k1',${at(20)},${at(10)},'اعتداء','','أمن المديرية','u-inv','مفرج عنه','','u-admin',${at(20)},${at(10)});
    INSERT INTO detainee_movements VALUES
      ('mv1','MV-1','p1','إيداع',${at(45)},NULL,'أمن المديرية','u-admin','إيداع أولي','application',NULL,${at(45)}),
      ('mv2','MV-2','p3','إفراج',${at(10)},'أمن المديرية',NULL,'u-admin','انتهاء المدة','application',NULL,${at(10)}),
      ('mv3','MV-3','p3','تصحيح',${at(9)},NULL,NULL,'u-admin','تصحيح تاريخ','application','mv2',${at(9)});
    INSERT INTO correction_history VALUES ('h1','p3','release_date','2026-01-01','2026-01-02','خطأ إدخال','u-admin','mv3',${at(9)});
    INSERT INTO attachments VALUES ('a1','case','c1','محضر.pdf','pdf',2048,'${'ab'.repeat(32)}','active',${at(1)}),
                                   ('a2','case','c1','محذوف.pdf','pdf',100,'${'cd'.repeat(32)}','deleted',${at(1)});
    INSERT INTO audit_logs VALUES (1,'admin','create','cases','{"secret":"S1"}','{"secret":"S2"}',${at(2)}),(2,'khaled','update','cases','{"secret":"S3"}',NULL,${at(1)});
  `);
});

const REQUIRED: Record<string, string[]> = {
  admin: REPORT_CATALOG.map((r) => r.kind),
  investigator: ['case_file', 'cases_list', 'memos_list', 'detainees_current', 'detainees_admissions_releases', 'detainees_stats', 'detainee_movements', 'admin_summary'],
  viewer: ['case_file', 'cases_list', 'memos_list', 'detainees_current', 'detainees_admissions_releases', 'detainees_stats', 'detainee_movements', 'admin_summary'],
  detention_viewer: ['detainees_current', 'detainees_admissions_releases', 'detainees_stats', 'detainee_movements', 'admin_summary'],
};

describe('الصلاحيات', () => {
  const sessions: Record<string, Session> = { admin, investigator: inv, viewer: view, detention_viewer: det };
  for (const [role, sess] of Object.entries(sessions)) {
    for (const def of REPORT_CATALOG) {
      const allowed = REQUIRED[role].includes(def.kind);
      test(`${role} / ${def.kind} → ${allowed ? 'مسموح' : 'ممنوع'}`, async () => {
        const run = () => buildReport(deps, sess, def.kind, { caseId: 'c1' });
        if (allowed) { const d = await run(); assert.equal(d.kind, def.kind); } else await assert.rejects(run, forbidden);
      });
    }
  }
  test('حساب معطّل مرفوض حتى بجلسة مدير', async () => { await assert.rejects(() => buildReport(deps, off, 'cases_list'), forbidden); });
  test('جلسة بدور مزوّر (غير موجودة في القاعدة) مرفوضة', async () => { await assert.rejects(() => buildReport(deps, S('ghost', 'admin'), 'cases_list'), forbidden); });
  test('جلسة بدور أعلى من دور القاعدة مرفوضة (فحص مزدوج)', async () => { await assert.rejects(() => buildReport(deps, S('u-det', 'admin'), 'cases_list'), forbidden); });
  test('بلا جلسة مرفوض', async () => { await assert.rejects(() => buildReport(deps, null, 'cases_list'), forbidden); });
  test('مشاهد المحتجزين: التقرير الإداري لا يتضمن أقسام القضايا والمذكرات', async () => {
    const d = await buildReport(deps, det, 'admin_summary');
    const heads = d.sections.map((s) => s.heading);
    assert.ok(heads.includes('المحتجزون'));
    assert.ok(!heads.includes('القضايا') && !heads.includes('المذكرات') && !heads.includes('المستخدمون'));
    assert.ok(!JSON.stringify(d).includes('قضية'));
  });
  test('نوع تقرير غير معروف', async () => { await assert.rejects(() => buildReport(deps, admin, 'nope'), rcode('INVALID_KIND')); });
});

describe('صحة البيانات', () => {
  test('تقرير قضية: البيانات والمذكرات والمرفقات النشطة فقط', async () => {
    const d = await buildReport(deps, inv, 'case_file', { caseId: 'c1' });
    const txt = JSON.stringify(d);
    assert.ok(txt.includes('2026/1') && txt.includes('قسم مكافحة السرقات') && txt.includes('khaled'));
    assert.ok(txt.includes('م-1') && !txt.includes('م-2'));
    assert.ok(txt.includes('محضر.pdf') && !txt.includes('محذوف.pdf'));
    assert.ok(txt.includes('abababababababab'));
    assert.ok(!txt.includes('abababababababababab'), 'البصمة مختصرة');
  });
  test('تقرير قضية بلا معرّف أو بمعرّف غير موجود', async () => {
    await assert.rejects(() => buildReport(deps, admin, 'case_file', {}), rcode('CASE_REQUIRED'));
    await assert.rejects(() => buildReport(deps, admin, 'case_file', { caseId: 'zzz' }), rcode('NOT_FOUND'));
  });
  test('سجل القضايا: تصفية بالحالة والفترة والقسم', async () => {
    assert.equal((await buildReport(deps, admin, 'cases_list')).rowCount, 3);
    assert.equal((await buildReport(deps, admin, 'cases_list', { status: 'مغلقة' })).rowCount, 1);
    assert.equal((await buildReport(deps, admin, 'cases_list', { dateFrom: at(60), dateTo: NOW })).rowCount, 2);
    assert.equal((await buildReport(deps, admin, 'cases_list', { departmentId: 'd1' })).rowCount, 2);
  });
  test('فترة معكوسة ترفض', async () => {
    await assert.rejects(() => buildReport(deps, admin, 'cases_list', { dateFrom: NOW, dateTo: at(10) }), rcode('INVALID_RANGE'));
  });
  test('سجل المذكرات: عدد وتجميع حسب النوع', async () => {
    const d = await buildReport(deps, admin, 'memos_list');
    assert.equal(d.rowCount, 2);
    assert.ok(JSON.stringify(d).includes('مذكرة إلى النيابة'));
  });
  test('المحتجزون الحاليون: المدة بالأيام وعدم تضمين المفرج عنه', async () => {
    const d = await buildReport(deps, det, 'detainees_current');
    const t = d.sections[1]; assert.equal(t.type, 'table');
    if (t.type === 'table') {
      assert.equal(t.rows.length, 2);
      const m = Object.fromEntries(t.rows.map((r) => [r[0], r[6]]));
      assert.equal(m['R-1'], '45'); assert.equal(m['R-2'], '5');
      assert.ok(!t.rows.some((r) => r[0] === 'R-3'));
    }
  });
  test('الإيداع والإفراج: مدة المفرج عنه تُحسب حتى تاريخ الإفراج لا حتى اليوم', async () => {
    const d = await buildReport(deps, det, 'detainees_admissions_releases');
    const rel = d.sections[2];
    if (rel.type === 'table') { assert.equal(rel.rows.length, 1); assert.equal(rel.rows[0][4], '10'); } else assert.fail();
  });
  test('إحصاءات المحتجزين: متوسط، أطول مدة، المتجاوزون للحد', async () => {
    const d = await buildReport(deps, det, 'detainees_stats', { thresholdDays: 30 });
    const kv = d.sections[0]; if (kv.type !== 'kv') return assert.fail();
    const g = (l: string) => kv.rows.find((r) => r.label === l)?.value;
    assert.equal(g('المحتجزون الحاليون'), '2'); assert.equal(g('متوسط مدة الاحتجاز الحالية (يوم)'), '25');
    assert.equal(g('أطول مدة حالية (يوم)'), '45'); assert.equal(g('تجاوزوا 30 يوماً'), '1');
  });
  test('سجل الحركات يبقي الحركة التصحيحية مرتبطة بالأصل', async () => {
    const d = await buildReport(deps, det, 'detainee_movements');
    assert.equal(d.rowCount, 3);
    const t = d.sections[2]; if (t.type === 'table') assert.ok(t.rows.some((r) => r[0] === 'MV-3' && r[8] === 'MV-2')); else assert.fail();
  });
  test('سجل التصحيحات يحفظ القيمة السابقة والجديدة', async () => {
    const d = await buildReport(deps, admin, 'correction_history'); const txt = JSON.stringify(d);
    assert.ok(txt.includes('2026-01-01') && txt.includes('2026-01-02') && txt.includes('خطأ إدخال'));
  });
  test('تقرير العمليات لا يسرّب قيم previous/new', async () => {
    const d = await buildReport(deps, admin, 'operations'); const txt = JSON.stringify(d);
    assert.equal(d.rowCount, 2); assert.ok(!/S1|S2|S3|secret/.test(txt));
  });
  test('التقرير الإداري الكامل للمدير يشمل أداء الأقسام', async () => {
    const txt = JSON.stringify(await buildReport(deps, admin, 'admin_summary'));
    assert.ok(txt.includes('أداء الأقسام') && txt.includes('المستخدمون'));
  });
  test('حد الحجم: تجاوز 5000 سجل يرفض بدل تقرير ناقص', async () => {
    await db.execAsync(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 5100)
      INSERT INTO cases SELECT 'x'||i,'X/'||i,'t','','','سرقة','d1','u-inv',${at(1)},'','','جديدة','u-admin',${at(1)},${at(1)} FROM n;`);
    await assert.rejects(() => buildReport(deps, admin, 'cases_list'), rcode('TOO_LARGE'));
  });
  test('حقل documentNumber وcreatedBy من القاعدة لا من الجلسة', async () => {
    const d = await buildReport(deps, inv, 'cases_list'); assert.equal(d.createdBy, 'khaled'); assert.match(d.documentNumber, /^SCD-20261120-[0-9A-Z]{4}-[A-Z]{2}$/);
  });
});

describe('HTML / PDF', () => {
  test('اتجاه RTL ولغة عربية والترويسة الرسمية وخانات التوقيع', async () => {
    const html = renderReportHtml(await buildReport(deps, admin, 'cases_list'));
    assert.ok(html.includes('<html lang="ar" dir="rtl">') && html.includes('direction: rtl'));
    for (const t of ['وزارة الداخلية', 'إدارة المباحث الجنائية', 'م/ حجة', 'التوقيع', 'الاعتماد', 'الختم الرسمي', 'رقم المستند', 'counter(page)']) assert.ok(html.includes(t), t);
  });
  test('هروب HTML: لا يُنفَّذ أي وسم داخل البيانات', async () => {
    const html = renderReportHtml(await buildReport(deps, admin, 'cases_list'));
    assert.ok(html.includes('&lt;b&gt;منزل&lt;/b&gt;') && !html.includes('<b>منزل</b>'));
  });
  test('كل الأنواع تنتج HTML بلا الكلمة undefined أو null', async () => {
    for (const def of REPORT_CATALOG) {
      const html = renderReportHtml(await buildReport(deps, admin, def.kind, { caseId: 'c1' }));
      assert.ok(!/undefined|\bnull\b|NaN/.test(html), def.kind);
    }
  });
});

describe('ZIP / DOCX', () => {
  test('CRC32 يطابق zlib', () => {
    for (const s of ['', 'a', 'مرحبا بالعالم', 'x'.repeat(100000)]) {
      const b = new TextEncoder().encode(s); assert.equal(crc32(b), zlibCrc32(b));
    }
  });
  test('بنية ZIP: ترويسة محلية وسجل مركزي ونهاية صحيحة وعدد الإدخالات', () => {
    const z = buildZip([{ name: 'a.txt', data: 'hello' }, { name: 'b/ب.txt', data: 'مرحبا' }]);
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
    assert.equal(v.getUint32(0, true), 0x04034b50);
    assert.equal(v.getUint32(z.length - 22, true), 0x06054b50);
    assert.equal(v.getUint16(z.length - 22 + 10, true), 2);
  });
  test('DOCX: الأجزاء المطلوبة وRTL والعربية وحقول الترقيم', async () => {
    const z = Buffer.from(renderReportDocx(await buildReport(deps, admin, 'cases_list'))).toString('utf8');
    for (const t of ['[Content_Types].xml', 'word/document.xml', 'word/footer1.xml', 'word/styles.xml', '<w:bidi/>', '<w:rtl/>', '<w:bidiVisual/>', 'PAGE', 'NUMPAGES',
      'وزارة الداخلية', 'إدارة المباحث الجنائية', 'م/ حجة', 'الختم الرسمي', 'قسم مكافحة السرقات']) assert.ok(z.includes(t), t);
  });
  test('DOCX: نص ضار يُهرَّب وأحرف التحكم تُحذف', async () => {
    assert.equal(escapeXml('a\u0000b<c>&"\''), 'ab&lt;c&gt;&amp;&quot;&apos;');
    const z = Buffer.from(renderReportDocx(await buildReport(deps, admin, 'cases_list'))).toString('utf8');
    assert.ok(z.includes('&lt;b&gt;منزل&lt;/b&gt;') && !z.includes('<b>منزل'));
  });
  test('DOCX: تقرير عريض (7 أعمدة فأكثر) يُنشأ بوضع أفقي', async () => {
    const z = Buffer.from(renderReportDocx(await buildReport(deps, admin, 'cases_list'))).toString('utf8');
    assert.ok(z.includes('w:orient="landscape"'));
  });
  test('إنشاء كل الأنواع بصيغة DOCX وحفظها لفحصها خارجياً', async () => {
    mkdirSync('/tmp/scd-reports', { recursive: true });
    for (const def of REPORT_CATALOG) {
      const bytes = renderReportDocx(await buildReport(deps, admin, def.kind, { caseId: 'c1' }));
      assert.ok(bytes.length > 1500, def.kind);
      writeFileSync('/tmp/scd-reports/' + def.kind + '.docx', bytes);
      writeFileSync('/tmp/scd-reports/' + def.kind + '.html', renderReportHtml(await buildReport(deps, admin, def.kind, { caseId: 'c1' })));
    }
  });
});

describe('أدوات مساعدة', () => {
  test('قراءة التاريخ المُدخل (أرقام عربية ولاتينية، رفض القيم الخاطئة)', () => {
    assert.equal(fmtDate(parseDateInput('2026-11-05')), '2026-11-05');
    assert.equal(fmtDate(parseDateInput('٢٠٢٦-١١-٠٥')), '2026-11-05');
    assert.equal(parseDateInput(''), undefined);
    assert.equal(parseDateInput('2026-02-30'), null);
    assert.equal(parseDateInput('غير تاريخ'), null);
  });
  test('مدة الاحتجاز لا تكون سالبة', () => { assert.equal(durationDays(NOW, null, NOW - DAY), 0); });
  test('اسم الملف آمن (بلا مسارات أو رموز)', () => {
    const n = safeFileName('../../etc/passwd: سجل القضايا', NOW); assert.ok(!/[\/\\:.]/.test(n)); assert.ok(n.includes('سجل_القضايا'));
  });
  test('تنسيق التاريخ', () => { assert.equal(fmtDate(NOW), '2026-11-20'); assert.equal(fmtDate(null), '—'); });
  test('الوثيقة لا تتغير بنوع ReportDocument (فحص شكل)', async () => {
    const d: ReportDocument = await buildReport(deps, admin, 'cases_list'); assert.ok(d.createdAt === NOW && d.sections.length > 0);
  });
});
