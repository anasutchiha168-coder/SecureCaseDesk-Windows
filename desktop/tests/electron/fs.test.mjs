import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createFsService } = require('../../electron/lib/fs-service.cjs');
const { toLocalPath } = require('../../electron/lib/fs-paths.cjs');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-fs-'));
  const documentRoot = path.join(base, 'documents');
  const cacheRoot = path.join(base, 'cache');
  const svc = createFsService({ documentRoot, cacheRoot });
  svc.ensureRoots();
  const u = (...p) => pathToFileURL(path.join(documentRoot, ...p)).href;
  return { base, documentRoot, cacheRoot, svc, u };
}
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('كتابة وقراءة وstat ورفض create على موجود', () => {
  const { svc, u } = setup();
  svc.write(u('a.bin'), new Uint8Array([1, 2, 3]), 'create');
  assert.deepEqual([...svc.read(u('a.bin'))], [1, 2, 3]);
  assert.equal(svc.stat(u('a.bin')).size, 3);
  assert.equal(code(() => svc.write(u('a.bin'), new Uint8Array([9]), 'create')), 'ALREADY_EXISTS');
  svc.write(u('a.bin'), 'مرحبا', 'overwrite');
  assert.equal(svc.read(u('a.bin'), 'text'), 'مرحبا');
  assert.equal(svc.stat(u('nope')).exists, false);
  assert.equal(code(() => svc.read(u('nope'))), 'NOT_FOUND');
});

test('أسماء بمسافات و% و# وحروف عربية تعمل', () => {
  const { svc, documentRoot } = setup();
  const name = 'تقرير 100% #1 (نسخة).pdf';
  const uri = pathToFileURL(path.join(documentRoot, name)).href;
  svc.write(uri, 'x', 'create');
  assert.ok(fs.existsSync(path.join(documentRoot, name)));
  assert.equal(svc.list(pathToFileURL(documentRoot).href)[0].name, name);
});

test('منع الخروج من الجذور: .. ومسار مطلق وجار بنفس البادئة', () => {
  const { svc, base, documentRoot } = setup();
  const evil = path.join(base, 'documents-evil');
  fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, 's.txt'), 'secret');
  assert.equal(code(() => svc.read(pathToFileURL(path.join(documentRoot, '..', 'documents-evil', 's.txt')).href)), 'FS_FORBIDDEN');
  assert.equal(code(() => svc.read(pathToFileURL(path.join(evil, 's.txt')).href)), 'FS_FORBIDDEN');
  assert.equal(code(() => svc.read(path.join(base, 'documents', '..', 'documents-evil', 's.txt'))), 'FS_FORBIDDEN');
  assert.equal(code(() => svc.read('relative/path.txt')), 'INVALID_PAYLOAD');
  assert.equal(code(() => svc.read('file://server/share/x')), 'FS_FORBIDDEN');
});

test('الرابط الرمزي الخارجي لا يُخرج من documents', (t) => {
  const { svc, base, documentRoot, u } = setup();
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'x.txt'), 'x');
  try { fs.symlinkSync(outside, path.join(documentRoot, 'link'), 'junction'); } catch { return t.skip('لا صلاحية إنشاء روابط'); }
  assert.equal(code(() => svc.read(u('link', 'x.txt'))), 'FS_FORBIDDEN');
  assert.equal(code(() => svc.write(u('link', 'new.txt'), 'x', 'overwrite')), 'FS_FORBIDDEN');
});

test('منع كتابة الملفات التنفيذية والنصوص البرمجية', () => {
  const { svc, u } = setup();
  for (const n of ['a.exe', 'b.BAT', 'c.ps1', 'd.lnk', 'e.js']) assert.equal(code(() => svc.write(u(n), 'x', 'overwrite')), 'FS_FORBIDDEN', n);
});

test('handle: writeAt/readRange بالتسلسل وعند نهاية الملف', () => {
  const { svc, u } = setup();
  svc.write(u('h.bin'), new Uint8Array(0), 'create');
  svc.writeAt(u('h.bin'), 0, new Uint8Array([1, 2, 3, 4]));
  svc.writeAt(u('h.bin'), 4, new Uint8Array([5, 6]));
  assert.deepEqual([...svc.readRange(u('h.bin'), 2, 3)], [3, 4, 5]);
  assert.deepEqual([...svc.readRange(u('h.bin'), 4, 10)], [5, 6]);
  assert.equal(svc.readRange(u('h.bin'), 99, 5).length, 0);
  assert.equal(code(() => svc.writeAt(u('missing'), 0, new Uint8Array([1]))), 'NOT_FOUND');
});

