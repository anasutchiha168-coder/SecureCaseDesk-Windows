// حقن بدائل Windows داخل حزمة react-native-web المثبّتة في desktop/.stage (لا يمسّ جذر المشروع).
// دوال نقية (نص ← نص) + applyRnwPatch التي تقرأ/تكتب الملفات. تُختبر دون شبكة.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export const PATCH_MARK = '__SCD_RNW_PATCH__';
export const OVERRIDES = ['Alert', 'Share', 'I18nManager', 'DevSettings'];

// القسم 4 (تخطيط سطح المكتب): مكوّنات تُستبدل داخل react-native-web نفسها عبر shims/rnw-section4.ts.
// (react-native.tsx لا يدخل الحزمة أبداً لأن Expo يحوّل react-native إلى react-native-web قبل محلّل Metro.)
export const S4_MARK = '__SCD_RNW_S4__';
export const S4_OVERRIDES = ['Text', 'TextInput', 'ScrollView', 'FlatList', 'Modal', 'RefreshControl'];
// مكوّنات أصلية يحتاجها createSection4 كمعاملات (يجب أن نجد سطر تصديرها).
export const S4_NEEDS = ['Text', 'TextInput', 'ScrollView', 'FlatList', 'Modal', 'Pressable', 'ActivityIndicator', 'StyleSheet', 'useWindowDimensions'];

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
export function patchRnwEsm(src, extrasSpec, section4Spec = null) {
  if (src.includes(PATCH_MARK)) {
    if (section4Spec && !src.includes(S4_MARK)) throw new Error('react-native-web معدَّلة بنسخة قديمة بلا القسم 4؛ أعد البناء من الصفر (بدون --skip-install)');
    return src;
  }
  const find = (n) => { const m = src.match(exportLine(n)); return m ? m[2] : null; };
  const viewPath = find('View');
  const regPath = find('AppRegistry');
  if (!viewPath || !regPath) throw new Error('dist/index.js في react-native-web لا يصدّر View/AppRegistry بالصيغة المتوقعة');
  const statusPath = find('StatusBar');

  // القسم 4: نجمع مسارات المكوّنات الأصلية قبل حذف تصديراتها.
  const s4Paths = {};
  if (section4Spec) {
    for (const n of S4_NEEDS) {
      const pth = find(n);
      if (!pth) throw new Error(`dist/index.js في react-native-web لا يصدّر ${n} بالصيغة المتوقعة (مطلوب للقسم 4)`);
      s4Paths[n] = pth;
    }
  }

  let out = src;
  const removed = section4Spec ? [...OVERRIDES, ...S4_OVERRIDES] : OVERRIDES;
  for (const n of removed) out = out.replace(exportLine(n), '');
  for (const n of removed) {
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
    ...(section4Spec
      ? [
          `/* ${S4_MARK}: مكوّنات القسم 4 (textAlign/قوائم/نوافذ/تحديث) */`,
          ...S4_NEEDS.map((n) => `import __scdR_${n} from '${s4Paths[n]}';`),
          `import { createSection4 as __scdS4Create } from '${section4Spec}';`,
          `const __scdS4 = __scdS4Create({ View: __scdView, ${S4_NEEDS.map((n) => `${n}: __scdR_${n}`).join(', ')} });`,
          ...S4_OVERRIDES.map((n) => `export const ${n} = __scdS4.${n};`),
        ]
      : []),
    '',
  ];
  return out.replace(/\s*$/, '\n') + lines.join('\n');
}

