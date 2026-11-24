// يختبر shims القسم 5 (expo-file-system/print/sharing/document-picker) مقابل معالجات Electron الحقيقية عبر جسر وهمي
// ينسخ الحمولات بـ structuredClone مثل IPC الفعلي. لا يحتاج Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./_ts-resolve.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const { buildHandlers } = require('../../electron/ipc/handlers.cjs');
const { createFsService } = require('../../electron/lib/fs-service.cjs');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-shim-'));
const files = createFsService({ documentRoot: path.join(base, 'documents'), cacheRoot: path.join(base, 'cache') });
files.ensureRoots();
const pickQueue = { open: [], save: [] };
const win = { isDestroyed: () => false };
const printed = [];
const shellCalls = [];
const handlers = buildHandlers({
  app: {}, getWindow: () => win, versions: {}, platform: 'win32', arch: 'x64', files,
  printer: { toPdf: async (p) => { printed.push(p); return { uri: 'file:///x.pdf', numberOfPages: 1 }; }, print: async (p) => { printed.push(p); return { printed: true }; } },
  dialog: { showOpenDialog: async () => pickQueue.open.shift() ?? { canceled: true }, showSaveDialog: async () => pickQueue.save.shift() ?? { canceled: true } },
  shell: { openPath: async (p) => { shellCalls.push(p); return ''; }, showItemInFolder() {} },
});
const run = (ch, payload) => {
  const e = handlers.get(ch);
  try { const data = e.run(e.validate(structuredClone(payload))); return { ok: true, data: data === undefined ? null : data, async: !!(data && typeof data.then === 'function') }; }
  catch (err) { return { ok: false, error: { code: err.code || 'INTERNAL', message: err.message } }; }
};
const decode = (res) => { if (res.ok) return structuredClone(res.data); const e = new Error(`[${res.error.code}] ${res.error.message}`); throw e; };
globalThis.window = {
  scd: {
    isDesktop: true, platform: 'win32',
    invokeSync: (ch, p) => { const r = run(ch, p); if (r.ok) assert.equal(r.async, false, 'قناة متزامنة أعادت وعداً: ' + ch); return decode(r); },
    invoke: async (ch, p) => { const e = handlers.get(ch); try { return structuredClone(await e.run(e.validate(structuredClone(p)))); } catch (err) { throw new Error(`[${err.code || 'INTERNAL'}] ${err.message}`); } },
  },
};

const FS = await import('../../shims/expo-file-system.ts');
const Print = await import('../../shims/expo-print.ts');
const Sharing = await import('../../shims/expo-sharing.ts');
const Picker = await import('../../shims/expo-document-picker.ts');
const { File, Directory, Paths, FileMode } = FS;
const rejectsCode = async (p, code) => assert.rejects(p, (e) => e.code === code);
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code);

test('Paths + Directory.create/exists + File.create/write/exists/size/bytes', async () => {
  const dir = new Directory(Paths.document, 'attachments');
  assert.equal(dir.exists, false);
  dir.create({ intermediates: true, idempotent: true });
  dir.create({ intermediates: true, idempotent: true });
  assert.equal(dir.exists, true);
  const f = new File(dir, 'تقرير 100% #1.bin');
  assert.equal(f.exists, false);
  f.create();
  f.write(new Uint8Array([1, 2, 3]));
  assert.equal(f.exists, true); assert.equal(f.size, 3);
  assert.deepEqual([...(await f.bytes())], [1, 2, 3]);
  assert.equal(f.name, 'تقرير 100% #1.bin'); assert.equal(f.extension, '.bin');
  assert.equal(f.parentDirectory.name, 'attachments');
  throwsCode(() => f.create(), 'ALREADY_EXISTS');
  f.create({ overwrite: true }); assert.equal(f.size, 0);
  f.write('نص عربي'); assert.equal(await f.text(), 'نص عربي'); assert.equal(f.textSync(), 'نص عربي');
  f.writeSync('متوافق مع writeSync');
  assert.equal(f.textSync(), 'متوافق مع writeSync');
});

test('handle: كتابة متسلسلة WriteOnly وقراءة متسلسلة ReadOnly (مقاطع)', () => {
  const f = new File(Paths.cache, 'h.bin');
  f.create();
  const w = f.open(FileMode.WriteOnly);
  w.writeBytes(new Uint8Array([1, 2, 3])); w.writeBytesSync(new Uint8Array([4, 5]));
  assert.equal(w.offset, 5); w.close();
  throwsCode(() => w.writeBytes(new Uint8Array([9])), 'INVALID_PAYLOAD');
  const r = f.open(FileMode.ReadOnly);
  assert.deepEqual([...r.readBytesSync(2)], [1, 2]); assert.deepEqual([...r.readBytesSync(10)], [3, 4, 5]);
  assert.equal(r.readBytesSync(4).length, 0); assert.equal(r.size, 5);
  throwsCode(() => r.writeBytes(new Uint8Array([1])), 'INVALID_PAYLOAD');
  r.close();
  throwsCode(() => new File(Paths.cache, 'nope.bin').open(FileMode.ReadOnly), 'NOT_FOUND');
});

