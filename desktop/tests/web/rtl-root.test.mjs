import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createShimResolver, buildTable } = require('../../shims/metro-alias.cjs');
const registry = require('../../shims/registry.json');

// rtl-root.ts بلا أي استيراد، فيُحمَّل مباشرة. نعزل globalThis بين الاختبارات.
const load = async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rtlroot-'));
  writeFileSync(path.join(tmp, 'rtl-root.ts'), readFileSync(path.join(desktop, 'shims', 'rtl-root.ts'), 'utf8'));
  return import(pathToFileURL(path.join(tmp, 'rtl-root.ts')).href + '?t=' + Math.random());
};
const reset = () => { delete globalThis.__scdRtlRootCtx; delete globalThis.__SCD_RN_DIAG; };

// React مصغّر: السياق قيمة حالية يضبطها Provider أثناء الرسم المتداخل.
function fakeReact() {
  let current = new Map();
  const R = {
    createContext: (v) => { const c = { _default: v }; c.Provider = Symbol('Provider'); return c; },
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useContext: (c) => (current.has(c) ? current.get(c) : c._default),
  };
  // يرسم شجرة عناصر مبسّطة: يستدعي المكوّنات الدالّية ويضبط قيمة Provider لأبنائها.
  R.render = (el) => {
    if (el == null || typeof el !== 'object') return el;
    if (typeof el.type === 'function') return R.render(el.type({ ...el.props, children: el.children.length > 1 ? el.children : el.children[0] }));
    if (typeof el.type === 'symbol') {
      const ctx = [...current.keys()].length; void ctx;
      const key = Object.values(globalThis).find((v) => v && v.Provider === el.type);
      const prev = current.get(key);
      current.set(key, el.props.value);
      const kids = el.children.map(R.render);
      prev === undefined ? current.delete(key) : current.set(key, prev);
      return { ...el, children: kids };
    }
    return { ...el, children: el.children.map(R.render) };
  };
  return R;
}
const findAll = (el, pred, out = []) => { if (el && typeof el === 'object') { if (pred(el)) out.push(el); (el.children || []).forEach((c) => findAll(c, pred, out)); } return out; };

test('createRtlRoot: يلفّ بـ View dir=rtl lang=ar وflex:1 ويمرّر ref يضبط السمات', async () => {
  reset();
  const { createRtlRoot, applyRtlAttrs } = await load();
  const R = fakeReact();
  const Root = createRtlRoot(R, 'VIEW');
  const tree = R.render(R.createElement(Root, null, R.createElement('child', {})));
  const views = findAll(tree, (e) => e.type === 'VIEW');
  assert.equal(views.length, 1);
  assert.equal(views[0].props.dir, 'rtl');
  assert.equal(views[0].props.lang, 'ar');
  assert.deepEqual(views[0].props.style, { flex: 1 });
  assert.equal(views[0].props.ref, applyRtlAttrs);
  assert.equal(findAll(tree, (e) => e.type === 'child').length, 1, 'الابن يبقى داخل الجذر');
  assert.equal(globalThis.__SCD_RN_DIAG.rtlRoot, 1);
});

test('createRtlRoot: لا لفّ مزدوج عند التداخل (سياق مشترك)', async () => {
  reset();
  const { createRtlRoot } = await load();
  const R = fakeReact();
  const A = createRtlRoot(R, 'VIEW');
  const B = createRtlRoot(R, 'VIEW'); // نسخة ثانية (مثلاً ESM/CJS) تتشارك السياق عبر globalThis
  const tree = R.render(R.createElement(A, null, R.createElement(B, null, R.createElement('leaf', {}))));
  assert.equal(findAll(tree, (e) => e.type === 'VIEW').length, 1);
  assert.equal(findAll(tree, (e) => e.type === 'leaf').length, 1);
  assert.equal(globalThis.__SCD_RN_DIAG.rtlRootNested, 1);
});

