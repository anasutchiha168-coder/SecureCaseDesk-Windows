# electron/ — القسم 2 ✔

| الملف | الدور |
|---|---|
| `main.cjs` | دورة حياة التطبيق، النافذة، بروتوكول `app://bundle`، قفل الصلاحيات، حراسة التنقل |
| `preload.cjs` | الجسر الوحيد `window.scd` عبر contextBridge (قائمة بيضاء لـ invoke والأحداث) |
| `channels.cjs` | القائمة البيضاء + القسم المنفِّذ لكل قناة |
| `ipc/register.cjs` | بوابات IPC: قناة مسموحة ← مُرسل موثوق (الإطار الرئيسي + app://bundle) ← حمولة صالحة |
| `ipc/handlers.cjs` | المعالجات. المنفّذ: `app:*` و`window:*`. الباقي يرمي `NOT_IMPLEMENTED (القسم N)` |
| `lib/security.cjs` | التحقق من المصدر، منع traversal، CSP، رؤوس الأمان، الروابط الخارجية |
| `lib/window-state.cjs` | حفظ/تنقية موضع النافذة (يتعامل مع فصل الشاشات) |
| `lib/logger.cjs` | سجل تشغيلي في `userData/logs` (لا حمولات ولا بيانات قضايا) |
| `smoke/` | صفحة فحص ذاتي تعمل تحت CSP الإنتاج: `npm run smoke` |

## لماذا بروتوكول app:// وليس file://
مصدر ثابت `app://bundle` يتيح التحقق من هوية المُرسل وتطبيق CSP صارمة وتوجيه SPA لـ expo-router بمسارات مطلقة.
تُخدم الواجهة من `desktop/web-dist/` (يُنتجها القسم 3).

## العقد مع الواجهة
- `window.scd.invoke(channel, payload)` يعيد البيانات أو يرمي `Error` رسالته `[CODE] message` (استخدم `parseScdError` من `shims/bridge-contract.ts`).
- `window.scd.on('scd:event:window-state', cb)` يعيد دالة إلغاء الاشتراك.
- لإضافة قناة: `channels.cjs` + `preload.cjs` + `bridge-contract.ts` + معالج؛ اختبار `parity` يفشل إن اختلفت.

## متغيرات بيئة
| المتغير | الأثر |
|---|---|
| `SCD_DEV_URL` | تحميل خادم Expo المحلي (localhost فقط، ويُتجاهل في النسخة المُحزَّمة) |
| `SCD_DISABLE_GPU=1` | تعطيل التسريع الرسومي (للتوافق مع Winlator/Wine) |
| `SCD_DEVTOOLS=1` | السماح بأدوات المطوّر في النسخة المُحزَّمة (للتشخيص فقط) |
| `SCD_SMOKE=1` | وضع الفحص الذاتي (يستخدم userData مؤقتاً) |
