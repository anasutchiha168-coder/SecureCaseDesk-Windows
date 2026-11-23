// عقد قنوات IPC بين الواجهة (shims) وعملية Electron الرئيسية.
// الواجهة لا ترى Node.js أبداً: فقط window.scd المكشوف من preload (القسم 2).
// القنوات هنا مسودة تُثبَّت في القسم 2 وتُملأ في 5/6/7.
export const SCD_CHANNELS = {
  app:    { relaunch: 'scd:app:relaunch', info: 'scd:app:info' },
  fs:     { read: 'scd:fs:read', write: 'scd:fs:write', exists: 'scd:fs:exists', remove: 'scd:fs:remove', list: 'scd:fs:list', stat: 'scd:fs:stat', mkdir: 'scd:fs:mkdir', openDialog: 'scd:fs:open-dialog', saveDialog: 'scd:fs:save-dialog' },
  db:     { open: 'scd:db:open', exec: 'scd:db:exec', run: 'scd:db:run', all: 'scd:db:all', first: 'scd:db:first', tx: 'scd:db:tx', close: 'scd:db:close' },
  secure: { get: 'scd:secure:get', set: 'scd:secure:set', remove: 'scd:secure:remove' },
  auth:   { available: 'scd:auth:available', prompt: 'scd:auth:prompt' },
  print:  { toPdf: 'scd:print:to-pdf', print: 'scd:print:print' },
  share:  { reveal: 'scd:share:reveal', available: 'scd:share:available' },
} as const;

export interface ScdBridge {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
}

declare global {
  interface Window { scd?: ScdBridge }
}

export function getBridge(): ScdBridge | undefined {
  return typeof window !== 'undefined' ? window.scd : undefined;
}
