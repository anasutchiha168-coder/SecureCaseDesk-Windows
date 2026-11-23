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
