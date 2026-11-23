// SECURECASEDESK_PHASE9_S4
// منطق الطباعة والمشاركة (بدون React Native ليُختبر في Node): الصلاحيات، سلامة الملف قبل التصدير،
// وصيغة حدث التدقيق. الصلاحيات تُعاد عند كل عملية تصدير حتى لو كان الملف مولّداً سابقاً.

import { can } from '../../security/permissions';
import { requirePerm, ForbiddenError, type Session } from '../../security/guard';
import type { DbLike } from '../attachments/attachments-repo';
import { crc32 } from './reports-zip';
import { getReportDefinition, ReportError, type ReportDefinition, type ReportFormat } from './reports-types';

export type ExportAction = 'share' | 'print' | 'save';

export const REPORT_MIME: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
};
export const REPORT_UTI: Record<ReportFormat, string> = {
  pdf: 'com.adobe.pdf',
  docx: 'org.openxmlformats.wordprocessingml.document',
  xlsx: 'org.openxmlformats.spreadsheetml.sheet',
  txt: 'public.plain-text',
};

export const REPORT_FORMAT_LABEL: Record<ReportFormat, string> = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', txt: 'نص TXT' };

export type ExportErrorCode = 'FILE_MISSING' | 'FILE_CORRUPT' | 'SHARE_UNAVAILABLE' | 'NOT_REPORT_FILE' | 'SAVE_FAILED';

export class ExportError extends Error {
  constructor(public readonly code: ExportErrorCode) {
    super('EXPORT_' + code);
    this.name = 'ExportError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const EXPORT_ERROR_MESSAGES: Record<ExportErrorCode, string> = {
  FILE_MISSING: 'ملف التقرير لم يعد موجوداً (حُذف تلقائياً أو يدوياً). أنشئ التقرير من جديد.',
  FILE_CORRUPT: 'ملف التقرير تالف أو تغيّر بعد إنشائه، لذلك لن يُصدَّر. أنشئ التقرير من جديد.',
  SHARE_UNAVAILABLE: 'المشاركة غير متاحة على هذا الجهاز.',
  NOT_REPORT_FILE: 'المسار ليس ملف تقرير صالحاً.',
  SAVE_FAILED: 'تعذر حفظ الملف في المجلد المختار. جرّب مجلداً آخر أو استخدم «مشاركة».',
};

// فحص مزدوج: الجلسة ثم الدور الحالي من جدول المستخدمين (حساب معطّل أو دور مزوّر = رفض).
export async function authorizeReportAction(
  db: DbLike, session: Session | null | undefined, kind: string
): Promise<{ session: Session; username: string; def: ReportDefinition }> {
  const def = getReportDefinition(kind);
  if (!def) throw new ReportError('INVALID_KIND');
  const s = requirePerm(session, def.permission);
  const row = await db.getFirstAsync<{ role: string; is_active: number; username: string }>(
    'SELECT role, COALESCE(is_active, 1) AS is_active, username FROM users WHERE id = ?', [s.userId]);
  if (!row || Number(row.is_active) !== 1 || !can(row.role, def.permission)) throw new ForbiddenError(String(def.permission));
  return { session: s, username: row.username, def };
}

const startsWith = (b: Uint8Array, s: string) => b.length >= s.length && s.split('').every((c, i) => b[i] === c.charCodeAt(0));

function u16(b: Uint8Array, o: number) { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

// يتحقق من حزمة DOCX: نهاية ZIP سليمة، كل إدخال له CRC صحيح، والأجزاء الأساسية موجودة.
export function verifyDocxPackage(bytes: Uint8Array): void {
  verifyZipPackage(bytes, ['[Content_Types].xml', 'word/document.xml', '_rels/.rels']);
}

export function verifyXlsxPackage(bytes: Uint8Array): void {
  verifyZipPackage(bytes, ['[Content_Types].xml', 'xl/workbook.xml', '_rels/.rels']);
}

function verifyZipPackage(bytes: Uint8Array, required: string[]): void {
  const bad = () => { throw new ExportError('FILE_CORRUPT'); };
  if (bytes.length < 100 || !startsWith(bytes, 'PK')) bad();
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) bad();
  const count = u16(bytes, eocd + 10); const cdSize = u32(bytes, eocd + 12); const cdOff = u32(bytes, eocd + 16);
  if (count < required.length || cdOff + cdSize > bytes.length) bad();
  const dec = new TextDecoder();
  const names = new Set<string>();
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) bad();
    const method = u16(bytes, p + 10); const crc = u32(bytes, p + 16); const csize = u32(bytes, p + 20);
    const nlen = u16(bytes, p + 28); const elen = u16(bytes, p + 30); const clen = u16(bytes, p + 32); const lho = u32(bytes, p + 42);
    if (method !== 0) bad(); // مولّدنا يكتب STORED فقط
    const name = dec.decode(bytes.slice(p + 46, p + 46 + nlen));
    if (lho + 30 > bytes.length || u32(bytes, lho) !== 0x04034b50) bad();
    const start = lho + 30 + u16(bytes, lho + 26) + u16(bytes, lho + 28);
    if (start + csize > bytes.length) bad();
    if (crc32(bytes.subarray(start, start + csize)) !== crc) bad();
    names.add(name);
    p += 46 + nlen + elen + clen;
  }
  for (const req of required) if (!names.has(req)) bad();
}

// يتحقق من الملف قبل أي تصدير: النوع، البنية، والبصمة المسجلة عند الإنشاء.
export function verifyReportFile(
  bytes: Uint8Array, format: ReportFormat, expectedSha256: string, sha256Hex: (b: Uint8Array) => string
): void {
  const bad = () => { throw new ExportError('FILE_CORRUPT'); };
  if (bytes.length < (format === 'txt' ? 20 : 500)) bad();
  if (format === 'pdf') {
    if (!startsWith(bytes, '%PDF-')) bad();
    const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 1100)));
    if (!tail.includes('%%EOF')) bad();
  } else if (format === 'docx') {
    verifyDocxPackage(bytes);
  } else if (format === 'xlsx') {
    verifyXlsxPackage(bytes);
  } else {
    // TXT: BOM + نص UTF-8 صالح بلا بايتات صفرية.
    if (bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf || bytes.includes(0)) bad();
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { bad(); }
  }
  if (sha256Hex(bytes) !== expectedSha256) bad();
}

// مسار مسموح: داخل مجلد reports فقط وبامتداد pdf أو docx.
export function assertReportPath(uri: string): ReportFormat {
  const m = /\/reports\/[^/\\]+\.(pdf|docx|xlsx|txt)$/i.exec(uri);
  if (!m || uri.includes('..')) throw new ExportError('NOT_REPORT_FILE');
  return m[1].toLowerCase() as ReportFormat;
}

// حدث التدقيق: بيانات وصفية فقط، لا محتوى تقرير ولا أسماء أشخاص.
export function exportAuditEvent(
  action: ExportAction, def: ReportDefinition, info: { format: ReportFormat | 'html'; documentNumber: string; sizeBytes?: number; sha256?: string }
) {
  return {
    operationType: action === 'share' ? 'report_share' : action === 'save' ? 'report_save' : 'report_print',
    entityType: 'report',
    entityId: info.documentNumber,
    newValues: { kind: def.kind, format: info.format, size: info.sizeBytes ?? null, sha256: info.sha256 ?? null },
    reason: (action === 'share' ? 'مشاركة تقرير ' : action === 'save' ? 'حفظ تقرير على الجهاز ' : 'طباعة تقرير ') + def.title,
  };
}
