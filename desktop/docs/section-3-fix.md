# إصلاح فشل بناء القسم 3 (shim react-native لم يدخل الحزمة)

**العَرَض (GitHub Actions):** `expo export` ينجح (4.4MB) لكن الفحص الثابت يفشل:
`shim react-native لم يُدمج في الحزمة` و`بديل Alert غير موجود في الحزمة`.

**السبب:** Expo على الويب يحوّل `react-native` إلى `react-native-web` داخل محلّله الخاص، فلا يصل الاسم إلى `desktop/shims/metro-alias.cjs`
(بينما `expo-sqlite` وغيرها تصل لأن Expo لا يحوّلها). فبقي `Alert.alert` الفارغ الأصلي في react-native-web.

**الإصلاح:** لا نعتمد على ترتيب المحلّلات. بعد `npm install` يعدّل `build-web.mjs` حزمة `react-native-web` داخل `desktop/.stage` فقط:
- `dist/index.js` (ESM): يُحذف تصدير `Alert` و`I18nManager` الأصليَّين، ويُصدَّر `Alert/Share/I18nManager/DevSettings` من `shims/rnw-extras.ts` (+ `StatusBar` إن غاب).
- `dist/cjs/index.js`: يُنقل الأصل إلى `index.original.js` ويُكتب غلاف يحفظ بقية الصادرات.
- التعديل idempotent، ويفشل بوضوح (لا نجاح كاذب) إن اختلفت صيغة الحزمة.
- أُضيف `--clear` إلى `expo export` لتفادي كاش Metro.

لا تغيير على `src` ولا Android ولا جذر المشروع. `react-native.tsx` والمحلّل بقيا كما هما (لا تعارض).

**نتائج حقيقية هنا (بلا شبكة):** اختبارات الويب 44/44 (9 جديدة)، Electron 23/23، verify-backup ✔، check-shims ✔، rn-compat 24/24.
**لم يُشغَّل هنا:** `expo export` الفعلي — المعيار هو workflow `desktop-section3.yml` على windows-latest.

---

# إصلاح 2: فشل فحص Electron `عقدة RN-web الجذرية dir=rtl`

**العَرَض (GitHub Actions، خطوة «Electron smoke on the real bundle»):** البناء ينجح وكل فحوص الدخان تنجح (shim، RTL للمستند، رسم الواجهة،
السياق الآمن، خطوط Cairo، لا أخطاء غير متوقعة) عدا فحص واحد:
`✘ عقدة RN-web الجذرية dir=rtl — diag={"registered":0,"rendered":0,...}` و`chain=div[dir=-] > div[dir=-] > ...`.

**الاستنتاج من القيم:** `registered:0` تعني أن أحداً لم يستدعِ `AppRegistry.registerComponent` الذي لففناه، فلم يُنشأ جذر `<View dir="rtl">` أبداً،
رغم أن الواجهة نفسها رُسمت. أي أن Expo (SDK 58) يركّب التطبيق على الويب بمسار لا يمرّ بهذا الاستدعاء، واعتمادنا عليه وحده كان خطأً.
(هذا استنتاج من السجل؛ لم أستطع فحص الحزمة المبنية لأن بيئتي بلا شبكة.)

**الإصلاح:** نضمن الجذر من مكان لا يعتمد على طريقة التركيب:
- `shims/safe-area-context.tsx` (جديد): shim لـ `react-native-safe-area-context` يعيد تصدير الحزمة كما هي ويلفّ `SafeAreaProvider` فقط بـ `<View dir="rtl" lang="ar" style={{flex:1}}>`.
  `SafeAreaProvider` هو أعلى عنصر يُرسم في `src/app/_layout.tsx` نفسه (يُستورد منه مباشرة)، فوجوده مضمون. الـ shim نفسه يصل للحزمة الحقيقية (استثناء المحلّل)، ولا يعمل إلا مع `platform=web` و`SCD_TARGET=windows` (الأندرويد لا يتأثر).
- `shims/rtl-root.ts` (جديد): منطق الجذر المشترك (بلا استيراد react/react-native فيُختبر دون شبكة): سياق واحد على `globalThis` يمنع اللفّ المزدوج مع لفّ `AppRegistry` إن عمل،
  و`ref` يضبط `dir/lang` على عقدة DOM الفعلية حتى لو لم تمرّرهما react-native-web.
- `registry.json`: `react-native-safe-area-context` من `native-web` إلى `shim`.
- فحص البناء الثابت (`verifyWebDist`) صار يتأكد أن العلامة `__scdRtlRootCtx` دخلت الحزمة، فإن لم يعترض Metro الوحدة يفشل `build:web` برسالة واضحة بدل أن ينتظر الفحص الدخاني.
- `react-native.tsx`: لا يمسح `diag` إن نُفِّذ بعد rnw-extras.

**تشخيص أفضل إن فشل الفحص مجدداً:** `web-probe.js` ينتظر حتى 5 ثوانٍ للعقدة، و`smoke-web.mjs` يطبع كل قيمة (`path` و`diag` و`chain` و`rootChildren`) في سطر مستقل،
ويكتب الفحص كاملاً في ملخص الـ job (Summary) في GitHub ليُقرأ على الهاتف بلا قصّ. العدّادان الجديدان `rtlRoot` (جذر SafeAreaProvider رُسم) و`rtlRootNested` (تخطّى اللفّ).

**ما شُغّل فعلاً هنا (بلا شبكة):** `verify:section3` ✔ — verify-backup 247/247، check-shims 18/18، rn-compat 24/24، Electron 24/24، الويب 51/51 (7 جديدة: الجذر المشترك،
اللفّ غير المزدوج، تعايشه مع لفّ AppRegistry، ضبط السمات، المحلّل يحوّل safe-area على web+windows فقط ويستثني الـ shim ولا يمسّ android/ios)، و`tsc --strict` نظيف على الملفين الجديدين.
**لم يُشغَّل:** `expo export` والفحص الدخاني على الحزمة الحقيقية (المعيار الحقيقي: workflow `desktop-section3.yml` على windows-latest). لا أعرف مسبقاً أن react-native-web
يمرّر `dir` من `View` إلى DOM؛ ضبط السمة عبر `ref` يضمن عقدة `dir="rtl"` في كل الأحوال، لكن قلب `left/right` برمجياً (سياق react-native-web) يتحقق منه القسم 4.
