// SECURECASEDESK_PHASE12_S3
// اختبارات 12.3 — جودة المستندات العربية: DOCX وHTML المعدّ للـ PDF والطباعة.
// تشغَّل بـ: npm run test:arabic-docs
// حدود صادقة: تتحقق من بنية الملفات ووسوم الاتجاه فقط. شكل الحروف والصفحة المطبوعة يُثبتان على الجهاز (D26–D30).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { renderReportDocx } from '../src/modules/reports/reports-docx';
import { renderReportHtml } from '../src/modules/reports/reports-html';
import { crc32 } from '../src/modules/reports/reports-zip';
import { REPORT_CATALOG, type ReportDocument, type ReportSection } from '../src/modules/reports/reports-types';

const ARABIC = /[\u0600-\u06FF]/;
const NOW = new Date(2026, 10, 21, 10, 30, 0).getTime();

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

function assertWellFormed(xml: string, label: string) {
  assert.ok(xml.startsWith('<?xml'), label + ': ينقصه تصريح XML');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, label + ': أحرف تحكم غير مسموحة');
  assert.doesNotMatch(xml.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, ''), /&/, label + ': & غير مهرّبة');
  const stack: string[] = [];
  const body = xml.replace(/<\?[\s\S]*?\?>/, '');
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)([^<>]*?)(\/?)>/g)) {
    const [, close, name, attrs, selfClose] = m;
    assert.doesNotMatch(attrs, /=\s*[^"'\s]/, label + ': قيمة سمة بلا اقتباس في <' + name + '>');
    if (close) { assert.equal(stack.pop(), name, label + ': وسم إغلاق غير متوازن </' + name + '>'); }
    else if (!selfClose) stack.push(name);
  }
  assert.deepEqual(stack, [], label + ': وسوم لم تُغلق');
  assert.equal((body.match(/</g) ?? []).length, (body.match(/>/g) ?? []).length, label + ': أقواس غير متساوية');
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const textRuns = (xml: string) => [...xml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unxml(m[1]));

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

describe('DOCX: البنية والسلامة', () => {
  const zip = readZip(renderReportDocx(sampleDoc()));
  test('الأجزاء المطلوبة موجودة وكل CRC سليم', () => {
    for (const n of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/footer1.xml', 'docProps/core.xml']) assert.ok(zip.has(n), 'ينقص: ' + n);
  });
  test('كل أجزاء XML سليمة البنية', () => {
    for (const [n, d] of zip) if (n.endsWith('.xml') || n.endsWith('.rels')) assertWellFormed(d.toString('utf8'), n);
  });
  test('كل علاقة تشير إلى جزء موجود، وكل Override له جزء', () => {
    for (const relName of ['_rels/.rels', 'word/_rels/document.xml.rels']) {
      const base = relName.startsWith('word/') ? 'word/' : '';
      for (const m of zip.get(relName)!.toString('utf8').matchAll(/Target="([^"]+)"/g)) assert.ok(zip.has(base + m[1]), relName + ' ← ' + m[1]);
    }
    for (const m of zip.get('[Content_Types].xml')!.toString('utf8').matchAll(/PartName="\/([^"]+)"/g)) assert.ok(zip.has(m[1]), 'Override بلا جزء: ' + m[1]);
  });
  test('معرّف التذييل في sectPr موجود في علاقات المستند', () => {
    const doc = zip.get('word/document.xml')!.toString('utf8');
    const id = /<w:footerReference [^>]*r:id="([^"]+)"/.exec(doc)?.[1];
    assert.ok(id);
    assert.match(zip.get('word/_rels/document.xml.rels')!.toString('utf8'), new RegExp('Id="' + id + '"[^>]*footer'));
  });
  test('خصائص المستند: لغة ar-SA والعنوان بالعربية', () => {
    const core = zip.get('docProps/core.xml')!.toString('utf8');
    assert.match(core, /<dc:language>ar-SA<\/dc:language>/);
    assert.match(core, /<dc:title>تقرير قضية منفردة<\/dc:title>/);
  });
  test('التوليد حتمي: نفس المدخلات تعطي نفس البايتات', () => {
    assert.deepEqual(Buffer.from(renderReportDocx(sampleDoc())), Buffer.from(renderReportDocx(sampleDoc())));
  });
});

describe('DOCX: العربية وRTL', () => {
  const zip = readZip(renderReportDocx(sampleDoc()));
  const doc = zip.get('word/document.xml')!.toString('utf8');
  const footer = zip.get('word/footer1.xml')!.toString('utf8');
  const styles = zip.get('word/styles.xml')!.toString('utf8');
  test('كل فقرة بصيغة bidi، في المستند والتذييل', () => {
    for (const [label, xml] of [['document', doc], ['footer', footer]] as const) {
      const paras = [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)];
      assert.ok(paras.length > 0);
      for (const p of paras) assert.match(p[1], /^<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*<w:bidi\/>/, label + ': فقرة بلا bidi');
    }
  });
  test('كل نص عربي داخل مقطع rtl وبخط معقّد وحجم szCs', () => {
    for (const r of doc.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)) {
      const t = /<w:t[^>]*>([\s\S]*?)<\/w:t>/.exec(r[1]);
      if (t && ARABIC.test(t[1])) { assert.match(r[1], /<w:rtl\/>/); assert.match(r[1], /w:cs="/); assert.match(r[1], /<w:szCs w:val="\d+"\/>/); }
    }
  });
  test('الأنماط الافتراضية: لغة ar-SA واتجاه bidi', () => {
    assert.match(styles, /<w:lang w:val="ar-SA" w:bidi="ar-SA"\/>/);
    assert.match(styles, /<w:pPrDefault><w:pPr><w:bidi\/>/);
  });
  test('كل جدول bidiVisual، وخلايا كل صف = أعمدة الشبكة، ومجموعها = عرض الجدول', () => {
    const tables = [...doc.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)];
    assert.equal(tables.length, 4);
    for (const t of tables) {
      const x = t[1];
      assert.match(x, /<w:bidiVisual\/>/);
      const grid = [...x.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => +m[1]);
      const total = +/<w:tblW w:w="(\d+)"/.exec(x)![1];
      assert.ok(Math.abs(grid.reduce((a, b) => a + b, 0) - total) <= grid.length, 'مجموع الأعمدة لا يطابق العرض');
      for (const row of x.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)) assert.equal((row[1].match(/<w:tc>/g) ?? []).length, grid.length, 'عدد خلايا الصف مختلف');
    }
  });
  test('النصوص تعود كما أُدخلت: عنوان، خلايا، نص طويل، أرقام مختلطة، تشكيل', () => {
    const joined = textRuns(doc).join('\n');
    for (const s of ['تقرير قضية منفردة', 'بيانات القضية', 'قضية سرقة منزل', MIXED, TASHKEEL, 'مذكرة إلى النيابة', 'لا توجد مرفقات.', 'المدير العام', 'التوقيع', 'الاعتماد', 'الختم الرسمي', 'وزارة الداخلية']) assert.ok(joined.includes(s), 'مفقود: ' + s);
    assert.ok(joined.includes(LONG), 'النص الطويل قُطع أو تغيّر');
    assert.ok(joined.includes('السطر الأول') && joined.includes('السطر الثالث'));
  });
  test('الأسطر المتعددة تُصدَّر كفواصل br لا كأحرف سطر داخل w:t', () => {
    assert.doesNotMatch(doc, /<w:t[^>]*>[^<]*\n[^<]*<\/w:t>/);
    assert.ok((doc.match(/<w:br\/>/g) ?? []).length >= 2);
  });
  test('التذييل: ترقيم صفحات PAGE وNUMPAGES بحقول متوازنة', () => {
    assert.match(footer, /instrText[^>]*> PAGE </); assert.match(footer, /instrText[^>]*> NUMPAGES </);
    for (const k of ['begin', 'separate', 'end']) assert.equal((footer.match(new RegExp('fldCharType="' + k + '"', 'g')) ?? []).length, 2);
  });
  test('الترويسة الرسمية قبل أي جدول', () => {
    assert.ok(doc.indexOf('وزارة الداخلية') < doc.indexOf('<w:tbl>'));
  });
});

