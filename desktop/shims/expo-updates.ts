// Shim لـ expo-updates على Windows: إعادة تحميل الواجهة عبر Electron (scd:app:reload).
// المستدعي الوحيد في src هو _layout.tsx (إعادة التحميل بعد تغيير RTL) ويلتقط الأخطاء ويعتمد بديلاً.
import { getBridge, SCD_CHANNELS } from './bridge-contract';

export async function reloadAsync(): Promise<void> {
  const bridge = getBridge();
  if (bridge) {
    await bridge.invoke(SCD_CHANNELS.app.reload);
    return;
  }
  // تشغيل في متصفح عادي (تطوير Expo Web بلا Electron).
  if (typeof window !== 'undefined') window.location.reload();
}
