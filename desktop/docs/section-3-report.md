# تقرير القسم 3 — تجهيز واجهات React Native Web

## ما أُنجز
**لم يُعدَّل أي ملف في `src/` أو Android** (`verify-backup`: 247/247 مطابق). كل شيء داخل `desktop/` + workflow جديد.

### 1) خط بناء الويب (`scripts/build-web.mjs` + `scripts/lib/stage.mjs`)
بناء في نسخة مرحلية `desktop/.stage/app` (تُحذف بعد النجاح) تُنسخ إليها `src` و`assets` و`app.json` و`package.json`؛ الأصول لا تُلمس.
- `app.json` المرحلي فقط: `web.bundler=metro` و**`web.output=single`** (الافتراضي في SDK 58 صار `server` ويحتاج خادماً — لا يصلح لـ `app://`) و**`asyncRoutes.web=false`** (لا حاجة لتقسيم المسارات من ملفات محلية، ويقلل نقاط الفشل).
- `metro.config.js` مُولَّد يربط `createShimResolver` بـ `SCD_TARGET=windows`.
- تثبيت `react-dom` و`react-native-web` و`@expo/metro-runtime` بـ `npx expo install` ليختار Expo النسخ المتوافقة مع SDK 58 (لا أخمّن أرقام النسخ).
- ما بعد التصدير: `index.html` يُضبط `lang="ar" dir="rtl"` وعنوان وخلفية داكنة قبل تحميل JS (بلا سكربت inline لأن CSP تمنعه)، ثم **فحص ثابت** للمخرجات (`verifyWebDist`): index، عدم وجود موارد خارجية أو inline، وجود shim الـ RN والـ Alert والـ shims الأخرى في الحزمة، ملفات Cairo الستة، وعدم وجود مراجع مكسورة.

### 2) shims واجهات React Native (`shims/react-native.tsx`)
`react-native-web` يمرّ كما هو، ونستبدل فقط ما لا يعمل (مُصنَّف في `shims/rn-compat.json`؛ الفحص `check-rnweb-compat` يغطي كل الأسماء الـ 24 التي تستوردها src ويفشل لو ظهر اسم جديد غير مصنّف):

| الواجهة | المشكلة على الويب | الحل |
|---|---|---|
| `Alert.alert` (**102 استدعاء**) | دالة فارغة في react-native-web ⇒ كل تأكيدات الحذف ورسائل الخطأ ستختفي | حوار داخلي: عربي RTL، Cairo، داكن، تركيز محصور، Esc/Enter، `inert` للخلفية، طابور، `textContent` فقط (لا HTML) |
| `Share.share` (3) | غير موجود | `navigator.share` ← نسخ إلى الحافظة مع إشعار ← خطأ صريح (القسم 5 يضيف مشاركة الملفات) |
| `I18nManager` | `forceRTL` لا يعمل؛ `isRTL=false` كان سيجعل `ROW='row-reverse'` فيُعكس التخطيط، ويدخل `_layout` حلقة إعادة تحميل RTL | `isRTL=true` ثابتاً + `dir="rtl"` على المستند وعلى جذر RN-web |
| `DevSettings` / `StatusBar` | غير موجودين/بلا معنى | بدائل آمنة |
| `RefreshControl` | بلا سحب للتحديث | موثّق (noop) — أزرار التحديث في القسم 4 |

**اعتراض Metro:** يُعترض `react-native` و`react-native-web` معاً (لأن Expo قد يحوّل الأول إلى الثاني قبل وصوله لمحلّلنا) ويُستثنى ملف الـ shim نفسه كي يصل إلى الحزمة الحقيقية دون حلقة. الأندرويد لا يتأثر: الشرط `platform=web` **و** `SCD_TARGET=windows`.

