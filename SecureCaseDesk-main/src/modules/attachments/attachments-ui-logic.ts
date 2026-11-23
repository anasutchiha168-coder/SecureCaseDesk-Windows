// SECURECASEDESK_PHASE9_S2
// منطق واجهة المرفقات (بدون React/Expo) كي يُختبر في Node. الصلاحيات هنا للعرض فقط؛
// الإنفاذ الحقيقي يتم في attachments-repo على مستوى البيانات.

import { can, type Permission } from '../../security/permissions';
import { ForbiddenError } from '../../security/guard';
import {
  AttachmentError, ATTACHMENT_ERROR_MESSAGES, MAX_ATTACHMENT_BYTES, MIN_DELETE_REASON_LENGTH,
  type AttachmentEntityType,
} from './attachments-types';

export const ENTITY_LABELS: Record<AttachmentEntityType, string> = {
  case: 'القضية', memo: 'المذكرة', detainee: 'المحتجز',
};

const VIEW_PERM: Record<AttachmentEntityType, Permission> = {
  case: 'cases.view', memo: 'memos.view', detainee: 'detainees.view',
};
const MANAGE_PERM: Record<AttachmentEntityType, Permission> = {
  case: 'cases.manage', memo: 'memos.manage', detainee: 'detainees.manage',
};

export interface AttachmentUiPermissions {
  canView: boolean; canAdd: boolean; canDelete: boolean; canVerify: boolean;
}

export function attachmentUiPermissions(
  role: string | null | undefined, entityType: AttachmentEntityType
): AttachmentUiPermissions {
  const canView = can(role, VIEW_PERM[entityType]);
  return {
    canView,
    canAdd: can(role, MANAGE_PERM[entityType]),
    canDelete: can(role, 'attachments.admin'),
    canVerify: canView,
  };
}

const AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
export function toArabicDigits(value: number | string): string {
  return String(value).replace(/[0-9]/g, (d) => AR_DIGITS[Number(d)]);
}

export function formatFileSize(bytes: number): string {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return toArabicDigits(n) + ' بايت';
  if (n < 1024 * 1024) return toArabicDigits((n / 1024).toFixed(1)) + ' كيلوبايت';
  return toArabicDigits((n / (1024 * 1024)).toFixed(1)) + ' ميغابايت';
}

export function fileTypeLabel(mime: string): string {
  if (mime === 'application/pdf') return 'PDF';
  if (mime === 'image/jpeg') return 'صورة JPG';
  if (mime === 'image/png') return 'صورة PNG';
  return 'ملف';
}

export function isImageMime(mime: string): boolean {
  return mime === 'image/jpeg' || mime === 'image/png';
}

// فحص مبدئي قبل قراءة الملف في الذاكرة (التحقق الكامل بالمحتوى يتم في المستودع).
export function precheckPickedFile(asset: { name?: string | null; size?: number | null }): string | null {
  const name = String(asset.name ?? '').trim();
  if (!name) return ATTACHMENT_ERROR_MESSAGES.INVALID_NAME;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (!['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) return ATTACHMENT_ERROR_MESSAGES.UNSUPPORTED_TYPE;
  if (typeof asset.size === 'number') {
    if (asset.size === 0) return ATTACHMENT_ERROR_MESSAGES.EMPTY_FILE;
    if (asset.size > MAX_ATTACHMENT_BYTES) return ATTACHMENT_ERROR_MESSAGES.FILE_TOO_LARGE;
  }
  return null;
}

export function validateDeleteReason(reason: string): string | null {
  return String(reason ?? '').trim().length >= MIN_DELETE_REASON_LENGTH
    ? null : ATTACHMENT_ERROR_MESSAGES.REASON_REQUIRED;
}

// رسالة عربية آمنة للمستخدم؛ لا تُسرّب تفاصيل داخلية.
export function friendlyAttachmentError(e: unknown): string {
  if (e instanceof AttachmentError) {
    if (e.code === 'STORAGE_FAILED' && e.detail) {
      // سبب تقني مختصر لأخطاء التخزين فقط، بعد إزالة أي مسارات.
      const d = e.detail.replace(/(file|content):\/\/\S+|\/\S+/g, '…').slice(0, 140);
      return e.message + '\n(' + d + ')';
    }
    return e.message;
  }
  if (e instanceof ForbiddenError) return 'ليس لديك صلاحية لتنفيذ هذه العملية.';
  return 'حدث خطأ غير متوقع. لم تتم العملية.';
}

export function integrityMessage(problem: 'FILE_MISSING' | 'INTEGRITY_FAILED' | 'DECRYPT_FAILED' | null): string {
  if (!problem) return 'الملف سليم: تطابقت البصمة وسلمت عملية فك التشفير.';
  return ATTACHMENT_ERROR_MESSAGES[problem];
}
