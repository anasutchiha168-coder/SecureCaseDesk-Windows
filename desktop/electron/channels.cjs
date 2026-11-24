'use strict';
// القائمة البيضاء الوحيدة لقنوات invoke. يجب أن تطابق preload.cjs و shims/bridge-contract.ts
// (يتحقق من التطابق tests/electron/parity.test.mjs).
// section = القسم الذي ينفّذ القناة؛ 2 = منفّذة الآن، غير ذلك = تُرجع NOT_IMPLEMENTED صريحاً.
const CHANNELS = Object.freeze({
  'scd:app:info': 2,
  'scd:app:relaunch': 2,
  'scd:app:reload': 2,
  'scd:window:minimize': 2,
  'scd:window:toggle-maximize': 2,
  'scd:window:close': 2,
  'scd:window:state': 2,
  'scd:fs:read': 5, 'scd:fs:write': 5, 'scd:fs:exists': 5, 'scd:fs:remove': 5, 'scd:fs:list': 5,
  'scd:fs:stat': 5, 'scd:fs:mkdir': 5, 'scd:fs:open-dialog': 5, 'scd:fs:save-dialog': 5,
  'scd:fs:roots': 5, 'scd:fs:copy': 5, 'scd:fs:move': 5, 'scd:fs:read-range': 5, 'scd:fs:write-at': 5,
  'scd:db:open': 6, 'scd:db:exec': 6, 'scd:db:run': 6, 'scd:db:all': 6, 'scd:db:first': 6,
  'scd:db:tx': 6, 'scd:db:close': 6,
  'scd:secure:get': 7, 'scd:secure:set': 7, 'scd:secure:remove': 7,
  'scd:auth:available': 7, 'scd:auth:prompt': 7,
  'scd:print:to-pdf': 5, 'scd:print:print': 5,
  'scd:share:reveal': 5, 'scd:share:available': 5,
});

// أحداث main → renderer المسموحة (للاشتراك عبر scd.on).
const EVENTS = Object.freeze(['scd:event:window-state']);

// قنوات تُستدعى أيضاً عبر ipcRenderer.sendSync (القسم 5): واجهة File/Directory في expo-file-system متزامنة.
// معالجاتها متزامنة حتماً. الحوارات والطباعة غير متزامنة ولا تُدرج هنا.
const SYNC = Object.freeze([
  'scd:fs:roots', 'scd:fs:stat', 'scd:fs:exists', 'scd:fs:read', 'scd:fs:read-range', 'scd:fs:write', 'scd:fs:write-at',
  'scd:fs:mkdir', 'scd:fs:remove', 'scd:fs:list', 'scd:fs:move', 'scd:fs:copy',
]);

module.exports = { CHANNELS, EVENTS, SYNC };
