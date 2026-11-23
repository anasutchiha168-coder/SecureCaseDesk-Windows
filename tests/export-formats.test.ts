// اختبارات صيغ التصدير الجديدة (Excel/TXT) وخطاب المذكرة. تشغَّل بـ: npm run test:export-formats
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderReportXlsx } from '../src/modules/reports/reports-xlsx';
import { renderReportTxt } from '../src/modules/reports/reports-txt';
import { verifyReportFile, verifyXlsxPackage, assertReportPath, REPORT_MIME, ExportError } from '../src/modules/reports/reports-export-logic';
import { renderMemoHtml, memoPdfFileName } from '../src/modules/memos/memo-document';
import { AttachmentError } from '../src/modules/attachments/attachments-types';
import { friendlyAttachmentError } from '../src/modules/attachments/attachments-ui-logic';
import type { ReportDocument } from '../src/modules/reports/reports-types';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const doc: ReportDocument = {
  kind: 'cases_list', title: 'سجل القضايا', documentNumber: 'SCD-20261122-AB12-CA', createdAt: new Date(2026, 10, 22, 9, 0).getTime(),
  createdBy: 'admin', filtersText: 'كل الفترات', rowCount: 2,
  sections: [
    { type: 'kv', heading: 'ملخص', rows: [{ label: 'العدد', value: '2' }] },
    { type: 'table', heading: 'القضايا <&>', columns: ['الرقم', 'العنوان'], rows: [['2555', 'سرقة & نهب'], ['2556', 'قضية "ب"']] },
    { type: 'table', heading: 'القضايا <&>', columns: ['أ'], rows: [] }, // اسم ورقة مكرر + جدول فارغ
    { type: 'text', heading: 'ملاحظات', text: 'سطر1\nسطر2' },
  ],
};

describe('Excel', () => {
  test('حزمة XLSX سليمة وتجتاز الفحص', () => {
    const b = renderReportXlsx(doc);
    verifyXlsxPackage(b);
    verifyReportFile(b, 'xlsx', sha(b), sha);
    assert.match(REPORT_MIME.xlsx, /spreadsheetml\.sheet$/);
  });
  test('عبث بالملف يرفضه الفحص', () => {
    const b = renderReportXlsx(doc); const t = b.slice(); t[200] ^= 1;
    assert.throws(() => verifyReportFile(t, 'xlsx', sha(b), sha), (e) => e instanceof ExportError && e.code === 'FILE_CORRUPT');
  });
  test('أسماء الأوراق فريدة وصالحة', () => {
    const s = Buffer.from(renderReportXlsx(doc)).toString('utf8');
    const names = [...s.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(names.length, 3); // الملخص + جدولان
    assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length);
    for (const n of names) assert.ok(n.length <= 31 && !/[\\/?*\[\]:]/.test(n));
  });
  test('الرموز الخاصة تُهرَّب في XML', () => {
    const s = Buffer.from(renderReportXlsx(doc)).toString('utf8');
    assert.ok(s.includes('سرقة &amp; نهب') && s.includes('&quot;ب&quot;'));
  });
});

describe('TXT', () => {
  test('UTF-8 مع BOM ويحتوي البيانات', () => {
    const b = renderReportTxt(doc);
    assert.deepEqual([...b.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const t = new TextDecoder().decode(b.slice(3));
    assert.ok(t.includes('2555') && t.includes('العنوان: سرقة & نهب') && t.includes(doc.documentNumber));
    verifyReportFile(b, 'txt', sha(b), sha);
  });
  test('نص بلا BOM مرفوض', () => {
    const b = renderReportTxt(doc).slice(3);
    assert.throws(() => verifyReportFile(b, 'txt', sha(b), sha), (e) => e instanceof ExportError);
  });
  test('مسارات الصيغ الأربع مقبولة وغيرها مرفوض', () => {
    for (const f of ['pdf', 'docx', 'xlsx', 'txt']) assert.equal(assertReportPath('file:///c/reports/a.' + f), f);
    assert.throws(() => assertReportPath('file:///c/reports/a.exe'));
    assert.throws(() => assertReportPath('file:///c/other/a.txt'));
  });
});

describe('خطاب المذكرة', () => {
  const memo = { memoNumber: '1757', memoDate: new Date(2026, 10, 22).getTime(), typeName: 'أوامر قضائية إلزامية (إحضار)',
    recipient: 'السجن المركزي', subject: 'احظار الفرد <script>', body: 'طلب تحظير الشخص\nسطر ثان', caseNumber: '2555', status: 'مرسلة' };
  test('يحوي كل عناصر الورقة الرسمية ويهرّب HTML', () => {
    const h = renderMemoHtml(memo);
    for (const t of ['وزارة الداخلية', 'إدارة المباحث الجنائية', '1757', 'السجن المركزي', '2555', 'التوقيع', 'الختم الرسمي', 'size: A4']) assert.ok(h.includes(t), t);
    assert.ok(!h.includes('<script>') && h.includes('&lt;script&gt;'));
  });
  test('دون قضية مرتبطة لا يظهر سطر القضية، واسم الملف آمن', () => {
    assert.ok(!renderMemoHtml({ ...memo, caseNumber: null }).includes('مرتبطة بالقضية'));
    assert.equal(memoPdfFileName('../1757/x'), 'memo_1757_x.pdf');
  });
});

describe('تشخيص أخطاء المرفقات', () => {
  test('STORAGE_FAILED يعرض سبباً مختصراً بلا مسارات', () => {
    const m = friendlyAttachmentError(new AttachmentError('STORAGE_FAILED', 'direct: cannot open file:///data/user/0/app/files/attachments/x.enc'));
    assert.ok(m.startsWith('تعذر حفظ الملف') && m.includes('direct') && !m.includes('/data/'));
  });
});
