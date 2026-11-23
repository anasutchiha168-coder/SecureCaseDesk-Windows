// اختبارات المرحلة 9 / القسم 4 — الطباعة والتصدير والتكامل. تشغَّل بـ: npm run test:reports-export
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { NodeDb, MemoryStorage, nodeCrypto, uuid, PDF } from './helpers/node-env';
import { initAttachmentsSchema } from '../src/modules/attachments/attachments-schema';
import { initAuditSchema } from '../src/database/audit-schema';
import { addAttachment, deleteAttachment, type AttachmentDeps } from '../src/modules/attachments/attachments-repo';
import { buildReport } from '../src/modules/reports/reports-data';
import { renderReportDocx } from '../src/modules/reports/reports-docx';
import { renderReportHtml } from '../src/modules/reports/reports-html';
import {
  authorizeReportAction, verifyReportFile, verifyDocxPackage, assertReportPath, exportAuditEvent,
  ExportError, REPORT_MIME, REPORT_UTI,
} from '../src/modules/reports/reports-export-logic';
import { REPORT_CATALOG, getReportDefinition } from '../src/modules/reports/reports-types';
import { can } from '../src/security/permissions';
import { ForbiddenError, type Session } from '../src/security/guard';

const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const S = (userId: string, role: string): Session => ({ userId, role: role as Session['role'] });
const sess = { admin: S('u-admin', 'admin'), investigator: S('u-inv', 'investigator'), viewer: S('u-view', 'viewer'), detention_viewer: S('u-det', 'detention_viewer') };
const forbidden = (e: unknown) => e instanceof ForbiddenError;
const exp = (c: string) => (e: unknown) => e instanceof ExportError && e.code === c;

let db: NodeDb; let storage: MemoryStorage; let key: Uint8Array | null; let adeps: AttachmentDeps;

