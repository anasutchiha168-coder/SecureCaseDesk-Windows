import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CHANNELS, SYNC } = require('../../electron/channels.cjs');
const { buildHandlers } = require('../../electron/ipc/handlers.cjs');
const { registerIpc } = require('../../electron/ipc/register.cjs');
const { createFsService } = require('../../electron/lib/fs-service.cjs');

function setup({ openPaths = [], savePath = null, openPathError = '' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-ipc-'));
  const files = createFsService({ documentRoot: path.join(base, 'documents'), cacheRoot: path.join(base, 'cache') });
  files.ensureRoots();
  const mainFrame = { url: 'app://bundle/' };
  const webContents = { mainFrame };
  const win = { webContents, isDestroyed: () => false };
  const shellCalls = [];
  const dialogCalls = [];
  const dialog = {
    showOpenDialog: async (_w, o) => { dialogCalls.push(o); return openPaths.length ? { canceled: false, filePaths: openPaths } : { canceled: true, filePaths: [] }; },
    showSaveDialog: async (_w, o) => { dialogCalls.push(o); return savePath ? { canceled: false, filePath: savePath } : { canceled: true }; },
  };
  const shell = { openPath: async (p) => { shellCalls.push(['open', p]); return openPathError; }, showItemInFolder: (p) => shellCalls.push(['show', p]) };
  const printer = { toPdf: async (p) => ({ uri: 'file:///x.pdf', echo: p.width }), print: async () => ({ printed: true }) };
  const invoke = new Map(); const sync = new Map();
  const logger = { info() {}, warn() {}, error() {} };
  registerIpc({
    ipcMain: { handle: (c, f) => invoke.set(c, f), on: (c, f) => sync.set(c, f) }, logger, getWindow: () => win, devOrigin: null,
    handlers: buildHandlers({ app: { getVersion: () => '1', isPackaged: true, getLocale: () => 'ar' }, getWindow: () => win, versions: {}, platform: 'win32', arch: 'x64', files, printer, dialog, shell }),
  });
  const ev = (over = {}) => ({ sender: webContents, senderFrame: mainFrame, ...over });
  const call = async (ch, payload) => invoke.get(ch)(ev(), structuredClone(payload));
  const callSync = (ch, payload, over) => { const e = ev(over); sync.get(ch)(e, structuredClone(payload)); return e.returnValue; };
  const u = (...p) => pathToFileURL(path.join(base, 'documents', ...p)).href;
  return { base, files, call, callSync, ev, invoke, sync, shellCalls, dialogCalls, u, webContents };
}

test('كل قنوات SYNC مسجّلة لـ sendSync وكل قنوات CHANNELS لـ invoke', () => {
  const { invoke, sync } = setup();
  assert.deepEqual([...invoke.keys()].sort(), Object.keys(CHANNELS).sort());
  assert.deepEqual([...sync.keys()].sort(), [...SYNC].sort());
  for (const c of SYNC) assert.ok(c.startsWith('scd:fs:'), c);
});

test('IPC متزامن: roots/write/read-range/stat وأخطاء بلا مسارات داخلية', () => {
  const { callSync, u } = setup();
  const roots = callSync('scd:fs:roots');
  assert.equal(roots.ok, true); assert.match(roots.data.document, /^file:\/\//);
  assert.equal(callSync('scd:fs:write', { uri: u('a.bin'), data: new Uint8Array([7, 8, 9]), mode: 'create' }).ok, true);
  assert.deepEqual([...callSync('scd:fs:read-range', { uri: u('a.bin'), offset: 1, length: 5 }).data], [8, 9]);
  const dup = callSync('scd:fs:write', { uri: u('a.bin'), data: 'x', mode: 'create' });
  assert.equal(dup.ok, false); assert.equal(dup.error.code, 'ALREADY_EXISTS');
  assert.ok(!JSON.stringify(dup).includes(os.tmpdir()));
});

test('مصدر غير موثوق يُرفض على القنوات المتزامنة وغير المتزامنة', async () => {
  const { callSync, call, ev, sync, invoke } = setup();
  assert.equal(callSync('scd:fs:roots', undefined, { sender: {} }).error.code, 'UNTRUSTED_SENDER');
  assert.equal(callSync('scd:fs:roots', undefined, { senderFrame: { url: 'https://evil.example/' } }).error.code, 'UNTRUSTED_SENDER');
  const r = await invoke.get('scd:fs:read')(ev({ senderFrame: { url: 'https://evil.example/' } }), { uri: 'x' });
  assert.equal(r.error.code, 'UNTRUSTED_SENDER');
  void call; void sync;
});

test('التحقق من الحمولة: حقول ناقصة/خاطئة', async () => {
  const { call, callSync } = setup();
  assert.equal((await call('scd:fs:read', {})).error.code, 'INVALID_PAYLOAD');
  assert.equal((await call('scd:fs:read', { uri: 'file:///x', as: 'zip' })).error.code, 'INVALID_PAYLOAD');
  assert.equal(callSync('scd:fs:write', { uri: 'file:///x', data: 5 }).error.code, 'INVALID_PAYLOAD');
  assert.equal(callSync('scd:fs:read-range', { uri: 'file:///x', offset: -1, length: 1 }).error.code, 'INVALID_PAYLOAD');
  assert.equal(callSync('scd:fs:remove', { uri: 'file:///x', kind: 'weird' }).error.code, 'INVALID_PAYLOAD');
  assert.equal((await call('scd:print:to-pdf', { html: '' })).error.code, 'INVALID_PAYLOAD');
  assert.equal((await call('scd:print:to-pdf', { html: 'x', width: -5, height: 10 })).error.code, 'INVALID_PAYLOAD');
});

test('open-dialog: ملف يُنسخ إلى cache/picked، والإلغاء، والمرشّحات الخاطئة', async () => {
  const src = path.join(os.tmpdir(), `scd-src-${process.pid}.pdf`); fs.writeFileSync(src, '%PDF-1.4');
  const t = setup({ openPaths: [src] });
  const r = await t.call('scd:fs:open-dialog', { filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  assert.equal(r.ok, true); assert.equal(r.data.canceled, false);
  const f = r.data.files[0];
  assert.equal(f.mimeType, 'application/pdf'); assert.match(f.uri, /\/cache\/picked\//);
  assert.equal(t.files.read(f.uri, 'text'), '%PDF-1.4');
  assert.deepEqual(t.dialogCalls[0].filters, [{ name: 'PDF', extensions: ['pdf'] }]);
  assert.equal((await setup().call('scd:fs:open-dialog', {})).data.canceled, true);
  assert.equal((await t.call('scd:fs:open-dialog', { filters: [{ name: 'x', extensions: ['../e'] }] })).error.code, 'INVALID_PAYLOAD');
});

test('open-dialog مجلد: يمنح كتابة داخله فقط (مسار Directory.pickDirectoryAsync)', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-dest-'));
  const t = setup({ openPaths: [dest] });
  const target = pathToFileURL(path.join(dest, 'r.pdf')).href;
  assert.equal(t.callSync('scd:fs:write', { uri: target, data: 'x', mode: 'create' }).error.code, 'FS_FORBIDDEN');
  const r = await t.call('scd:fs:open-dialog', { directory: true });
  assert.equal(r.data.canceled, false);
  assert.equal(t.callSync('scd:fs:write', { uri: target, data: 'x', mode: 'create' }).ok, true);
  assert.equal(fs.readFileSync(path.join(dest, 'r.pdf'), 'utf8'), 'x');
});

test('save-dialog: يمنح الملف المختار فقط ويرفض الامتدادات الخطرة', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-save-'));
  const okPath = path.join(dest, 'تقرير.pdf');
  const t = setup({ savePath: okPath });
  const r = await t.call('scd:fs:save-dialog', { defaultName: 'تقرير.pdf' });
  assert.equal(r.data.name, 'تقرير.pdf');
  assert.equal(t.callSync('scd:fs:write', { uri: r.data.uri, data: 'p', mode: 'create' }).ok, true);
  assert.equal(t.callSync('scd:fs:write', { uri: pathToFileURL(path.join(dest, 'other.pdf')).href, data: 'p', mode: 'create' }).error.code, 'FS_FORBIDDEN');
  const evil = setup({ savePath: path.join(dest, 'x.exe') });
  assert.equal((await evil.call('scd:fs:save-dialog', {})).error.code, 'FS_FORBIDDEN');
  assert.equal((await setup().call('scd:fs:save-dialog', {})).data.canceled, true);
});

test('share:reveal: يفتح PDF/صور فقط؛ غيرها يُظهَر في المستكشف ولا يُنفَّذ أبداً', async () => {
  const t = setup();
  t.files.write(t.u('a.pdf'), '%PDF', 'create'); t.files.write(t.u('b.docx'), 'x', 'create'); t.files.write(t.u('c.txt'), 'x', 'create');
  assert.deepEqual((await t.call('scd:share:reveal', { uri: t.u('a.pdf') })).data, { opened: true });
  assert.equal(t.shellCalls[0][0], 'open');
  t.files.write(t.u('data.bin'), 'x', 'create');
  assert.deepEqual((await t.call('scd:share:reveal', { uri: t.u('data.bin') })).data, { opened: false });
  assert.equal(t.shellCalls.at(-1)[0], 'show');
  // مسار خارج الجذور مرفوض قبل أي استدعاء للنظام
  const before = t.shellCalls.length;
  assert.equal((await t.call('scd:share:reveal', { uri: 'file:///C:/Windows/System32/calc.exe' })).ok, false);
  assert.equal(t.shellCalls.length, before);
  assert.equal((await t.call('scd:share:reveal', { uri: t.u('missing.pdf') })).error.code, 'NOT_FOUND');
  assert.equal((await t.call('scd:share:available')).data, true);
  const failing = setup({ openPathError: 'no association' });
  failing.files.write(failing.u('a.pdf'), '%PDF', 'create');
  assert.deepEqual((await failing.call('scd:share:reveal', { uri: failing.u('a.pdf') })).data, { opened: false });
  assert.equal(failing.shellCalls.at(-1)[0], 'show');
});

test('الطباعة تمرّ للخدمة بالأبعاد', async () => {
  const t = setup();
  assert.equal((await t.call('scd:print:to-pdf', { html: '<p>x</p>', width: 595, height: 842 })).data.echo, 595);
  assert.equal((await t.call('scd:print:print', { html: '<p>x</p>' })).data.printed, true);
});
