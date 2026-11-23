python3 - <<'PYEOF'
# SecureCaseDesk v2.2 — المرحلة 12 / القسم 12.3 (من جذر المشروع)
import json, os, re, subprocess, sys, shutil, datetime
TS = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
def die(m): print('\n✘ ' + m); sys.exit(1)
if not (os.path.isfile('package.json') and os.path.isfile('src/database/db.ts')): die('شغّل الأمر من جذر مشروع SecureCaseDesk.')
if '"name": "securecasedesk"' not in open('package.json', encoding='utf8').read(): die('package.json ليس لمشروع securecasedesk.')
if not os.path.isfile('scripts/preflight-build.mjs') or not os.path.isdir('docs/phase12'): die('القسمان 12.1 و12.2 غير مثبّتين.')
for f in ['src/modules/reports/reports-docx.ts', 'src/modules/reports/reports-html.ts']:
    if not os.path.isfile(f): die('ملف مفقود: ' + f)

def write(path, text):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    if os.path.isfile(path):
        if open(path, encoding='utf8').read() == text: print('  = بلا تغيير: ' + path); return
        shutil.copy(path, path + '.bak_' + TS); print('  ! نُسخ احتياطياً: ' + path + '.bak_' + TS)
    open(path, 'w', encoding='utf8', newline='\n').write(text); print('  ✔ كُتب: ' + path)

