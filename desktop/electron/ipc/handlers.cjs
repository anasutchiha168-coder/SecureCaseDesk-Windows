'use strict';
const { CHANNELS } = require('../channels.cjs');
const { ScdError } = require('../lib/errors.cjs');
const { none } = require('../lib/validate.cjs');

// ctx: { app, getWindow(), versions }   (تُحقن للاختبار بدون Electron)
function windowState(win) {
  return { maximized: win.isMaximized(), fullScreen: win.isFullScreen(), focused: win.isFocused() };
}

function buildHandlers(ctx) {
  const win = () => {
    const w = ctx.getWindow();
    if (!w || w.isDestroyed()) throw new ScdError('NO_WINDOW', 'النافذة الرئيسية غير متاحة');
    return w;
  };
  const h = new Map();
  const add = (channel, validate, run) => h.set(channel, { validate, run });

  add('scd:app:info', none, () => ({
    name: 'SecureCaseDesk',
    version: ctx.app.getVersion(),
    electron: ctx.versions.electron,
    chrome: ctx.versions.chrome,
    platform: ctx.platform,
    arch: ctx.arch,
    packaged: ctx.app.isPackaged,
    locale: ctx.app.getLocale(),
  }));
  // بديل expo-updates.reloadAsync: إعادة تحميل الواجهة فقط (الحالة في الذاكرة تُفقد، القاعدة والملفات لا).
  add('scd:app:reload', none, () => { win().webContents.reload(); return null; });
  add('scd:app:relaunch', none, () => { ctx.app.relaunch(); ctx.app.exit(0); return null; });

  add('scd:window:minimize', none, () => { win().minimize(); return null; });
  add('scd:window:toggle-maximize', none, () => {
    const w = win();
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return windowState(w);
  });
  add('scd:window:close', none, () => { win().close(); return null; });
  add('scd:window:state', none, () => windowState(win()));

  // القنوات غير المنفّذة بعد: فشل صريح بدل الصمت (تُستبدل في الأقسام 5–7).
  for (const [channel, section] of Object.entries(CHANNELS)) {
    if (h.has(channel)) continue;
    add(channel, (p) => p, () => {
      throw new ScdError('NOT_IMPLEMENTED', `القناة ${channel} غير منفَّذة بعد (القسم ${section})`);
    });
  }
  return h;
}

module.exports = { buildHandlers, windowState };