test('createRtlRoot: إن كان لفّ AppRegistry يعمل (rendered>0) لا نضيف جذراً ثانياً', async () => {
  reset();
  const { createRtlRoot, getDiag } = await load();
  getDiag().rendered = 1;
  const R = fakeReact();
  const Root = createRtlRoot(R, 'VIEW');
  const tree = R.render(R.createElement(Root, null, R.createElement('leaf', {})));
  assert.equal(findAll(tree, (e) => e.type === 'VIEW').length, 0);
  assert.equal(findAll(tree, (e) => e.type === 'leaf').length, 1);
});

test('getDiag: يكمّل الحقول الناقصة دون مسح عدّادات rnw-extras', async () => {
  reset();
  globalThis.__SCD_RN_DIAG = { registered: 3, rendered: 0, patchedRegistry: true, hasRegistry: true };
  const { getDiag } = await load();
  const d = getDiag();
  assert.equal(d.registered, 3);
  assert.equal(d.patchedRegistry, true);
  assert.equal(d.rtlRoot, 0);
  assert.equal(d.rtlRootNested, 0);
});

test('applyRtlAttrs: يضبط dir/lang على العقدة ويتجاهل null', async () => {
  reset();
  const { applyRtlAttrs } = await load();
  const attrs = {};
  applyRtlAttrs({ setAttribute: (k, v) => { attrs[k] = v; } });
  assert.deepEqual(attrs, { dir: 'rtl', lang: 'ar' });
  assert.doesNotThrow(() => { applyRtlAttrs(null); applyRtlAttrs({}); });
});

test('registry: react-native-safe-area-context صار shim وملفه موجود ويُحوَّل على web+windows فقط', () => {
  const e = registry.modules['react-native-safe-area-context'];
  assert.equal(e.action, 'shim');
  assert.ok(existsSync(path.join(desktop, 'shims', e.file)));
  const shim = path.join(desktop, 'shims', e.file);
  const fakeCtx = (origin) => ({ originModulePath: origin, resolveRequest: () => ({ type: 'base' }) });
  const r = createShimResolver(undefined, { enabled: () => true });
  assert.equal(r(fakeCtx('/p/src/app/_layout.tsx'), 'react-native-safe-area-context', 'web').filePath, shim);
  assert.equal(r(fakeCtx('/p/node_modules/expo-router/build/ExpoRoot.js'), 'react-native-safe-area-context', 'web').filePath, shim);
  assert.equal(r(fakeCtx(shim), 'react-native-safe-area-context', 'web').type, 'base', 'الـ shim نفسه يصل للحزمة الحقيقية');
  assert.equal(r(fakeCtx('/p/src/a.tsx'), 'react-native-safe-area-context', 'android').type, 'base');
  assert.equal(r(fakeCtx('/p/src/a.tsx'), 'react-native-safe-area-context', 'ios').type, 'base');
  assert.equal(createShimResolver(undefined, { enabled: () => false })(fakeCtx('/p/a.tsx'), 'react-native-safe-area-context', 'web').type, 'base');
  assert.ok(buildTable(registry, desktop).has('react-native-safe-area-context'));
});

test('safe-area-context.tsx: يعيد تصدير الحزمة ويلفّ SafeAreaProvider فقط، بلا Node ولا src ولا HTML', () => {
  const s = readFileSync(path.join(desktop, 'shims', 'safe-area-context.tsx'), 'utf8');
  assert.match(s, /export \* from 'react-native-safe-area-context'/);
  assert.match(s, /export function SafeAreaProvider/);
  assert.match(s, /createRtlRoot\(/);
  for (const f of ['safe-area-context.tsx', 'rtl-root.ts']) {
    const t = readFileSync(path.join(desktop, 'shims', f), 'utf8');
    assert.ok(!/require\(|node:|process\./.test(t), f + ' يستعمل Node');
    assert.ok(!/from\s+['"][./]*\/?src\//.test(t) && !t.includes("'@/"), f + ' يستورد من src');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(t), f + ' يحقن HTML/eval');
  }
  assert.ok(!/from\s+['"]react(-native)?['"]/.test(readFileSync(path.join(desktop, 'shims', 'rtl-root.ts'), 'utf8')), 'rtl-root لا يستورد react/react-native');
});
