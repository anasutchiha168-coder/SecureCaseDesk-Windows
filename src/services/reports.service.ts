// SECURECASEDESK_PHASE9_S3
// خدمة التقارير للتطبيق: تبني المستند من قاعدة البيانات المشفرة (بعد فحص الصلاحيات)، ثم تنتج PDF (expo-print)
// أو DOCX (مولّد داخلي)، وتتحقق من سلامة الملف الناتج، وتسجّل العملية في سجل التدقيق (بدون محتوى التقرير).
// الملفات تُحفظ في مجلد الكاش المؤقت وتُنظَّف تلقائياً لأن التقارير تحوي بيانات حساسة غير مشفرة.

import * as Print from 'expo-print';
import * as Crypto from 'expo-crypto';
import { File, Directory, Paths } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getDb } from '@/database/db';
import { can } from '@/security/permissions';
import { requirePerm, ForbiddenError, type Session } from '@/security/guard';
import { recordSystemEvent } from '@/modules/audit/audit-integration';
import type { DbLike } from '@/modules/attachments/attachments-repo';
import { buildReport } from '@/modules/reports/reports-data';
import { renderReportHtml } from '@/modules/reports/reports-html';
import { renderReportDocx } from '@/modules/reports/reports-docx';
import { renderReportXlsx } from '@/modules/reports/reports-xlsx';
import { renderReportTxt } from '@/modules/reports/reports-txt';
import { applyReportSummary } from '@/modules/reports/reports-summary';
import { safeFileName } from '@/modules/reports/reports-format';
import {
  REPORT_CATALOG, getReportDefinition, ReportError, ReportStageError,
  type ReportDefinition, type ReportFilters, type ReportFormat, type ReportStage, type ReportSummaryOption,
} from '@/modules/reports/reports-types';

export { ReportError, ReportStageError, REPORT_ERROR_MESSAGES, REPORT_STAGE_LABELS } from '@/modules/reports/reports-types';
export type { ReportFilters, ReportFormat, ReportDefinition, ReportSummaryOption } from '@/modules/reports/reports-types';

export interface GeneratedReport {
  fileName: string;
  uri: string;
  format: ReportFormat;
  sizeBytes: number;
  sha256: string;
  rowCount: number;
  title: string;
  documentNumber: string;
  createdAt: number;
}

const KEEP_MS = 24 * 60 * 60 * 1000; // تنظيف تلقائي للملفات الأقدم من 24 ساعة

function reportsDir(): Directory {
  const d = new Directory(Paths.cache, 'reports');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

// عرض فقط: الإنفاذ الحقيقي داخل buildReport.
export function listAvailableReports(session: Session | null | undefined): ReportDefinition[] {
  if (!session) return [];
  return REPORT_CATALOG.filter((r) => can(session.role, r.permission));
}

export function cleanupOldReports(maxAgeMs: number = KEEP_MS): number {
  let n = 0;
  try {
    const now = Date.now();
    for (const item of reportsDir().list()) {
      if (item instanceof File && now - (item.modificationTime ?? 0) > maxAgeMs) { item.delete(); n++; }
    }
  } catch (e) { console.error('[Reports] تعذر التنظيف:', e); }
  return n;
}

export function deleteGeneratedReport(uri: string): void {
  const f = new File(uri);
  // لا نحذف إلا داخل مجلد التقارير.
  if (!uri.includes('/reports/')) throw new Error('INVALID_REPORT_PATH');
  if (f.exists) f.delete();
}

function verifyOutput(bytes: Uint8Array, format: ReportFormat): void {
  const head = (s: string) => s.split('').every((c, i) => bytes[i] === c.charCodeAt(0));
  const ok = format === 'txt'
    ? bytes.length > 20
    : bytes.length > 500 && (format === 'pdf' ? head('%PDF-') : head('PK'));
  if (!ok) throw new Error('REPORT_OUTPUT_INVALID');
}

// يُغلّف كل مرحلة: الأخطاء المعروفة (صلاحيات/تقارير) تمر كما هي، وغيرها تُنسب لمرحلتها مع سبب تقني مختصر،
// بدل الرسالة العامة «خطأ غير متوقع» التي كانت تخفي سبب فشل PDF.
async function stage<T>(name: ReportStage, fn: () => Promise<T> | T): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof ReportError || e instanceof ForbiddenError || e instanceof ReportStageError) throw e;
    const detail = (e instanceof Error ? e.name + ': ' + e.message : String(e)).slice(0, 220);
    console.error('[Reports] مرحلة ' + name + ':', e);
    throw new ReportStageError(name, detail);
  }
}

// PDF: نقرأ بايتات ناتج expo-print ونكتبها بأنفسنا (بدل File.move بين مجلدين) ثم نحذف الأصل،
// بنفس أسلوب الكتابة الذي ينجح مع DOCX/XLSX/TXT.
async function renderPdfTo(target: File, html: string): Promise<void> {
  const printed = await stage('render', () => Print.printToFileAsync({ html, width: 595, height: 842 }));
  const src = new File(printed.uri);
  const bytes = await stage('write', async () => await src.bytes());
  await stage('write', () => {
    if (!target.exists) target.create();
    target.write(bytes);
  });
  try { if (src.exists) src.delete(); } catch { /* الأصل في الكاش؛ لا يؤثر */ }
}

export async function generateReport(
  session: Session | null | undefined,
  kind: string,
  format: ReportFormat,
  filters: ReportFilters = {},
  summary: ReportSummaryOption = { mode: 'none' },
): Promise<GeneratedReport> {
  const def = getReportDefinition(kind);
  if (def) requirePerm(session, def.permission); // قبل أي لمس للقاعدة أو الملفات
  const database = (await stage('build', () => getDb())) as unknown as DbLike;
  const base0 = await stage('build', () => buildReport({ db: database, now: () => Date.now() }, session, kind, filters));
  const doc = applyReportSummary(base0, summary);
  if (!doc) throw new ReportError('SUMMARY_INVALID');

  cleanupOldReports();
  const dir = reportsDir();
  const base = safeFileName(doc.title, doc.createdAt) + '_' + Crypto.randomUUID().slice(0, 6);
  const fileName = base + '.' + format;
  const target = new File(dir, fileName);
  if (target.exists) target.delete();

  try {
    if (format === 'pdf') {
      await renderPdfTo(target, renderReportHtml(doc));
    } else {
      const out = await stage('render', () => (format === 'docx' ? renderReportDocx(doc) : format === 'xlsx' ? renderReportXlsx(doc) : renderReportTxt(doc)));
      await stage('write', () => { target.create(); target.write(out); });
    }
    const bytes = await stage('verify', async () => {
      const b = await target.bytes();
      verifyOutput(b, format);
      return b;
    });
    const digest = bytesToHex(sha256(bytes));

    await stage('audit', () => recordSystemEvent(session, def!.permission, {
      operationType: 'report_generate',
      entityType: 'report',
      entityId: doc.documentNumber,
      newValues: { kind: doc.kind, format, rows: doc.rowCount, size: bytes.length, sha256: digest, summary: summary.mode },
      reason: 'إنشاء تقرير ' + doc.title,
    }));

    return {
      fileName, uri: target.uri, format, sizeBytes: bytes.length, sha256: digest, rowCount: doc.rowCount,
      title: doc.title, documentNumber: doc.documentNumber, createdAt: doc.createdAt,
    };
  } catch (e) {
    // لا يبقى ملف ناقص أو غير مُدقَّق على الجهاز.
    try { if (target.exists) target.delete(); } catch { /* لا شيء */ }
    throw e;
  }
}
