'use strict';
const { CHANNELS } = require('../channels.cjs');
const { ScdError, toEnvelopeError } = require('../lib/errors.cjs');
const { isTrustedUrl } = require('../lib/security.cjs');

// يسجّل كل قناة بغلاف موحّد { ok, data | error }. ثلاث بوابات قبل أي تنفيذ:
// 1) القناة في القائمة البيضاء  2) المُرسل هو الإطار الرئيسي لنافذتنا وبمصدر موثوق  3) الحمولة صالحة.
function registerIpc({ ipcMain, handlers, getWindow, devOrigin, logger }) {
  const trusted = (event) => {
    const w = getWindow();
    if (!w || w.isDestroyed() || event.sender !== w.webContents) return false;
    const frame = event.senderFrame;
    if (!frame || frame !== w.webContents.mainFrame) return false;
    return isTrustedUrl(frame.url, devOrigin);
  };

  for (const channel of Object.keys(CHANNELS)) {
    const entry = handlers.get(channel);
    if (!entry) throw new Error(`لا معالج للقناة ${channel}`);
    ipcMain.handle(channel, async (event, payload) => {
      try {
        if (!trusted(event)) {
          logger.warn(`رُفض طلب IPC من مصدر غير موثوق على ${channel}`);
          throw new ScdError('UNTRUSTED_SENDER', 'مصدر الطلب غير موثوق');
        }
        const data = await entry.run(entry.validate(payload), event);
        return { ok: true, data: data === undefined ? null : data };
      } catch (e) {
        if (!(e instanceof ScdError)) logger.error(`فشل ${channel}: ${e && e.message}`);
        return { ok: false, error: toEnvelopeError(e) };
      }
    });
  }
}
module.exports = { registerIpc };