test('list/move/copy/delete على ملفات ومجلدات، وmove يحدّث uri، ونقل ملف إلى مجلد', () => {
  const d = new Directory(Paths.document, 'ops'); d.create({ intermediates: true });
  const a = new File(d, 'a.txt'); a.create(); a.write('A');
  const sub = new Directory(d, 'sub'); sub.create();
  assert.deepEqual(d.list().map((x) => [x.name, x instanceof Directory]), [['a.txt', false], ['sub', true]]);
  a.move(new File(d, 'b.txt')); assert.equal(a.name, 'b.txt'); assert.equal(a.exists, true);
  a.move(sub); assert.equal(a.uri.endsWith('/sub/b.txt'), true);
  const c = new File(d, 'c.txt'); a.copy(c); assert.equal(c.textSync(), 'A'); assert.equal(a.exists, true);
  const dc = new Directory(Paths.document, 'ops-copy'); d.copy(dc); assert.equal(new File(dc, 'c.txt').exists, true);
  throwsCode(() => d.copy(dc), 'ALREADY_EXISTS');
  throwsCode(() => new File(d, 'c.txt').move(new Directory(d, 'zzz', 'q')), 'NOT_FOUND');
  d.delete(); assert.equal(d.exists, false);
  throwsCode(() => d.delete(), 'NOT_FOUND');
  throwsCode(() => new Directory(Paths.document).delete(), 'FS_FORBIDDEN');
});

test('مسارات خارج الجذور ومسارات Windows الخام', async () => {
  assert.throws(() => new File('file:///etc/passwd').exists, (e) => ['FS_FORBIDDEN', 'INVALID_PAYLOAD'].includes(e.code));
  assert.throws(() => new File('C:\\Windows\\win.ini').exists, (e) => ['FS_FORBIDDEN', 'INVALID_PAYLOAD'].includes(e.code));
  await rejectsCode(new File(Paths.document, '..', 'x').bytes(), 'FS_FORBIDDEN');
  throwsCode(() => new File(Paths.document, 'run.exe').write('x'), 'FS_FORBIDDEN');
});

test('Directory.pickDirectoryAsync: اختيار → كتابة createFile بلا تضارب (1)، وإلغاء → خطأ يطابق /cancel/', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-pick-'));
  pickQueue.open.push({ canceled: false, filePaths: [dest] });
  const target = await Directory.pickDirectoryAsync();
  const f1 = target.createFile('r.pdf', 'application/pdf'); f1.write(new Uint8Array([1, 2]));
  const f2 = target.createFile('r.pdf', 'application/pdf');
  assert.equal(f1.name, 'r.pdf'); assert.equal(f2.name, 'r (1).pdf');
  assert.deepEqual([...(await f1.bytes())], [1, 2]);
  await assert.rejects(Directory.pickDirectoryAsync(), (e) => /cancel/i.test(e.message));
});

test('expo-document-picker: نسخة في cache مع الاسم الأصلي، المرشّحات، والإلغاء', async () => {
  const src = path.join(base, 'صورة.png'); fs.writeFileSync(src, 'PNG');
  pickQueue.open.push({ canceled: false, filePaths: [src] });
  const r = await Picker.getDocumentAsync({ type: ['application/pdf', 'image/jpeg', 'image/png'], copyToCacheDirectory: true, multiple: false });
  assert.equal(r.canceled, false);
  assert.equal(r.assets[0].name, 'صورة.png'); assert.equal(r.assets[0].mimeType, 'image/png'); assert.equal(r.assets[0].size, 3);
  assert.equal(new File(r.assets[0].uri).textSync(), 'PNG');
  assert.deepEqual((await Picker.getDocumentAsync()).assets, null);
  assert.deepEqual(Picker.filtersFor(['application/pdf', 'image/png'])[0].extensions, ['pdf', 'png']);
  assert.deepEqual(Picker.filtersFor('*/*')[0].extensions, ['*']);
});

test('expo-print: printToFileAsync/printAsync تمرّر html والأبعاد وترفض غير ذلك', async () => {
  const r = await Print.printToFileAsync({ html: '<p>x</p>', width: 595, height: 842, margins: { left: 1 } });
  assert.equal(r.uri, 'file:///x.pdf'); assert.equal(printed.at(-1).width, 595);
  await Print.printAsync({ html: '<p>y</p>' });
  await rejectsCode(Print.printToFileAsync({}), 'INVALID_PAYLOAD');
  await rejectsCode(Print.printAsync({ uri: 'file:///x.pdf' }), 'INVALID_PAYLOAD');
});

test('expo-sharing: متاح، ويفتح PDF في cache عبر البرنامج الافتراضي', async () => {
  assert.equal(await Sharing.isAvailableAsync(), true);
  const f = new File(Paths.cache, 'view.pdf'); f.create(); f.write('%PDF-');
  await Sharing.shareAsync(f.uri, { mimeType: 'application/pdf', dialogTitle: 'x' });
  assert.equal(shellCalls.length, 1); assert.ok(shellCalls[0].endsWith('view.pdf'));
  await rejectsCode(Sharing.shareAsync('file:///C:/Windows/System32/cmd.exe'), 'FS_FORBIDDEN');
});

test('بلا جسر Electron: خطأ واضح NO_BRIDGE بدل فشل صامت', () => {
  const saved = globalThis.window; globalThis.window = {};
  try { throwsCode(() => new File('file:///x').exists, 'NO_BRIDGE'); } finally { globalThis.window = saved; }
});
