// جسر الملفات/الطباعة بين الـ shims وعملية Electron الرئيسية (القسم 5).
// callSync يستعمل IPC المتزامن لأن واجهة expo-file-system الجديدة (exists/create/write/readBytesSync) متزامنة.
import { getBridge, parseScdError } from './bridge-contract';

export class DesktopFsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DesktopFsError';
    this.code = code;
  }
}

function toError(e: unknown): DesktopFsError {
  if (e instanceof DesktopFsError) return e;
  const p = parseScdError(e);
  return new DesktopFsError(p.code, p.message);
}

export function callSync<T = unknown>(channel: string, payload?: unknown): T {
  const b = getBridge();
  if (!b || typeof b.invokeSync !== 'function') throw new DesktopFsError('NO_BRIDGE', 'جسر سطح المكتب غير متاح');
  try { return b.invokeSync<T>(channel, payload); } catch (e) { throw toError(e); }
}

export async function callAsync<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const b = getBridge();
  if (!b) throw new DesktopFsError('NO_BRIDGE', 'جسر سطح المكتب غير متاح');
  try { return await b.invoke<T>(channel, payload); } catch (e) { throw toError(e); }
}