beforeEach(async () => {
  db = new NodeDb(); storage = new MemoryStorage(); key = null;
  await db.execAsync(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE cases (id TEXT PRIMARY KEY, case_number TEXT, title TEXT, complainant TEXT, suspects TEXT, case_type TEXT, department_id TEXT, officer_id TEXT,
      registration_date INTEGER, incident_location TEXT, incident_details TEXT, status TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE memo_types (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE memos (id TEXT PRIMARY KEY, memo_number TEXT, memo_type_id TEXT, memo_date INTEGER, recipient_organization TEXT, subject TEXT, body TEXT,
      linked_case_id TEXT, status TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE detainees (id TEXT PRIMARY KEY, full_name TEXT);
    INSERT INTO users VALUES ('u-admin','admin','admin',1),('u-inv','khaled','investigator',1),('u-view','viewer','viewer',1),('u-det','det','detention_viewer',1),('u-off','off','admin',0);
    ALTER TABLE users ADD COLUMN department_id TEXT;
    UPDATE users SET department_id = 'd1' WHERE id = 'u-inv';
    INSERT INTO departments VALUES ('d1','قسم مكافحة السرقات');
    INSERT INTO cases VALUES ('c1','2026/1','قضية سرقة','أ','ب','سرقة','d1','u-inv',${NOW},'حجة','تفاصيل','قيد التحقيق','u-admin',${NOW},${NOW});
  `);
  await initAttachmentsSchema(db as never);
  await initAuditSchema(db as never);
  adeps = {
    db, storage, crypto: nodeCrypto, uuid, now: () => NOW,
    async getMasterKey(allowCreate) { if (key) return key; if (!allowCreate) throw new Error('KEY'); key = new Uint8Array(randomBytes(32)); return key; },
  };
});

describe('صلاحيات المشاركة والطباعة', () => {
  for (const [role, s] of Object.entries(sess)) {
    for (const def of REPORT_CATALOG) {
      const allowed = can(role, def.permission);
      test(`${role} / ${def.kind} → ${allowed ? 'مسموح' : 'ممنوع'}`, async () => {
        const run = () => authorizeReportAction(db, s, def.kind);
        if (allowed) assert.equal((await run()).def.kind, def.kind); else await assert.rejects(run, forbidden);
      });
    }
  }
  test('تقارير القضايا والمذكرات ممنوعة على مشاهد المحتجزين صراحة', async () => {
    for (const k of ['case_file', 'cases_list', 'memos_list', 'correction_history', 'operations'])
      await assert.rejects(() => authorizeReportAction(db, sess.detention_viewer, k), forbidden, k);
  });
  test('حساب معطّل، دور مزوّر، بلا جلسة، نوع مجهول: كلها مرفوضة', async () => {
    await assert.rejects(() => authorizeReportAction(db, S('u-off', 'admin'), 'cases_list'), forbidden);
    await assert.rejects(() => authorizeReportAction(db, S('u-det', 'admin'), 'cases_list'), forbidden);
    await assert.rejects(() => authorizeReportAction(db, S('ghost', 'admin'), 'cases_list'), forbidden);
    await assert.rejects(() => authorizeReportAction(db, null, 'cases_list'), forbidden);
    await assert.rejects(() => authorizeReportAction(db, sess.admin, 'nope'));
  });
  test('سحب صلاحية المستخدم بعد إنشاء الملف يمنع المشاركة فوراً', async () => {
    await authorizeReportAction(db, sess.investigator, 'cases_list');
    await db.runAsync("UPDATE users SET role = 'detention_viewer' WHERE id = 'u-inv'");
    await assert.rejects(() => authorizeReportAction(db, sess.investigator, 'cases_list'), forbidden);
    await db.runAsync("UPDATE users SET is_active = 0 WHERE id = 'u-inv'");
    await assert.rejects(() => authorizeReportAction(db, S('u-inv', 'detention_viewer'), 'detainees_current'), forbidden);
  });
});

describe('سلامة الملفات قبل التصدير', () => {
  const mkPdf = () => { const b = new Uint8Array(900); b.set(new TextEncoder().encode('%PDF-1.4\n')); b.set(new TextEncoder().encode('\n%%EOF\n'), 880); return b; };

  test('PDF سليم يمر', () => { const b = mkPdf(); verifyReportFile(b, 'pdf', sha(b), sha); });
  test('PDF: رأس خاطئ، قطع في النهاية، صغير، أو بصمة مختلفة ← مرفوض', () => {
    const ok = mkPdf();
    const noHead = ok.slice(); noHead[0] = 0x58;
    const cut = ok.slice(0, 700);
    const flipped = ok.slice(); flipped[300] ^= 1;
    for (const [b, h] of [[noHead, sha(noHead)], [cut, sha(cut)], [new Uint8Array(100), sha(new Uint8Array(100))], [flipped, sha(ok)]] as [Uint8Array, string][])
      assert.throws(() => verifyReportFile(b, 'pdf', h, sha), exp('FILE_CORRUPT'));
  });
  test('DOCX حقيقي من المولّد يمر بفحص البنية والبصمة', async () => {
    const doc = await buildReport({ db, now: () => NOW }, sess.admin, 'cases_list');
    const b = renderReportDocx(doc);
    verifyDocxPackage(b); verifyReportFile(b, 'docx', sha(b), sha);
  });
  test('DOCX: تعديل بايت واحد داخل المحتوى يُكشف (CRC) حتى لو لم تُفحص البصمة', async () => {
    const b = renderReportDocx(await buildReport({ db, now: () => NOW }, sess.admin, 'cases_list'));
    const t = b.slice(); const i = new TextDecoder('latin1').decode(t).indexOf('<w:body>') + 20; t[i] ^= 0x01;
    assert.throws(() => verifyDocxPackage(t), exp('FILE_CORRUPT'));
    assert.throws(() => verifyReportFile(t, 'docx', sha(b), sha), exp('FILE_CORRUPT'));
  });
  test('DOCX: ملف مقطوع أو ليس ZIP أو ينقصه الجزء الأساسي ← مرفوض', async () => {
    const b = renderReportDocx(await buildReport({ db, now: () => NOW }, sess.admin, 'cases_list'));
    assert.throws(() => verifyDocxPackage(b.slice(0, b.length - 30)), exp('FILE_CORRUPT'));
    assert.throws(() => verifyDocxPackage(new TextEncoder().encode('x'.repeat(600))), exp('FILE_CORRUPT'));
    const { buildZip } = await import('../src/modules/reports/reports-zip');
    const noDoc = buildZip([1, 2, 3, 4, 5].map((n) => ({ name: 'f' + n + '.xml', data: '<a/>' })));
    assert.throws(() => verifyDocxPackage(noDoc), exp('FILE_CORRUPT'));
  });
  test('مسار الملف: يقبل مجلد reports فقط وبامتداد pdf/docx', () => {
    assert.equal(assertReportPath('file:///data/cache/reports/سجل_20261120.pdf'), 'pdf');
    assert.equal(assertReportPath('file:///data/cache/reports/a.DOCX'), 'docx');
    for (const p of ['file:///data/attachments/x.enc', 'file:///data/cache/reports/../secret.pdf', 'file:///data/cache/reports/a.exe', 'file:///data/cache/a.pdf', 'file:///data/cache/reports/sub/../a.pdf'])
      assert.throws(() => assertReportPath(p), exp('NOT_REPORT_FILE'), p);
  });
  test('أنواع MIME وUTI صحيحة', () => {
    assert.equal(REPORT_MIME.pdf, 'application/pdf');
    assert.match(REPORT_MIME.docx, /wordprocessingml\.document$/);
    assert.equal(REPORT_UTI.pdf, 'com.adobe.pdf');
  });
});

describe('حدث التدقيق', () => {
  test('بيانات وصفية فقط بلا محتوى تقرير ولا أسماء', async () => {
    const def = getReportDefinition('case_file')!;
    const ev = exportAuditEvent('share', def, { format: 'pdf', documentNumber: 'SCD-1', sizeBytes: 1234, sha256: 'ab'.repeat(32) });
    assert.equal(ev.operationType, 'report_share'); assert.equal(ev.entityType, 'report');
    const txt = JSON.stringify(ev); assert.ok(!/khaled|قضية سرقة|2026\/1/.test(txt));
    assert.equal(exportAuditEvent('print', def, { format: 'html', documentNumber: 'SCD-2' }).operationType, 'report_print');
  });
});

describe('تكامل المرفقات والتقارير والتصدير', () => {
  const caseAtt = async (name: string) => addAttachment(adeps, sess.investigator, 'case', 'c1', { name, bytes: PDF('محتوى ' + name) });

  test('المرفق المضاف يظهر في تقرير القضية (HTML وDOCX) بحجمه وبصمته', async () => {
    const info = await caseAtt('محضر-الضبط.pdf');
    const doc = await buildReport({ db, now: () => NOW }, sess.investigator, 'case_file', { caseId: 'c1' });
    assert.ok(JSON.stringify(doc).includes('محضر-الضبط.pdf') && JSON.stringify(doc).includes(info.sha256_plain.slice(0, 16)));
    assert.ok(renderReportHtml(doc).includes('محضر-الضبط.pdf'));
    assert.ok(Buffer.from(renderReportDocx(doc)).toString('utf8').includes('محضر-الضبط.pdf'));
  });
  test('حذف المرفق (منطقي) يخرجه من التقرير ويبقي سجله في الجدول', async () => {
    const info = await caseAtt('سيُحذف.pdf');
    await deleteAttachment(adeps, sess.admin, info.id, 'تم رفعه بالخطأ');
    const txt = JSON.stringify(await buildReport({ db, now: () => NOW }, sess.admin, 'case_file', { caseId: 'c1' }));
    assert.ok(!txt.includes('سيُحذف.pdf'));
    assert.equal((await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM attachments WHERE status='deleted'"))!.n, 1);
  });
  test('التقرير لا يكشف محتوى الملف المشفر ولا اسم التخزين', async () => {
    await caseAtt('سري.pdf');
    const row = await db.getFirstAsync<{ storage_name: string }>('SELECT storage_name FROM attachments');
    const txt = JSON.stringify(await buildReport({ db, now: () => NOW }, sess.admin, 'case_file', { caseId: 'c1' }));
    assert.ok(!txt.includes(row!.storage_name) && !txt.includes('محتوى سري.pdf'));
  });
  test('مشاهد المحتجزين لا يصل لتقرير القضية ولا لتصديره مهما وُجدت مرفقات', async () => {
    await caseAtt('x.pdf');
    await assert.rejects(() => buildReport({ db, now: () => NOW }, sess.detention_viewer, 'case_file', { caseId: 'c1' }), forbidden);
    await assert.rejects(() => authorizeReportAction(db, sess.detention_viewer, 'case_file'), forbidden);
  });
  test('إنشاء التقرير وتصديره لا يعدّل جداول القضايا والمرفقات', async () => {
    await caseAtt('y.pdf');
    const snap = async () => JSON.stringify([await db.getAllAsync('SELECT * FROM cases'), await db.getAllAsync('SELECT id,status,sha256_plain FROM attachments')]);
    const before = await snap();
    const doc = await buildReport({ db, now: () => NOW }, sess.admin, 'case_file', { caseId: 'c1' });
    renderReportDocx(doc); renderReportHtml(doc);
    assert.equal(await snap(), before);
  });
});
