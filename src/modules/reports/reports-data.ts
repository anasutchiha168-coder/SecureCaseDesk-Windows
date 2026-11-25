// SECURECASEDESK_PHASE9_S3
// بناء مستندات التقارير من بيانات SecureCaseDesk الفعلية. الاعتماديات محقونة (قاعدة بيانات، ساعة)
// ليعمل الكود نفسه في التطبيق وفي اختبارات Node. الصلاحيات تُفحص مرتين: الجلسة ثم الدور الحالي في قاعدة البيانات.

import { can } from '../../security/permissions';
import { requirePerm, ForbiddenError, type Session } from '../../security/guard';
import { resolveCaseScope, caseScopeSql, memoScopeSql, caseDepartmentAllowed, type CaseScope } from '../../security/case-scope'; // SECURECASEDESK_FIX_L1_G1_G2
import type { DbLike } from '../attachments/attachments-repo';
import {
  getReportDefinition, ReportError, MAX_REPORT_ROWS,
  type ReportDocument, type ReportFilters, type ReportKind, type ReportSection,
} from './reports-types';
import { cell, durationDays, endOfDay, fmtDate, fmtDateTime, fmtSize, startOfDay } from './reports-format';

export interface ReportDeps {
  db: DbLike;
  now(): number;
}

async function authorize(deps: ReportDeps, session: Session | null | undefined, perm: Parameters<typeof requirePerm>[1]): Promise<{ s: Session; username: string }> {
  const s = requirePerm(session, perm);
  const row = await deps.db.getFirstAsync<{ role: string; is_active: number; username: string }>(
    'SELECT role, COALESCE(is_active, 1) AS is_active, username FROM users WHERE id = ?', [s.userId]
  );
  if (!row || Number(row.is_active) !== 1 || !can(row.role, perm)) throw new ForbiddenError(String(perm));
  return { s, username: row.username };
}

function guardRows<T>(rows: T[]): T[] {
  if (rows.length > MAX_REPORT_ROWS) throw new ReportError('TOO_LARGE');
  return rows;
}

function range(f: ReportFilters): { from: number | null; to: number | null } {
  const from = f.dateFrom ? startOfDay(f.dateFrom) : null;
  const to = f.dateTo ? endOfDay(f.dateTo) : null;
  if (from !== null && to !== null && from > to) throw new ReportError('INVALID_RANGE');
  return { from, to };
}

function rangeText(from: number | null, to: number | null): string {
  if (from === null && to === null) return 'كل الفترات';
  return 'من ' + (from ? fmtDate(from) : 'البداية') + ' إلى ' + (to ? fmtDate(to) : 'اليوم');
}

