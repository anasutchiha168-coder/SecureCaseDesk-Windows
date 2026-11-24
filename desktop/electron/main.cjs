'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, protocol, net, session, shell, dialog, ipcMain, screen, safeStorage } = require('electron');

const sec = require('./lib/security.cjs');
const { loadState, saveState, sanitizeState, MIN } = require('./lib/window-state.cjs');
const { createLogger } = require('./lib/logger.cjs');
const { buildHandlers, windowState } = require('./ipc/handlers.cjs');
const { registerIpc } = require('./ipc/register.cjs');
const { installMenu } = require('./menu.cjs');
const { createFsService } = require('./lib/fs-service.cjs');
const { createPrintService } = require('./lib/print-service.cjs');
const { createDbService, loadSqlcipherDriver } = require('./lib/db-service.cjs');
const { createSecureService, createAuthService, sessionTtlMs } = require('./lib/secure-service.cjs');

const SMOKE = process.env.SCD_SMOKE === '1';
const DEV_ORIGIN = sec.parseDevUrl(process.env.SCD_DEV_URL, app.isPackaged);
const DEV = !app.isPackaged;

// ── قبل ready ─────────────────────────────────────────────
app.setName('SecureCaseDesk');
app.setAppUserModelId('gov.moi.hajjah.securecasedesk');
if (SMOKE) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'scd-smoke-')));
// القسم 9: مجلد بيانات مخصص اختيارياً (اختبار/Winlator). الافتراضي %APPDATA%\SecureCaseDesk (من productName).
if (!SMOKE && process.env.SCD_DATA_DIR) app.setPath('userData', path.resolve(process.env.SCD_DATA_DIR));
if (process.env.SCD_DISABLE_GPU === '1') app.disableHardwareAcceleration(); // مفيد على Winlator/Wine
app.commandLine.appendSwitch('lang', 'ar');
protocol.registerSchemesAsPrivileged([
  { scheme: sec.APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow = null;
let dbService = null; // القسم 6
let logger = null;
let crashTimes = [];

const webRoot = () => {
  // جذر مخصص مسموح فقط في وضع الفحص أو غير المُحزَّم.
  if ((SMOKE || DEV) && process.env.SCD_WEB_ROOT) return path.resolve(process.env.SCD_WEB_ROOT);
  if (SMOKE) return path.join(__dirname, 'smoke');
  return path.join(app.getAppPath(), 'web-dist');
};

function installProtocol() {
  const root = webRoot();
  protocol.handle(sec.APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== sec.APP_HOST) return new Response('Forbidden', { status: 403 });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
    const r = sec.resolveRequest(root, url.pathname);
    if (r.status !== 200) return new Response(r.status === 400 ? 'Bad Request' : 'Not Found', { status: r.status });
    try {
      const res = await net.fetch(pathToFileURL(r.file).toString());
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(sec.SECURITY_HEADERS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    } catch (e) {
      logger.error(`تعذّر قراءة ${path.basename(r.file)}: ${e && e.message}`);
      return new Response('Internal Error', { status: 500 });
    }
  });
}

function lockDownSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));  // لا كاميرا/ميكروفون/موقع/إشعارات
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());               // الحفظ يمر عبر IPC (القسم 5) فقط
}

