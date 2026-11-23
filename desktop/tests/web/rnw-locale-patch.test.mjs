import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { patchLocaleDefault, applyRnwPatch, LOCALE_MARK } from '../../scripts/lib/patch-rnw.mjs';

const ESM = `import * as React from 'react';
var defaultLocale = {
  direction: 'ltr',
  locale: 'en-US'
};
var LocaleContext = /*#__PURE__*/createContext(defaultLocale);
export function LocaleProvider(props) { return props.children; }
`;
const CJS = `"use strict";
exports.__esModule = true;
const defaultLocale = { direction: "ltr", locale: "en-US" };
exports.LocaleProvider = function () {};
`;

test('الطبقة B: يحوّل defaultLocale إلى rtl (ESM وCJS) ويحفظ locale والبقية', () => {
  for (const src of [ESM, CJS]) {
    const r = patchLocaleDefault(src);
    assert.equal(r.status, 'patched');
    assert.match(r.src, /direction:\s*(['"])rtl\1/);
    assert.ok(!/direction:\s*(['"])ltr\1/.test(r.src));
    assert.match(r.src, /locale:\s*(['"])en-US\1/);
    assert.ok(r.src.includes(LOCALE_MARK));
    assert.doesNotThrow(() => new Function(r.src.replace(/^import .*$/m, '').replace(/^export function/m, 'function').replace(/^exports\..*$/gm, '').replace(/createContext\(defaultLocale\)/, 'null')));
  }
});

test('الطبقة B: idempotent وصيغة غير معروفة ← missing بلا تعديل ولا رمي', () => {
  const once = patchLocaleDefault(ESM).src;
  assert.deepEqual(patchLocaleDefault(once), { src: once, status: 'already' });
  const odd = 'const x = { direction: "ltr" };\n';
  assert.deepEqual(patchLocaleDefault(odd), { src: odd, status: 'missing' });
});

test('applyRnwPatch: يعدّل useLocale في ESM وCJS إن وُجد ويتخطّاه بتحذير إن غاب', () => {
  const mk = (withLocale) => {
    const stage = mkdtempSync(path.join(tmpdir(), 'rnwloc-'));
    const pkg = path.join(stage, 'node_modules', 'react-native-web');
    mkdirSync(path.join(pkg, 'dist', 'cjs', 'modules', 'useLocale'), { recursive: true });
    mkdirSync(path.join(pkg, 'dist', 'modules', 'useLocale'), { recursive: true });
    mkdirSync(path.join(stage, 'scd-shims'), { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), '{"name":"react-native-web","version":"0.21.0"}');
    writeFileSync(path.join(pkg, 'dist', 'index.js'), "export { default as View } from './exports/View';\nexport { default as AppRegistry } from './exports/AppRegistry';\nexport { default as Alert } from './exports/Alert';\nexport { default as I18nManager } from './exports/I18nManager';\n");
    writeFileSync(path.join(pkg, 'dist', 'cjs', 'index.js'), '"use strict";\nexports.View = 1;\n');
    if (withLocale) {
      writeFileSync(path.join(pkg, 'dist', 'modules', 'useLocale', 'index.js'), ESM);
      writeFileSync(path.join(pkg, 'dist', 'cjs', 'modules', 'useLocale', 'index.js'), CJS);
    }
    return { stage, pkg };
  };
  const a = mk(true); const logs = [];
  const r1 = applyRnwPatch(a.stage, (m) => logs.push(m));
  assert.equal(r1.localeOk, 2);
  for (const p of [['dist', 'modules', 'useLocale', 'index.js'], ['dist', 'cjs', 'modules', 'useLocale', 'index.js']]) {
    assert.match(readFileSync(path.join(a.pkg, ...p), 'utf8'), /direction:\s*(['"])rtl\1/);
  }
  const before = readFileSync(path.join(a.pkg, 'dist', 'modules', 'useLocale', 'index.js'), 'utf8');
  assert.equal(applyRnwPatch(a.stage, () => {}).localeOk, 2);
  assert.equal(readFileSync(path.join(a.pkg, 'dist', 'modules', 'useLocale', 'index.js'), 'utf8'), before, 'تكرار التطبيق لا يغيّر شيئاً');
  const b = mk(false); const logsB = [];
  assert.equal(applyRnwPatch(b.stage, (m) => logsB.push(m)).localeOk, 0);
  assert.ok(logsB.some((m) => m.includes('⚠')));
});
