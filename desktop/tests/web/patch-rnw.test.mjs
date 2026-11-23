import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchRnwEsm, buildCjsWrapper, applyRnwPatch, toSpecifier, PATCH_MARK, OVERRIDES } from '../../scripts/lib/patch-rnw.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE = `/** license */
export { default as AccessibilityInfo } from './exports/AccessibilityInfo';
export { default as Alert } from './exports/Alert';
export { default as AppRegistry } from './exports/AppRegistry';
export { default as I18nManager } from './exports/I18nManager';
export { default as StatusBar } from './exports/StatusBar';
export { default as View } from './exports/View';
`;
const SAMPLE_CRLF = SAMPLE.replace(/\n/g, '\r\n');

test('ESM: يزيل Alert/I18nManager الأصليَّين ويصدّر بدائلنا مرة واحدة', () => {
  for (const src of [SAMPLE, SAMPLE_CRLF]) {
    const out = patchRnwEsm(src, '../../../scd-shims/rnw-extras');
    assert.ok(out.includes(PATCH_MARK));
    assert.ok(!/export \{ default as Alert \}/.test(out));
    assert.ok(!/export \{ default as I18nManager \}/.test(out));
    for (const n of OVERRIDES) assert.equal((out.match(new RegExp(`export const ${n}\\b`, 'g')) || []).length, 1, n);
    assert.ok(out.includes("export { default as View } from './exports/View'"), 'بقية التصديرات سليمة');
    assert.ok(out.includes("export { default as StatusBar }"), 'StatusBar الأصلي يبقى');
    assert.ok(!/export const StatusBar/.test(out));
    assert.ok(out.includes("from '../../../scd-shims/rnw-extras'"));
  }
});

test('ESM: بلا StatusBar أصلي ← نصدّر بدلاً منه', () => {
  const out = patchRnwEsm(SAMPLE.replace(/^export \{ default as StatusBar.*\n/m, ''), './x');
  assert.match(out, /export const StatusBar = __scdX\.StatusBar/);
});

test('ESM: idempotent (تشغيل ثانٍ لا يغيّر شيئاً)', () => {
  const once = patchRnwEsm(SAMPLE, './x');
  assert.equal(patchRnwEsm(once, './x'), once);
});

test('ESM: صيغة غير متوقعة ← فشل صريح لا نجاح كاذب', () => {
  assert.throws(() => patchRnwEsm('export const nothing = 1;\n', './x'), /View\/AppRegistry/);
  const odd = SAMPLE.replace("export { default as Alert } from './exports/Alert';", "export { default as Alert, default as Alert2 } from './exports/Alert';");
  assert.throws(() => patchRnwEsm(odd, './x'), /Alert/);
});

test('toSpecifier: مسار نسبي بشرطات مائلة أمامية', () => {
  const stage = path.join('C:', 'a', 'stage');
  const spec = toSpecifier(path.join(stage, 'node_modules', 'react-native-web', 'dist', 'index.js'), path.join(stage, 'scd-shims', 'rnw-extras'));
  assert.equal(spec, '../../../scd-shims/rnw-extras');
});

test('CJS: الغلاف يحافظ على الأصل ويستبدل المطلوب فقط', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rnwcjs-'));
  mkdirSync(path.join(dir, 'node_modules', 'react'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'react', 'index.js'), 'exports.createElement = function () {};');
  // أصل يشبه مخرجات Babel: خصائص غير قابلة للضبط (configurable=false).
  writeFileSync(path.join(dir, 'index.original.js'), `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