describe('DOCX: الصفحة والجداول العريضة', () => {
  test('تقرير عادي: A4 عمودي والجداول داخل الهوامش', () => {
    const doc = readZip(renderReportDocx(sampleDoc())).get('word/document.xml')!.toString('utf8');
    assert.match(doc, /<w:pgSz w:w="11906" w:h="16838"\/>/);
    const margins = /w:right="(\d+)"[^>]*w:left="(\d+)"/.exec(doc)!;
    for (const t of doc.matchAll(/<w:tblW w:w="(\d+)"/g)) assert.ok(+t[1] <= 11906 - +margins[1] - +margins[2]);
    assert.match(doc, /<w:bidi\/><\/w:sectPr>/);
  });
  test('7 أعمدة فأكثر: A4 أفقي', () => {
    const doc = readZip(renderReportDocx(sampleDoc({}, [WIDE]))).get('word/document.xml')!.toString('utf8');
    assert.match(doc, /<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"\/>/);
    for (const t of doc.matchAll(/<w:tblW w:w="(\d+)"/g)) assert.ok(+t[1] <= 16838 - 1700);
  });
  test('6 أعمدة تبقى عمودية', () => {
    const six: ReportSection = { type: 'table', columns: ['1', '2', '3', '4', '5', '6'], rows: [] };
    assert.match(readZip(renderReportDocx(sampleDoc({}, [six]))).get('word/document.xml')!.toString('utf8'), /w:h="16838"/);
  });
  test('أقصى حجم (5000 صف × 8 أعمدة): زمن معقول وبنية سليمة وكل الصفوف', () => {
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
  test('DOCX: هروب الرموز وحذف أحرف التحكم', () => {
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
  test('قيم فارغة: لا تظهر undefined أو null أو NaN أو [object', () => {
    const d = sampleDoc({ filtersText: '', createdBy: '' }, [{ type: 'table', columns: ['أ', 'ب'], rows: [['', '—'], ['x', '']] }, { type: 'text', text: '' }]);
    const all = renderReportHtml(d) + readZip(renderReportDocx(d)).get('word/document.xml')!.toString('utf8');
    assert.doesNotMatch(all, /undefined|\bnull\b|NaN|\[object/);
  });
  test('كل أنواع التقارير العشرة تنتج DOCX وHTML صالحين', () => {
    assert.equal(REPORT_CATALOG.length, 10);
    for (const def of REPORT_CATALOG) {
      const d = sampleDoc({ kind: def.kind, title: def.title });
      assertWellFormed(readZip(renderReportDocx(d)).get('word/document.xml')!.toString('utf8'), def.kind);
      assert.ok(renderReportHtml(d).includes(def.title));
    }
  });
  test('محارف تجاوز الاتجاه تُحذف من النصوص المُصدَّرة', () => {
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
  test('قائمة خطوط عربية مع بدائل Android', () => {
    const fam = /font-family: ([^;]+);/.exec(html)![1];
    for (const f of ['Noto Naskh Arabic', 'Noto Sans Arabic', 'Tahoma', 'Arial']) assert.ok(fam.includes(f), f);
    assert.match(fam, /sans-serif$/);
  });
  test('إعدادات الطباعة: A4 وترويسة جدول متكررة ومنع كسر الصف', () => {
    assert.match(html, /@page \{ size: A4;/); assert.match(html, /thead \{ display: table-header-group; \}/); assert.match(html, /tr \{ page-break-inside: avoid; \}/);
    assert.match(html, /h2 \{[^}]*page-break-after: avoid/);
  });
  test('كل جدول بيانات له thead والخلايا لليمين', () => {
    const tables = html.match(/<table>/g)!.length, theads = html.match(/<thead>/g)!.length;
    assert.ok(tables > theads && theads >= 3);
    assert.match(html, /th, td \{[^}]*text-align: right;/);
  });
  test('لا موارد خارجية', () => {
    assert.doesNotMatch(html, /https?:\/\//i); assert.doesNotMatch(html, /<(img|link|iframe|script)\b/i);
    assert.doesNotMatch(html, /@import|url\(/i);
  });
  test('نصوص عربية سليمة: العنوان والمرجع المختلط والتشكيل والنص الطويل', () => {
    for (const s of ['تقرير قضية منفردة', MIXED, TASHKEEL, 'وزارة الداخلية', 'التوقيع', 'الختم الرسمي']) assert.ok(html.includes(s), s);
    assert.ok(html.includes(LONG.slice(0, 300)));
  });
  test('خانات التوقيع أسفل الصفحة', () => {
    assert.ok(html.indexOf('class="sign"') > html.lastIndexOf('</table>'));
  });
});
