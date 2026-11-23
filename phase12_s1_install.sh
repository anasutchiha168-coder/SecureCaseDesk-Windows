#!/usr/bin/env bash
# SecureCaseDesk v2.2 — المرحلة 12 / القسم 12.1: إعداد البناء (EAS + GitHub Actions + فحص SQLCipher الثابت) وتجهيز أول APK
# التشغيل من جذر المشروع:   bash phase12_s1_install.sh
# آمن لإعادة التشغيل: ينسخ احتياطياً كل ملف موجود يُعدَّل (*.bak_التاريخ) ولا يكرر التعديلات.
# يضيف: eas.json (APK) • android.allowBackup=false • فحص ما قبل البناء • Workflow لـ GitHub Actions • سكربتات npm • توثيق
# ثم يشغّل فحص ما قبل البناء (و tsc إن كانت node_modules موجودة) ويكتب النتائج الفعلية في docs/phase12/12.1-preflight-results.md
# لا يبني APK ولا يتصل بالإنترنت: البناء الفعلي تنفّذه أنت (الأوامر تُطبع في النهاية).
set -euo pipefail

TS="$(date +%Y%m%d_%H%M%S)"
say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

say "فحص المكان والمتطلبات"
[ -f package.json ] && [ -f app.json ] && [ -f src/database/db.ts ] \
  || die "شغّل السكربت من جذر مشروع SecureCaseDesk (الذي فيه package.json و app.json و src/)."
grep -q '"name": "securecasedesk"' package.json || die "package.json ليس لمشروع securecasedesk."
command -v node >/dev/null 2>&1 || die "Node.js غير متوفر."
grep -q 'PRAGMA cipher_version' src/database/db.ts || die "src/database/db.ts لا يحوي فحص SQLCipher — المشروع غير متوافق."
[ -d src/modules/ai ] || warn "مجلد src/modules/ai غير موجود: هل أُغلقت المرحلة 11؟"
ok "المشروع سليم"

# كتابة ملف جديد (نسخ احتياطي للقديم إن اختلف محتواه)
write_file() {
  local target="$1" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  mkdir -p "$(dirname "$target")"
  if [ -f "$target" ]; then
    if cmp -s "$tmp" "$target"; then ok "بلا تغيير: $target"; rm -f "$tmp"; return; fi
    cp "$target" "$target.bak_$TS"
    warn "نُسخ احتياطياً: $target.bak_$TS"
  fi
  mv "$tmp" "$target"
  ok "كُتب: $target"
}

say "إنشاء ملفات 12.1"
write_file 'eas.json' <<'SCD_EOF_P12S1_0'
{
  "cli": {
    "version": ">= 27.10.0",
    "appVersionSource": "remote"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      }
    },
    "preview": {
      "distribution": "internal",
      "autoIncrement": true,
      "android": {
        "buildType": "apk"
      }
    },
    "production": {
      "autoIncrement": true,
      "android": {
        "buildType": "apk"
      }
    }
  },
  "submit": {
    "production": {}
  }
}
SCD_EOF_P12S1_0
write_file 'scripts/preflight-build.mjs' <<'SCD_EOF_P12S1_1'
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
SCD_EOF_P12S1_1
write_file 'scripts/repo-hygiene.sh' <<'SCD_EOF_P12S1_2'
#!/usr/bin/env bash
# SECURECASEDESK_PHASE12_S1
# تنظيف مستودع المشروع من ملفات مؤقتة/غريبة. الوضع الافتراضي: عرض فقط (لا يغيّر شيئاً).
#   bash scripts/repo-hygiene.sh            # عرض
#   bash scripts/repo-hygiene.sh --apply    # نقل (لا حذف) إلى tools/legacy-cleanup/ ليمكن التراجع
set -euo pipefail
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
DEST="tools/legacy-cleanup"
list=()
# ملفات فارغة بأسماء غريبة نتجت عن أخطاء إعادة توجيه في الطرفية
for f in "0" "{" "MAX_ATTACHMENT_CIPHER_BYTES"; do [ -f "$f" ] && [ ! -s "$f" ] && list+=("$f"); done
# سكربتات المراحل السابقة (للأرشفة فقط)
for f in phase*.sh phase*.py apply-*.sh fix_*.py fix_project.py*; do [ -f "$f" ] && list+=("$f"); done
# نسخ احتياطية مؤقتة داخل src
while IFS= read -r f; do list+=("$f"); done < <(find src tests -type f \( -name '*.bak' -o -name '*.bak_*' -o -name '*.bak-*' \) 2>/dev/null)
# إزالة التكرار
mapfile -t list < <(printf '%s\n' "${list[@]:-}" | awk 'NF && !seen[$0]++')
if [ "${#list[@]}" -eq 0 ]; then echo "لا شيء للتنظيف."; exit 0; fi
echo "الملفات المرشحة (${#list[@]}):"; printf '  - %s\n' "${list[@]}"
if [ "$APPLY" -ne 1 ]; then echo; echo "وضع العرض فقط. للنقل: bash scripts/repo-hygiene.sh --apply"; exit 0; fi
mkdir -p "$DEST"
for f in "${list[@]}"; do
  mkdir -p "$DEST/$(dirname -- "$f")"
  mv -- "$f" "$DEST/$f"
