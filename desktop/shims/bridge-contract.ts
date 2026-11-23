// عقد قنوات IPC بين الواجهة (shims) وعملية Electron الرئيسية.
// الواجهة لا ترى Node.js أبداً: فقط window.scd المكشوف من preload (القسم 2).
// القسم 2 ثبّت هذا العقد: أي قناة جديدة يجب أن تُضاف هنا وفي electron/channels.cjs و electron/preload.cjs
// (يفرض التطابق tests/electron/parity.test.mjs). تنفيذ fs/print/share في 5، db في 6، secure/auth في 7.
export const SCD_CHANNELS = {
  app:    { relaunch: 'scd:app:relaunch', reload: 'scd:app:reload', info: 'scd:app:info' },
  window: { minimize: 'scd:window:minimize', toggleMaximize: 'scd:window:toggle-maximize', close: 'scd:window:close', state: 'scd:window:state' },
  fs:     { read: 'scd:fs:read', write: 'scd:fs:write', exists: 'scd:fs:exists', remove: 'scd:fs:remove', list: 'scd:fs:list', stat: 'scd:fs:stat', mkdir: 'scd:fs:mkdir', openDialog: 'scd:fs:open-dialog', saveDialog: 'scd:fs:save-dialog' },
  db:     { open: 'scd:db:open', exec: 'scd:db:exec', run: 'scd:db:run', all: 'scd:db:all', first: 'scd:db:first', tx: 'scd:db:tx', close: 'scd:db:close' },
  secure: { get: 'scd:secure:get', set: 'scd:secure:set', remove: 'scd:secure:remove' },
  auth:   { available: 'scd:auth:available', prompt: 'scd:auth:prompt' },
  print:  { toPdf: 'scd:print:to-pdf', print: 'scd:print:print' },
  share:  { reveal: 'scd:share:reveal', available: 'scd:share:available' },
} as const;

export const SCD_EVENTS = { windowState: 'scd:event:window-state' } as const;

export type ScdErrorCode =
  | 'CHANNEL_NOT_ALLOWED' | 'EVENT_NOT_ALLOWED' | 'UNTRUSTED_SENDER' | 'INVALID_PAYLOAD'
  | 'NOT_IMPLEMENTED' | 'NO_WINDOW' | 'INTERNAL';

export interface ScdBridge {
  readonly isDesktop: true;
  readonly platform: string;
  // الأخطاء ترجع برسالة بالشكل: "[CODE] message" (contextBridge ينسخ الرسالة فقط). استخدم parseScdError.
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
  on(event: string, callback: (data: unknown) => void): () => void;
}

export function parseScdError(e: unknown): { code: ScdErrorCode | 'UNKNOWN'; message: string } {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^\[([A-Z_]+)\]\s*(.*)$/s.exec(msg);
  return m ? { code: m[1] as ScdErrorCode, message: m[2] } : { code: 'UNKNOWN', message: msg };
}

declare global {
  interface Window { scd?: ScdBridge }
}

export function getBridge(): ScdBridge | undefined {
  return typeof window !== 'undefined' ? window.scd : undefined;
}
