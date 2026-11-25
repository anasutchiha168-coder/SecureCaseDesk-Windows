import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CHANNELS } = require('../../electron/channels.cjs');
const { buildHandlers } = require('../../electron/ipc/handlers.cjs');
const { registerIpc } = require('../../electron/ipc/register.cjs');

function setup({ maximized = false } = {}) {
  const calls = [];
  const mainFrame = { url: 'app://bundle/index.html' };
  const webContents = { mainFrame, reload: () => calls.push('reload') };
  const win = {
    webContents, isDestroyed: () => false,
    isMaximized: () => maximized, isFullScreen: () => false, isFocused: () => true,
    minimize: () => calls.push('minimize'), maximize: () => calls.push('maximize'),
    unmaximize: () => calls.push('unmaximize'), close: () => calls.push('close'),
  };
  const app = { getVersion: () => '2.2.0', isPackaged: true, getLocale: () => 'ar', relaunch: () => calls.push('relaunch'), exit: (c) => calls.push('exit' + c) };
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
  const logs = [];
  const logger = { info() {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  registerIpc({
    ipcMain, logger, getWindow: () => win, devOrigin: null,
    handlers: buildHandlers({ app, getWindow: () => win, versions: { electron: '37.0.0', chrome: '138' }, platform: 'win32', arch: 'x64' }),
  });
  const ev = (over = {}) => ({ sender: webContents, senderFrame: mainFrame, ...over });
  return { handlers, ev, calls, logs, webContents, mainFrame };
}

test('كل قناة في القائمة البيضاء لها معالج مسجّل', () => {
  const { handlers } = setup();
  assert.deepEqual([...handlers.keys()].sort(), Object.keys(CHANNELS).sort());
});

test('app:info يعيد معلومات بلا مسارات', async () => {
  const { handlers, ev } = setup();
  const r = await handlers.get('scd:app:info')(ev(), undefined);
  assert.equal(r.ok, true);
  assert.equal(r.data.version, JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
  assert.equal(r.data.platform, 'win32');
  assert.ok(!JSON.stringify(r.data).match(/[A-Z]:\\|\/home\//));
});

test('مُرسل غير موثوق يُرفض: مصدر آخر / نافذة أخرى / إطار فرعي', async () => {
  const { handlers, ev, logs } = setup();
  const h = handlers.get('scd:app:reload');
  for (const bad of [
    ev({ senderFrame: { url: 'https://evil.com/' } }),
    ev({ sender: {} }),
    ev({ senderFrame: { url: 'app://bundle/index.html' } }), // إطار غير الرئيسي
    ev({ senderFrame: null }),
  ]) {
    const r = await h(bad);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'UNTRUSTED_SENDER');
  }
  assert.ok(logs.length >= 4);
});

test('حمولة غير صالحة تُرفض قبل التنفيذ', async () => {
  const { handlers, ev, calls } = setup();
  const r = await handlers.get('scd:window:close')(ev(), { x: 1 });
  assert.equal(r.error.code, 'INVALID_PAYLOAD');
  assert.ok(!calls.includes('close'));
});

test('قنوات النافذة والتطبيق تنفّذ فعلاً', async () => {
  const s = setup();
  await s.handlers.get('scd:window:minimize')(s.ev());
  await s.handlers.get('scd:app:reload')(s.ev());
  await s.handlers.get('scd:app:relaunch')(s.ev());
  const t = await s.handlers.get('scd:window:toggle-maximize')(s.ev());
  assert.deepEqual(s.calls, ['minimize', 'reload', 'relaunch', 'exit0', 'maximize']);
  assert.deepEqual(Object.keys(t.data).sort(), ['focused', 'fullScreen', 'maximized']);
  const m = setup({ maximized: true });
  await m.handlers.get('scd:window:toggle-maximize')(m.ev());
  assert.deepEqual(m.calls, ['unmaximize']);
});

test('قنوات الأقسام 5–7 تفشل صراحةً مع رقم القسم', async () => {
  const { handlers, ev } = setup();
  for (const [ch, sec] of [['scd:db:open', 6], ['scd:db:tx', 6], ['scd:secure:get', 7], ['scd:auth:prompt', 7]]) {
    const r = await handlers.get(ch)(ev(), {});
    assert.equal(r.error.code, 'NOT_IMPLEMENTED');
    assert.match(r.error.message, new RegExp(`القسم ${sec}`));
  }
});

test('أخطاء داخلية لا تسرّب رسالتها الأصلية للواجهة', async () => {
  const { handlers, ev } = setup();
  const { buildHandlers: _ } = { buildHandlers };
  // نُفشل getVersion لمحاكاة خطأ غير متوقع
  const calls = []; const wc = { mainFrame: { url: 'app://bundle/' } };
  const win = { webContents: wc, isDestroyed: () => false };
  const m = new Map();
  registerIpc({
    ipcMain: { handle: (c, f) => m.set(c, f), on: () => {} }, logger: { warn() {}, error: (x) => calls.push(x) }, getWindow: () => win,
    handlers: buildHandlers({ app: { getVersion: () => { throw new Error('C:\\Users\\secret\\path'); }, isPackaged: true, getLocale: () => 'ar' }, getWindow: () => win, versions: {}, platform: 'win32', arch: 'x64' }),
  });
  const r = await m.get('scd:app:info')({ sender: wc, senderFrame: wc.mainFrame });
  assert.equal(r.error.code, 'INTERNAL');
  assert.ok(!r.error.message.includes('secret'));
  assert.ok(calls[0].includes('secret')); // يُسجَّل محلياً فقط
  void handlers; void ev;
});
