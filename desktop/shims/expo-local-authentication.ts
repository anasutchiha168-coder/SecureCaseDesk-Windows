// Shim لـ expo-local-authentication على Windows — القسم 7. لا يمسّ سلوك Android.
// Windows Hello يحتاج وحدة WinRT أصلية غير موجودة في Electron؛ لذا نُعلن صراحة «لا عتاد/لا تسجيل» فتُخفي src خيار البصمة
// (biometric-policy.unavailableReason) ويبقى الدخول بكلمة المرور. لا نقبل أي نجاح مزوّر.
import { getBridge, parseScdError, SCD_CHANNELS } from './bridge-contract';

const CH = SCD_CHANNELS.auth;

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const b = getBridge();
  if (!b) throw new Error('جسر سطح المكتب غير متاح');
  try { return await b.invoke<T>(channel, payload); } catch (e) { throw new Error(parseScdError(e).message); }
}

export async function hasHardwareAsync(): Promise<boolean> {
  const r = await call<{ hasHardware: boolean }>(CH.available);
  return r.hasHardware === true;
}
export async function isEnrolledAsync(): Promise<boolean> {
  const r = await call<{ enrolled: boolean }>(CH.available);
  return r.enrolled === true;
}
export async function authenticateAsync(options?: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const message = typeof options?.promptMessage === 'string' ? options.promptMessage.slice(0, 200) : undefined;
  const r = await call<{ success: boolean; error?: string }>(CH.prompt, message ? { message } : undefined);
  return r.success === true ? { success: true } : { success: false, error: r.error || 'not_available' };
}