Object.defineProperty(exports, "View", { enumerable: true, get: function () { return 'RNWView'; } });
Object.defineProperty(exports, "AppRegistry", { enumerable: true, get: function () { return { registerComponent() {} }; } });
Object.defineProperty(exports, "Alert", { enumerable: true, get: function () { return { alert: 'noop' }; } });
Object.defineProperty(exports, "Text", { enumerable: true, get: function () { return 'RNWText'; } });
`);
  writeFileSync(path.join(dir, 'extras.js'), `exports.createScdExtras = function (c) { global.__core = c; return { Alert: { alert: 'scd' }, Share: 'S', I18nManager: 'I', DevSettings: 'D', StatusBar: 'SB' }; };`);
  writeFileSync(path.join(dir, 'index.js'), buildCjsWrapper('./extras.js'));
  const m = createRequire(import.meta.url)(path.join(dir, 'index.js'));
  assert.equal(m.Alert.alert, 'scd');
  assert.equal(m.Share, 'S');
  assert.equal(m.Text, 'RNWText');
  assert.equal(m.View, 'RNWView');
  assert.equal(m.StatusBar, 'SB');
  assert.equal(m.__esModule, true);
  assert.equal(global.__core.View, 'RNWView');
  delete global.__core;
});

test('applyRnwPatch على مجلد مرحلي اصطناعي (ESM + CJS) وتكراره', () => {
  const stage = mkdtempSync(path.join(tmpdir(), 'rnwstage-'));
  const pkg = path.join(stage, 'node_modules', 'react-native-web');
  mkdirSync(path.join(pkg, 'dist', 'cjs'), { recursive: true });
  mkdirSync(path.join(stage, 'scd-shims'), { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), '{"name":"react-native-web","version":"0.21.0"}');
  writeFileSync(path.join(pkg, 'dist', 'index.js'), SAMPLE);
  writeFileSync(path.join(pkg, 'dist', 'cjs', 'index.js'), '"use strict";\nexports.View = 1;\n');
  const quiet = () => {};
  applyRnwPatch(stage, quiet);
  const esm1 = readFileSync(path.join(pkg, 'dist', 'index.js'), 'utf8');
  assert.ok(esm1.includes("'../../../scd-shims/rnw-extras'"));
  assert.ok(existsSync(path.join(pkg, 'dist', 'cjs', 'index.original.js')));
  assert.ok(readFileSync(path.join(pkg, 'dist', 'cjs', 'index.js'), 'utf8').includes("'../../../../scd-shims/rnw-extras'"));
  applyRnwPatch(stage, quiet); // مرة ثانية
  assert.equal(readFileSync(path.join(pkg, 'dist', 'index.js'), 'utf8'), esm1);
  assert.equal(readFileSync(path.join(pkg, 'dist', 'cjs', 'index.original.js'), 'utf8'), '"use strict";\nexports.View = 1;\n');
});

test('applyRnwPatch: الحزمة غير مثبّتة ← خطأ واضح', () => {
  assert.throws(() => applyRnwPatch(mkdtempSync(path.join(tmpdir(), 'empty-')), () => {}), /غير مثبّتة/);
});

test('rnw-extras.ts: يصدّر البدائل ويضبط RTL ويلفّ AppRegistry مرة واحدة', async () => {
  // Node ESM يشترط الامتداد في الاستيراد النسبي (Metro لا يشترطه): ننسخ الـ shims إلى مجلد مؤقت ونضيف .ts.
  const tmp = mkdtempSync(path.join(tmpdir(), 'extras-'));
  for (const f of ['rnw-extras.ts', 'web-alert.ts', 'alert-core.ts', 'web-share.ts', 'web-i18n.ts']) {
    const code = readFileSync(path.join(desktop, 'shims', f), 'utf8').replace(/from '(\.\/[\w-]+)'/g, "from '$1.ts'");
    writeFileSync(path.join(tmp, f), code);
  }
  const { createScdExtras } = await import(pathToFileURL(path.join(tmp, 'rnw-extras.ts')).href);
  const calls = [];
  const registry = { registerComponent(key, provider) { calls.push(key); return provider; } };
  const x = createScdExtras({ View: 'VIEW', AppRegistry: registry, createElement: (...a) => a });
  assert.equal(typeof x.Alert.alert, 'function');
  assert.equal(typeof x.Share.share, 'function');
  assert.equal(x.I18nManager.isRTL, true);
  assert.equal(typeof x.DevSettings.reload, 'function');
  assert.ok(x.StatusBar);
  assert.equal(globalThis.__SCD_RN_WEB__.shim, 1);
  const first = registry.registerComponent;
  createScdExtras({ View: 'VIEW', AppRegistry: registry, createElement: (...a) => a });
  assert.equal(registry.registerComponent, first, 'لا لفّ مزدوج');
  const provider = registry.registerComponent('main', () => function Inner() { return null; });
  const Wrapped = provider();
  assert.equal(Wrapped.name, 'ScdRtlRoot');
  const el = Wrapped({ a: 1 });
  assert.equal(el[0], 'VIEW');
  assert.equal(el[1].dir, 'rtl');
  assert.equal(calls[0], 'main');
});
