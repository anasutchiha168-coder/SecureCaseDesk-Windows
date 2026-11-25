// SECURECASEDESK_PHASE8_S3
export const AUDIT_OPERATION_LABELS: Record<string, string> = {
  create: 'إنشاء',
  update: 'تعديل',
  delete: 'حذف',
  login: 'تسجيل دخول',
  logout: 'تسجيل خروج',
  failed_login: 'محاولة دخول فاشلة',
  biometric_enable: 'تفعيل الدخول بالبصمة', // SECURECASEDESK_BIOMETRIC
  biometric_unlock: 'فتح قفل التطبيق بالبصمة',
  biometric_disable: 'إيقاف الدخول بالبصمة',
  unauthorized_access: 'محاولة وصول غير مصرح بها',
  protection_test: 'فحص حماية ذاتي',
  integration_test: 'اختبار تكامل سجل التدقيق',
  verification_report: 'إنشاء تقرير تحقق',
  report_export: 'مشاركة تقرير التحقق',
  report_generate: 'إنشاء تقرير',
  report_share: 'مشاركة تقرير',
  report_print: 'طباعة تقرير',
  report_save: 'حفظ تقرير على الجهاز',
  memo_pdf: 'تصدير مذكرة PDF',
  memo_save: 'حفظ مذكرة PDF على الجهاز',
  memo_print: 'طباعة مذكرة',
  sync_completed: 'استئناف المزامنة بنجاح',
  sync_conflict: 'تعارض في المزامنة',
  sync_denied: 'رفض الخادم للمزامنة',
  backup_create: 'إنشاء نسخة احتياطية',
  backup_restore: 'استعادة نسخة احتياطية',
  attachment_add: 'إضافة مرفق',
  attachment_delete: 'حذف مرفق مصرّح',
  attachment_view: 'فتح مرفق',
  attachment_integrity_failure: 'فشل سلامة مرفق',
  permission_change: 'تغيير صلاحيات',
  ai_settings_change: 'تغيير إعدادات الذكاء الاصطناعي',
  ai_consent: 'إقرار إرسال البيانات للخدمة السحابية',
  ai_key_change: 'تغيير مفتاح الخدمة السحابية',
  ai_request: 'طلب ذكاء اصطناعي',
  ai_summary: 'تلخيص بالذكاء الاصطناعي',
  ai_summary_review: 'مراجعة ملخص ذكي',
  ai_report_summary: 'تلخيص تقرير بالذكاء الاصطناعي',
  ai_report_summary_review: 'مراجعة ملخص تقرير ذكي',
  ai_draft: 'صياغة/مراجعة مستند بالذكاء الاصطناعي',
  ai_draft_review: 'مراجعة مسودة مستند ذكية',
  ai_memo_prefill: 'فتح نموذج مذكرة من مسودة ذكية (دون حفظ)', // SECURECASEDESK_PHASE11_S5
  ai_reset: 'مسح كل بيانات الذكاء الاصطناعي', // SECURECASEDESK_PHASE11_S5
};

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  users: 'المستخدمون',
  departments: 'الأقسام',
  cases: 'القضايا',
  memos: 'المذكرات',
  memo_types: 'أنواع المذكرات',
  persons: 'الأشخاص',
  detainees: 'المحتجزون',
  detainee_categories: 'فئات المحتجزين',
  crime_classifications: 'التصنيفات القانونية للجرائم',
  detainee_movements: 'حركات المحتجزين',
  correction_history: 'سجل التصحيحات',
  session: 'جلسات الدخول',
  access: 'محاولات الوصول',
  audit: 'سجل التدقيق',
  sync: 'المزامنة',
  backup: 'النسخ الاحتياطي',
  report: 'التقارير',
  attachments: 'المرفقات',
  self_test: 'فحص ذاتي',
  ai: 'الذكاء الاصطناعي',
};

export function auditOperationLabel(value: string): string {
  return AUDIT_OPERATION_LABELS[value] ?? value;
}

export function auditEntityLabel(value: string): string {
  return AUDIT_ENTITY_LABELS[value] ?? value;
}

export const CHAIN_CODE_LABELS: Record<string, string> = {
  VALID: 'السلسلة سليمة بالكامل',
  SEQUENCE_GAP: 'ثغرة في التسلسل: حذف أو إعادة ترتيب سجل',
  BROKEN_LINK: 'انقطاع في ربط السلسلة بين سجلين',
  INVALID_HMAC: 'توقيع غير صالح: تم تعديل محتوى سجل',
  UNKNOWN_VERSION: 'إصدار توقيع غير معروف',
  SELF_TEST_FAILED: 'فشل الاختبار الذاتي لمحرك التوقيع',
  AUDIT_KEY_MISSING: 'مفتاح التوقيع مفقود: لا يمكن التحقق من سلسلة قائمة',
  AUDIT_KEY_INVALID: 'مفتاح التوقيع تالف',
  AUDIT_KEY_NOT_INITIALIZED: 'لم يُنشأ مفتاح التوقيع بعد (لا سجلات)',
};

export function chainCodeLabel(code: string): string {
  return CHAIN_CODE_LABELS[code] ?? 'نتيجة غير معروفة: ' + code;
}