function guardWebContents() {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.on('will-navigate', (e, url) => {
      if (sec.isTrustedUrl(url, DEV_ORIGIN)) return;
      e.preventDefault();
      if (sec.isSafeExternalUrl(url)) shell.openExternal(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (sec.isSafeExternalUrl(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

function errorPage(detail) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<!doctype html><meta charset="utf-8"><title>SecureCaseDesk</title>
<body dir="rtl" style="background:#000;color:#fff;font-family:Segoe UI,Tahoma,sans-serif;padding:48px">
<h2>تعذّر تحميل واجهة التطبيق</h2><p>${esc(detail)}</p><p>أعد تثبيت التطبيق أو راجع ملف السجل في مجلد البيانات.</p></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createWindow() {
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  const areas = () => screen.getAllDisplays().map((d) => d.workArea);
  const st = loadState(stateFile, areas());
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');

  const win = new BrowserWindow({
    title: 'SecureCaseDesk',
    width: st.width, height: st.height, x: st.x, y: st.y,
    minWidth: MIN.width, minHeight: MIN.height,
    show: false, backgroundColor: '#000000', autoHideMenuBar: true,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: DEV || process.env.SCD_DEVTOOLS === '1',
    },
  });
  mainWindow = win;
  // القسم 6: لا اتصالات/معاملات يتيمة عند إعادة تحميل الواجهة أو انهيارها أو إغلاق النافذة.
  const dropDb = () => { if (dbService) dbService.closeAll(); };
  win.webContents.on('did-start-loading', dropDb);
  win.webContents.on('render-process-gone', dropDb);
  win.on('closed', dropDb);

  win.once('ready-to-show', () => { if (st.maximized) win.maximize(); win.show(); });

  const pushState = () => { if (!win.isDestroyed()) win.webContents.send('scd:event:window-state', windowState(win)); };
  ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'].forEach((ev) => win.on(ev, pushState));

  let timer = null;
  const persist = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    saveState(stateFile, sanitizeState({ ...b, maximized: win.isMaximized() }, areas()));
  };
  const debounced = () => { clearTimeout(timer); timer = setTimeout(persist, 400); };
  ['resize', 'move', 'maximize', 'unmaximize'].forEach((ev) => win.on(ev, debounced));
  win.on('close', persist);
  win.on('closed', () => { clearTimeout(timer); mainWindow = null; });

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3 = ABORTED
    logger.error(`فشل تحميل الواجهة (${code} ${desc})`);
    win.loadURL(errorPage(`${desc} (${code})`));
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    logger.error(`انهارت عملية الواجهة: ${d.reason}`);
    if (d.reason === 'clean-exit') return;
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < 60000).concat(now);
    if (crashTimes.length > 3) {
      dialog.showErrorBox('SecureCaseDesk', 'توقفت الواجهة مراراً. سيُغلق التطبيق.');
      app.exit(1);
    } else if (!win.isDestroyed()) win.webContents.reload();
  });

  win.loadURL(DEV_ORIGIN || sec.APP_ENTRY);
  return win;
}

async function runSmoke(win) {
  const deadline = Date.now() + 20000;
  let result = null;
  while (Date.now() < deadline && !result) {
    await new Promise((r) => setTimeout(r, 300));
    try { result = await win.webContents.executeJavaScript('window.__smokeResult || null'); } catch { /* لم تُحمَّل بعد */ }
  }
  const out = result || { ok: false, error: 'انتهت المهلة دون نتيجة', checks: [] };
  process.stdout.write('SCD_SMOKE_RESULT ' + JSON.stringify(out) + '\n');
  app.exit(out.ok ? 0 : 1);
}

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  guardWebContents();

  app.whenReady().then(() => {
    logger = createLogger(path.join(app.getPath('userData'), 'logs'));
    logger.info(`بدء SecureCaseDesk ${app.getVersion()} (Electron ${process.versions.electron})${SMOKE ? ' [smoke]' : ''}`);
    // القسم 5: documents (دائم) وcache (يُفرَّغ عند الإقلاع والإغلاق لأنه قد يحوي مرفقات مفكوكة).
    const files = createFsService({
      documentRoot: path.join(app.getPath('userData'), 'documents'),
      cacheRoot: path.join(app.getPath('userData'), 'cache'),
      platform: process.platform,
    });
    files.ensureRoots();
    files.purgeCache();
    // القسم 6: SQLCipher داخل documents/SQLite. غياب المحرك = فشل مغلق عند الفتح وليس قاعدة غير مشفّرة.
    const driver = loadSqlcipherDriver();
    if (!driver.available) logger.error('محرك SQLCipher غير متوفر: ' + driver.reason);
    dbService = createDbService({ files, driver, logger });
    app.on('will-quit', () => { dbService.closeAll(); });
    // القسم 7: safeStorage/DPAPI. SCD_WINLATOR=1 يفعّل خلفية اختبار برمجية فقط (انظر secure-service.cjs).
    const secure = createSecureService({
      safeStorage, logger,
      dir: path.join(app.getPath('userData'), 'secure'),
      softwareTest: process.env.SCD_WINLATOR === '1',
      sessionTtl: sessionTtlMs(),
    });
    const secInfo = secure.info();
    logger.info(`التخزين الآمن: ${secInfo.backend}${secInfo.available ? '' : ' (غير متاح — سيفشل مغلقاً)'}`);
    const auth = createAuthService();
    const printer = createPrintService({ BrowserWindow, files, platform: process.platform });
    app.on('will-quit', () => { files.purgeCache(); });
    installProtocol();
    lockDownSession();
    installMenu({ dev: DEV });
    registerIpc({
      ipcMain,
      logger,
      devOrigin: DEV_ORIGIN,
      getWindow: () => mainWindow,
      handlers: buildHandlers({
        app, getWindow: () => mainWindow, versions: process.versions, platform: process.platform, arch: process.arch,
        files, printer, dialog, shell, db: dbService, secure, auth,
      }),
    });
    const win = createWindow();
    if (SMOKE) runSmoke(win);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => app.quit());
}
