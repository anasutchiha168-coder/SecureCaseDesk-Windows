import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rtlguard-'));
  writeFileSync(path.join(tmp, 'web-i18n.ts'), readFileSync(path.join(desktop, 'shims', 'web-i18n.ts'), 'utf8'));
  return import(pathToFileURL(path.join(tmp, 'web-i18n.ts')).href + '?t=' + Math.random());
};
const reset = () => { delete globalThis.__scdRtlDomGuard; delete globalThis.__SCD_RN_DIAG; };
const el = (attrs = {}) => ({ attrs: { ...attrs }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = v; } });
const fakeRoot = () => { const r = el(); r.children = []; return r; };
const fakeDoc = (root, ready = 'complete') => ({ getElementById: (id) => (id === 'root' ? root : null), readyState: ready, listeners: [], addEventListener(n, f) { this.listeners.push([n, f]); } });
const fakeMO = () => { const M = function (cb) { M.last = { cb, observed: null }; this.observe = (t, o) => { M.last.observed = [t, o]; }; }; return M; };

test('الحارس: يضبط dir/lang على الابن الموجود فوراً ويراقب أبناء #root فقط', async () => {
  reset();
  const { installRtlDomGuard } = await load();
  const root = fakeRoot(); const child = el({ dir: 'auto' }); root.children.push(child);
  const MO = fakeMO();
  assert.equal(installRtlDomGuard(fakeDoc(root), { MutationObserver: MO }), true);
  assert.equal(child.attrs.dir, 'rtl');
  assert.equal(child.attrs.lang, 'ar');
  assert.equal(MO.last.observed[0], root);
  assert.deepEqual(MO.last.observed[1], { childList: true });
});

test('الحارس: عقدة تُضاف لاحقاً أو تُستبدل تأخذ dir=rtl عبر المراقب', async () => {
  reset();
  const { installRtlDomGuard } = await load();
  const root = fakeRoot(); const MO = fakeMO(); const g = { MutationObserver: MO };
  installRtlDomGuard(fakeDoc(root), g);
  const late = el(); root.children.push(late);
  MO.last.cb();
  assert.equal(late.attrs.dir, 'rtl');
  const replaced = el(); root.children = [replaced];
  MO.last.cb();
  assert.equal(replaced.attrs.dir, 'rtl');
  assert.equal(g.__SCD_RN_DIAG.domRoot, 2);
});

test('الحارس: idempotent، ولا يعدّ عقدة سليمة مرة ثانية', async () => {
  reset();
  const { installRtlDomGuard } = await load();
  const root = fakeRoot(); root.children.push(el({ dir: 'rtl', lang: 'ar' }));
  const g = { MutationObserver: fakeMO() };
  installRtlDomGuard(fakeDoc(root), g);
  installRtlDomGuard(fakeDoc(root), g);
  assert.equal(g.__scdRtlDomGuard, true);
  assert.ok((g.__SCD_RN_DIAG?.domRoot ?? 0) === 0);
});

test('الحارس: بلا #root الآن ← ينتظر DOMContentLoaded ثم يطبّق', async () => {
  reset();
  const { installRtlDomGuard } = await load();
  const root = fakeRoot(); let present = false;
  const doc = { getElementById: () => (present ? root : null), readyState: 'loading', listeners: [], addEventListener(n, f) { this.listeners.push([n, f]); } };
  assert.equal(installRtlDomGuard(doc, { MutationObserver: fakeMO() }), true);
  assert.equal(doc.listeners[0][0], 'DOMContentLoaded');
  const c = el(); root.children.push(c); present = true;
  doc.listeners[0][1]();
  assert.equal(c.attrs.dir, 'rtl');
});

test('الحارس: بلا document (Node) ← لا يرمي ويعيد false', async () => {
  reset();
  const { installRtlDomGuard } = await load();
  assert.equal(installRtlDomGuard(undefined, {}), false);
  assert.equal(installRtlDomGuard({}, {}), false);
});

test('rnw-extras يستدعي الحارس عند وجود document ويضع domRoot في التشخيص', async () => {
  reset(); delete globalThis.__SCD_RN_WEB__;
  const tmp = mkdtempSync(path.join(tmpdir(), 'extras-g-'));
  for (const f of ['rnw-extras.ts', 'web-alert.ts', 'alert-core.ts', 'web-share.ts', 'web-i18n.ts']) {
    writeFileSync(path.join(tmp, f), readFileSync(path.join(desktop, 'shims', f), 'utf8').replace(/from '(\.\/[\w-]+)'/g, "from '$1.ts'"));
  }
  const root = fakeRoot(); const child = el(); root.children.push(child);
  const docEl = el();
  const prevDoc = globalThis.document;
  globalThis.document = { documentElement: docEl, getElementById: (id) => (id === 'root' ? root : null), addEventListener() {} };
  try {
    const { createScdExtras } = await import(pathToFileURL(path.join(tmp, 'rnw-extras.ts')).href + '?t=' + Math.random());
    createScdExtras({ View: 'VIEW', createElement: () => null });
    assert.equal(docEl.attrs.dir, 'rtl');
    assert.equal(child.attrs.dir, 'rtl');
    assert.equal(globalThis.__SCD_RN_DIAG.domRoot, 1);
  } finally { if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc; }
});

test('web-i18n.ts: الحارس بلا Node ولا HTML ولا eval', () => {
  const t = readFileSync(path.join(desktop, 'shims', 'web-i18n.ts'), 'utf8');
  assert.ok(!/require\(|node:|\bprocess\./.test(t));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(t));
});
