// SECURECASEDESK_PHASE9_S3
// أنواع نظام التقارير. لا تعتمد على React Native ليعمل الكود نفسه في اختبارات Node.

import type { Permission } from '../../security/permissions';

export type ReportKind =
  | 'case_file'
  | 'cases_list'
  | 'memos_list'
  | 'detainees_current'
  | 'detainees_admissions_releases'
  | 'detainees_stats'
  | 'detainee_movements'
  | 'correction_history'
  | 'admin_summary'
  | 'operations';

export type ReportFormat = 'pdf' | 'docx' | 'xlsx' | 'txt';

export interface ReportFilters {
  caseId?: string;          // case_file
  status?: string;          // cases_list / memos_list
  departmentId?: string;    // cases_list
  officerId?: string;       // cases_list / detainees_current
  dateFrom?: number;        // ميلادي بالمللي ثانية، بداية اليوم
  dateTo?: number;          // نهاية اليوم
  detaineeId?: string;      // detainee_movements / correction_history
  thresholdDays?: number;   // detainees_stats (المدة المتجاوزة)
}

export interface ReportDefinition {
  kind: ReportKind;
  title: string;
  description: string;
  permission: Permission;
  needsCase?: boolean;
  supportsDates?: boolean;
}

export const REPORT_CATALOG: readonly ReportDefinition[] = [
  { kind: 'case_file', title: 'تقرير قضية منفردة', description: 'ملف القضية كاملاً مع المذكرات والمرفقات المرتبطة', permission: 'cases.view', needsCase: true },
  { kind: 'cases_list', title: 'سجل القضايا', description: 'كل القضايا مع إمكانية التصفية بالحالة والفترة', permission: 'cases.view', supportsDates: true },
  { kind: 'memos_list', title: 'سجل المذكرات', description: 'المذكرات الرسمية مع إحصاء الأنواع', permission: 'memos.view', supportsDates: true },
  { kind: 'detainees_current', title: 'سجل المحتجزين الحاليين', description: 'المحتجزون الموجودون حالياً ومدة احتجاز كل منهم', permission: 'detainees.view' },
  { kind: 'detainees_admissions_releases', title: 'تقرير الإيداع والإفراج', description: 'حالات الإيداع والإفراج خلال فترة محددة', permission: 'detainees.view', supportsDates: true },
  { kind: 'detainees_stats', title: 'إحصاءات المحتجزين', description: 'حسب الفئة وجهة الحجز والمسؤول ومدد الاحتجاز', permission: 'detainees.view' },
  { kind: 'detainee_movements', title: 'سجل حركات المحتجزين', description: 'السجل التاريخي للحركات غير القابل للتعديل', permission: 'detainees.view', supportsDates: true },
  { kind: 'correction_history', title: 'سجل التصحيحات', description: 'تاريخ تصحيح بيانات المحتجزين مع القيم السابقة', permission: 'detainees.correct', supportsDates: true },
  { kind: 'admin_summary', title: 'التقرير الإداري الشامل', description: 'إحصاءات القضايا والمذكرات والمحتجزين وأداء الأقسام', permission: 'dashboard.view' },
  { kind: 'operations', title: 'تقرير العمليات والتعديلات', description: 'ملخص سجل التدقيق دون كشف القيم الحساسة', permission: 'audit.view', supportsDates: true },
] as const;

export function getReportDefinition(kind: string): ReportDefinition | null {
  return REPORT_CATALOG.find((r) => r.kind === kind) ?? null;
}

// ===== نموذج المستند المحايد (يُحوَّل إلى HTML/PDF وإلى DOCX) =====

export interface KeyValueRow { label: string; value: string }

export type ReportSection =
  | { type: 'kv'; heading?: string; rows: KeyValueRow[] }
  | { type: 'table'; heading?: string; columns: string[]; rows: string[][]; emptyText?: string }
  | { type: 'text'; heading?: string; text: string };

export interface ReportDocument {
  kind: ReportKind;
  title: string;
  documentNumber: string;   // مثال: SCD-20261120-AB12-CA
  createdAt: number;
  createdBy: string;
  filtersText: string;      // وصف الفلاتر المطبقة بالعربية
  sections: ReportSection[];
  rowCount: number;         // لسجل التدقيق (بدون محتوى)
}

export class ReportError extends Error {
  constructor(public readonly code: 'INVALID_KIND' | 'CASE_REQUIRED' | 'NOT_FOUND' | 'INVALID_RANGE' | 'TOO_LARGE' | 'SUMMARY_INVALID') {
    super('REPORT_' + code);
    this.name = 'ReportError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const REPORT_ERROR_MESSAGES: Record<ReportError['code'], string> = {
  INVALID_KIND: 'نوع التقرير غير معروف.',
  CASE_REQUIRED: 'اختر قضية لإنشاء تقرير القضية.',
  NOT_FOUND: 'السجل المطلوب غير موجود.',
  INVALID_RANGE: 'تاريخ البداية يجب ألا يكون بعد تاريخ النهاية.',
  TOO_LARGE: 'عدد السجلات كبير جداً. ضيّق الفترة أو الفلاتر.',
  SUMMARY_INVALID: 'نص الملخص فارغ أو غير صالح.',
};

export const MAX_REPORT_ROWS = 5000;

// SECURECASEDESK_REPORT_STAGES: فشل مرحلة محددة من الإنشاء (بدل رسالة «خطأ غير متوقع» العامة).
export type ReportStage = 'build' | 'render' | 'write' | 'verify' | 'audit';
export const REPORT_STAGE_LABELS: Record<ReportStage, string> = {
  build: 'قراءة البيانات وبناء المستند',
  render: 'تحويل المستند إلى الصيغة المطلوبة (PDF/Word/Excel)',
  write: 'كتابة الملف على الجهاز',
  verify: 'التحقق من سلامة الملف',
  audit: 'تسجيل العملية في سجل التدقيق',
};
export class ReportStageError extends Error {
  constructor(public readonly stage: ReportStage, public readonly detail: string) {
    super('REPORT_STAGE_' + stage + ': ' + detail);
    this.name = 'ReportStageError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ===== التلخيص داخل التقرير =====
export type ReportSummaryMode = 'none' | 'auto' | 'ai';
export type ReportSummaryOption =
  | { mode: 'none' }
  | { mode: 'auto' }
  | { mode: 'ai'; text: string };   // نص راجعه المستخدم واعتمده فعلاً
