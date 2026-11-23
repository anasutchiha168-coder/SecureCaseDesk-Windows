// SECURECASEDESK_PHASE9_S1
// أنواع المرفقات وثوابتها. لا اعتماد على Expo هنا كي يمكن اختبارها في Node.

export type AttachmentEntityType = 'case' | 'memo' | 'detainee';

export const ATTACHMENT_ENTITY_TYPES: readonly AttachmentEntityType[] = ['case', 'memo', 'detainee'];

// الحد الأقصى لحجم الملف الواحد (التشفير يتم في الذاكرة عبر JavaScript، لذا الحد محافظ).
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_ENTITY = 100;
export const MAX_FILENAME_LENGTH = 120;
export const MIN_DELETE_REASON_LENGTH = 5;

export type AttachmentKind = 'pdf' | 'jpeg' | 'png';

export interface AttachmentRecord {
  id: string;
  entity_type: AttachmentEntityType;
  entity_id: string;
  original_name: string;
  extension: string;
  mime_type: string;
  size_bytes: number;
  sha256_plain: string;
  sha256_cipher: string;
  enc_version: number;
  status: 'active' | 'deleted';
  created_by: string;
  created_at: number;
  deleted_by: string | null;
  deleted_at: number | null;
  reason: string | null; // سبب الحذف (الاسم reason ليلتقطه سجل التدقيق كسبب تصحيح/حذف)
}

// بيانات العرض: بدون مسار التخزين.
export type AttachmentInfo = Omit<AttachmentRecord, 'status' | 'deleted_by' | 'deleted_at' | 'reason'> & {
  created_by_name: string | null;
};

export interface AttachmentSource {
  name: string;
  bytes: Uint8Array;
  declaredMime?: string | null;
}

// رسائل الأخطاء بالعربية (تُعرض للمستخدم كما هي).
export type AttachmentErrorCode =
  | 'INVALID_NAME' | 'UNSUPPORTED_TYPE' | 'EMPTY_FILE' | 'FILE_TOO_LARGE'
  | 'CONTENT_MISMATCH' | 'MIME_MISMATCH' | 'DUPLICATE' | 'LIMIT_REACHED'
  | 'ENTITY_NOT_FOUND' | 'NOT_FOUND' | 'ALREADY_DELETED' | 'REASON_REQUIRED'
  | 'INTEGRITY_FAILED' | 'DECRYPT_FAILED' | 'KEY_MISSING' | 'FILE_MISSING' | 'STORAGE_FAILED';

export const ATTACHMENT_ERROR_MESSAGES: Record<AttachmentErrorCode, string> = {
  INVALID_NAME: 'اسم الملف غير صالح.',
  UNSUPPORTED_TYPE: 'نوع الملف غير مدعوم. الأنواع المسموحة: PDF وJPG وJPEG وPNG.',
  EMPTY_FILE: 'الملف فارغ.',
  FILE_TOO_LARGE: 'حجم الملف يتجاوز الحد المسموح (15 ميغابايت).',
  CONTENT_MISMATCH: 'محتوى الملف لا يطابق امتداده. تم رفض الملف.',
  MIME_MISMATCH: 'نوع الملف المعلن لا يطابق محتواه. تم رفض الملف.',
  DUPLICATE: 'هذا الملف مرفق مسبقاً بنفس السجل.',
  LIMIT_REACHED: 'تم بلوغ الحد الأقصى لعدد المرفقات في هذا السجل.',
  ENTITY_NOT_FOUND: 'السجل المراد الإرفاق به غير موجود.',
  NOT_FOUND: 'المرفق غير موجود.',
  ALREADY_DELETED: 'المرفق محذوف مسبقاً.',
  REASON_REQUIRED: 'سبب الحذف مطلوب (5 أحرف على الأقل).',
  INTEGRITY_FAILED: 'فشل التحقق من سلامة الملف: قد يكون الملف تالفاً أو معدّلاً.',
  DECRYPT_FAILED: 'تعذر فك تشفير الملف.',
  KEY_MISSING: 'مفتاح تشفير المرفقات غير متوفر على هذا الجهاز.',
  FILE_MISSING: 'ملف المرفق غير موجود على الجهاز.',
  STORAGE_FAILED: 'تعذر حفظ الملف. لم يتم تسجيل المرفق.',
};

export class AttachmentError extends Error {
  // detail: سبب تقني مختصر (يُعرض لأخطاء التخزين فقط ليسهل تشخيصها على الجهاز؛ بلا مسارات ولا بيانات).
  constructor(public readonly code: AttachmentErrorCode, public readonly detail?: string) {
    super(ATTACHMENT_ERROR_MESSAGES[code]);
    this.name = 'AttachmentError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