FILES = {}
FILES['tests/arabic-documents.test.ts'] = r'''// SECURECASEDESK_PHASE12_S3
// اختبارات 12.3 — جودة المستندات العربية: DOCX (بنية OOXML، RTL، الخطوط، الجداول، الترقيم) وHTML المعدّ للـ PDF والطباعة.
// تشغَّل بـ: npm run test:arabic-docs
// حدود صادقة: هذه تتحقق من بنية الملفات ووسوم الاتجاه. تشكيل الحروف الفعلي وشكل الصفحة المطبوعة لا يُثبتان إلا بفتح الملف في Word / عارض PDF على الجهاز (D26–D30).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { renderReportDocx } from '../src/modules/reports/reports-docx';
import { renderReportHtml } from '../src/modules/reports/reports-html';
import { crc32 } from '../src/modules/reports/reports-zip';
import { REPORT_CATALOG, type ReportDocument, type ReportSection } from '../src/modules/reports/reports-types';

const ARABIC = /[\u0600-\u06FF]/;
const NOW = new Date(2026, 10, 21, 10, 30, 0).getTime();

// ---------- قارئ ZIP مستقل (لا يعتمد على كود التطبيق) ----------
function readZip(bytes: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(bytes);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.ok(eocd >= 0, 'لا يوجد سجل نهاية ZIP');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    assert.equal(b.readUInt32LE(p), 0x02014b50, 'سجل مركزي مكسور');
    const method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16), csize = b.readUInt32LE(p + 20), usize = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28), elen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), lho = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(b.readUInt32LE(lho), 0x04034b50, 'ترويسة محلية مكسورة: ' + name);
    const dstart = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    const raw = b.subarray(dstart, dstart + csize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    assert.equal(data.length, usize, 'حجم غير مطابق: ' + name);
    assert.equal(crc32(new Uint8Array(data)), crc, 'CRC غير مطابق: ' + name);
    out.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

// ---------- فاحص XML مبسّط: توازن الوسوم وسلامة الرموز ----------
function assertWellFormed(xml: string, label: string) {
  assert.ok(xml.startsWith('<?xml'), label + ': ينقصه تصريح XML');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, label + ': أحرف تحكم غير مسموحة');
  assert.doesNotMatch(xml.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, ''), /&/, label + ': & غير مهرّبة');
  const stack: string[] = [];
  const body = xml.replace(/<\?[\s\S]*?\?>/, '');
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)([^<>]*?)(\/?)>/g)) {
    const [, close, name, attrs, selfClose] = m;
    assert.doesNotMatch(attrs, /=\s*[^"'\s]/, label + ': قيمة سمة بلا علامات اقتباس في <' + name + '>');
    if (close) { assert.equal(stack.pop(), name, label + ': وسم إغلاق غير متوازن </' + name + '>'); }
    else if (!selfClose) stack.push(name);
  }
  assert.deepEqual(stack, [], label + ': وسوم لم تُغلق');
  assert.equal((body.match(/</g) ?? []).length, (body.match(/>/g) ?? []).length, label + ': أقواس < > غير متساوية');
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const textRuns = (xml: string) => [...xml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unxml(m[1]));

// ---------- مستندات الاختبار ----------
const LONG = 'تفصيل الواقعة: ' + 'تم استلام بلاغ من المواطن بشأن سرقة مبلغ مالي من منزله الكائن في حي الصفا، وبعد المعاينة والتحري تبيّن وجود آثار كسر في الباب الخلفي. '.repeat(40);
const MIXED = 'رقم المحضر: 2026/145 — الهاتف 0771234567 — الرقم المرجعي SCD-20261121-AB12-CA — ١٢٣٤٥';
const TASHKEEL = 'بِسْمِ اللَّهِ — مُحَمَّد';

function sampleDoc(over: Partial<ReportDocument> = {}, extra: ReportSection[] = []): ReportDocument {
  return {
    kind: 'case_file', title: 'تقرير قضية منفردة', documentNumber: 'SCD-20261121-AB12-CA', createdAt: NOW,
    createdBy: 'المدير العام', filtersText: 'الفترة: 2026-01-01 إلى 2026-11-21', rowCount: 3,
    sections: [
      { type: 'kv', heading: 'بيانات القضية', rows: [
        { label: 'رقم القضية', value: '2026/145' }, { label: 'العنوان', value: 'قضية سرقة منزل' },
        { label: 'المرجع', value: MIXED }, { label: 'متعدد الأسطر', value: 'السطر الأول\nالسطر الثاني\nالسطر الثالث' },
        { label: 'تشكيل', value: TASHKEEL },
      ] },
      { type: 'text', heading: 'تفاصيل الحادثة', text: LONG },
      { type: 'table', heading: 'المذكرات', columns: ['الرقم', 'النوع', 'التاريخ', 'الحالة'], rows: [['م-1', 'مذكرة إلى النيابة', '2026-11-16', 'مسودة'], ['م-2', 'أوامر وتكليفات', '2026-11-18', 'معتمدة']] },
      { type: 'table', heading: 'مرفقات (فارغ)', columns: ['الاسم', 'الحجم'], rows: [], emptyText: 'لا توجد مرفقات.' },
      ...extra,
    ],
    ...over,
  };
}
const WIDE: ReportSection = { type: 'table', heading: 'جدول عريض', columns: ['١', '٢', '٣', '٤', '٥', '٦', '٧', '٨'], rows: [['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح']] };

// =====================================================================
describe('DOCX: البنية والسلامة', () => {
  const zip = readZip(renderReportDocx(sampleDoc()));

  test('الأجزاء المطلوبة موجودة وكل CRC سليم', () => {
    for (const n of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/footer1.xml', 'docProps/core.xml']) assert.ok(zip.has(n), 'ينقص: ' + n);
  });
  test('كل أجزاء XML سليمة البنية', () => {
    for (const [n, d] of zip) if (n.endsWith('.xml') || n.endsWith('.rels')) assertWellFormed(d.toString('utf8'), n);
  });
  test('كل علاقة (Relationship) تشير إلى جزء موجود فعلاً، وكل Override له جزء', () => {
    for (const relName of ['_rels/.rels', 'word/_rels/document.xml.rels']) {
      const base = relName.startsWith('word/') ? 'word/' : '';
      for (const m of zip.get(relName)!.toString('utf8').matchAll(/Target="([^"]+)"/g)) assert.ok(zip.has(base + m[1]), relName + ' ← ' + m[1]);
    }
    for (const m of zip.get('[Content_Types].xml')!.toString('utf8').matchAll(/PartName="\/([^"]+)"/g)) assert.ok(zip.has(m[1]), 'Override بلا جزء: ' + m[1]);
  });
  test('المعرّف r:id للتذييل في sectPr موجود في علاقات المستند', () => {
    const doc = zip.get('word/document.xml')!.toString('utf8');
    const id = /<w:footerReference [^>]*r:id="([^"]+)"/.exec(doc)?.[1];
    assert.ok(id);
    assert.match(zip.get('word/_rels/document.xml.rels')!.toString('utf8'), new RegExp('Id="' + id + '"[^>]*footer'));
  });
  test('خصائص المستند: لغة ar-SA والعنوان محفوظ بالعربية', () => {
    const core = zip.get('docProps/core.xml')!.toString('utf8');
    assert.match(core, /<dc:language>ar-SA<\/dc:language>/);
    assert.match(core, /<dc:title>تقرير قضية منفردة<\/dc:title>/);
  });
  test('التوليد حتمي: نفس المدخلات تعطي نفس البايتات', () => {
    const a = renderReportDocx(sampleDoc()), b = renderReportDocx(sampleDoc());
    assert.deepEqual(Buffer.from(a), Buffer.from(b));
  });
});

describe('DOCX: العربية وRTL', () => {
  const zip = readZip(renderReportDocx(sampleDoc()));
  const doc = zip.get('word/document.xml')!.toString('utf8');
  const footer = zip.get('word/footer1.xml')!.toString('utf8');
  const styles = zip.get('word/styles.xml')!.toString('utf8');

  test('كل فقرة (w:p) بصيغة bidi، في المستند والتذييل', () => {
    for (const [label, xml] of [['document', doc], ['footer', footer]] as const) {
      const paras = [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)];
      assert.ok(paras.length > 0);
      for (const p of paras) assert.match(p[1], /^<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*<w:bidi\/>/, label + ': فقرة بلا bidi');
    }
  });
  test('كل نص يحوي عربية داخل مقطع <w:rtl/> وبخط معقّد w:cs وحجم szCs', () => {
    for (const r of doc.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)) {
      const t = /<w:t[^>]*>([\s\S]*?)<\/w:t>/.exec(r[1]);
      if (t && ARABIC.test(t[1])) {
        assert.match(r[1], /<w:rtl\/>/); assert.match(r[1], /w:cs="/); assert.match(r[1], /<w:szCs w:val="\d+"\/>/);
      }
    }
  });
  test('الأنماط الافتراضية: لغة ar-SA واتجاه bidi', () => {
    assert.match(styles, /<w:lang w:val="ar-SA" w:bidi="ar-SA"\/>/);
    assert.match(styles, /<w:pPrDefault><w:pPr><w:bidi\/>/);
  });
  test('كل جدول bidiVisual وعدد خلايا كل صف = عدد أعمدة الشبكة ومجموع الأعمدة = عرض الجدول', () => {
    const tables = [...doc.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)];
    assert.equal(tables.length, 4); // بيانات + مذكرات + مرفقات فارغة + التوقيع
    for (const t of tables) {
      const x = t[1];
      assert.match(x, /<w:bidiVisual\/>/);
      const grid = [...x.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => +m[1]);
      const total = +/<w:tblW w:w="(\d+)"/.exec(x)![1];
      assert.ok(Math.abs(grid.reduce((a, b) => a + b, 0) - total) <= grid.length, 'مجموع الأعمدة لا يطابق العرض');
      for (const row of x.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)) assert.equal((row[1].match(/<w:tc>/g) ?? []).length, grid.length, 'عدد خلايا الصف مختلف');
    }
  });
  test('نصوص المستند تعود كما أُدخلت: عنوان، رؤوس، خلايا، نص طويل، أرقام عربية وإنجليزية مختلطة، تشكيل', () => {
    const joined = textRuns(doc).join('\n');
    for (const s of ['تقرير قضية منفردة', 'بيانات القضية', 'قضية سرقة منزل', MIXED, TASHKEEL, 'مذكرة إلى النيابة', 'لا توجد مرفقات.', 'المدير العام', 'التوقيع', 'الاعتماد', 'الختم الرسمي', 'وزارة الداخلية']) {
      assert.ok(joined.includes(s), 'مفقود: ' + s);
    }
    assert.ok(joined.includes(LONG), 'النص الطويل قُطع أو تغيّر');
    assert.ok(joined.includes('السطر الأول') && joined.includes('السطر الثالث'));
  });
  test('الأسطر المتعددة تُصدَّر كفواصل <w:br/> لا كأحرف سطر داخل w:t', () => {
    assert.doesNotMatch(doc, /<w:t[^>]*>[^<]*\n[^<]*<\/w:t>/);
    assert.ok((doc.match(/<w:br\/>/g) ?? []).length >= 2);
  });
  test('التذييل: ترقيم صفحات حقيقي PAGE وNUMPAGES بحقول متوازنة', () => {
    assert.match(footer, /instrText[^>]*> PAGE </); assert.match(footer, /instrText[^>]*> NUMPAGES </);
    assert.equal((footer.match(/fldCharType="begin"/g) ?? []).length, 2);
    assert.equal((footer.match(/fldCharType="end"/g) ?? []).length, 2);
    assert.equal((footer.match(/fldCharType="separate"/g) ?? []).length, 2);
  });
  test('الترويسة الرسمية في أعلى المستند قبل أي جدول', () => {
    assert.ok(doc.indexOf('وزارة الداخلية') < doc.indexOf('<w:tbl>'));
  });
});

describe('DOCX: الصفحة والجداول العريضة', () => {
  test('تقرير عادي: A4 عمودي وهوامش وعرض الجداول داخل الصفحة', () => {
    const doc = readZip(renderReportDocx(sampleDoc())).get('word/document.xml')!.toString('utf8');
    assert.match(doc, /<w:pgSz w:w="11906" w:h="16838"\/>/);
    const margins = /w:right="(\d+)"[^>]*w:left="(\d+)"/.exec(doc)!;
    for (const t of doc.matchAll(/<w:tblW w:w="(\d+)"/g)) assert.ok(+t[1] <= 11906 - +margins[1] - +margins[2]);
    assert.match(doc, /<w:bidi\/><\/w:sectPr>/);
  });
  test('7 أعمدة فأكثر: A4 أفقي وعرض الجدول داخل الصفحة', () => {
    const doc = readZip(renderReportDocx(sampleDoc({}, [WIDE]))).get('word/document.xml')!.toString('utf8');
    assert.match(doc, /<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"\/>/);
    for (const t of doc.matchAll(/<w:tblW w:w="(\d+)"/g)) assert.ok(+t[1] <= 16838 - 1700);
  });
  test('6 أعمدة تبقى عمودية (حد التحويل عند 7)', () => {
    const six: ReportSection = { type: 'table', columns: ['1', '2', '3', '4', '5', '6'], rows: [] };
    assert.match(readZip(renderReportDocx(sampleDoc({}, [six]))).get('word/document.xml')!.toString('utf8'), /w:h="16838"/);
  });
  test('أقصى حجم تقرير (5000 صف × 8 أعمدة): يُبنى بزمن معقول وبنية سليمة وكل الصفوف موجودة', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ['سجل ' + i, 'قيد التحقيق', '2026-11-21', 'ق' + i, 'x', 'y', 'z', 'ملاحظة طويلة نوعاً ما ' + i]);
    const t0 = Date.now();
    const bytes = renderReportDocx(sampleDoc({}, [{ type: 'table', heading: 'كبير', columns: ['1', '2', '3', '4', '5', '6', '7', '8'], rows }]));
    const ms = Date.now() - t0;
    const xml = readZip(bytes).get('word/document.xml')!.toString('utf8');
    assertWellFormed(xml, 'big');
    assert.ok(xml.includes('سجل 4999') && xml.includes('سجل 0'));
    assert.ok(ms < 8000, 'بطيء جداً: ' + ms + 'ms');
    assert.ok(bytes.length < 16 * 1024 * 1024);
  });
});

describe('DOCX/HTML: محتوى ضار وحالات حدّية', () => {
  const hostile = '<script>alert(1)</script> & "q" \'a\' ]]> \u0000\u001b\u0008 end';
  test('DOCX: هروب الرموز وحذف أحرف التحكم، والملف يبقى سليماً', () => {
    const d = sampleDoc({ title: hostile, createdBy: hostile }, [{ type: 'kv', rows: [{ label: hostile, value: hostile }] }]);
    const zip = readZip(renderReportDocx(d));
    for (const n of ['word/document.xml', 'word/footer1.xml', 'docProps/core.xml']) assertWellFormed(zip.get(n)!.toString('utf8'), n);
    const joined = textRuns(zip.get('word/document.xml')!.toString('utf8')).join('');
    assert.ok(joined.includes('<script>alert(1)</script> & "q"'));
    assert.doesNotMatch(joined, /[\u0000\u001b\u0008]/);
  });
  test('HTML: لا يُنفَّذ أي وسم من البيانات', () => {
    const html = renderReportHtml(sampleDoc({ title: hostile }, [{ type: 'table', columns: [hostile], rows: [[hostile]] }]));
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /\son\w+=/i);
  });
  test('قيم فارغة/غير معرّفة: لا تظهر undefined أو null أو NaN أو [object', () => {
    const d = sampleDoc({ filtersText: '', createdBy: '' }, [{ type: 'table', columns: ['أ', 'ب'], rows: [['', '—'], ['x', '']] }, { type: 'text', text: '' }]);
    const all = renderReportHtml(d) + readZip(renderReportDocx(d)).get('word/document.xml')!.toString('utf8');
    assert.doesNotMatch(all, /undefined|\bnull\b|NaN|\[object/);
  });
  test('كل أنواع التقارير العشرة تنتج DOCX وHTML صالحين بعناوينها العربية', () => {
    assert.equal(REPORT_CATALOG.length, 10);
    for (const def of REPORT_CATALOG) {
      const d = sampleDoc({ kind: def.kind, title: def.title });
      assertWellFormed(readZip(renderReportDocx(d)).get('word/document.xml')!.toString('utf8'), def.kind);
      assert.ok(renderReportHtml(d).includes(def.title));
    }
  });
  // فجوة معروفة: محارف التحكم بالاتجاه (مثل U+202E) لا تُحذف من النص؛ يمكن لمُدخل ضار قلب ترتيب نص ظاهر في مستند رسمي.
  test('محارف تجاوز الاتجاه (U+202A–202E, U+2066–2069) تُحذف من النصوص المُصدَّرة', { todo: 'فجوة معروفة: escapeXml/escapeHtml لا تحذفها — انظر docs/phase12/12.3' }, () => {
    const evil = 'اسم\u202Egpj.exe\u202C وهمي \u2066x\u2069';
    const joined = textRuns(readZip(renderReportDocx(sampleDoc({ title: evil }))).get('word/document.xml')!.toString('utf8')).join('');
    assert.doesNotMatch(joined, /[\u202A-\u202E\u2066-\u2069]/);
    assert.doesNotMatch(renderReportHtml(sampleDoc({ title: evil })), /[\u202A-\u202E\u2066-\u2069]/);
  });
});

describe('HTML (مصدر PDF والطباعة)', () => {
  const html = renderReportHtml(sampleDoc({}, [WIDE]));
  test('اللغة والاتجاه والترميز', () => {
    assert.match(html, /<html lang="ar" dir="rtl">/); assert.match(html, /<meta charset="utf-8"\/>/);
    assert.match(html, /body \{ direction: rtl; text-align: right;/);
  });
  test('قائمة خطوط عربية مع بدائل نظام Android', () => {
    const fam = /font-family: ([^;]+);/.exec(html)![1];
    for (const f of ['Noto Naskh Arabic', 'Noto Sans Arabic', 'Tahoma', 'Arial']) assert.ok(fam.includes(f), f);
    assert.match(fam, /sans-serif$/);
  });
  test('إعدادات الطباعة: A4 وهوامش وترويسة جدول متكررة ومنع كسر الصف', () => {
    assert.match(html, /@page \{ size: A4;/); assert.match(html, /thead \{ display: table-header-group; \}/); assert.match(html, /tr \{ page-break-inside: avoid; \}/);
    assert.match(html, /h2 \{[^}]*page-break-after: avoid/);
  });
  test('كل جدول بيانات له <thead>، والخلايا محاذاة لليمين', () => {
    const tables = html.match(/<table>/g)!.length, theads = html.match(/<thead>/g)!.length;
    assert.ok(tables > theads && theads >= 3);
    assert.match(html, /th, td \{[^}]*text-align: right;/);
  });
  test('لا موارد خارجية: لا شبكة أثناء الطباعة (بلا http/src/link/@import/url())', () => {
    assert.doesNotMatch(html, /https?:\/\//i); assert.doesNotMatch(html, /<(img|link|iframe|script)\b/i);
    assert.doesNotMatch(html, /@import|url\(/i);
  });
  test('نصوص عربية سليمة: العنوان والمرجع المختلط والتشكيل والنص الطويل', () => {
    for (const s of ['تقرير قضية منفردة', MIXED, TASHKEEL, 'وزارة الداخلية', 'التوقيع', 'الختم الرسمي']) assert.ok(html.includes(s), s);
    assert.ok(html.includes(LONG.slice(0, 300)));
  });
  test('خانات التوقيع والاعتماد والختم موجودة وأسفل الصفحة', () => {
    assert.ok(html.indexOf('class="sign"') > html.lastIndexOf('</table>'));
  });
});
'''
FILES['tests/rtl-static.test.ts'] = r'''// SECURECASEDESK_PHASE12_S3
// اختبارات 12.3 — فحص ثابت لشيفرة الواجهة: RTL والخطوط واللغة. تشغَّل بـ: npm run test:rtl
// حدود صادقة: فحص نصي لملفات .tsx. لا يثبت الشكل الفعلي على الشاشة — ذلك بنود D21–D25 على الجهاز.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.tsx$/.test(e.name)) out.push(p);   // .bak_* لا تنتهي بـ .tsx فتُستثنى
  }
  return out;
}
const files = walk(path.join(ROOT, 'src/app')).concat(walk(path.join(ROOT, 'src/components')));
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');
const read = (f: string) => fs.readFileSync(f, 'utf8');
const layout = read(path.join(ROOT, 'src/app/_layout.tsx'));
const ADAPTIVE = "I18nManager.isRTL ? 'row' : 'row-reverse'";

describe('إعداد RTL على مستوى التطبيق', () => {
  test('_layout يفعّل allowRTL وforceRTL', () => {
    assert.match(layout, /I18nManager\.allowRTL\(true\)/); assert.match(layout, /I18nManager\.forceRTL\(true\)/);
  });
  test('app.json: الواجهة داكنة ولا يعطّل supportsRtl', () => {
    const app = JSON.parse(read(path.join(ROOT, 'app.json'))).expo;
    assert.equal(app.userInterfaceStyle, 'dark');
    assert.notEqual(app.android?.supportsRtl, false);
  });
  // فجوة معروفة: forceRTL لا يسري إلا بعد إعادة تشغيل التطبيق. على جهاز لغته غير عربية، أول تشغيل بعد التثبيت قد يكون LTR.
  test('إعادة تحميل التطبيق بعد أول forceRTL (reloadAsync/restart) على جهاز غير عربي', { todo: 'فجوة معروفة: لا يوجد reload بعد forceRTL — يُتحقق منه بالبند D21' }, () => {
    assert.match(layout, /reloadAsync|RNRestart|DevSettings\.reload/);
  });
});

describe('الخطوط', () => {
  test('كل fontFamily حرفي في الشيفرة هو خط Cairo مُحمَّل في _layout', () => {
    const loaded = new Set([...layout.matchAll(/\b(Cairo_\d+[A-Za-z]+)\b/g)].map((m) => m[1]));
    assert.ok(loaded.size >= 3);
    for (const f of files) for (const m of read(f).matchAll(/fontFamily:\s*'([^']+)'/g)) assert.ok(loaded.has(m[1]), rel(f) + ' يستخدم خطاً غير محمَّل: ' + m[1]);
  });
  test('أسماء الخطوط في theme.ts (Fonts.*) كلها محمَّلة', () => {
    const loaded = new Set([...layout.matchAll(/\b(Cairo_\d+[A-Za-z]+)\b/g)].map((m) => m[1]));
    const theme = read(path.join(ROOT, 'src/constants/theme.ts'));
    const block = /export const Fonts = \{([\s\S]*?)\}/.exec(theme)?.[1] ?? '';
    const names = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(names.length >= 3);
    for (const n of names) assert.ok(loaded.has(n), 'Fonts.* يشير لخط غير محمَّل: ' + n);
  });
});

describe('اتجاه الصفوف', () => {
  test('ثوابت ROW كلها بالنمط المتكيّف نفسه', () => {
    for (const f of files) for (const m of read(f).matchAll(/const ROW[^=]*=\s*([^;]+);/g)) assert.equal(m[1].trim(), ADAPTIVE, rel(f));
  });
  // خط أساس: الاستخدام المباشر لـ 'row-reverse' خارج نمط ROW. عندما يكون RTL مفعّلاً يعرض row-reverse الترتيب من اليسار لليمين.
  // لا يُسمح بزيادة الأعداد الحالية (يمنع التفاقم). خفضها يتطلب تعديل الشاشات ثم تحديث هذا الجدول، وتُتحقق على الجهاز بـ D22.
  const BASELINE: Record<string, number> = {
    'src/app/(tabs)/audit.tsx': 7, 'src/app/(tabs)/cases.tsx': 1, 'src/app/(tabs)/memos.tsx': 2,
    'src/app/audit-report.tsx': 4, 'src/app/audit-sync.tsx': 3,
  };
  const counts: Record<string, number> = {};
  for (const f of files) {
    const src = read(f).replace(/'row' \| 'row-reverse'/g, '').split(ADAPTIVE).join('');   // تعريف النوع ونمط ROW لا يُحسبان
    const n = (src.match(/row-reverse/g) ?? []).length;
    if (n) counts[rel(f)] = n;
  }
  test('لا ملف جديد يستخدم row-reverse مباشرة، ولا زيادة في الملفات المعروفة', (t) => {
    t.diagnostic('الاستخدام المباشر الحالي: ' + JSON.stringify(counts));
    for (const [f, n] of Object.entries(counts)) assert.ok(n <= (BASELINE[f] ?? 0), f + ': ' + n + ' استخدامات مباشرة (المسموح ' + (BASELINE[f] ?? 0) + ')');
  });
  test('الملفات المعروفة لم تُصلَح دون تحديث خط الأساس (يُبقي الجدول صادقاً)', () => {
    for (const [f, n] of Object.entries(BASELINE)) assert.equal(counts[f] ?? 0, n, f + ': تغيّر العدد — حدّث BASELINE');
  });
  test('إصلاح كامل: لا استخدام مباشر لـ row-reverse', { todo: 'فجوة معروفة: ' + Object.values(counts).reduce((a, b) => a + b, 0) + ' استخدامات في ' + Object.keys(counts).length + ' ملفات — تُفحص بالبند D22' }, () => {
    assert.deepEqual(counts, {});
  });
});

describe('اللغة: واجهة عربية فقط', () => {
  // كلمات لاتينية مقبولة: اختصارات تقنية متعارف عليها
  const ALLOWED = /^(PDF|Word|DOCX|HTTPS|SHA|HMAC|AES|SQLCipher|SecureCaseDesk|Admin|API|AI|ID|URL|YYYY|MM|DD|UTC|APK|RTL|QR)$/i;
  test('نصوص JSX الظاهرة لا تحوي كلمات لاتينية غير الاختصارات المعتمدة', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/(?<![=\-])>([^<>{}=;()]*[\u0600-\u06FF][^<>{}=;()]*)<\//g)) {
        for (const w of m[1].match(/[A-Za-z]{2,}/g) ?? []) if (!ALLOWED.test(w)) bad.push(rel(f) + ': ' + w);
      }
    }
    assert.deepEqual(bad, []);
  });
  test('عناوين الشاشات (title / headerTitle) عربية', () => {
    for (const f of files) for (const m of read(f).matchAll(/(?:title|headerTitle)\s*[:=]\s*['"]([^'"]+)['"]/g)) {
      if (/^[\x00-\x7F]*$/.test(m[1]) && !/^(\s*|[\d\W]+)$/.test(m[1]) && !/^[a-z]+$/.test(m[1])) assert.fail(rel(f) + ': ' + m[1]);
    }
  });
});
'''
FILES['docs/phase12/12.3-backup-documents-rtl-tests.md'] = r'''# المرحلة 12 / القسم 12.3 — النسخ الاحتياطي والمستندات العربية وRTL

> قاعدة الصدق (القسم 22): لا يُعلَّم أي اختبار «نجح» دون تنفيذه فعلياً. كل خانات الجهاز أدناه تبدأ «لم يُنفَّذ». ما يخص الخادم المركزي يبقى «معلّق حتى المرحلة 13».

## أولاً: ما أُضيف
| الملف | الغرض |
|---|---|
| `tests/arabic-documents.test.ts` | DOCX: بنية OOXML وCRC وعلاقات الأجزاء وXML سليم، bidi لكل فقرة، rtl وخط معقّد لكل نص عربي، جداول bidiVisual، الصفحة العمودية/الأفقية، الترقيم PAGE/NUMPAGES، أسطر متعددة، أرقام مختلطة، تشكيل، أقصى حجم 5000 صف، محتوى ضار. HTML/PDF: lang/dir، خطوط، @page A4، ترويسة جدول متكررة، لا موارد خارجية |
| `tests/rtl-static.test.ts` | فحص ثابت للواجهة: forceRTL، الخطوط المحمَّلة، نمط ROW، منع انتشار `row-reverse`، واجهة عربية فقط |

## ثانياً: النسخ الاحتياطي — تغطية 22.1 بالاختبارات القائمة (من المرحلة 10)
لم تُكرَّر اختبارات النسخ في 12.3 لأنها شاملة أصلاً. جدول الربط:

| بند 22.1 / المرحلة 10 | الملف |
|---|---|
| إنشاء نسخة مشفّرة (قاعدة + مرفقات + أسرار)، لا نص صريح في الملف | `backup-package.test.ts` |
| كشف العبث: بايت مقلوب، بتر، بايتات زائدة، تبديل إطارات، ترويسة معدّلة، كلمة مرور خاطئة | `backup-package.test.ts` • `backup-restore.test.ts` |
| تحقق كامل قبل الاستعادة + نسخة أمان قبل الاستعادة (PreRestore) | `backup-restore-prep.test.ts` |
| الاستعادة الكاملة (قاعدة + مرفقات + أسرار) وتأكيد صريح ومنع الاستعادتين المتزامنتين | `backup-restore.test.ts` |
| التراجع عند الفشل أو الانقطاع والتعافي عند الإقلاع | `backup-rollback.test.ts` • `backup-restore.test.ts` |
| ترحيل قاعدة قديمة، منع التكرار، التراجع (على ملفات تجريبية) | `legacy-migration.test.ts` • `backup-integration.test.ts` |
| تدقيق أحداث النسخ/الاستعادة بلا أسرار | `backup-restore-prep.test.ts` |

**حدود:** هذه اختبارات Node بملفات حقيقية وتشفير node:crypto، لكن القاعدة فيها SQLite عادية والأسرار محاكاة (ليس SQLCipher ولا SecureStore). الإثبات الحقيقي على الجهاز: D32–D39. **الترحيل من القاعدة القديمة الفعلية معلّق حتى توفّرها** (D39).

## ثالثاً: فجوات معروفة اكتُشفت (ليست مخفية)
| # | الفجوة | الأثر | كيف تظهر |
|---|---|---|---|
| G1 | `escapeXml` و`escapeHtml` لا تحذفان محارف تجاوز الاتجاه (U+202A–202E، U+2066–2069) | مُدخل ضار قد يقلب ترتيب نص ظاهر في مستند رسمي (مثل اسم ملف مضلّل) | اختبار `todo` في arabic-documents |
| G2 | `forceRTL` بلا إعادة تحميل | على جهاز لغته غير عربية قد يكون أول تشغيل بعد التثبيت LTR حتى إعادة التشغيل | اختبار `todo` في rtl-static • D21 |
| G3 | 17 استخداماً مباشراً لـ `row-reverse` في 5 ملفات (audit، cases، memos، audit-report، audit-sync) بدل نمط ROW المتكيّف | عند تفعيل RTL يعرض `row-reverse` الترتيب من اليسار لليمين، فقد تختلف هذه الشاشات عن بقية التطبيق | اختبار `todo` + خط أساس يمنع الزيادة • D22 |
| G4 | ترقيم صفحات PDF يعتمد على `@page { @bottom-center }` | قد لا يدعمه WebView على بعض إصدارات Android فيغيب الترقيم | D29 |
| G5 | DOCX يطلب الخط Arial للعربية | قد يستبدله Word/WPS على الجهاز بخط آخر؛ الشكل يتغير لا المعنى | D27 |

قرار الإصلاح لكل فجوة يعود إليك؛ لم يُعدَّل أي كود تطبيق في 12.3.

## رابعاً: ما تحقق منه المساعد خارج المشروع (أدوات خارجية)
ولّد المساعد DOCX وHTML بمولّدات المشروع نفسها وفتحهما: DOCX عبر LibreOffice وpython-docx، وHTML→PDF عبر Chromium. النتيجة: RTL صحيح، الأعمدة من اليمين، التشكيل والأرقام المختلطة سليمة، الترقيم يعمل. هذا **ليس** بديلاً عن D26–D31 على جهاز Android.

## خامساً: التشغيل
```bash
npm run test:arabic-docs
npm run test:rtl
npm run test:all
npx tsc --noEmit
```
اختبارات `todo` تظهر كـ«TODO» ولا تُفشل التشغيل؛ هي الفجوات المذكورة أعلاه.

## سادساً: قائمة الجهاز (على APK مثبّت) — تُكمل D01–D20
| الرمز | البند | الخطوات | المتوقع | الفعلي |
|---|---|---|---|---|
| D21 | RTL عند أول تشغيل (G2) | ثبّت APK على جهاز لغته الإنجليزية، افتحه، ثم أغلقه وأعد فتحه | الاتجاه RTL في الحالتين | لم يُنفَّذ |
| D22 | شاشات row-reverse (G3) | قارن شاشات التدقيق/القضايا/المذكرات/تقرير التدقيق/مزامنة التدقيق ببقية الشاشات | الأيقونات والعناوين بنفس ترتيب RTL | لم يُنفَّذ |
| D23 | الخطوط | تصفّح كل الشاشات | خط Cairo ظاهر بلا مربعات ولا خط نظام | لم يُنفَّذ |
| D24 | الإدخال العربي | اكتب عربياً وأرقاماً في كل حقل | المؤشر والمحاذاة سليمان | لم يُنفَّذ |
| D25 | النوافذ والقوائم | افتح كل نافذة منبثقة وقائمة | محاذاة RTL وأزرار الإغلاق في مكانها | لم يُنفَّذ |
| D26 | PDF لكل التقارير العشرة | أنشئ وشارك وافتح في عارض PDF | حروف متصلة وبلا مربعات | لم يُنفَّذ |
| D27 | DOCX لكل التقارير العشرة | افتح في Word أو WPS أو Google Docs | RTL وجداول من اليمين (G5) | لم يُنفَّذ |
| D28 | تقرير عريض | سجل حركات المحتجزين بصيغة DOCX | صفحة أفقية وكل الأعمدة ظاهرة | لم يُنفَّذ |
| D29 | تقرير طويل | 200+ صف بصيغة PDF | ترويسة الجدول تتكرر وأرقام الصفحات تظهر (G4) | لم يُنفَّذ |
| D30 | الطباعة والمشاركة | اطبع عبر نافذة النظام وشارك لتطبيق آخر | تعمل، الملف سليم | لم يُنفَّذ |
| D31 | نص طويل وأسطر متعددة | قضية بتفاصيل طويلة وأسطر | لا قطع ولا تداخل | لم يُنفَّذ |
| D32 | إنشاء نسخة | أنشئ نسخة بمرفقات واختر الوجهة | يظهر الملف بحجم معقول | لم يُنفَّذ |
| D33 | التحقق من النسخة | افتح تحقق النسخة | ينجح بكلمة المرور الصحيحة | لم يُنفَّذ |
| D34 | الاستعادة | عدّل بيانات ثم استعد النسخة | تعود البيانات وتُنشأ نسخة PreRestore | لم يُنفَّذ |
| D35 | كلمة مرور خاطئة | استعادة بكلمة خاطئة | رفض والبيانات كما هي | لم يُنفَّذ |
| D36 | انقطاع أثناء الاستعادة | أغلق التطبيق قسراً أثناءها | تعافٍ عند الفتح التالي بلا فقد بيانات | لم يُنفَّذ |
| D37 | استعادة على جهاز آخر | استعد نسخة على جهاز نظيف | الدخول يعمل، المرفقات تُفتح، سلسلة التدقيق VALID | لم يُنفَّذ |
| D38 | تدقيق النسخ | افحص سجل التدقيق | أحداث النسخ والاستعادة مسجّلة | لم يُنفَّذ |
| D39 | قاعدة قديمة | **معلّق حتى توفر القاعدة الفعلية** | ترحيل آمن بلا تكرار | معلّق |
| D40 | منع فقدان البيانات | أغلق التطبيق قسراً أثناء إضافة قضية ومرفق | لا بيانات نصف محفوظة | لم يُنفَّذ |
'''

