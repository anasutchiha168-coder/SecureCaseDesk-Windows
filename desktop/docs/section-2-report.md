# تقرير القسم 2 — إعداد Electron

## ما أُنجز
- **Main**: نافذة واحدة (حد أدنى 1024×680، خلفية سوداء، قائمة عربية مخفية)، single-instance، حفظ موضع/حجم النافذة مع تنقيته، إعادة تحميل تلقائية عند انهيار الواجهة (حتى 3 مرات/دقيقة)، صفحة خطأ عربية عند فشل التحميل، `AppUserModelId`.
- **بروتوكول `app://bundle`**: تقديم `web-dist` مع منع traversal وتوجيه SPA ورؤوس أمان وCSP (بلا `unsafe-eval` ولا inline script ولا مصادر خارجية).
- **الصلاحيات**: كل الصلاحيات مرفوضة، التنزيلات المباشرة مرفوضة (الحفظ عبر IPC في القسم 5)، `webview` ممنوع، `window.open` مرفوض، التنقل لمصدر غير موثوق ممنوع، والروابط الخارجية https فقط في المتصفح الافتراضي.
- **webPreferences**: `contextIsolation`, `sandbox`, `webSecurity` مفعّلة؛ `nodeIntegration` معطّل بكل أشكاله؛ DevTools معطّلة في النسخة المُحزَّمة.
- **IPC**: غلاف `{ok,data|error}`، ثلاث بوابات (قائمة بيضاء / مُرسل موثوق / حمولة صالحة)، الأخطاء الداخلية لا تسرّب رسائلها للواجهة.
- **منفّذ فعلياً**: `app:info/reload/relaunch`، `window:minimize/toggle-maximize/close/state`، حدث `window-state`. و**shim `expo-updates`** صار يعمل (يغطي `Updates.reloadAsync` في `_layout.tsx`).
- قنوات 5–7 (fs/db/secure/auth/print/share) مسجّلة وتفشل بـ `NOT_IMPLEMENTED (القسم N)`.

## نتائج حقيقية (ما شُغّل فعلاً في بيئتي)
- `node --test tests/electron/*.test.mjs`: **23/23 ناجح** (security, window-state, ipc, parity).
- `verify-backup`: 247/247 مطابق، `src` لم يُمسّ. `check-shims`: 18/18 مصنّفة.
- `node --check` على كل ملفات electron: سليم.
- **خطأ حقيقي كشفه الاختبار وأُصلح**: `new URL('app://bundle').origin` يعيد `'null'` في Node، ما كان سيجعل كل طلبات IPC تُرفض في Electron؛ صارت المقارنة على `protocol` و`host`.

## ما لم يُشغَّل (بصدق)
- **Electron نفسه لم يُشغَّل**: لا شبكة لتثبيته هنا، فلم تُنفَّذ النافذة ولا الـ preload ولا الـ smoke فعلياً. المنطق النقي مُختبَر؛ الطبقة المرتبطة بـ Electron مفحوصة نحوياً فقط.
- لذلك أُضيف `npm run smoke` (16 فحصاً داخل الواجهة تحت CSP الإنتاج) وworkflow `desktop-section2.yml` يشغّله على `windows-latest`. **نتيجته الحقيقية هي معيار نجاح هذا القسم.**
- إصدار Electron `^37.0.0` لم يُتحقق من تثبيته؛ عدّله إن لزم، ويُقفل بـ package-lock عند أول تثبيت.

## ملاحظات للأقسام القادمة
1. **القسم 3**: يجب أن ينتج البناء `desktop/web-dist/index.html`. RTL في `_layout.tsx` يعتمد `SecureStore` + إعادة تحميل، وسيعتمد على القسم 7؛ على الويب الأسلم ضبط `dir="rtl"` مباشرة.
2. **القسم 9**: تأكد أن `net.fetch(file://)` يقرأ `web-dist` داخل asar، وإلا ضعه في `extraResources`/`asarUnpack`. الـ smoke على نسخة مُحزَّمة يتحقق من ذلك.
3. **Winlator**: إن فشل Chromium sandbox تحت Wine فجرّب `SCD_DISABLE_GPU=1` ثم الوسيط `--no-sandbox` (للاختبار فقط، لا للإنتاج).
4. CSP تسمح بـ `style-src 'unsafe-inline'` (react-native-web) و`connect-src data: blob:`؛ عند إضافة معاينة PDF (القسم 5) قد يلزم `frame-src blob:`.
