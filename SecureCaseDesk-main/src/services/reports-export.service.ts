// SECURECASEDESK_PHASE9_S4
// مشاركة وطباعة التقارير على Android. قبل كل عملية: إعادة فحص الصلاحيات من قاعدة البيانات،
// والتحقق من سلامة الملف (بنية + SHA-256)، ثم تسجيل الحدث في سجل التدقيق (إلزامي: فشل التسجيل يوقف التصدير).

import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Directory, File } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getDb } from '@/database/db';
import type { Session } from '@/security/guard';
import { recordSystemEvent } from '@/modules/audit/audit-integration';
import type { DbLike } from '@/modules/attachments/attachments-repo';
import { buildReport } from '@/modules/reports/reports-data';
import { renderReportHtml } from '@/modules/reports/reports-html';
import type { ReportFilters, ReportSummaryOption } from '@/modules/reports/reports-types';
import { applyReportSummary } from '@/modules/reports/reports-summary';
import {
  assertReportPath, authorizeReportAction, exportAuditEvent, verifyReportFile,
  ExportError, EXPORT_ERROR_MESSAGES, REPORT_MIME, REPORT_UTI,
} from '@/modules/reports/reports-export-logic';
import type { GeneratedReport } from '@/services/reports.service';

export { ExportError, EXPORT_ERROR_MESSAGES };

const hex = (b: Uint8Array) => bytesToHex(sha256(b));

// يشارك ملف PDF أو DOCX المُنشأ سابقاً (واتساب، البريد، حفظ في «الملفات»...).
export async function shareReportFile(session: Session | null | undefined, report: GeneratedReport, kind: string): Promise<void> {
  const db = (await getDb()) as unknown as DbLike;
  const { def } = await authorizeReportAction(db, session, kind);
  const format = assertReportPath(report.uri);
  if (format !== report.format) throw new ExportError('NOT_REPORT_FILE');

  const file = new File(report.uri);
  if (!file.exists) throw new ExportError('FILE_MISSING');
  const bytes = await file.bytes();
  verifyReportFile(bytes, format, report.sha256, hex);

  if (!(await Sharing.isAvailableAsync())) throw new ExportError('SHARE_UNAVAILABLE');

  await recordSystemEvent(session, def.permission,
    exportAuditEvent('share', def, { format, documentNumber: report.documentNumber, sizeBytes: bytes.length, sha256: report.sha256 }), true);

  await Sharing.shareAsync(report.uri, { mimeType: REPORT_MIME[format], UTI: REPORT_UTI[format], dialogTitle: 'مشاركة التقرير' });
}

// يطبع التقرير. أندرويد لا يطبع ملفاً جاهزاً من مساره، فيُعاد بناء التقرير من البيانات الحالية
// (بنفس فحص الصلاحيات) ثم يُرسل لخدمة الطباعة الأصلية. قد تختلف الأرقام عن ملف أُنشئ قبل ساعات.
export async function printReport(session: Session | null | undefined, kind: string, filters: ReportFilters = {}, summary: ReportSummaryOption = { mode: 'none' }): Promise<void> {
  const db = (await getDb()) as unknown as DbLike;
  const { def } = await authorizeReportAction(db, session, kind);
  const built = await buildReport({ db, now: () => Date.now() }, session, kind, filters);
  const doc = applyReportSummary(built, summary) ?? built;

  await recordSystemEvent(session, def.permission,
    exportAuditEvent('print', def, { format: 'html', documentNumber: doc.documentNumber }), true);

  await Print.printAsync({ html: renderReportHtml(doc) });
}

// يحفظ نسخة من الملف في مجلد يختاره المستخدم (التنزيلات، المستندات، بطاقة SD...) عبر منتقي المجلدات في النظام.
// يعيد اسم الملف المحفوظ، أو null إن ألغى المستخدم الاختيار. بعد الحفظ يُتحقق من الطول الفعلي للنسخة.
// ملاحظة أمنية: الملف المحفوظ خارج التطبيق غير مشفر؛ يُسجَّل الحدث في التدقيق قبل الحفظ (إلزامي).
export async function saveReportToDevice(session: Session | null | undefined, report: GeneratedReport, kind: string): Promise<string | null> {
  const db = (await getDb()) as unknown as DbLike;
  const { def } = await authorizeReportAction(db, session, kind);
  const format = assertReportPath(report.uri);
  if (format !== report.format) throw new ExportError('NOT_REPORT_FILE');

  const source = new File(report.uri);
  if (!source.exists) throw new ExportError('FILE_MISSING');
  const bytes = await source.bytes();
  verifyReportFile(bytes, format, report.sha256, hex);

  let target: Directory;
  try {
    target = await Directory.pickDirectoryAsync();
  } catch (e) {
    // إلغاء المنتقي يرمي أحياناً بدل أن يعيد قيمة فارغة.
    const m = e instanceof Error ? e.message : String(e);
    if (/cancel|dismiss|abort/i.test(m)) return null;
    throw e;
  }
  if (!target) return null;

  await recordSystemEvent(session, def.permission,
    exportAuditEvent('save', def, { format, documentNumber: report.documentNumber, sizeBytes: bytes.length, sha256: report.sha256 }), true);

  const out = target.createFile(report.fileName, REPORT_MIME[format]);
  out.write(bytes);
  const back = await out.bytes();
  if (back.length !== bytes.length) { try { out.delete(); } catch { /* لا شيء */ } throw new ExportError('SAVE_FAILED'); }
  return report.fileName;
}