test('mkdir/list/remove/move/copy', () => {
  const { svc, u, documentRoot } = setup();
  svc.mkdir(u('d1', 'sub'), { intermediates: true });
  assert.equal(code(() => svc.mkdir(u('d1'), {})), 'ALREADY_EXISTS');
  svc.mkdir(u('d1'), { idempotent: true });
  assert.equal(code(() => svc.mkdir(u('x', 'y'), {})), 'NOT_FOUND');
  svc.write(u('d1', 'f.txt'), 'hi', 'create');
  assert.deepEqual(svc.list(u('d1')).map((e) => [e.name, e.isDirectory]), [['f.txt', false], ['sub', true]]);

  svc.write(u('m1.txt'), 'one', 'create'); svc.write(u('m2.txt'), 'two', 'create');
  svc.move(u('m1.txt'), u('m2.txt'), 'file');                       // ملف فوق ملف: يستبدل
  assert.equal(svc.read(u('m2.txt'), 'text'), 'one');
  assert.equal(svc.stat(u('m1.txt')).exists, false);
  svc.copy(u('d1'), u('d2'), 'dir');
  assert.equal(svc.read(u('d2', 'f.txt'), 'text'), 'hi');
  assert.equal(code(() => svc.copy(u('d1'), u('d2'), 'dir')), 'ALREADY_EXISTS');
  assert.equal(code(() => svc.move(u('d1'), u('d1', 'sub', 'in'), 'dir')), 'INVALID_PAYLOAD');
  assert.equal(code(() => svc.move(u('d1'), u('d2'), 'dir')), 'ALREADY_EXISTS');
  svc.move(u('d1'), u('d3'), 'dir');
  assert.ok(fs.existsSync(path.join(documentRoot, 'd3', 'f.txt')));
  assert.equal(code(() => svc.remove(u('d3'), { kind: 'file' })), 'INVALID_PAYLOAD');
  svc.remove(u('d3'), { kind: 'dir' });
  assert.equal(code(() => svc.remove(u('d3'))), 'NOT_FOUND');
  assert.equal(code(() => svc.remove(pathToFileURL(documentRoot).href)), 'FS_FORBIDDEN');
});

test('المنح: مجلد اختاره المستخدم يُسمح به وغيره لا', () => {
  const { svc, base, u } = setup();
  const ext = path.join(base, 'Downloads'); fs.mkdirSync(ext);
  const target = pathToFileURL(path.join(ext, 'r.pdf')).href;
  assert.equal(code(() => svc.write(target, 'x', 'create')), 'FS_FORBIDDEN');
  svc.policy.grantDir(ext, true);
  svc.write(target, 'x', 'create');
  assert.equal(fs.readFileSync(path.join(ext, 'r.pdf'), 'utf8'), 'x');
  svc.policy.grantFile(path.join(base, 'only.txt'), false);
  fs.writeFileSync(path.join(base, 'only.txt'), 'o');
  assert.equal(svc.read(pathToFileURL(path.join(base, 'only.txt')).href, 'text'), 'o');
  assert.equal(code(() => svc.write(pathToFileURL(path.join(base, 'only.txt')).href, 'z', 'overwrite')), 'FS_FORBIDDEN');
  assert.equal(code(() => svc.read(pathToFileURL(path.join(base, 'other.txt')).href)), 'FS_FORBIDDEN');
  assert.ok(u('x'));
});

test('pickedCopy و purgeCache', () => {
  const { svc, base, cacheRoot } = setup();
  const src = path.join(base, 'مستند: تجربة?.pdf'.replace(/[:?]/g, '')); fs.writeFileSync(src, '%PDF-1');
  const r = svc.pickedCopy(src);
  assert.match(r.uri, /\/cache\/picked\//);
  assert.equal(svc.read(r.uri, 'text'), '%PDF-1');
  assert.ok(svc.purgeCache() >= 1);
  assert.deepEqual(fs.readdirSync(cacheRoot), []);
});

test('toLocalPath على Windows: محركات وUNC وADS وأسماء محجوزة', () => {
  assert.equal(toLocalPath('file:///C:/Users/a%20b/x.pdf', 'win32'), 'C:\\Users\\a b\\x.pdf');
  assert.equal(toLocalPath('C:/Users/x.pdf', 'win32'), 'C:\\Users\\x.pdf');
  const c = (u) => { try { toLocalPath(u, 'win32'); } catch (e) { return e.code; } };
  assert.equal(c('file://server/share/x.pdf'), 'FS_FORBIDDEN');
  assert.equal(c('\\\\server\\share\\x'), 'INVALID_PAYLOAD');
  assert.equal(c('C:\\a\\b.txt:stream'), 'FS_FORBIDDEN');
  assert.equal(c('C:\\a\\NUL'), 'FS_FORBIDDEN');
  assert.equal(c('C:\\a\\com1.txt'), 'FS_FORBIDDEN');
  assert.equal(c('C:\\a\\b.'), 'FS_FORBIDDEN');
  assert.equal(c('/etc/passwd'), 'INVALID_PAYLOAD');
  assert.equal(c('file:///C:/a/%00b'), 'INVALID_PAYLOAD');
});
