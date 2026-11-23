// SECURECASEDESK_PHASE12_S1
// فحص ما قبل البناء (Node فقط، بلا اعتمادات). يفحص إعدادات البناء والأمان الثابتة قبل إرسال البناء إلى EAS.
// الاستخدام:  node scripts/preflight-build.mjs        (رمز الخروج 0 = نجح، 1 = فشل بند إلزامي)
// ملاحظة صادقة: هذا فحص ثابت للإعدادات فقط؛ لا يثبت أن SQLCipher يعمل على الجهاز — ذلك يُثبت بتشغيل APK حقيقي (انظر docs/phase12/12.1-build-setup.md).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const results = [];
const add = (level, name, detail = '') => results.push({ level, name, detail });
const pass = (n, d) => add('PASS', n, d);
const fail = (n, d) => add('FAIL', n, d);
const warn = (n, d) => add('WARN', n, d);
const readJson = (f) => {
  try { return JSON.parse(readFileSync(join(root, f), 'utf8')); } catch (e) { return { __error: String(e.message || e) }; }
};
const readText = (f) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return null; } };

// ── 1) app.json ─────────────────────────────────────────────
const app = readJson('app.json');
if (app.__error) {
  fail('app.json قابل للقراءة', app.__error);
} else {
  const ex = app.expo ?? {};
  ex.android?.package ? pass('اسم حزمة Android محدد', ex.android.package) : fail('اسم حزمة Android محدد', 'expo.android.package مفقود');
  const plugins = Array.isArray(ex.plugins) ? ex.plugins : [];
  const sqlite = plugins.find((p) => (Array.isArray(p) ? p[0] : p) === 'expo-sqlite');
  const opts = Array.isArray(sqlite) ? (sqlite[1] ?? {}) : {};
  if (!sqlite) fail('SQLCipher: إضافة expo-sqlite مضافة', 'غير موجودة في plugins');
  else if (opts.useSQLCipher !== true) fail('SQLCipher: useSQLCipher = true', 'بدونها يُبنى SQLite عادي غير مشفّر');
  else pass('SQLCipher: useSQLCipher = true في plugins');
  if (opts.android && opts.android.useSQLCipher === false) fail('SQLCipher: لا يوجد تعطيل خاص بـ Android', 'android.useSQLCipher=false');
  ex.android?.allowBackup === false
    ? pass('android.allowBackup = false (منع النسخ الاحتياطي التلقائي لبيانات التطبيق)')
    : fail('android.allowBackup = false', 'مطلوب كي لا تُرفع بيانات التطبيق إلى نسخ Google/ADB التلقائية');
  ex.userInterfaceStyle === 'dark' ? pass('الواجهة الداكنة مفعلة') : warn('userInterfaceStyle ليست dark');
  ex.extra?.eas?.projectId ? pass('EAS projectId موجود') : fail('EAS projectId موجود', 'نفّذ: npx eas-cli init');
  const urls = JSON.stringify(ex).match(/https?:\/\/[^"\s]+/g) ?? [];
  urls.length === 0 ? pass('لا عناوين خادم في app.json (لا مزامنة قبل المرحلة 13)') : warn('عناوين URL في app.json', urls.join(' , '));
}

// ── 2) eas.json ─────────────────────────────────────────────
const eas = readJson('eas.json');
if (eas.__error) {
  fail('eas.json قابل للقراءة', eas.__error);
} else {
  const b = eas.build ?? {};
  for (const p of ['preview', 'production']) {
    b[p]?.android?.buildType === 'apk' ? pass(`eas.json: ${p} ينتج APK`) : fail(`eas.json: ${p} ينتج APK`, 'android.buildType يجب أن تكون "apk"');
  }
  b.preview?.autoIncrement ? pass('eas.json: preview يزيد versionCode تلقائياً (للتحديث فوق نسخة مثبتة)') : warn('eas.json: preview بلا autoIncrement');
  const envUrls = JSON.stringify(b).match(/https?:\/\/[^"\s]+/g) ?? [];
  envUrls.length === 0 ? pass('eas.json بلا عناوين خادم') : fail('eas.json بلا عناوين خادم', envUrls.join(' , '));
  eas.cli?.appVersionSource === 'remote' ? pass('appVersionSource = remote') : warn('appVersionSource ليست remote');
}

// ── 3) package.json ─────────────────────────────────────────
const pkg = readJson('package.json');
if (pkg.__error) {
  fail('package.json قابل للقراءة', pkg.__error);
} else {
  pkg.dependencies?.['expo-sqlite'] ? pass('اعتماد expo-sqlite موجود', pkg.dependencies['expo-sqlite']) : fail('اعتماد expo-sqlite موجود');
  pkg.dependencies?.['expo-secure-store'] ? pass('اعتماد expo-secure-store موجود (مفتاح SQLCipher)') : fail('اعتماد expo-secure-store موجود');
  existsSync(join(root, 'package-lock.json')) ? pass('package-lock.json موجود (للأمر npm ci)') : fail('package-lock.json موجود', 'مطلوب لبناء قابل للتكرار');
  if (existsSync(join(root, '.npmrc'))) pass('.npmrc موجود', 'EAS وGitHub يقرآنه (legacy-peer-deps)');
  const dev = Object.keys(pkg.dependencies ?? {}).filter((d) => ['@expo/ngrok', 'tsx'].includes(d));
  if (dev.length) warn('أدوات تطوير ضمن dependencies', dev.join(', '));
}

// ── 4) حارس SQLCipher في الكود ─────────────────────────────
const dbts = readText('src/database/db.ts');
if (!dbts) fail('src/database/db.ts موجود');
else {
  dbts.includes('PRAGMA cipher_version') && dbts.includes('FATAL_SECURITY')
    ? pass('db.ts يرفض العمل إن لم يتوفر SQLCipher (cipher_version + FATAL_SECURITY)')
    : fail('db.ts يرفض العمل إن لم يتوفر SQLCipher', 'حارس cipher_version مفقود');
  /db_encryption_key/.test(dbts) && /SecureStore/.test(dbts)
    ? pass('مفتاح القاعدة يُخزَّن في SecureStore')
    : fail('مفتاح القاعدة يُخزَّن في SecureStore');
}

// ── 5) الأسرار والتوقيع ─────────────────────────────────────
const gi = readText('.gitignore') ?? '';
for (const pat of ['*.jks', '*.key', '*.p12']) gi.includes(pat) ? pass(`.gitignore يتجاهل ${pat}`) : fail(`.gitignore يتجاهل ${pat}`);
gi.includes('credentials.json') ? pass('.gitignore يتجاهل credentials.json') : fail('.gitignore يتجاهل credentials.json', 'أعد تشغيل سكربت التثبيت');
gi.includes('.apk') ? pass('.gitignore يتجاهل ملفات APK') : warn('.gitignore لا يتجاهل APK');
const SKIP = new Set(['node_modules', '.git', '.expo', 'dist', 'android', 'ios']);
const secretFiles = [];
const junk = [];
(function walk(dir, depth = 0) {
  if (depth > 6) return;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p, depth + 1); continue; }
    if (/\.(jks|keystore|p12|pem)$/i.test(name) || name === 'credentials.json') secretFiles.push(p.slice(root.length + 1));
    if (/\.bak(_|-|$)/.test(name) || /\s/.test(name) || name === '0' || name === '{') junk.push(p.slice(root.length + 1));
  }
})(root);
secretFiles.length === 0 ? pass('لا ملفات مفاتيح/توقيع داخل المشروع') : fail('ملفات مفاتيح/توقيع داخل المشروع', secretFiles.join(' , '));
junk.length === 0 ? pass('لا ملفات مؤقتة/غريبة') : warn(`ملفات مؤقتة أو بأسماء غريبة (${junk.length})`, 'نظّفها بـ: bash scripts/repo-hygiene.sh  (تجريبي بلا تغيير)');

// ── 6) البناء الأصلي المولّد ─────────────────────────────────
for (const d of ['android', 'ios']) {
  if (existsSync(join(root, d))) gi.includes(`/${d}`) ? pass(`مجلد ${d}/ موجود ومُتجاهَل (CNG)`) : warn(`مجلد ${d}/ موجود وغير مُتجاهَل`);
}

// ── الطباعة ────────────────────────────────────────────────
const icon = { PASS: '✔', FAIL: '✘', WARN: '!' };
for (const r of results) console.log(`${icon[r.level]} [${r.level}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const c = (l) => results.filter((r) => r.level === l).length;
console.log(`\nالنتيجة: ${c('PASS')} نجح • ${c('WARN')} تحذير • ${c('FAIL')} فشل`);
process.exit(c('FAIL') > 0 ? 1 : 0);
