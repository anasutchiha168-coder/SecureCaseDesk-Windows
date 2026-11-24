'use strict';
// preload بوضع sandbox: لا يستطيع require إلا 'electron'. لذلك القائمة مكرّرة هنا عمداً
// ويضمن tests/electron/parity.test.mjs تطابقها مع channels.cjs و bridge-contract.ts.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  // <CHANNELS>
  'scd:app:info', 'scd:app:relaunch', 'scd:app:reload',
  'scd:window:minimize', 'scd:window:toggle-maximize', 'scd:window:close', 'scd:window:state',
  'scd:fs:read', 'scd:fs:write', 'scd:fs:exists', 'scd:fs:remove', 'scd:fs:list',
  'scd:fs:stat', 'scd:fs:mkdir', 'scd:fs:open-dialog', 'scd:fs:save-dialog',
  'scd:fs:roots', 'scd:fs:copy', 'scd:fs:move', 'scd:fs:read-range', 'scd:fs:write-at',
  'scd:db:open', 'scd:db:exec', 'scd:db:run', 'scd:db:all', 'scd:db:first', 'scd:db:tx', 'scd:db:close',
  'scd:secure:get', 'scd:secure:set', 'scd:secure:remove',
  'scd:auth:available', 'scd:auth:prompt',
  'scd:print:to-pdf', 'scd:print:print',
  'scd:share:reveal', 'scd:share:available',
  // </CHANNELS>
]);
const EVENTS = new Set(['scd:event:window-state']);
// القنوات المسموح استدعاؤها بشكل متزامن (ملفات القسم 5 فقط). main يتحقق من المُرسل والحمولة لكل منها.
const SYNC = new Set([
  'scd:fs:roots', 'scd:fs:stat', 'scd:fs:exists', 'scd:fs:read', 'scd:fs:read-range', 'scd:fs:write', 'scd:fs:write-at',
  'scd:fs:mkdir', 'scd:fs:remove', 'scd:fs:list', 'scd:fs:move', 'scd:fs:copy',
]);

// عبر contextBridge تُنسخ الأخطاء برسالتها فقط، لذا الرمز يُدمج في الرسالة بالشكل: [CODE] message
function fail(code, message) {
  const e = new Error(`[${code}] ${message}`);
  e.name = 'ScdError';
  e.code = code;
  return e;
}

async function invoke(channel, payload) {
  if (typeof channel !== 'string' || !INVOKE.has(channel)) {
    throw fail('CHANNEL_NOT_ALLOWED', 'قناة غير مسموحة');
  }
  const res = await ipcRenderer.invoke(channel, payload);
  if (res && res.ok === true) return res.data;
  const err = res && res.error ? res.error : {};
  throw fail(typeof err.code === 'string' ? err.code : 'INTERNAL', typeof err.message === 'string' ? err.message : 'فشل غير معروف');
}

function invokeSync(channel, payload) {
  if (typeof channel !== 'string' || !SYNC.has(channel)) throw fail('CHANNEL_NOT_ALLOWED', 'قناة متزامنة غير مسموحة');
  const res = ipcRenderer.sendSync(channel, payload);
  if (res && res.ok === true) return res.data;
  const err = res && res.error ? res.error : {};
  throw fail(typeof err.code === 'string' ? err.code : 'INTERNAL', typeof err.message === 'string' ? err.message : 'فشل غير معروف');
}

function on(event, callback) {
  if (typeof event !== 'string' || !EVENTS.has(event)) throw fail('EVENT_NOT_ALLOWED', 'حدث غير مسموح');
  if (typeof callback !== 'function') throw fail('INVALID_PAYLOAD', 'callback مطلوب');
  const listener = (_e, data) => callback(data); // لا نمرّر كائن event الخام للواجهة
  ipcRenderer.on(event, listener);
  return () => ipcRenderer.removeListener(event, listener);
}

contextBridge.exposeInMainWorld('scd', { isDesktop: true, platform: process.platform, invoke, invokeSync, on });
