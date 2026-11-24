// إصلاح القسم 4: مكوّنات القسم 4 (وقياس textAlign) يجب أن تدخل الحزمة عبر حقن react-native-web، لا عبر react-native.tsx.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchRnwEsm, buildCjsWrapper, applyRnwPatch, PATCH_MARK, S4_MARK, S4_OVERRIDES, S4_NEEDS } from '../../scripts/lib/patch-rnw.mjs';
import { verifyWebDist, CAIRO_WEIGHTS } from '../../scripts/lib/stage.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAMES = ['AccessibilityInfo', 'ActivityIndicator', 'Alert', 'AppRegistry', 'DevSettings', 'FlatList', 'I18nManager', 'Modal', 'Pressable',
  'RefreshControl', 'ScrollView', 'StatusBar', 'StyleSheet', 'Text', 'TextInput', 'View', 'useWindowDimensions'];
const RNW = '/** license */\n' + NAMES.map((n) => `export { default as ${n} } from './exports/${n}';`).join('\n') + '\nexport { default as TextInputState } from \'./exports/TextInputState\';\n';

test('ESM: يستبدل Text/TextInput/ScrollView/FlatList/Modal/RefreshControl ويصدّر بدائلنا مرة واحدة', () => {
  for (const src of [RNW, RNW.replace(/\n/g, '\r\n')]) {
    const out = patchRnwEsm(src, '../../../scd-shims/rnw-extras', '../../../scd-shims/rnw-section4');
    assert.ok(out.includes(PATCH_MARK) && out.includes(S4_MARK));
    for (const n of S4_OVERRIDES) {
      assert.ok(!new RegExp(`export \\{ default as ${n} \\}`).test(out), n + ' الأصلي ما زال مُصدَّراً');
      assert.equal((out.match(new RegExp(`export const ${n}\\b`, 'g')) || []).length, 1, n);
    }
    assert.ok(out.includes('export { default as TextInputState }'), 'لا يُحذف ما لا يخصّنا');
    assert.ok(out.includes("from '../../../scd-shims/rnw-section4'"));
    for (const n of S4_NEEDS) assert.ok(out.includes(`import __scdR_${n} from './exports/${n}'`), n);
  }
});

test('ESM: idempotent، وبدون section4Spec يبقى السلوك القديم تماماً', () => {
  const once = patchRnwEsm(RNW, './x', './s4');
  assert.equal(patchRnwEsm(once, './x', './s4'), once);
  const legacy = patchRnwEsm(RNW, './x');
  assert.ok(!legacy.includes(S4_MARK));
  assert.ok(legacy.includes("export { default as Text } from './exports/Text'"));
  assert.throws(() => patchRnwEsm(legacy, './x', './s4'), /نسخة قديمة/);
});

