// Shim لـ expo-secure-store عبر Electron safeStorage (DPAPI) — القسم 7. الواجهة المستعملة في src: getItemAsync/setItemAsync/deleteItemAsync.
// المفاتيح والقيم تعبر IPC محلياً فقط ولا تُخزَّن في الواجهة. خيارات expo (keychainService وغيرها) تُتجاهل لأنها خاصة بالموبايل.
import { getBridge, parseScdError, SCD_CHANNELS } from './bridge-contract';

const CH = SCD_CHANNELS.secure;
const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

export class DesktopSecureError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'DesktopSecureError'; this.code = code; }
}

async function call<T = unknown>(channel: string, payload: unknown): Promise<T> {
  const b = getBridge();
  if (!b) throw new DesktopSecureError('NO_BRIDGE', 'جسر سطح المكتب غير متاح');
  try { return await b.invoke<T>(channel, payload); } catch (e) {
    const p = parseScdError(e);
    throw new DesktopSecureError(p.code, p.message);
  }
}
function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new DesktopSecureError('INVALID_PAYLOAD', 'اسم المفتاح غير صالح');
  return key;
}

// ثوابت للتوافق مع واجهة expo (بلا أثر على Windows).
export const AFTER_FIRST_UNLOCK = 0;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;
export const ALWAYS = 2;
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3;
export const ALWAYS_THIS_DEVICE_ONLY = 4;
export const WHEN_UNLOCKED = 5;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;

export async function isAvailableAsync(): Promise<boolean> { return getBridge() !== undefined; }

export async function getItemAsync(key: string, _options?: Record<string, unknown>): Promise<string | null> {
  const v = await call<string | null>(CH.get, { name: checkKey(key) });
  return typeof v === 'string' ? v : null;
}
export async function setItemAsync(key: string, value: string, _options?: Record<string, unknown>): Promise<void> {
  if (typeof value !== 'string') throw new DesktopSecureError('INVALID_PAYLOAD', 'القيمة يجب أن تكون نصاً');
  await call(CH.set, { name: checkKey(key), value });
}
export async function deleteItemAsync(key: string, _options?: Record<string, unknown>): Promise<void> {
  await call(CH.remove, { name: checkKey(key) });
}
