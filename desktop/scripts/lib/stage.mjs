// دوال نقية لبناء نسخة الويب (القسم 3). مفصولة عن build-web.mjs كي تُختبر دون شبكة.
// المبدأ: لا نعدّل app.json ولا package.json ولا أي ملف في جذر المشروع؛ كل التعديلات على نسخة مرحلية في desktop/.stage.

// ما يُنسخ من الجذر إلى المرحلة (قائمة بيضاء: لا android/ ولا tests/ ولا سكربتات الإصلاح ولا desktop/ نفسه).
export const STAGE_COPY = ['src', 'assets', 'app.json', 'package.json', 'package-lock.json', '.npmrc', 'tsconfig.json'];

// حزم الويب غير الموجودة في جذر المشروع؛ تُثبَّت بـ `expo install` كي يختار Expo النسخ المتوافقة مع SDK.
export const WEB_DEPS = ['react-dom', 'react-native-web', '@expo/metro-runtime'];

// SDK 58: الافتراضي web.output='server' (يحتاج خادماً) وasyncRoutes للويب مفعّل افتراضياً.
// Electron يخدم ملفات ثابتة عبر app://bundle: نحتاج 'single' (index.html واحد) وبلا تقسيم مسارات لاحق.
export function buildStagedAppJson(rootAppJson) {
  const app = structuredClone(rootAppJson);
  const expo = app.expo;
  expo.web = { ...(expo.web || {}), bundler: 'metro', output: 'single' };
  expo.extra = { ...(expo.extra || {}) };
  expo.extra.router = { ...(expo.extra.router || {}), origin: false, asyncRoutes: { web: false } };
  expo.plugins = (expo.plugins || []).map((p) => {
    const name = Array.isArray(p) ? p[0] : p;
    if (name !== 'expo-router') return p;
    const opts = Array.isArray(p) ? { ...(p[1] || {}) } : {};
    opts.asyncRoutes = { ...(opts.asyncRoutes || {}), web: false };
    return ['expo-router', opts];
  });
  // لا نحتاج EAS/التحديثات على سطح المكتب.
  if (expo.extra.eas) delete expo.extra.eas;
  return app;
}

export function buildMetroConfig() {
  return `// مُولَّد تلقائياً من desktop/scripts/lib/stage.mjs — لا تعدّله يدوياً.
const { getDefaultConfig } = require('expo/metro-config');
const { createShimResolver } = require('./scd-shims/metro-alias.cjs');

process.env.SCD_TARGET = 'windows';
const config = getDefaultConfig(__dirname);
config.resolver.resolveRequest = createShimResolver(config.resolver.resolveRequest);
module.exports = config;
`;
}

// index.html الناتج من Expo: نضبط اللغة والاتجاه والعنوان ولون الخلفية قبل تحميل JS (يمنع وميض أبيض).
// لا سكربت inline (CSP لا تسمح به).
export function patchIndexHtml(html) {
  let out = html;
  out = /<html\b[^>]*>/i.test(out)
    ? out.replace(/<html\b[^>]*>/i, '<html lang="ar" dir="rtl">')
    : out;
  out = /<title>[\s\S]*?<\/title>/i.test(out)
    ? out.replace(/<title>[\s\S]*?<\/title>/i, '<title>SecureCaseDesk</title>')
    : out.replace(/<\/head>/i, '<title>SecureCaseDesk</title></head>');
  if (!out.includes('data-scd-bg')) {
    out = out.replace(/<\/head>/i, '<style data-scd-bg>html,body{background:#0B1120;margin:0}</style></head>');
  }
  return out;
}

// فحص ثابت لمخرجات الويب. يعيد قائمة أخطاء (فارغة = سليم). يعتمد على قوائم ملفات ونصوص فقط ليُختبر بسهولة.
export const CAIRO_WEIGHTS = ['Cairo_300Light', 'Cairo_400Regular', 'Cairo_500Medium', 'Cairo_600SemiBold', 'Cairo_700Bold', 'Cairo_800ExtraBold'];

export function verifyWebDist({ files, readText }) {
  const errors = [];
  const has = (re) => files.some((f) => re.test(f));
  if (!files.includes('index.html')) return ['index.html غير موجود'];
  const html = readText('index.html');

  if (!/<html[^>]*\blang="ar"/i.test(html) || !/<html[^>]*\bdir="rtl"/i.test(html)) errors.push('index.html بلا lang="ar" dir="rtl"');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
  if (scripts.length === 0) errors.push('لا يوجد <script> في index.html');
  for (const a of scripts) if (!/\bsrc=/.test(a)) errors.push('سكربت inline ممنوع بسبب CSP');
  for (const m of html.matchAll(/\b(?:src|href)=["'](https?:)?\/\/[^"']+["']/gi)) errors.push('مورد خارجي في index.html: ' + m[0]);

  const jsFiles = files.filter((f) => /\.js$/.test(f));
  if (jsFiles.length === 0) errors.push('لا ملفات JS');
  const allJs = jsFiles.map((f) => readText(f));
  if (!allJs.some((t) => t.includes('__SCD_RN_WEB__'))) errors.push('shim react-native لم يُدمج في الحزمة (لا علامة __SCD_RN_WEB__)');
  if (!allJs.some((t) => t.includes('scd-alert-overlay'))) errors.push('بديل Alert غير موجود في الحزمة');
  if (!allJs.some((t) => t.includes('__scdRtlRootCtx'))) errors.push('جذر RTL (shim react-native-safe-area-context) لم يُدمج في الحزمة (لا علامة __scdRtlRootCtx)');
  if (!allJs.some((t) => t.includes('DesktopNotImplementedError') || t.includes('scd:db:open'))) errors.push('shims الأقسام 5–7 لم تُدمج (expo-sqlite وغيره ما زال أصلياً؟)');

  const ttf = files.filter((f) => /\.ttf$/i.test(f));
  for (const w of CAIRO_WEIGHTS) if (!ttf.some((f) => f.includes(w))) errors.push('خط Cairo مفقود: ' + w);
  if (!has(/\.png$/i)) errors.push('لا صور PNG في المخرجات');

  // كل مرجع مطلق للأصول في index.html يجب أن يكون موجوداً فعلاً.
  for (const m of html.matchAll(/\b(?:src|href)=["'](\/[^"'?#]+)/gi)) {
    const rel = decodeURIComponent(m[1].slice(1));
    if (!files.includes(rel)) errors.push('مرجع مكسور في index.html: ' + m[1]);
  }
  return errors;
}