// dist/cjs/index.js: يُنقل الأصلي إلى index.original.js ويُكتب غلاف يحافظ على الـ getters الأصلية.
export function buildCjsWrapper(extrasSpec, section4Spec = null) {
  const s4 = section4Spec
    ? `/* ${S4_MARK} */
var __s4 = require('${section4Spec}').createSection4({ View: __orig.View, ${S4_NEEDS.map((n) => `${n}: __orig.${n}`).join(', ')} });
Object.keys(__s4).forEach(function (k) { __over[k] = __s4[k]; });
`
    : '';
  return `"use strict";
/* ${PATCH_MARK} */
var __orig = require('./index.original.js');
var __x = require('${extrasSpec}').createScdExtras({ View: __orig.View, AppRegistry: __orig.AppRegistry, StatusBar: __orig.StatusBar, createElement: require('react').createElement });
var __over = { Alert: __x.Alert, Share: __x.Share, I18nManager: __x.I18nManager, DevSettings: __x.DevSettings };
if (!__orig.StatusBar) __over.StatusBar = __x.StatusBar;
${s4}var __out = {};
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

// الطبقة B: السياق الافتراضي في react-native-web هو ltr؛ نجعله rtl فيقلب RNW يسار/يمين في كل الشجرة دون أي جذر React.
// دالة نقية (نص ← نتيجة). تفشل بهدوء (status=missing) إن اختلفت الصيغة، ولا توقف البناء.
export const LOCALE_MARK = '__SCD_RNW_LOCALE__';
const LOCALE_LTR = /(\bdefaultLocale\s*=\s*\{[^}]*?\bdirection\s*:\s*)(['"])ltr\2/;
export function patchLocaleDefault(src) {
  if (src.includes(LOCALE_MARK)) return { src, status: 'already' };
  if (!LOCALE_LTR.test(src)) return { src, status: 'missing' };
  const out = src.replace(LOCALE_LTR, (_m, pre, q) => pre + q + 'rtl' + q);
  const tail = ";(function () { try { globalThis." + LOCALE_MARK + " = 'rtl-default'; } catch (e) {} })(); /* " + LOCALE_MARK + " */\n";
  return { src: out.replace(/\s*$/, '\n') + tail, status: 'patched' };
}

export function applyRnwPatch(stageDir, log = console.log) {
  const pkg = join(stageDir, 'node_modules', 'react-native-web');
  const extras = join(stageDir, 'scd-shims', 'rnw-extras');
  const s4File = join(stageDir, 'scd-shims', 'rnw-section4');
  const hasS4 = existsSync(s4File + '.ts');
  if (!existsSync(join(pkg, 'package.json'))) throw new Error('react-native-web غير مثبّتة في المرحلة: ' + pkg);
  const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;

  const esm = join(pkg, 'dist', 'index.js');
  if (!existsSync(esm)) throw new Error('لا يوجد dist/index.js في react-native-web ' + version);
  const before = readFileSync(esm, 'utf8');
  const after = patchRnwEsm(before, toSpecifier(esm, extras), hasS4 ? toSpecifier(esm, s4File) : null);
  if (after !== before) writeFileSync(esm, after);
  if (!readFileSync(esm, 'utf8').includes(PATCH_MARK)) throw new Error('فشل التحقق بعد تعديل dist/index.js');
  if (hasS4 && !readFileSync(esm, 'utf8').includes(S4_MARK)) throw new Error('فشل التحقق: مكوّنات القسم 4 لم تُحقن في dist/index.js');
  log(`✔ react-native-web@${version}: عُدّل dist/index.js (ESM)${hasS4 ? ' + مكوّنات القسم 4 (textAlign/FlatList/Modal/ScrollView/RefreshControl)' : ''}`);
  if (!hasS4) log('⚠ scd-shims/rnw-section4.ts غير موجود: لن تُحقن مكوّنات القسم 4');

  const cjs = join(pkg, 'dist', 'cjs', 'index.js');
  const cjsOrig = join(pkg, 'dist', 'cjs', 'index.original.js');
  if (existsSync(cjs)) {
    if (!readFileSync(cjs, 'utf8').includes(PATCH_MARK)) {
      renameSync(cjs, cjsOrig);
      writeFileSync(cjs, buildCjsWrapper(toSpecifier(cjs, extras), hasS4 ? toSpecifier(cjs, s4File) : null));
    }
    log('✔ عُدّل dist/cjs/index.js (CJS)');
  }
  let localeOk = 0;
  for (const lf of [join(pkg, 'dist', 'modules', 'useLocale', 'index.js'), join(pkg, 'dist', 'cjs', 'modules', 'useLocale', 'index.js')]) {
    if (!existsSync(lf)) continue;
    const r = patchLocaleDefault(readFileSync(lf, 'utf8'));
    if (r.status === 'patched') writeFileSync(lf, r.src);
    if (r.status === 'missing') log('⚠ useLocale: صيغة defaultLocale غير متوقعة، تخطّينا الطبقة B في ' + lf);
    else localeOk++;
  }
  log(localeOk ? '✔ useLocale: الاتجاه الافتراضي rtl (' + localeOk + ' ملف)' : '⚠ لم تُطبَّق الطبقة B (useLocale غير موجود)؛ يبقى حارس DOM');
  return { version, localeOk };
}
