import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const sec = require('../../electron/lib/security.cjs');

test('isTrustedUrl: app://bundle فقط، وorigin التطوير عند تمريره', () => {
  assert.ok(sec.isTrustedUrl('app://bundle/index.html'));
  assert.ok(sec.isTrustedUrl('app://bundle/cases/1?x=2'));
  assert.ok(!sec.isTrustedUrl('app://evil/index.html'));
  assert.ok(!sec.isTrustedUrl('https://bundle/'));
  assert.ok(!sec.isTrustedUrl('file:///C:/x.html'));
  assert.ok(!sec.isTrustedUrl('data:text/html,hi'));
  assert.ok(!sec.isTrustedUrl(undefined));
  assert.ok(!sec.isTrustedUrl('http://localhost:8081/'));
  assert.ok(sec.isTrustedUrl('http://localhost:8081/x', 'http://localhost:8081'));
  assert.ok(!sec.isTrustedUrl('http://localhost:9999/x', 'http://localhost:8081'));
});

test('parseDevUrl: يُتجاهل في النسخة المُحزَّمة وخارج localhost', () => {
  assert.equal(sec.parseDevUrl('http://localhost:8081', true), null);
  assert.equal(sec.parseDevUrl('http://evil.com:8081', false), null);
  assert.equal(sec.parseDevUrl('https://localhost:8081', false), null);
  assert.equal(sec.parseDevUrl('not a url', false), null);
  assert.equal(sec.parseDevUrl('http://127.0.0.1:8081/x', false), 'http://127.0.0.1:8081');
});

test('isSafeExternalUrl: https فقط وبلا بيانات اعتماد', () => {
  assert.ok(sec.isSafeExternalUrl('https://example.com/a'));
  for (const u of ['http://example.com', 'file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)', 'ms-msdt:/x', 'https://u:p@example.com', 'app://bundle/']) {
    assert.ok(!sec.isSafeExternalUrl(u), u);
  }
});

test('safeResolve: يمنع الخروج من الجذر', () => {
  const root = path.resolve('/srv/web');
  assert.equal(sec.safeResolve(root, '/index.html'), path.join(root, 'index.html'));
  assert.equal(sec.safeResolve(root, '/a/b.js'), path.join(root, 'a', 'b.js'));
  for (const bad of ['/../etc/passwd', '/a/../../x', '/%2e%2e/x', '/..%2f..%2fx', '/a\\b', '/a%5Cb', '/x%00.js', '/%E0%A4%A']) {
    assert.equal(sec.safeResolve(root, bad), null, bad);
  }
});

test('resolveRequest: ملف | SPA fallback | 404 للأصول المفقودة | 400 للخطِر', () => {
  const root = path.resolve('/srv/web');
  const files = new Set([path.join(root, 'index.html'), path.join(root, '_expo', 'app.js')]);
  const fsImpl = { statSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return { isFile: () => true }; } };
  assert.deepEqual(sec.resolveRequest(root, '/_expo/app.js', fsImpl), { status: 200, file: path.join(root, '_expo', 'app.js') });
  assert.equal(sec.resolveRequest(root, '/', fsImpl).spa, true);
  assert.equal(sec.resolveRequest(root, '/cases/12', fsImpl).spa, true);
  assert.equal(sec.resolveRequest(root, '/missing.js', fsImpl).status, 404);
  assert.equal(sec.resolveRequest(root, '/..%5Cx', fsImpl).status, 400);
  assert.equal(sec.resolveRequest(root, '/x', { statSync: () => { throw new Error('no'); } }).status, 404);
});

test('CSP: بلا unsafe-eval ولا unsafe-inline للسكربت، وlockdown كامل', () => {
  const csp = sec.buildCsp();
  const dir = (n) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(n + ' '));
  assert.ok(!/unsafe-eval/.test(csp));
  assert.equal(dir('script-src'), "script-src 'self'");
  assert.equal(dir('default-src'), "default-src 'none'");
  for (const d of ["object-src 'none'", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'self'"]) assert.ok(csp.includes(d), d);
  assert.ok(!/https?:\/\//.test(csp), 'لا مصادر خارجية');
  assert.ok(sec.SECURITY_HEADERS['X-Content-Type-Options'] === 'nosniff');
});

test('APP_ENTRY هو app://bundle/ (لا /index.html) كي يطابق expo-router الشاشة الرئيسية', () => {
  assert.equal(sec.APP_ENTRY, 'app://bundle/');
  assert.equal(new URL(sec.APP_ENTRY).pathname, '/');
  assert.ok(sec.isTrustedUrl(sec.APP_ENTRY));
  const root = path.resolve('/tmp/scd-root');
  const files = new Set([path.join(root, 'index.html')]);
  const fsImpl = { statSync: (p) => { if (files.has(p)) return { isFile: () => true }; throw new Error('ENOENT'); } };
  const r = sec.resolveRequest(root, '/', fsImpl);
  assert.equal(r.status, 200);
  assert.equal(r.file, path.join(root, 'index.html'));
});
