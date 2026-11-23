import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STAGE_COPY, WEB_DEPS, buildStagedAppJson, buildMetroConfig, patchIndexHtml, verifyWebDist, CAIRO_WEIGHTS,
} from '../../scripts/lib/stage.mjs';

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rootApp = JSON.parse(readFileSync(path.join(desktop, '..', 'app.json'), 'utf8'));
const { createShimResolver, buildTable } = require('../../shims/metro-alias.cjs');

test('app.json المرحلي: output=single وasyncRoutes معطّل، والأصل لم يتغير', () => {
  const before = JSON.stringify(rootApp);
  const staged = buildStagedAppJson(rootApp).expo;
  assert.equal(JSON.stringify(rootApp), before, 'الدالة تعدّل الأصل!');
  assert.equal(staged.web.output, 'single');
  assert.equal(staged.web.bundler, 'metro');
  assert.equal(staged.extra.router.asyncRoutes.web, false);
  const router = staged.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === 'expo-router');
  assert.equal(router[1].asyncRoutes.web, false);
  assert.equal(staged.slug, rootApp.expo.slug);
  assert.equal(staged.web.favicon, rootApp.expo.web.favicon);
  assert.equal(staged.extra.eas, undefined);
});

test('أصل app.json يبقى مخصّصاً لأندرويد (لا web.output فيه)', () => {
  assert.equal(rootApp.expo.web.output, undefined);
});

test('قائمة النسخ: لا android ولا tests ولا desktop ولا سكربتات الإصلاح', () => {
  for (const bad of ['desktop', 'tests', 'android', 'backend', '.github', 'eas.json']) assert.ok(!STAGE_COPY.includes(bad), bad);
  assert.ok(STAGE_COPY.includes('src'));
  assert.deepEqual([...WEB_DEPS].sort(), ['@expo/metro-runtime', 'react-dom', 'react-native-web']);
});

test('metro.config المُولَّد صالح نحوياً ويربط المحلّل', () => {
  const src = buildMetroConfig();
  assert.ok(src.includes("SCD_TARGET = 'windows'") && src.includes('createShimResolver'));
  new Function('require', 'module', '__dirname', src.replace(/const \{ getDefaultConfig \}[^\n]*\n/, '')); // نحو سليم
});

const fakeCtx = (origin) => ({ originModulePath: origin, resolveRequest: () => ({ type: 'base' }) });

test('المحلّل: react-native وreact-native-web يُحوَّلان للـ shim على web+windows فقط', () => {
  const r = createShimResolver(undefined, { enabled: () => true });
  const shim = path.join(desktop, 'shims', 'react-native.tsx');
  for (const name of ['react-native', 'react-native-web']) {
    assert.equal(r(fakeCtx('/p/src/a.tsx'), name, 'web').filePath, shim, name);
    assert.equal(r(fakeCtx('/p/src/a.tsx'), name, 'android').type, 'base', name + ' android');
    assert.equal(r(fakeCtx('/p/src/a.tsx'), name, 'ios').type, 'base', name + ' ios');
  }
});

test('المحلّل: الـ shim نفسه يصل إلى react-native-web الحقيقي (لا حلقة لا نهائية)', () => {
  const r = createShimResolver(undefined, { enabled: () => true });
  const shim = path.join(desktop, 'shims', 'react-native.tsx');
  assert.equal(r(fakeCtx(shim), 'react-native-web', 'web').type, 'base');
});

test('المحلّل: معطّل بدون SCD_TARGET=windows ⇒ لا تغيير', () => {
  const r = createShimResolver(undefined, { enabled: () => false });
  assert.equal(r(fakeCtx('/p/a.tsx'), 'react-native', 'web').type, 'base');
  assert.equal(r(fakeCtx('/p/a.tsx'), 'expo-sqlite', 'web').type, 'base');
});

test('المحلّل: shims الأقسام الأخرى ما زالت تعمل', () => {
  const r = createShimResolver(undefined, { enabled: () => true });
  assert.ok(r(fakeCtx('/p/a.tsx'), 'expo-sqlite', 'web').filePath.endsWith('expo-sqlite.ts'));
  assert.equal(r(fakeCtx('/p/a.tsx'), 'expo-crypto', 'web').type, 'base'); // native-web
  assert.ok(buildTable(require('../../shims/registry.json'), desktop).has('react-native-web'));
});

test('patchIndexHtml: lang/dir/title/خلفية، بلا سكربت inline، ومتكرر الأمان', () => {
  const src = '<!DOCTYPE html><html lang="en"><head><title>x</title><meta charset="utf-8"></head><body><div id="root"></div><script src="/_expo/a.js" defer></script></body></html>';
  const once = patchIndexHtml(src);
  assert.match(once, /<html lang="ar" dir="rtl">/);
  assert.match(once, /<title>SecureCaseDesk<\/title>/);
  assert.match(once, /background:#0B1120/);
  assert.ok(!/<script(?![^>]*src=)/.test(once));
  assert.equal(patchIndexHtml(once), once);
});

function fixture(over = {}) {
  const files = {
    'index.html': patchIndexHtml('<html><head></head><body><div id="root"></div><script src="/_expo/static/js/web/entry.js" defer></script></body></html>'),
    '_expo/static/js/web/entry.js': 'globalThis.__SCD_RN_WEB__=1;"scd-alert-overlay";"DesktopNotImplementedError"',
    'assets/x.png': 'png',
    ...Object.fromEntries(CAIRO_WEIGHTS.map((w) => [`assets/node_modules/@expo-google-fonts/cairo/${w}.abc.ttf`, 'f'])),
    ...over,
  };
  for (const k of Object.keys(files)) if (files[k] === null) delete files[k];
  return { files: Object.keys(files), readText: (f) => files[f] };
}

test('verifyWebDist: مخرجات سليمة ⇒ لا أخطاء', () => {
  assert.deepEqual(verifyWebDist(fixture()), []);
});

test('verifyWebDist: يلتقط الأعطال المهمة', () => {
  const has = (f, re) => verifyWebDist(f).some((e) => re.test(e));
  assert.ok(has(fixture({ 'index.html': null }), /index\.html/));
  assert.ok(has(fixture({ '_expo/static/js/web/entry.js': 'nothing' }), /__SCD_RN_WEB__/));
  assert.ok(has(fixture({ 'assets/node_modules/@expo-google-fonts/cairo/Cairo_700Bold.abc.ttf': null }), /Cairo_700Bold/));
  assert.ok(has(fixture({ 'index.html': '<html lang="ar" dir="rtl"><script>alert(1)</script><script src="/_expo/static/js/web/entry.js"></script>' }), /inline/));
  assert.ok(has(fixture({ 'index.html': '<html lang="ar" dir="rtl"><script src="https://evil.example/x.js"></script>' }), /خارجي/));
  assert.ok(has(fixture({ 'index.html': '<html lang="ar" dir="rtl"><script src="/missing.js"></script>' }), /مكسور/));
  assert.ok(has(fixture({ 'index.html': '<html lang="en"><script src="/_expo/static/js/web/entry.js"></script>' }), /rtl/));
});
