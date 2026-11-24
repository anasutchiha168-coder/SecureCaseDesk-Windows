// Shim لـ expo-sharing: لا توجد «ورقة مشاركة» في Windows، فنفتح الملف بالبرنامج الافتراضي (PDF/صور/Office)
// أو نُظهره في المستكشف (أنواع أخرى). لا تنفيذ لأي ملف أبداً (قائمة بيضاء في main) — القسم 5.
import { SCD_CHANNELS } from './bridge-contract';
import { callAsync } from './fs-bridge';

export async function isAvailableAsync(): Promise<boolean> {
  return (await callAsync<boolean>(SCD_CHANNELS.share.available)) === true;
}
export async function shareAsync(url: string, _options?: Record<string, unknown>): Promise<void> {
  await callAsync(SCD_CHANNELS.share.reveal, { uri: url, action: 'open' });
}
