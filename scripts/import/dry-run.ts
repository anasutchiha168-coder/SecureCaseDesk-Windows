/// <reference types="node" />
// SECURECASEDESK_DETAINEES_V22_S1_IMPORT
// تجربة جافة: تقرأ JSON المستخرج وتطبع تقريراً بما سيحدث دون أي قاعدة بيانات ودون طباعة أسماء.
// الاستخدام: npx tsx --tsconfig tests/tsconfig.json scripts/import/dry-run.ts import-data/detainees.json
import { readFileSync } from 'node:fs';
import { planImport, type RawRow } from '../../src/modules/detainees/excel-import';

const file = process.argv[2];
if (!file) { console.error('أعطني مسار ملف JSON'); process.exit(1); }
const rows = JSON.parse(readFileSync(file, 'utf8')) as RawRow[];
const { records, summary: s } = planImport(rows);
const line = (t: string) => console.log(t);
const table = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => line('   ' + String(v).padStart(5) + '  ' + k));

line('===== تقرير التجربة الجافة (لم يُكتب شيء) =====');
line(`الصفوف المقروءة: ${s.total} | ستُستورد: ${s.imported} | ستُتخطى: ${s.skipped.length}`);
line(`محتجزون حالياً: ${s.held} | مفرج عنهم: ${s.released}`);
if (s.skipped.length) { line('\n-- المتخطاة (رقم الصف في Excel : السبب) --'); s.skipped.slice(0, 30).forEach((x) => line(`   ${x.excelRow} : ${x.reason}`)); }
line('\n-- الفئات (الجديدة منها تُنشأ تلقائياً إن لم تكن موجودة) --'); table(s.byCategory);
line('\n-- وضع السجين بعد التحويل --'); table(s.byLegalStatus);
line('\n-- نوع الخروج بعد التصنيف --'); table(s.byExitKind);
line(`   ${String(s.exitUnclassified).padStart(5)}  لم يُصنَّف (نصه محفوظ كاملاً)`);
records.filter((r) => !r.held && !r.exitKind && r.exitProcedure).forEach((r) => line(`      صف ${r.excelRow}: ${r.exitProcedure}`));
line(`\n-- أسماء متطابقة (لم تُدمج): ${s.duplicateNames} | فترات متداخلة زمنياً: ${s.overlaps} --`);
records.filter((r) => r.flags.some((f) => f.startsWith('تداخل'))).forEach((r) => line(`   م ${r.reference} (صف ${r.excelRow}): ${r.flags.filter((f) => f.startsWith('تداخل')).join('؛ ')}`));
if (s.unknownLegalStatus.length) line('\nأوضاع سجين غير معروفة: ' + s.unknownLegalStatus.join('، '));
const emptyOffense = records.filter((r) => r.flags.some((f) => f.includes('التهمة فارغة'))).length;
line(`\nتهمة فارغة (ستُسجَّل «غير مبين»): ${emptyOffense}`);