function countBy(rows: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r, (m.get(r) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function groupTable(heading: string, first: string, rows: string[]): ReportSection {
  return { type: 'table', heading, columns: [first, 'العدد'], rows: countBy(rows).map(([k, v]) => [k, String(v)]), emptyText: 'لا توجد بيانات.' };
}

function docNumber(kind: ReportKind, now: number, id: string): string {
  // أحرف لاتينية وأرقام فقط كي لا يتشوش ترتيب الاتجاه عند عرضه ضمن نص عربي.
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 'SCD-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + h.toString(36).toUpperCase().padStart(4, '0').slice(-4) + '-' + kind.slice(0, 2).toUpperCase();
}

// ===== البناة =====

async function buildCaseFile(deps: ReportDeps, f: ReportFilters, can2: (p: Parameters<typeof can>[1]) => boolean, scope: CaseScope): Promise<{ filtersText: string; sections: ReportSection[]; rowCount: number }> {
  if (!f.caseId) throw new ReportError('CASE_REQUIRED');
  const c = await deps.db.getFirstAsync<Record<string, string | number | null>>(
    `SELECT c.*, d.name AS department_name, u.username AS officer_name, cb.username AS creator_name
     FROM cases c
     LEFT JOIN departments d ON d.id = c.department_id
     LEFT JOIN users u ON u.id = c.officer_id
     LEFT JOIN users cb ON cb.id = c.created_by
     WHERE c.id = ?`, [f.caseId]);
  if (!c || !caseDepartmentAllowed(scope, c.department_id as string | null)) throw new ReportError('NOT_FOUND');

  const sections: ReportSection[] = [
    { type: 'kv', heading: 'بيانات القضية', rows: [
      { label: 'رقم القضية', value: cell(c.case_number) },
      { label: 'عنوان القضية', value: cell(c.title) },
      { label: 'نوع القضية', value: cell(c.case_type) },
      { label: 'الحالة', value: cell(c.status) },
      { label: 'القسم المختص', value: cell(c.department_name) },
      { label: 'الضابط المسؤول', value: cell(c.officer_name) },
      { label: 'تاريخ التسجيل', value: fmtDate(Number(c.registration_date)) },
      { label: 'مكان الحادثة', value: cell(c.incident_location) },
      { label: 'المشتكي / المجني عليه', value: cell(c.complainant) },
      { label: 'المتهمون والأطراف', value: cell(c.suspects) },
      { label: 'سجّلها', value: cell(c.creator_name) },
      { label: 'آخر تعديل', value: fmtDateTime(Number(c.updated_at)) },
    ] },
    { type: 'text', heading: 'تفاصيل الحادثة', text: cell(c.incident_details) },
  ];
  let rowCount = 1;

  if (can2('memos.view')) {
    const memos = await deps.db.getAllAsync<{ memo_number: string; memo_date: number; subject: string; status: string; type_name: string | null }>(
      `SELECT m.memo_number, m.memo_date, m.subject, m.status, t.name AS type_name
       FROM memos m LEFT JOIN memo_types t ON t.id = m.memo_type_id
       WHERE m.linked_case_id = ? ORDER BY m.memo_date DESC`, [f.caseId]);
    rowCount += memos.length;
    sections.push({ type: 'table', heading: 'المذكرات المرتبطة', columns: ['رقم المذكرة', 'النوع', 'التاريخ', 'الموضوع', 'الحالة'],
      rows: memos.map((m) => [m.memo_number, cell(m.type_name), fmtDate(m.memo_date), m.subject, m.status]), emptyText: 'لا توجد مذكرات مرتبطة.' });
  }

  const atts = await deps.db.getAllAsync<{ original_name: string; extension: string; size_bytes: number; sha256_plain: string; created_at: number }>(
    `SELECT original_name, extension, size_bytes, sha256_plain, created_at FROM attachments
     WHERE entity_type = 'case' AND entity_id = ? AND status = 'active' ORDER BY created_at DESC`, [f.caseId]);
  rowCount += atts.length;
  sections.push({ type: 'table', heading: 'المرفقات', columns: ['اسم الملف', 'النوع', 'الحجم', 'تاريخ الإضافة', 'بصمة SHA-256 (أول 16)'],
    rows: atts.map((a) => [a.original_name, a.extension.toUpperCase(), fmtSize(a.size_bytes), fmtDate(a.created_at), a.sha256_plain.slice(0, 16)]), emptyText: 'لا توجد مرفقات.' });

  return { filtersText: 'القضية رقم ' + cell(c.case_number), sections, rowCount };
}

async function buildCasesList(deps: ReportDeps, f: ReportFilters, scope: CaseScope) {
  const { from, to } = range(f);
  const where: string[] = []; const args: unknown[] = [];
  if (f.status) { where.push('c.status = ?'); args.push(f.status); }
  if (f.departmentId) { where.push('c.department_id = ?'); args.push(f.departmentId); }
  if (f.officerId) { where.push('c.officer_id = ?'); args.push(f.officerId); }
  if (from !== null) { where.push('c.registration_date >= ?'); args.push(from); }
  if (to !== null) { where.push('c.registration_date <= ?'); args.push(to); }
  { const sc = caseScopeSql(scope, 'c.department_id'); where.push(sc.sql); args.push(...sc.args); }
  const rows = guardRows(await deps.db.getAllAsync<{ case_number: string; title: string; case_type: string; status: string; registration_date: number; department_name: string | null; officer_name: string | null }>(
    `SELECT c.case_number, c.title, c.case_type, c.status, c.registration_date, d.name AS department_name, u.username AS officer_name
     FROM cases c LEFT JOIN departments d ON d.id = c.department_id LEFT JOIN users u ON u.id = c.officer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.registration_date DESC LIMIT ${MAX_REPORT_ROWS + 1}`, args));
  const parts = [rangeText(from, to)];
  if (f.status) parts.push('الحالة: ' + f.status);
  return {
    filtersText: parts.join(' — '), rowCount: rows.length,
    sections: [
      { type: 'kv', heading: 'الملخص', rows: [{ label: 'عدد القضايا', value: String(rows.length) }] },
      groupTable('حسب الحالة', 'الحالة', rows.map((r) => r.status)),
      groupTable('حسب القسم', 'القسم', rows.map((r) => cell(r.department_name))),
      { type: 'table', heading: 'القضايا', columns: ['رقم القضية', 'العنوان', 'النوع', 'الحالة', 'القسم', 'الضابط', 'التاريخ'],
        rows: rows.map((r) => [r.case_number, r.title, r.case_type, r.status, cell(r.department_name), cell(r.officer_name), fmtDate(r.registration_date)]), emptyText: 'لا توجد قضايا مطابقة.' },
    ] as ReportSection[],
  };
}

async function buildMemosList(deps: ReportDeps, f: ReportFilters, scope: CaseScope) {
  const { from, to } = range(f);
  const where: string[] = []; const args: unknown[] = [];
  if (f.status) { where.push('m.status = ?'); args.push(f.status); }
  if (from !== null) { where.push('m.memo_date >= ?'); args.push(from); }
  if (to !== null) { where.push('m.memo_date <= ?'); args.push(to); }
  { const sc = memoScopeSql(scope, 'm.linked_case_id'); where.push(sc.sql); args.push(...sc.args); }
  const rows = guardRows(await deps.db.getAllAsync<{ memo_number: string; memo_date: number; recipient_organization: string; subject: string; status: string; type_name: string | null; case_number: string | null }>(
    `SELECT m.memo_number, m.memo_date, m.recipient_organization, m.subject, m.status, t.name AS type_name, c.case_number
     FROM memos m LEFT JOIN memo_types t ON t.id = m.memo_type_id LEFT JOIN cases c ON c.id = m.linked_case_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.memo_date DESC LIMIT ${MAX_REPORT_ROWS + 1}`, args));
  return {
    filtersText: rangeText(from, to) + (f.status ? ' — الحالة: ' + f.status : ''), rowCount: rows.length,
    sections: [
      { type: 'kv', heading: 'الملخص', rows: [{ label: 'عدد المذكرات', value: String(rows.length) }] },
      groupTable('حسب النوع', 'نوع المذكرة', rows.map((r) => cell(r.type_name))),
      { type: 'table', heading: 'المذكرات', columns: ['الرقم', 'النوع', 'التاريخ', 'الجهة المرسل إليها', 'الموضوع', 'القضية', 'الحالة'],
        rows: rows.map((r) => [r.memo_number, cell(r.type_name), fmtDate(r.memo_date), r.recipient_organization, r.subject, cell(r.case_number), r.status]), emptyText: 'لا توجد مذكرات مطابقة.' },
    ] as ReportSection[],
  };
}

interface DetRow { reference_number: string; full_name: string; admission_date: number; release_date: number | null; status: string; category_name: string | null; detaining_authority: string; officer_name: string | null; alleged_offense: string; id_number: string | null; legal_status: string | null; exit_type: string | null; period_no: number | null; classification_name: string | null }
const DET_SQL = `SELECT d.reference_number, d.full_name, d.admission_date, d.release_date, d.status, d.detaining_authority, d.alleged_offense,
  c.name AS category_name, u.username AS officer_name,
  p.id_number AS id_number, d.legal_status AS legal_status, d.exit_type AS exit_type, d.period_no AS period_no, k.name AS classification_name
  FROM detainees d LEFT JOIN persons p ON p.id = d.person_id LEFT JOIN detainee_categories c ON c.id = d.category_id
  LEFT JOIN crime_classifications k ON k.id = d.classification_id LEFT JOIN users u ON u.id = d.officer_id`;

function periodText(n: number | null | undefined): string {
  const p = n && n > 0 ? n : 1;
  return p > 1 ? p + ' (إعادة احتجاز)' : String(p);
}

async function buildDetaineesCurrent(deps: ReportDeps, f: ReportFilters) {
  const now = deps.now();
  const args: unknown[] = ['محتجز']; let extra = '';
  if (f.officerId) { extra = ' AND d.officer_id = ?'; args.push(f.officerId); }
  const rows = guardRows(await deps.db.getAllAsync<DetRow>(`${DET_SQL} WHERE d.status = ?${extra} ORDER BY d.admission_date ASC LIMIT ${MAX_REPORT_ROWS + 1}`, args));
  return {
    filtersText: 'المحتجزون الحاليون حتى ' + fmtDate(now), rowCount: rows.length,
    sections: [
      { type: 'kv', heading: 'الملخص', rows: [{ label: 'عدد المحتجزين الحاليين', value: String(rows.length) }] },
      { type: 'table', heading: 'سجل المحتجزين الحاليين', columns: ['الرقم المرجعي', 'الاسم', 'الفئة', 'جهة الحجز', 'التهمة', 'تاريخ الإيداع', 'المدة (يوم)', 'رقم الهوية', 'وضع السجين', 'الفترة'],
        rows: rows.map((r) => [r.reference_number, r.full_name, cell(r.category_name), r.detaining_authority, r.alleged_offense, fmtDate(r.admission_date), String(durationDays(r.admission_date, null, now)), cell(r.id_number), cell(r.legal_status), periodText(r.period_no)]), emptyText: 'لا يوجد محتجزون حالياً.' },
    ] as ReportSection[],
  };
}

async function buildAdmissionsReleases(deps: ReportDeps, f: ReportFilters) {
  const { from, to } = range(f); const now = deps.now();
  const adm = guardRows(await deps.db.getAllAsync<DetRow>(
    `${DET_SQL} WHERE (? IS NULL OR d.admission_date >= ?) AND (? IS NULL OR d.admission_date <= ?) ORDER BY d.admission_date DESC LIMIT ${MAX_REPORT_ROWS + 1}`, [from, from, to, to]));
  const rel = guardRows(await deps.db.getAllAsync<DetRow>(
    `${DET_SQL} WHERE d.release_date IS NOT NULL AND (? IS NULL OR d.release_date >= ?) AND (? IS NULL OR d.release_date <= ?) ORDER BY d.release_date DESC LIMIT ${MAX_REPORT_ROWS + 1}`, [from, from, to, to]));
  return {
    filtersText: rangeText(from, to), rowCount: adm.length + rel.length,
    sections: [
      { type: 'kv', heading: 'الملخص', rows: [{ label: 'حالات الإيداع', value: String(adm.length) }, { label: 'حالات الإفراج', value: String(rel.length) }] },
      { type: 'table', heading: 'حالات الإيداع', columns: ['الرقم المرجعي', 'الاسم', 'الفئة', 'جهة الحجز', 'تاريخ الإيداع', 'الفترة'],
        rows: adm.map((r) => [r.reference_number, r.full_name, cell(r.category_name), r.detaining_authority, fmtDate(r.admission_date), periodText(r.period_no)]), emptyText: 'لا توجد حالات إيداع.' },
      { type: 'table', heading: 'حالات الإفراج', columns: ['الرقم المرجعي', 'الاسم', 'تاريخ الإيداع', 'تاريخ الإفراج', 'المدة (يوم)', 'نوع الخروج'],
        rows: rel.map((r) => [r.reference_number, r.full_name, fmtDate(r.admission_date), fmtDate(r.release_date), String(durationDays(r.admission_date, r.release_date, now)), cell(r.exit_type)]), emptyText: 'لا توجد حالات إفراج.' },
    ] as ReportSection[],
  };
}

async function buildDetaineesStats(deps: ReportDeps, f: ReportFilters) {
  const now = deps.now();
  const threshold = Number.isFinite(f.thresholdDays) && (f.thresholdDays as number) > 0 ? Math.floor(f.thresholdDays as number) : 30;
  const all = guardRows(await deps.db.getAllAsync<DetRow>(`${DET_SQL} LIMIT ${MAX_REPORT_ROWS + 1}`));
  const current = all.filter((r) => r.status === 'محتجز');
  const t0 = startOfDay(now); const t1 = endOfDay(now);
  const durs = current.map((r) => durationDays(r.admission_date, null, now));
  const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
  const over = current.filter((r) => durationDays(r.admission_date, null, now) > threshold);
  return {
    filtersText: 'حتى ' + fmtDate(now) + ' — حد المدة: ' + threshold + ' يوماً', rowCount: all.length,
    sections: [
      { type: 'kv', heading: 'الملخص', rows: [
        { label: 'المحتجزون الحاليون', value: String(current.length) },
        { label: 'إيداع اليوم', value: String(all.filter((r) => r.admission_date >= t0 && r.admission_date <= t1).length) },
        { label: 'إفراج اليوم', value: String(all.filter((r) => r.release_date !== null && r.release_date >= t0 && r.release_date <= t1).length) },
        { label: 'متوسط مدة الاحتجاز الحالية (يوم)', value: String(avg) },
        { label: 'أطول مدة حالية (يوم)', value: String(durs.length ? Math.max(...durs) : 0) },
        { label: 'تجاوزوا ' + threshold + ' يوماً', value: String(over.length) },
      ] },
      groupTable('الحاليون حسب الفئة', 'الفئة', current.map((r) => cell(r.category_name))),
      groupTable('الحاليون حسب جهة الحجز', 'جهة الحجز', current.map((r) => r.detaining_authority)),
      groupTable('الحاليون حسب التصنيف القانوني', 'التصنيف القانوني', current.map((r) => cell(r.classification_name))),
      groupTable('الحاليون حسب المسؤول', 'الضابط المسؤول', current.map((r) => cell(r.officer_name))),
      { type: 'table', heading: 'المتجاوزون للمدة المحددة', columns: ['الرقم المرجعي', 'الاسم', 'تاريخ الإيداع', 'المدة (يوم)'],
        rows: over.map((r) => [r.reference_number, r.full_name, fmtDate(r.admission_date), String(durationDays(r.admission_date, null, now))]), emptyText: 'لا يوجد من تجاوز المدة.' },
    ] as ReportSection[],
  };
}

async function buildMovements(deps: ReportDeps, f: ReportFilters) {
  const { from, to } = range(f);
  const args: unknown[] = [from, from, to, to]; let extra = '';
  if (f.detaineeId) { extra = ' AND m.detainee_id = ?'; args.push(f.detaineeId); }
  const rows = guardRows(await deps.db.getAllAsync<{ movement_number: string; movement_type: string; movement_date: number; previous_authority: string | null; new_authority: string | null; reason: string | null; full_name: string; reference_number: string; username: string | null; related: string | null }>(
    `SELECT m.movement_number, m.movement_type, m.movement_date, m.previous_authority, m.new_authority, m.reason,
            d.full_name, d.reference_number, u.username, r.movement_number AS related
     FROM detainee_movements m JOIN detainees d ON d.id = m.detainee_id
     LEFT JOIN users u ON u.id = m.executed_by LEFT JOIN detainee_movements r ON r.id = m.related_movement_id
     WHERE (? IS NULL OR m.movement_date >= ?) AND (? IS NULL OR m.movement_date <= ?)${extra}
     ORDER BY m.movement_date DESC, m.created_at DESC LIMIT ${MAX_REPORT_ROWS + 1}`, args));
  return {
    filtersText: rangeText(from, to), rowCount: rows.length,
    sections: [
      { type: 'kv', heading: 'الملخص', rows: [{ label: 'عدد الحركات', value: String(rows.length) }] },
      groupTable('حسب نوع الحركة', 'نوع الحركة', rows.map((r) => r.movement_type)),
      { type: 'table', heading: 'سجل الحركات', columns: ['رقم الحركة', 'المحتجز', 'النوع', 'التاريخ', 'الجهة السابقة', 'الجهة الجديدة', 'المنفّذ', 'السبب', 'مرتبطة بـ'],
        rows: rows.map((r) => [r.movement_number, r.full_name + ' (' + r.reference_number + ')', r.movement_type, fmtDate(r.movement_date), cell(r.previous_authority), cell(r.new_authority), cell(r.username), cell(r.reason), cell(r.related)]), emptyText: 'لا توجد حركات.' },
    ] as ReportSection[],
  };
}

async function buildCorrections(deps: ReportDeps, f: ReportFilters) {
  const { from, to } = range(f);
  const args: unknown[] = [from, from, to, to]; let extra = '';
  if (f.detaineeId) { extra = ' AND h.detainee_id = ?'; args.push(f.detaineeId); }
  const rows = guardRows(await deps.db.getAllAsync<{ full_name: string; reference_number: string; field_name: string; previous_value: string | null; new_value: string | null; reason: string; username: string | null; created_at: number }>(
    `SELECT d.full_name, d.reference_number, h.field_name, h.previous_value, h.new_value, h.reason, u.username, h.created_at
     FROM correction_history h JOIN detainees d ON d.id = h.detainee_id LEFT JOIN users u ON u.id = h.executed_by
     WHERE (? IS NULL OR h.created_at >= ?) AND (? IS NULL OR h.created_at <= ?)${extra}
     ORDER BY h.created_at DESC LIMIT ${MAX_REPORT_ROWS + 1}`, args));
  return {
    filtersText: rangeText(from, to), rowCount: rows.length,
    sections: [
      { type: 'kv', heading: 'الملخص', rows: [{ label: 'عدد التصحيحات', value: String(rows.length) }] },
      { type: 'table', heading: 'سجل التصحيحات', columns: ['المحتجز', 'الحقل', 'القيمة السابقة', 'القيمة الجديدة', 'السبب', 'المنفّذ', 'التاريخ'],
        rows: rows.map((r) => [r.full_name + ' (' + r.reference_number + ')', r.field_name, cell(r.previous_value), cell(r.new_value), r.reason, cell(r.username), fmtDateTime(r.created_at)]), emptyText: 'لا توجد تصحيحات.' },
    ] as ReportSection[],
  };
}

async function buildAdminSummary(deps: ReportDeps, f: ReportFilters, can2: (p: Parameters<typeof can>[1]) => boolean, scope: CaseScope) {
  const now = deps.now(); const sections: ReportSection[] = []; let rowCount = 0;
  if (can2('cases.view')) {
    const cs = await deps.db.getAllAsync<{ status: string; department_name: string | null }>(
      'SELECT c.status, d.name AS department_name FROM cases c LEFT JOIN departments d ON d.id = c.department_id WHERE ' + caseScopeSql(scope, 'c.department_id').sql,
      caseScopeSql(scope, 'c.department_id').args);
    rowCount += cs.length;
    const closed = (s: string) => s === 'مغلقة' || s === 'مؤرشفة';
    sections.push({ type: 'kv', heading: 'القضايا', rows: [
      { label: 'إجمالي القضايا', value: String(cs.length) },
      { label: 'المفتوحة', value: String(cs.filter((c) => !closed(c.status)).length) },
      { label: 'المغلقة والمؤرشفة', value: String(cs.filter((c) => closed(c.status)).length) },
    ] });
    sections.push(groupTable('القضايا حسب الحالة', 'الحالة', cs.map((c) => c.status)));
    const depts = [...new Set(cs.map((c) => cell(c.department_name)))];
    sections.push({ type: 'table', heading: 'أداء الأقسام', columns: ['القسم', 'الإجمالي', 'المفتوحة', 'المغلقة'],
      rows: depts.map((d) => { const x = cs.filter((c) => cell(c.department_name) === d); return [d, String(x.length), String(x.filter((c) => !closed(c.status)).length), String(x.filter((c) => closed(c.status)).length)]; }), emptyText: 'لا توجد بيانات.' });
  }
  if (can2('memos.view')) {
    const ms = await deps.db.getAllAsync<{ type_name: string | null }>('SELECT t.name AS type_name FROM memos m LEFT JOIN memo_types t ON t.id = m.memo_type_id WHERE ' + memoScopeSql(scope, 'm.linked_case_id').sql,
      memoScopeSql(scope, 'm.linked_case_id').args);
    rowCount += ms.length;
    sections.push({ type: 'kv', heading: 'المذكرات', rows: [{ label: 'إجمالي المذكرات', value: String(ms.length) }] });
    sections.push(groupTable('المذكرات حسب النوع', 'النوع', ms.map((m) => cell(m.type_name))));
  }
  if (can2('detainees.view')) {
    const ds = await deps.db.getAllAsync<{ status: string; admission_date: number; release_date: number | null; category_name: string | null }>(
      'SELECT d.status, d.admission_date, d.release_date, c.name AS category_name FROM detainees d LEFT JOIN detainee_categories c ON c.id = d.category_id');
    rowCount += ds.length;
    const cur = ds.filter((d) => d.status === 'محتجز');
    sections.push({ type: 'kv', heading: 'المحتجزون', rows: [
      { label: 'المحتجزون الحاليون', value: String(cur.length) },
      { label: 'إيداع اليوم', value: String(ds.filter((d) => d.admission_date >= startOfDay(now) && d.admission_date <= endOfDay(now)).length) },
      { label: 'إفراج اليوم', value: String(ds.filter((d) => d.release_date !== null && d.release_date >= startOfDay(now) && d.release_date <= endOfDay(now)).length) },
    ] });
    sections.push(groupTable('الحاليون حسب الفئة', 'الفئة', cur.map((d) => cell(d.category_name))));
  }
  if (can2('users.manage')) {
    const u = await deps.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE COALESCE(is_active,1) = 1');
    sections.push({ type: 'kv', heading: 'المستخدمون', rows: [{ label: 'المستخدمون النشطون', value: String(u?.n ?? 0) }] });
  }
  void f;
  return { filtersText: 'حتى ' + fmtDate(now), sections, rowCount };
}

async function buildOperations(deps: ReportDeps, f: ReportFilters) {
  const { from, to } = range(f);
  // لا يُعرض أي محتوى من previous_values/new_values: التقرير ملخص إحصائي فقط.
  const rows = guardRows(await deps.db.getAllAsync<{ sequence_no: number; username: string | null; operation_type: string; entity_type: string; created_at: number }>(
    `SELECT sequence_no, username, operation_type, entity_type, created_at FROM audit_logs
     WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?)
     ORDER BY sequence_no DESC LIMIT ${MAX_REPORT_ROWS + 1}`, [from, from, to, to]));
  return {
    filtersText: rangeText(from, to), rowCount: rows.length,
    sections: [
      { type: 'kv', heading: 'الملخص', rows: [{ label: 'عدد العمليات المسجلة', value: String(rows.length) }] },
      groupTable('حسب نوع العملية', 'العملية', rows.map((r) => r.operation_type)),
      groupTable('حسب الجهة المتأثرة', 'الجدول', rows.map((r) => r.entity_type)),
      groupTable('حسب المستخدم', 'المستخدم', rows.map((r) => cell(r.username))),
      { type: 'table', heading: 'آخر 100 عملية', columns: ['التسلسل', 'المستخدم', 'العملية', 'الجهة', 'الوقت'],
        rows: rows.slice(0, 100).map((r) => [String(r.sequence_no), cell(r.username), r.operation_type, r.entity_type, fmtDateTime(r.created_at)]), emptyText: 'لا توجد عمليات.' },
    ] as ReportSection[],
  };
}

// ===== الواجهة العامة =====

export async function buildReport(
  deps: ReportDeps, session: Session | null | undefined, kind: string, filters: ReportFilters = {}
): Promise<ReportDocument> {
  const def = getReportDefinition(kind);
  if (!def) throw new ReportError('INVALID_KIND');
  const { s, username } = await authorize(deps, session, def.permission);

  // دور المستخدم الحالي من قاعدة البيانات لتحديد الأقسام المسموح بها داخل التقارير المركبة.
  const roleRow = await deps.db.getFirstAsync<{ role: string }>('SELECT role FROM users WHERE id = ?', [s.userId]);
  const can2 = (p: Parameters<typeof can>[1]) => can(roleRow?.role, p);
  const scope = await resolveCaseScope(deps.db, s); // L1

  let r: { filtersText: string; sections: ReportSection[]; rowCount: number };
  switch (def.kind) {
    case 'case_file': r = await buildCaseFile(deps, filters, can2, scope); break;
    case 'cases_list': r = await buildCasesList(deps, filters, scope); break;
    case 'memos_list': r = await buildMemosList(deps, filters, scope); break;
    case 'detainees_current': r = await buildDetaineesCurrent(deps, filters); break;
    case 'detainees_admissions_releases': r = await buildAdmissionsReleases(deps, filters); break;
    case 'detainees_stats': r = await buildDetaineesStats(deps, filters); break;
    case 'detainee_movements': r = await buildMovements(deps, filters); break;
    case 'correction_history': r = await buildCorrections(deps, filters); break;
    case 'admin_summary': r = await buildAdminSummary(deps, filters, can2, scope); break;
    case 'operations': r = await buildOperations(deps, filters); break;
    default: throw new ReportError('INVALID_KIND');
  }

  const now = deps.now();
  return {
    kind: def.kind, title: def.title, documentNumber: docNumber(def.kind, now, s.userId + now),
    createdAt: now, createdBy: username, filtersText: r.filtersText, sections: r.sections, rowCount: r.rowCount,
  };
}