print('\n== كتابة الملفات')
for p, t in FILES.items(): write(p, t)

print('\n== تحديث package.json')
pj = json.load(open('package.json', encoding='utf8'))
sc = pj.setdefault('scripts', {})
sc['test:arabic-docs'] = 'tsx --tsconfig tests/tsconfig.json --test tests/arabic-documents.test.ts'
sc['test:rtl'] = 'tsx --tsconfig tests/tsconfig.json --test tests/rtl-static.test.ts'
sc['test:phase12-s3'] = 'tsx --tsconfig tests/tsconfig.json --test tests/arabic-documents.test.ts tests/rtl-static.test.ts'
shutil.copy('package.json', 'package.json.bak_' + TS)
open('package.json', 'w', encoding='utf8').write(json.dumps(pj, ensure_ascii=False, indent=2) + '\n')
print('  ✔ أُضيفت: test:arabic-docs • test:rtl • test:phase12-s3')

def run(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf8', errors='replace')
    return p.returncode, (p.stdout or '') + (p.stderr or '')
def summary(out):
    keys = ('tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo')
    d = {}
    for k in keys:
        m = re.search(r'^\W*' + k + r'\s+(\d+)\s*$', out, re.M)
        if m: d[k] = int(m.group(1))
    return d
def lines(out, pat):
    return [re.sub(r'\s+', ' ', l).strip() for l in out.splitlines() if re.search(pat, l)]

print('\n== تشغيل الاختبارات (قد يستغرق دقيقة)')
rc1, o1 = run('npm run test:phase12-s3')
rc2, o2 = run('npm run test:all')
rc3, o3 = run('npx tsc --noEmit')
s1, s2 = summary(o1), summary(o2)
todos = sorted(set(lines(o1 + o2, r'# TODO')))
fails = sorted(set(lines(o1 + o2, r'^\s*not ok')) - set(todos))
node = run('node -v')[1].strip()
res = ['# نتائج 12.3 الفعلية (مُولَّدة آلياً)', '',
       '- التاريخ: ' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') + ' (UTC)', '- Node: ' + node,
       '- اختبارات Node على node:sqlite وملفات حقيقية (ليست SQLCipher ولا جهاز). اختبارات الجهاز D21–D40 تُسجَّل يدوياً في 12.3-backup-documents-rtl-tests.md', '',
       '## test:phase12-s3 (المستندات + RTL)', '- الرمز: ' + str(rc1) + ' — ' + json.dumps(s1), '',
       '## test:all', '- الرمز: ' + str(rc2) + ' — ' + json.dumps(s2), '',
       '## الفجوات المعروفة (اختبارات todo، لا تُفشل التشغيل)'] + ['- ' + t for t in todos] + ['',
       '## اختبارات فاشلة (غير todo)'] + (['- ' + f for f in fails] if fails else ['- لا شيء']) + ['',
       '## npx tsc --noEmit', '- الرمز: ' + str(rc3) + (' — 0 أخطاء' if rc3 == 0 else ''), '']
if rc3 != 0: res += ['```', o3[:3000], '```', '']
res += ['## الخلاصة', '- 12.3 اختبارات آلية: ' + ('نجحت' if rc1 == 0 else 'فيها فشل'), '- test:all: ' + ('نجح' if rc2 == 0 else 'فيه فشل'),
        '- اختبارات الجهاز D21–D40: لم تُنفَّذ بعد (يدوية)', '- القاعدة القديمة الفعلية (D39): معلّقة حتى توفرها']
write('docs/phase12/12.3-test-results.md', '\n'.join(res) + '\n')
print('\n' + '=' * 50)
print('test:phase12-s3 :', 'نجح' if rc1 == 0 else 'فشل', s1)
print('test:all        :', 'نجح' if rc2 == 0 else 'فشل', s2)
print('tsc             :', 'نجح' if rc3 == 0 else 'فشل')
print('الفجوات المعروفة (todo):', len(todos))
for f in fails: print('  فشل:', f)
print('النتائج الكاملة: docs/phase12/12.3-test-results.md')
