// حقن بدائل Windows داخل حزمة react-native-web المثبّتة في desktop/.stage (لا يمسّ جذر المشروع).
// دوال نقية (نص ← نص) + applyRnwPatch التي تقرأ/تكتب الملفات. تُختبر دون شبكة.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export const PATCH_MARK = '__SCD_RNW_PATCH__';
export const OVERRIDES = ['Alert', 'Share', 'I18nManager', 'DevSettings'];

const exportLine = (name) =>
  new RegExp(String.raw`^[ \t]*export\s*\{\s*default\s+as\s+${name}\s*\}\s*from\s*(['"])([^'"\r\n]+)\1\s*;?[ \t]*\r?$`, 'm');

const leftover = (src, name) =>
  new RegExp(String.raw`export\s*\{[^}]*\b${name}\b[^}]*\}`).test(src);

export function toSpecifier(fromFile, targetNoExt) {
  let rel = relative(dirname(fromFile), targetNoExt).split(sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

// dist/index.js (ESM): نحذف تصدير Alert/I18nManager الأصليَّين ونضيف تصديرنا.
export function patchRnwEsm(src, extrasSpec) {
  if (src.includes(PATCH_MARK)) return src;
  const find = (n) => { const m = src.match(exportLine(n)); return m ? m[2] : null; };
  const viewPath = find('View');
  const regPath = find('AppRegistry');
  if (!viewPath || !regPath) throw new Error('dist/index.js في react-native-web لا يصدّر View/AppRegistry بالصيغة المتوقعة');
  const statusPath = find('StatusBar');

  let out = src;
  for (const n of OVERRIDES) out = out.replace(exportLine(n), '');
  for (const n of OVERRIDES) {
    if (leftover(out, n)) throw new Error(`تعذّر إزالة تصدير ${n} الأصلي من react-native-web (صيغة غير متوقعة)`);
  }

  const lines = [
    '',
    `/* ${PATCH_MARK}: بدائل SecureCaseDesk لـ Windows */`,
    `import __scdView from '${viewPath}';`,
    `import __scdRegistry from '${regPath}';`,
    `import { createElement as __scdCE } from 'react';`,
    ...(statusPath ? [`import __scdStatus from '${statusPath}';`] : []),
    `import { createScdExtras as __scdCreate } from '${extrasSpec}';`,
    `const __scdX = __scdCreate({ View: __scdView, AppRegistry: __scdRegistry, createElement: __scdCE${statusPath ? ', StatusBar: __scdStatus' : ''} });`,
    'export const Alert = __scdX.Alert;',
    'export const Share = __scdX.Share;',
    'export const I18nManager = __scdX.I18nManager;',
    'export const DevSettings = __scdX.DevSettings;',
    ...(statusPath ? [] : ['export const StatusBar = __scdX.StatusBar;']),
    '',
  ];
  return out.replace(/\s*$/, '\n') + lines.join('\n');
}

// dist/cjs/index.js: يُنقل الأصلي إلى index.original.js ويُكتب غلاف يحافظ على الـ getters الأصلية.
export function buildCjsWrapper(extrasSpec) {
  return `"use strict";
/* ${PATCH_MARK} */
var __orig = require('./index.original.js');
var __x = require('${extrasSpec}').createScdExtras({ View: __orig.View, AppRegistry: __orig.AppRegistry, StatusBar: __orig.StatusBar, createElement: require('react').createElement });
var __over = { Alert: __x.Alert, Share: __x.Share, I18nManager: __x.I18nManager, DevSettings: __x.DevSettings };
if (!__orig.StatusBar) __over.StatusBar = __x.StatusBar;
var __out = {};
Object.keys(__orig).forEach(function (k) {
  if (k === '__esModule' || Object.prototype.hasOwnProperty.call(__over, k)) return;
  Object.defineProperty(__out, k, { enumerable: true, get: function () { return __orig[k]; } });
});
Object.keys(__over).forEach(function (k) {
  Object.defineProperty(__out, k, { enumerable: true, value: __over[k] });
});
Object.defineProperty(__out, '__esModule', { value: true });
module.exports = __out;
`;
}

export function applyRnwPatch(stageDir, log = console.log) {
  const pkg = join(stageDir, 'node_modules', 'react-native-web');
  const extras = join(stageDir, 'scd-shims', 'rnw-extras');
  if (!existsSync(join(pkg, 'package.json'))) throw new Error('react-native-web غير مثبّتة في المرحلة: ' + pkg);
  const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;

  const esm = join(pkg, 'dist', 'index.js');
  if (!existsSync(esm)) throw new Error('لا يوجد dist/index.js في react-native-web ' + version);
  const before = readFileSync(esm, 'utf8');
  const after = patchRnwEsm(before, toSpecifier(esm, extras));
  if (after !== before) writeFileSync(esm, after);
  if (!readFileSync(esm, 'utf8').includes(PATCH_MARK)) throw new Error('فشل التحقق بعد تعديل dist/index.js');
  log(`✔ react-native-web@${version}: عُدّل dist/index.js (ESM)`);

  const cjs = join(pkg, 'dist', 'cjs', 'index.js');
  const cjsOrig = join(pkg, 'dist', 'cjs', 'index.original.js');
  if (existsSync(cjs)) {
    if (!readFileSync(cjs, 'utf8').includes(PATCH_MARK)) {
      renameSync(cjs, cjsOrig);
      writeFileSync(cjs, buildCjsWrapper(toSpecifier(cjs, extras)));
    }
    log('✔ عُدّل dist/cjs/index.js (CJS)');
  }
  return { version };
}