test('ESM: غياب مكوّن مطلوب ← فشل صريح لا نجاح كاذب', () => {
  const noFlat = RNW.replace(/^export \{ default as FlatList.*\n/m, '');
  assert.throws(() => patchRnwEsm(noFlat, './x', './s4'), /FlatList/);
});

test('CJS: الغلاف يضيف مكوّنات القسم 4 فقط عند طلبها', () => {
  assert.ok(!buildCjsWrapper('./x').includes('createSection4'));
  const w = buildCjsWrapper('./x', './s4');
  assert.ok(w.includes("require('./s4').createSection4(") && w.includes(S4_MARK));
  assert.doesNotThrow(() => new Function('require', 'module', 'exports', w));
});

test('applyRnwPatch: يحقن القسم 4 حين يوجد rnw-section4.ts في المرحلة', () => {
  const stage = mkdtempSync(path.join(tmpdir(), 'rnws4-'));
  const pkg = path.join(stage, 'node_modules', 'react-native-web');
  mkdirSync(path.join(pkg, 'dist', 'cjs'), { recursive: true });
  mkdirSync(path.join(stage, 'scd-shims'), { recursive: true });
  writeFileSync(path.join(stage, 'scd-shims', 'rnw-section4.ts'), 'export function createSection4(){return{}}');
  writeFileSync(path.join(pkg, 'package.json'), '{"name":"react-native-web","version":"0.21.0"}');
  writeFileSync(path.join(pkg, 'dist', 'index.js'), RNW);
  writeFileSync(path.join(pkg, 'dist', 'cjs', 'index.js'), '"use strict";\nexports.View = 1;\n');
  applyRnwPatch(stage, () => {});
  const esm = readFileSync(path.join(pkg, 'dist', 'index.js'), 'utf8');
  assert.ok(esm.includes("'../../../scd-shims/rnw-section4'") && esm.includes(S4_MARK));
  assert.ok(readFileSync(path.join(pkg, 'dist', 'cjs', 'index.js'), 'utf8').includes("'../../../../scd-shims/rnw-section4'"));
  applyRnwPatch(stage, () => {});
  assert.equal(readFileSync(path.join(pkg, 'dist', 'index.js'), 'utf8'), esm);
});

test('rnw-section4.ts يعمل فعلاً: يضع __SCD_TEXTALIGN_FLIP__ ويعيد المكوّنات الستة (React وهمي)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'scd-s4-'));
  for (const f of ['desktop-layout-core.ts', 'desktop-layout-context.ts', 'text-align-fix.ts', 'rnw-section4.ts']) {
    writeFileSync(path.join(tmp, f), readFileSync(path.join(desktop, 'shims', f), 'utf8').replace(/from '(\.\/[\w-]+)'/g, "from '$1.ts'"));
  }
  const nm = (n, body) => { mkdirSync(path.join(tmp, 'node_modules', ...n.split('/')), { recursive: true }); writeFileSync(path.join(tmp, 'node_modules', ...n.split('/'), 'package.json'), '{"type":"module","main":"index.js"}'); writeFileSync(path.join(tmp, 'node_modules', ...n.split('/'), 'index.js'), body); };
  nm('react', 'export const createElement=(t,p,...c)=>({t,p,c});export const forwardRef=(f)=>f;export const useMemo=(f)=>f();export const useContext=()=>null;export const createContext=(v)=>({v});export const Children={toArray:(c)=>[].concat(c)};');
  nm('react-dom', 'export const flushSync=(f)=>f();');
  mkdirSync(path.join(tmp, 'node_modules', 'react-dom'), { recursive: true });
  writeFileSync(path.join(tmp, 'node_modules', 'react-dom', 'client.js'), 'export const createRoot=()=>({render(){},unmount(){}});');
  writeFileSync(path.join(tmp, 'node_modules', 'react-dom', 'package.json'), '{"type":"module","main":"index.js","exports":{".":"./index.js","./client":"./client.js"}}');
  const mod = await import(pathToFileURL(path.join(tmp, 'rnw-section4.ts')).href);
  delete globalThis.__SCD_TEXTALIGN_FLIP__;
  const R = { View: 'V', Text: 'T', TextInput: 'TI', ScrollView: 'SV', FlatList: 'FL', Modal: 'M', Pressable: 'P', ActivityIndicator: 'AI', StyleSheet: { flatten: (s) => s }, useWindowDimensions: () => ({ width: 1400 }) };
  const out = mod.createSection4(R);
  assert.deepEqual(Object.keys(out).sort(), [...S4_OVERRIDES].sort());
  assert.ok('__SCD_TEXTALIGN_FLIP__' in globalThis, 'القياس لم يضع العلامة');
  assert.equal(out.Text, 'T', 'بلا DOM ⇒ لا تعويض ⇒ المكوّن الأصلي نفسه');
  delete globalThis.__SCD_TEXTALIGN_FLIP__;
});

test('الفحص الثابت: يفشل بلا العلامة ويمرّ معها (نفس رسالة الخطأ في Actions)', () => {
  const mk = (js) => { const files = { 'index.html': '<html lang="ar" dir="rtl"><head><title>x</title></head><body><script src="/e.js"></script></body></html>', 'e.js': js, 'a.png': 'p', ...Object.fromEntries(CAIRO_WEIGHTS.map((w) => [`${w}.ttf`, 'f'])) }; return { files: Object.keys(files), readText: (f) => files[f] }; };
  const base = '"__SCD_RN_WEB__";"scd-alert-overlay";"__scdRtlRootCtx";"__SCD_DESKTOP__";"scd-desktop-css";"DesktopNotImplementedError"';
  assert.ok(verifyWebDist(mk(base)).some((e) => e.includes('textAlign')));
  assert.deepEqual(verifyWebDist(mk(base + ';"__SCD_TEXTALIGN_FLIP__"')), []);
});
