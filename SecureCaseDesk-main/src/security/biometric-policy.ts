// SECURECASEDESK_BIOMETRIC — منطق صرف (بلا اعتماديات Expo) لقرارات الدخول بالبصمة، قابل للاختبار بـ tsx.

export interface BiometricCapability {
  hasHardware: boolean;
  enrolled: boolean; // هل سجّل المستخدم بصمة (أو بيومترية) في إعدادات الجهاز؟
}

/** رسالة عربية توضح سبب عدم توفر البصمة، أو null إن كانت متاحة. */
export function unavailableReason(cap: BiometricCapability): string | null {
  if (!cap.hasHardware) return 'هذا الجهاز لا يدعم البصمة';
  if (!cap.enrolled) return 'لا توجد بصمة مسجّلة على الجهاز. أضف بصمتك من إعدادات الجهاز أولاً';
  return null;
}

export interface BiometricUserRow {
  id: string;
  username: string;
  is_active?: number | null;
}

export type BiometricLoginDecision =
  | { ok: true }
  | { ok: false; reason: string; auditReason: string };

/**
 * هل يُسمح بإكمال الدخول بالبصمة لهذا الحساب؟
 * البصمة وسيلة تحقق فقط؛ حالة الحساب تُفحص دائماً كما في الدخول بكلمة المرور.
 */
export function decideBiometricLogin(row: BiometricUserRow | null | undefined): BiometricLoginDecision {
  if (!row) {
    return { ok: false, reason: 'الحساب المرتبط بالبصمة لم يعد موجوداً. سجّل الدخول بكلمة المرور', auditReason: 'بصمة: الحساب المرتبط غير موجود' };
  }
  if (Number(row.is_active ?? 1) !== 1) {
    return { ok: false, reason: 'هذا الحساب معطّل، يرجى مراجعة مدير النظام', auditReason: 'بصمة: الحساب معطّل' };
  }
  return { ok: true };
}

// ───── قفل التطبيق التلقائي ─────
/** مهلة بقاء التطبيق مفتوحاً بعد الخروج منه قبل أن يُقفل ويطلب البصمة (دقيقة واحدة). */
export const BIOMETRIC_LOCK_TIMEOUT_MS = 60_000;

/**
 * هل يُقفل التطبيق عند العودة إليه؟
 * backgroundedAt: لحظة خروج المستخدم من التطبيق (null = لم يخرج). ساعة غير منطقية (الآن < الخروج) تُعامل كقفل احتياطاً.
 */
export function shouldLockAfterBackground(
  backgroundedAt: number | null,
  now: number,
  timeoutMs: number = BIOMETRIC_LOCK_TIMEOUT_MS
): boolean {
  if (backgroundedAt === null) return false;
  const away = now - backgroundedAt;
  if (away < 0) return true;
  return away >= timeoutMs;
}
