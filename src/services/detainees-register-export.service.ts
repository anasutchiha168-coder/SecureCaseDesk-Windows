// SECURECASEDESK_REGISTER_EXPORT
// تصدير «معلومية السجناء» (Excel بنفس ملف المعلومية) و«كشف المحتجزين اليومي» (PDF بنفس النموذج المعتمد).
// الصلاحية detainees.view تُفحص من الجلسة ثم من الدور الحالي في جدول المستخدمين؛ الملف يُحفظ في كاش التقارير (يُنظَّف تلقائياً)،
// ويُتحقق من سلامته، ويُسجَّل الإنشاء والمشاركة في سجل التدقيق (المشاركة إلزامية: فشل التسجيل يوقفها).

import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { File, Directory, Paths } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getDb } from '@/database/db';
import { can } from '@/security/permissions';
import { requirePerm, ForbiddenError, type Session } from '@/security/guard';
import { recordSystemEvent } from '@/modules/audit/audit-integration';
import type { DbLike } from '@/modules/attachments/attachments-repo';
import { loadRegisterRows, buildDayRegister } from '@/modules/detainees/register-data';
import { renderRegisterXlsx } from '@/modules/detainees/register-xlsx';
import { renderRegisterHtml } from '@/modules/detainees/register-html';
import { verifyXlsxPackage, REPORT_MIME, REPORT_UTI } from '@/modules/reports/reports-export-logic';
import { safeFileName } from '@/modules/reports/reports-format';

export type RegisterFormat = 'xlsx' | 'pdf';
export interface RegisterExport { fileName: string; uri: string; format: RegisterFormat; sizeBytes: number; sha256: string; rows: number }

const PERMISSION = 'detainees.view' as const;
const TITLE: Record<RegisterFormat, string> = { xlsx: 'معلومية السجناء', pdf: 'كشف المحتجزين' };

function dir(): Directory {
  const d = new Directory(Paths.cache, 'reports');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

async function authorize(db: DbLike, session: Session | null | undefined): Promise<Session> {
  const s = requirePerm(session, PERMISSION);
  const row = await db.getFirstAsync<{ role: string; is_active: number }>('SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?', [s.userId]);
  if (!row || Number(row.is_active) !== 1 || !can(row.role, PERMISSION)) throw new ForbiddenError(PERMISSION);
  return s;
}

const startsWith = (b: Uint8Array, t: string) => t.split('').every((c, i) => b[i] === c.charCodeAt(0));

export async function generateRegisterExport(session: Session | null | undefined, format: RegisterFormat, day: number = Date.now()): Promise<RegisterExport> {
  const db = (await getDb()) as unknown as DbLike;
  const s = await authorize(db, session);
  const now = Date.now();
  const rows = await loadRegisterRows(db, now);

  const fileName = safeFileName(TITLE[format], now) + '_' + Crypto.randomUUID().slice(0, 6) + '.' + format;
  const target = new File(dir(), fileName);
  if (target.exists) target.delete();
  try {
    if (format === 'xlsx') {
      target.create();
      target.write(renderRegisterXlsx({ rows, day, createdAt: now }));
    } else {
      const printed = await Print.printToFileAsync({ html: renderRegisterHtml(buildDayRegister(rows, day)), width: 842, height: 595 });
      const src = new File(printed.uri);
      const out = await src.bytes();
      target.create();
      target.write(out);
      try { if (src.exists) src.delete(); } catch { /* الأصل في الكاش */ }
    }
    const bytes = await target.bytes();
    if (format === 'xlsx') verifyXlsxPackage(bytes);
    else if (bytes.length < 500 || !startsWith(bytes, '%PDF-')) throw new Error('REGISTER_PDF_INVALID');
    const digest = bytesToHex(sha256(bytes));
    await recordSystemEvent(session, PERMISSION, {
      operationType: 'report_generate', entityType: 'report', entityId: fileName,
      newValues: { kind: 'detainees_register', format, rows: rows.length, size: bytes.length, sha256: digest },
      reason: 'إنشاء ' + TITLE[format],
    });
    void s;
    return { fileName, uri: target.uri, format, sizeBytes: bytes.length, sha256: digest, rows: rows.length };
  } catch (e) {
    try { if (target.exists) target.delete(); } catch { /* لا شيء */ }
    throw e;
  }
}

// ينشئ الملف ثم يفتح نافذة المشاركة (واتساب، البريد، حفظ في «الملفات»...).
export async function exportAndShareRegister(session: Session | null | undefined, format: RegisterFormat, day: number = Date.now()): Promise<RegisterExport> {
  const out = await generateRegisterExport(session, format, day);
  if (!(await Sharing.isAvailableAsync())) throw new Error('SHARE_UNAVAILABLE');
  await recordSystemEvent(session, PERMISSION, {
    operationType: 'report_share', entityType: 'report', entityId: out.fileName,
    newValues: { kind: 'detainees_register', format, size: out.sizeBytes, sha256: out.sha256 },
    reason: 'مشاركة ' + TITLE[format],
  }, true);
  await Sharing.shareAsync(out.uri, {
    mimeType: REPORT_MIME[format], UTI: REPORT_UTI[format], dialogTitle: format === 'xlsx' ? 'مشاركة ملف المعلومية (Excel)' : 'مشاركة كشف المحتجزين (PDF)',
  });
  return out;
}
