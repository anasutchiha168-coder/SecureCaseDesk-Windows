# إصلاح فشل بناء القسم 4: «قياس textAlign (القسم 4) غير موجود في الحزمة»

**العَرَض:** خطوة `Build web bundle` تفشل في workflows القسمين 3 و4 رغم نجاح `expo export`، برسالة `✘ قياس textAlign (القسم 4) غير موجود في الحزمة`.

**السبب:** Expo يحوّل `react-native` إلى `react-native-web` قبل محلّل Metro (انظر `docs/section-3-fix.md`)، فملف `shims/react-native.tsx` لا يدخل الحزمة أبداً.
وضع القسم 4 فيه: قياس textAlign، `Text/TextInput`، `ScrollView`، `FlatList` (عمودان)، `Modal` (عمود مركزي)، `RefreshControl`. فلم يصل أي منها للحزمة، لا العلامة فقط.

**الإصلاح:** نقل هذه المكوّنات إلى `shims/rnw-section4.ts` (دالة `createSection4` تستلم المكوّنات الأصلية كمعاملات، بلا استيراد من react-native-web)،
و`scripts/lib/patch-rnw.mjs` يحقنها في `dist/index.js` (ESM) و`dist/cjs/index.js` بنفس آلية Alert/Share. يفشل التعديل بوضوح إن غاب أي مكوّن مطلوب.
لا تغيير على `src` ولا Android ولا `react-native.tsx`.

**اختبارات:** `tests/web/section4-inject.test.mjs` (7).