done
echo "نُقلت إلى $DEST/ (لم يُحذف شيء). راجعها ثم احذف المجلد يدوياً إن أردت."
SCD_EOF_P12S1_2
write_file '.github/workflows/android-apk.yml' <<'SCD_EOF_P12S1_3'
# SECURECASEDESK_PHASE12_S1
# بناء APK للتشغيل المحلي (مرشّح إصدار محلي) عبر EAS ثم حفظه كـ Artifact في GitHub Actions.
# هذا الـ APK يعمل محلياً بلا خادم. لا مزامنة فيه (المرحلة 13 لاحقاً).
# الأسرار المطلوبة: EXPO_TOKEN فقط (Settings > Secrets and variables > Actions). لا مفاتيح قاعدة بيانات في CI:
# مفتاح SQLCipher يُولَّد على الجهاز ويُخزَّن في SecureStore.
# مهم: يجب أن يكون المستودع Private لأن الـ APK يُخزَّن كـ Artifact.
name: Android APK (local release candidate)

on:
  workflow_dispatch:
    inputs:
      profile:
        description: 'ملف البناء في eas.json'
        type: choice
        options: [preview, production]
        default: preview
  push:
    tags: ['v*']

permissions:
  contents: read

concurrency:
  group: android-apk-${{ github.ref }}
  cancel-in-progress: false

