// SECURECASEDESK_BIOMETRIC — غلاف حول expo-local-authentication + تخزين ربط البصمة بالحساب.
// البصمة هنا وسيلة تحقق إضافية على الجهاز؛ لا تُخزَّن كلمة المرور ولا أي بيانات بيومترية.
// المخزَّن فقط: معرّف الحساب المرتبط بالبصمة (داخل SecureStore المحمي بنظام التشغيل).
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { unavailableReason, type BiometricCapability } from '@/security/biometric-policy';

export const BIOMETRIC_UID_KEY = 'securecase_biometric_uid';

export interface BiometricStatus extends BiometricCapability {
  available: boolean;
  reason: string | null;
}

export async function getBiometricCapability(): Promise<BiometricStatus> {
  let hasHardware = false;
  let enrolled = false;
  try {
    hasHardware = await LocalAuthentication.hasHardwareAsync();
    enrolled = hasHardware ? await LocalAuthentication.isEnrolledAsync() : false;
  } catch {
    // أي فشل = غير متاح (لا نكسر شاشة الدخول)
  }
  const reason = unavailableReason({ hasHardware, enrolled });
  return { hasHardware, enrolled, available: reason === null, reason };
}

// نافذة البصمة نفسها قد تنقل التطبيق إلى الخلفية؛ هذه العلامة تمنع عدّ ذلك «خروجاً» من التطبيق.
let promptActive = false;
export function isBiometricPromptActive(): boolean { return promptActive; }

/** يعرض نافذة البصمة. disableDeviceFallback يمنع الرجوع إلى PIN/نمط الجهاز: البصمة فقط. */
export async function promptBiometric(message: string): Promise<{ success: boolean; cancelled: boolean }> {
  promptActive = true;
  try {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: message,
      cancelLabel: 'إلغاء',
      disableDeviceFallback: true,
    });
    if (r.success) return { success: true, cancelled: false };
    const err = (r as { error?: string }).error ?? '';
    return { success: false, cancelled: err === 'user_cancel' || err === 'system_cancel' || err === 'app_cancel' };
  } catch {
    return { success: false, cancelled: false };
  } finally {
    promptActive = false;
  }
}

export async function getEnrolledUserId(): Promise<string | null> {
  try { return (await SecureStore.getItemAsync(BIOMETRIC_UID_KEY)) || null; } catch { return null; }
}
export async function setEnrolledUserId(uid: string): Promise<void> {
  await SecureStore.setItemAsync(BIOMETRIC_UID_KEY, uid);
}
export async function clearEnrolledUserId(): Promise<void> {
  try { await SecureStore.deleteItemAsync(BIOMETRIC_UID_KEY); } catch { /* لا شيء */ }
}