### 3) إصلاح مكتشف أثناء العمل
دوال shims غير المنفذة كانت **ترمي خطأً متزامناً** بينما الأصلية تعيد Promise؛ `_layout.tsx` يستدعي `SecureStore.deleteItemAsync(...).catch()` فكان سينهار الجذر كله قبل أن تظهر أي شاشة. صارت ترفض Promise (`notImplementedAsync`)؛ الـ getters المتزامنة تبقى ترمي كالأصل.

### 4) الخطوط والأيقونات
- Cairo: من حزمة `@expo-google-fonts/cairo` عبر Metro (بلا CDN) وCSP تسمح `font-src 'self' data:`؛ الفحص الثابت يتأكد من ستة أوزان، وفحص Electron يتأكد أنها حُمّلت فعلاً.
- الأيقونات: `lucide-react-native` ← `react-native-svg` (له تنفيذ ويب). لا تغيير.

## نتائج حقيقية (ما شُغّل فعلاً هنا)
| الفحص | النتيجة |
|---|---|
| `verify-backup` | 247/247 مطابق، src لم يُمسّ |
| اختبارات Electron (القسم 2) | 23/23 |
| اختبارات الويب `tests/web` | 35/35 |
| `check-rnweb-compat` على src الحقيقي | 24/24 مصنّفة |
| `tsc --strict` على ملفات shims الجديدة | نظيف |
| حوار Alert في **Chromium حقيقي** (Playwright) | ناجح: النقر، Enter، Esc، التركيز، الطابور، الخلفية، رسالة طويلة، حقن HTML مرفوض |
| تجربة سكربت الفحص الدخاني في Chromium على صفحة اصطناعية | منطقه سليم (فشل فحصا السياق الآمن والخطوط فيها لأنها ليست Electron/حزمة حقيقية) |

**خطأ حقيقي كشفه اختبار Chromium وأُصلح:** النقر على خلفية الحوار كان يُفقد التركيز فيتعطل Enter/Esc.

## ما لم يُشغَّل (بصدق)
- **لم يُنفَّذ `expo export` ولا تحميل الحزمة في Electron** هنا: بيئتي بلا شبكة لتثبيت npm. لذلك لم أتحقق من: نجاح بناء Metro، ولا أن `react-native-web` يقبل `dir="rtl"` كما أتوقع، ولا أن react-native-web يقلب قيم `left/right/marginLeft` تلقائياً عند RTL (توثيقه يذكر الخصائص المنطقية start/end فقط)، ولا نسخة `react-native-web` التي سيختارها Expo.
- **المعيار الحقيقي لهذا القسم هو workflow `desktop-section3.yml` على `windows-latest`:** يشغّل `verify:section3` ثم `build:web` ثم `smoke:web` (يحمّل الحزمة الحقيقية في Electron ويفحص: shim، RTL، رسم الواجهة، الخطوط، السياق الآمن، **عدم وجود أي خطأ غير `DesktopNotImplementedError`**).
- نسخ الحافظة داخل Electron لم تُجرَّب (صلاحياته مرفوضة افتراضياً؛ التراجع `execCommand('copy')` يعمل بإيماءة مستخدم).
- `Linking.openURL('mailto:')` لن يفعل شيئاً بصمت حتى القسم 5 (Electron يفتح https فقط).
- إن فشل البناء فسجل الخطأ يحدد السبب؛ الاحتمالات الأرجح: عدم توافق `react-native-web` مع `react-native 0.88` في أحد المكتبات، أو مسار تحليل Metro لـ `react-native-web` — أرسله لي وأصلحه.

## للقسم 4
1. إن لم يقلب RN-web قيم `left/right` تحت `dir=rtl`، فالأنسب معالجتها مع إعادة تصميم التخطيط.
2. شريط التبويبات السفلي (`(tabs)/_layout.tsx`) ما زال تصميم هاتف.
3. `useNativeDriver:true` (6 مواضع)، `elevation` (5)، `shadow*` (16): تعمل بتحذيرات في الكونسول فقط.