jobs:
  verify:
    name: فحص وتحقق قبل البناء
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: تثبيت الاعتماديات
        run: npm ci
      - name: فحص إعدادات البناء والأمان
        run: node scripts/preflight-build.mjs
      - name: فحص TypeScript
        run: npx tsc --noEmit
      - name: اختبارات الوحدات
        run: npm run test:all

  build:
    name: بناء APK عبر EAS
    needs: verify
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      PROFILE: ${{ inputs.profile || 'preview' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: تثبيت الاعتماديات
        run: npm ci
      - name: إعداد EAS CLI
        uses: expo/expo-github-action@v8
        with:
          eas-version: latest
          token: ${{ secrets.EXPO_TOKEN }}
      - name: بناء Android على خوادم EAS
        run: |
          set -euo pipefail
          eas build --platform android --profile "$PROFILE" --non-interactive --wait --json > build.json
          jq -e '.[0].status == "FINISHED"' build.json > /dev/null || { echo "فشل البناء:"; cat build.json; exit 1; }
          echo "BUILD_URL=$(jq -r '.[0].artifacts.buildUrl' build.json)" >> "$GITHUB_ENV"
          echo "EAS_BUILD_ID=$(jq -r '.[0].id' build.json)" >> "$GITHUB_ENV"
      - name: تنزيل APK وحساب SHA-256
        run: |
          set -euo pipefail
          mkdir -p artifacts
          APK="artifacts/SecureCaseDesk-${PROFILE}-run${GITHUB_RUN_NUMBER}.apk"
          curl -fsSL "$BUILD_URL" -o "$APK"
          unzip -tq "$APK" > /dev/null   # التأكد أنه أرشيف APK سليم
          sha256sum "$APK" | tee "$APK.sha256"
          echo "eas_build_id=$EAS_BUILD_ID" > artifacts/build-info.txt
          echo "commit=$GITHUB_SHA" >> artifacts/build-info.txt
          echo "profile=$PROFILE" >> artifacts/build-info.txt
      - name: رفع APK كـ Artifact
        uses: actions/upload-artifact@v4
        with:
          name: SecureCaseDesk-apk-${{ env.PROFILE }}-run${{ github.run_number }}
          path: artifacts/
          if-no-files-found: error
          retention-days: 30
SCD_EOF_P12S1_3
write_file 'docs/phase12/12.1-build-setup.md' <<'SCD_EOF_P12S1_4'
# المرحلة 12 / القسم 12.1 — إعداد البناء وتوليد أول APK

> الحالة الصادقة: هذا القسم **يجهّز** البناء (إعدادات + فحوص + Workflow). لا يُعتبر APK «مُنتَجاً» إلا بعد أن تنفّذ أنت أمر البناء فعلاً وتسجّل النتيجة في الجدول أسفل الصفحة. لا تُعلَّم أي خانة «نجح» دون تنفيذها.

## ما الذي أُضيف
| الملف | الغرض |
|---|---|
| `eas.json` | ملفات بناء `development` و`preview` و`production`، وكلها تنتج **APK**؛ `preview` و`production` بزيادة تلقائية لـ versionCode |
| `app.json` | `android.allowBackup=false` (منع النسخ التلقائي لبيانات التطبيق) + بقاء `expo-sqlite` بخيار `useSQLCipher: true` |
| `scripts/preflight-build.mjs` | فحص ثابت لإعدادات البناء والأمان قبل الإرسال |
| `scripts/repo-hygiene.sh` | عرض/نقل الملفات المؤقتة والغريبة (لا يحذف) |
| `.github/workflows/android-apk.yml` | فحص ← بناء EAS ← تنزيل APK + SHA-256 ← حفظه Artifact |
| `package.json` | سكربتات: `typecheck` و`test:all` و`preflight` |

## متطلبات لمرة واحدة
1. حساب Expo، وتسجيل الدخول: `npx eas-cli login`
2. المشروع مربوط أصلاً (`extra.eas.projectId` موجود في `app.json`).
3. **مفتاح توقيع Android (Keystore):** أول بناء يجب أن يكون **تفاعلياً** من جهازك كي يولّد EAS المفتاح ويحفظه عنده:
   ```bash
   npx eas-cli build --platform android --profile preview
   ```
   أجب بـ Yes عند سؤال توليد Keystore. بعدها فقط تعمل بناءات GitHub الآلية (`--non-interactive`).
   لا تفقد الوصول لحساب Expo: التحديثات فوق التطبيق المثبّت تتطلب نفس مفتاح التوقيع.
4. لـ GitHub Actions: أنشئ Access Token من حساب Expo وأضفه كسر باسم `EXPO_TOKEN`.
5. المستودع على GitHub يجب أن يكون **Private** (الـ APK يُخزَّن Artifact).

## الأوامر
```bash
node scripts/preflight-build.mjs            # فحص الإعدادات (أو: npm run preflight)
npx tsc --noEmit                            # فحص الأنواع
npm run test:all                            # كل اختبارات الوحدات
npx expo-doctor                             # تشخيص الاعتماديات (يحتاج إنترنت)
npx eas-cli build --platform android --profile preview   # بناء APK (مرة أولى تفاعلية)
```
عبر GitHub: تبويب **Actions** ← «Android APK (local release candidate)» ← **Run workflow**.
الناتج: Artifact باسم `SecureCaseDesk-apk-preview-run<N>` فيه الـ APK وملف `.sha256` وملف `build-info.txt`.

## تثبيت APK على جهاز حقيقي
1. نزّل الـ APK من Artifact (فكّ الضغط) أو من رابط EAS.
2. تحقق من البصمة: `sha256sum -c SecureCaseDesk-preview-run<N>.apk.sha256`
3. انقله للهاتف وفعّل «التثبيت من مصادر غير معروفة» للتطبيق الذي ستفتحه منه، أو: `adb install -r <الملف>.apk`

## التحقق من SQLCipher على البناء الحقيقي
الفحص الثابت لا يكفي. على الجهاز:
- التطبيق يستدعي `PRAGMA cipher_version` عند فتح القاعدة ويرفض العمل (`FATAL_SECURITY`) إن لم تتوفر SQLCipher؛ فإن فُتح التطبيق وسجّلتَ الدخول فهذا مؤشر أول (لكنه ليس الإثبات الكامل).
- الإثبات الكامل (إصدار SQLCipher + عدم وجود ترويسة `SQLite format 3` في ملف القاعدة) يُنفَّذ عبر `inspectDatabaseEncryption()` الموجودة في `src/database/db.ts`، وسنربطها بشاشة تشخيص ونوثق نتيجتها في **12.2**.

## قيود معروفة (موثّقة)
- لم أتمكن من تشغيل `npm ci` ولا `expo-doctor` ولا بناء EAS في بيئتي (لا شبكة/حساب) — لذلك هذه الخطوات عليك.
- الخيار `android.allowBackup` لم أجد تأكيداً له في صفحة مرجع SDK 58 التي استرجعتها؛ تحقق منه بعد أول بناء: `npx expo prebuild --platform android --no-install --clean` ثم افحص `android/app/src/main/AndroidManifest.xml` (يجب أن يحوي `android:allowBackup="false"`) ثم احذف مجلد `android/` (مُتجاهَل في git).
- `@expo/ngrok` و`tsx` ضمن `dependencies` (أدوات تطوير) — غير ضارّة لكن يُفضّل نقلها إلى `devDependencies` لاحقاً مع إعادة توليد `package-lock.json` عندك.
- ملف `SECURITY.md` يشير إلى «المرحلة 10: الباك إند» وهذا قديم؛ الخادم في المرحلة 13. يُصحَّح في 12.4.

## سجل النتائج الفعلية (يُملأ بعد التنفيذ)
| البند | النتيجة | التاريخ/الملاحظة |
|---|---|---|
| `node scripts/preflight-build.mjs` | قيد التنفيذ | يُكتب تلقائياً في `12.1-preflight-results.md` |
| `npx tsc --noEmit` | قيد التنفيذ | |
| `npm run test:all` | قيد التنفيذ | |
| `npx expo-doctor` | لم يُنفَّذ | |
| أول بناء EAS (preview) | لم يُنفَّذ | |
| تنزيل وتثبيت APK على جهاز حقيقي | لم يُنفَّذ | |
| فتح التطبيق وتسجيل الدخول على الـ APK | لم يُنفَّذ | |
| بناء عبر GitHub Actions | لم يُنفَّذ | |
SCD_EOF_P12S1_4
chmod +x scripts/repo-hygiene.sh

say "تعديل app.json و package.json"
cp app.json "app.json.bak_$TS"; cp package.json "package.json.bak_$TS"
node - <<'SCD_NODE_P12S1'
const fs = require('fs');
// app.json: منع النسخ الاحتياطي التلقائي لبيانات التطبيق (قاعدة مشفرة + أسرار)
const app = JSON.parse(fs.readFileSync('app.json', 'utf8'));
app.expo = app.expo || {};
app.expo.android = app.expo.android || {};
let changedApp = false;
if (app.expo.android.allowBackup !== false) { app.expo.android.allowBackup = false; changedApp = true; }
if (changedApp) fs.writeFileSync('app.json', JSON.stringify(app, null, 2) + '\n');
console.log(changedApp ? '  ✔ app.json: android.allowBackup=false' : '  ✔ app.json: بلا تغيير');
// package.json: توحيد الإصدار + سكربتات
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let changedPkg = false;
const want = {
  typecheck: 'tsc --noEmit',
  preflight: 'node scripts/preflight-build.mjs',
  'test:all': 'tsx --tsconfig tests/tsconfig.json --test tests/*.test.ts',
  'build:apk:preview': 'eas build --platform android --profile preview',
};
pkg.scripts = pkg.scripts || {};
for (const [k, v] of Object.entries(want)) if (pkg.scripts[k] !== v) { pkg.scripts[k] = v; changedPkg = true; }
if (app.expo.version && pkg.version !== app.expo.version) { pkg.version = app.expo.version; changedPkg = true; }
if (changedPkg) fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(changedPkg ? '  ✔ package.json: سكربتات + توحيد الإصدار مع app.json' : '  ✔ package.json: بلا تغيير');
SCD_NODE_P12S1

say "تحديث .gitignore"
if grep -q 'SECURECASEDESK_PHASE12_S1' .gitignore 2>/dev/null; then
  ok ".gitignore محدّث مسبقاً"
else
  cp .gitignore ".gitignore.bak_$TS" 2>/dev/null || true
  cat >> .gitignore <<'SCD_GI_P12S1'

# SECURECASEDESK_PHASE12_S1: مخرجات البناء والتوقيع لا تدخل المستودع أبداً
*.apk
*.aab
*.apks
credentials.json
artifacts/
tools/legacy-cleanup/
SCD_GI_P12S1
  ok "أُضيفت قواعد APK والتوقيع إلى .gitignore"
fi

say "تشغيل الفحوص الفعلية"
RES="docs/phase12/12.1-preflight-results.md"
{
  echo "# نتائج فحص 12.1 الفعلية"
  echo
  echo "- التاريخ: $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC)"
  echo "- Node: $(node -v)"
  echo
  echo '## node scripts/preflight-build.mjs'
  echo '```'
} > "$RES"
set +e
node scripts/preflight-build.mjs 2>&1 | tee -a "$RES"
PF=${PIPESTATUS[0]}
echo '```' >> "$RES"
TSC="لم يُنفَّذ (node_modules غير موجودة — نفّذ npm ci ثم npx tsc --noEmit)"
if [ -d node_modules ]; then
  echo "- فحص TypeScript..."
  npx tsc --noEmit > /tmp/scd_tsc_$TS.log 2>&1; TC=$?
  if [ $TC -eq 0 ]; then TSC="نجح (0 أخطاء)"; else TSC="فشل (رمز $TC) — انظر الأخطاء أدناه"; fi
  { echo; echo '## npx tsc --noEmit'; echo '```'; tail -n 40 /tmp/scd_tsc_$TS.log; echo '```'; } >> "$RES"
fi
set -e
{ echo; echo "## الخلاصة"; echo "- preflight: $([ "$PF" -eq 0 ] && echo 'نجح' || echo 'فشل (رمز '"$PF"')')"; echo "- tsc: $TSC"; echo "- بناء EAS وتثبيت APK: لم يُنفَّذا بعد (خطوات يدوية)"; } >> "$RES"
ok "كُتبت النتائج في $RES"

say "الخلاصة"
[ "$PF" -eq 0 ] && ok "فحص ما قبل البناء: نجح" || warn "فحص ما قبل البناء: فشل — راجع السطور ✘ أعلاه قبل البناء"
echo "  tsc: $TSC"
cat <<'SCD_NEXT_P12S1'

الخطوات التالية (عليك تنفيذها — لم أبنِ APK ولا أعلن نجاحه):
  1) npm ci && npx expo-doctor
  2) npx eas-cli login
  3) أول بناء تفاعلي (يولّد Keystore):  npx eas-cli build --platform android --profile preview
  4) نزّل الـ APK وثبّته على جهاز حقيقي، وافتح التطبيق وسجّل الدخول
  5) أضف EXPO_TOKEN في أسرار GitHub (المستودع Private) ثم شغّل Workflow «Android APK (local release candidate)»
  6) اختياري: bash scripts/repo-hygiene.sh   (عرض الملفات المؤقتة؛ --apply للنقل)
التفاصيل: docs/phase12/12.1-build-setup.md
SCD_NEXT_P12S1
