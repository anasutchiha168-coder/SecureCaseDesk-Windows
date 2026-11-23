// SECURECASEDESK_MEMO_PRINT
// تصدير المذكرة: PDF (مشاركة أو حفظ في مجلد يختاره المستخدم) أو طباعة مباشرة عبر خدمة الطباعة في النظام
// (تعرض الطابعات المتصلة: Wi-Fi / USB / بلوتوث / خدمات الطباعة المثبتة، ومنها «حفظ بصيغة PDF»).
// قبل كل عملية: إعادة فحص الصلاحية ونطاق القسم من القاعدة، وتسجيل الحدث في التدقيق (إلزامي).
// لا يُكتب ملف PDF خارج الكاش إلا عند «حفظ في الجهاز» بطلب صريح؛ والنسخة المؤقتة تُحذف بعد المشاركة/الحفظ.

import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';
import { getDb } from '@/database/db';
import { requirePerm, ForbiddenError, type Session } from '@/security/guard';
import { resolveCaseScope, caseDepartmentAllowed } from '@/security/case-scope';
import { recordSystemEvent } from '@/modules/audit/audit-integration';
import { renderMemoHtml, memoPdfFileName, type MemoPrintInput } from '@/modules/memos/memo-document';

export class MemoExportError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'SHARE_UNAVAILABLE' | 'PDF_INVALID' | 'SAVE_FAILED') {
    super('MEMO_EXPORT_' + code);
    this.name = 'MemoExportError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const MEMO_EXPORT_MESSAGES: Record<MemoExportError['code'], string> = {
  NOT_FOUND: 'المذكرة غير موجودة أو ليست ضمن نطاق صلاحيتك.',
  SHARE_UNAVAILABLE: 'المشاركة غير متاحة على هذا الجهاز.',
  PDF_INVALID: 'تعذر إنشاء ملف PDF صالح للمذكرة.',
  SAVE_FAILED: 'تعذر حفظ الملف في المجلد المختار. جرّب مجلداً آخر أو استخدم «مشاركة».',
};

interface Loaded { input: MemoPrintInput; id: string }

// يقرأ المذكرة من القاعدة (لا يثق بما في الواجهة) مع فحص الدور الحالي ونطاق القسم.
async function loadMemo(session: Session | null | undefined, memoId: string): Promise<Loaded> {
  const s = requirePerm(session, 'memos.view');
  const db = await getDb();
  const u = await db.getFirstAsync<{ is_active: number }>('SELECT COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?', [s.userId]);
  if (!u || Number(u.is_active) !== 1) throw new ForbiddenError('memos.view');
  const m = await db.getFirstAsync<{
    id: string; memo_number: string; memo_date: number; recipient_organization: string; subject: string;
    body: string | null; linked_case_id: string | null; status: string; type_name: string | null;
  }>(
    `SELECT m.id, m.memo_number, m.memo_date, m.recipient_organization, m.subject, m.body, m.linked_case_id, m.status,
            t.name AS type_name
     FROM memos m LEFT JOIN memo_types t ON t.id = m.memo_type_id WHERE m.id = ?`, [memoId]);
  if (!m) throw new MemoExportError('NOT_FOUND');

  let caseNumber: string | null = null;
  if (m.linked_case_id) {
    const scope = await resolveCaseScope(db, s);
    const c = await db.getFirstAsync<{ case_number: string; department_id: string | null }>(
      'SELECT case_number, department_id FROM cases WHERE id = ?', [m.linked_case_id]);
    if (!c || !caseDepartmentAllowed(scope, c.department_id)) throw new MemoExportError('NOT_FOUND');
    caseNumber = c.case_number;
  } else {
    const scope = await resolveCaseScope(db, s);
    if (scope.kind === 'none') throw new MemoExportError('NOT_FOUND');
  }
  return {
    id: m.id,
    input: {
      memoNumber: m.memo_number, memoDate: m.memo_date, typeName: m.type_name ?? '—', recipient: m.recipient_organization,
      subject: m.subject, body: m.body, caseNumber, status: m.status,
    },
  };
}

const audit = (session: Session | null | undefined, kind: 'pdf' | 'save' | 'print', l: Loaded) =>
  recordSystemEvent(session, 'memos.view', {
    operationType: kind === 'print' ? 'memo_print' : kind === 'save' ? 'memo_save' : 'memo_pdf',
    entityType: 'memos',
    entityId: l.id,
    newValues: { memo_number: l.input.memoNumber },
    reason: kind === 'print' ? 'طباعة مذكرة' : kind === 'save' ? 'حفظ مذكرة PDF على الجهاز' : 'تصدير مذكرة PDF',
  }, true);

const CACHE_DIR = 'memo-pdf';

function cacheDir(): Directory {
  const d = new Directory(Paths.cache, CACHE_DIR);
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

export function purgeMemoPdfCache(): void {
  try { const d = new Directory(Paths.cache, CACHE_DIR); if (d.exists) d.delete(); } catch { /* لا شيء */ }
}

// ينشئ PDF مؤقتاً في الكاش ويتحقق من صحته.
async function buildPdf(l: Loaded): Promise<{ file: File; bytes: Uint8Array; name: string }> {
  purgeMemoPdfCache();
  const name = memoPdfFileName(l.input.memoNumber);
  const { uri } = await Print.printToFileAsync({ html: renderMemoHtml(l.input), width: 595, height: 842 });
  const file = new File(cacheDir(), name);
  if (file.exists) file.delete();
  new File(uri).move(file);
  const bytes = await file.bytes();
  const head = '%PDF-';
  if (bytes.length < 500 || !head.split('').every((c, i) => bytes[i] === c.charCodeAt(0))) {
    try { file.delete(); } catch { /* لا شيء */ }
    throw new MemoExportError('PDF_INVALID');
  }
  return { file, bytes, name };
}

// مشاركة PDF (واتساب، البريد، «حفظ في الملفات»...).
export async function shareMemoPdf(session: Session | null | undefined, memoId: string): Promise<void> {
  const l = await loadMemo(session, memoId);
  if (!(await Sharing.isAvailableAsync())) throw new MemoExportError('SHARE_UNAVAILABLE');
  await audit(session, 'pdf', l);
  const { file, name } = await buildPdf(l);
  try {
    await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: name });
  } finally {
    purgeMemoPdfCache();
  }
}

// حفظ PDF في مجلد يختاره المستخدم. يعيد اسم الملف أو null عند الإلغاء.
export async function saveMemoPdfToDevice(session: Session | null | undefined, memoId: string): Promise<string | null> {
  const l = await loadMemo(session, memoId);
  let target: Directory;
  try {
    target = await Directory.pickDirectoryAsync();
  } catch (e) {
    if (/cancel|dismiss|abort/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
  if (!target) return null;
  await audit(session, 'save', l);
  const { bytes, name } = await buildPdf(l);
  try {
    const out = target.createFile(name, 'application/pdf');
    out.write(bytes);
    const back = await out.bytes();
    if (back.length !== bytes.length) { try { out.delete(); } catch { /* لا شيء */ } throw new MemoExportError('SAVE_FAILED'); }
    return name;
  } finally {
    purgeMemoPdfCache();
  }
}

// طباعة مباشرة: يفتح مربع الطباعة في النظام لاختيار الطابعة (أو حفظ PDF).
export async function printMemo(session: Session | null | undefined, memoId: string): Promise<void> {
  const l = await loadMemo(session, memoId);
  await audit(session, 'print', l);
  await Print.printAsync({ html: renderMemoHtml(l.input) });
}
