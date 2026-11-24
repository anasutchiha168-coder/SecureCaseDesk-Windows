# القسم 7 — الأمان والصلاحيات (safeStorage / DPAPI)

## ما نُفِّذ
- `electron/lib/secure-service.cjs`: بديل `expo-secure-store` في العملية الرئيسية. القيم تُشفَّر بـ `safeStorage` (على Windows: Chromium OSCrypt، مفتاحه محمي بـ DPAPI ومربوط بحساب مستخدم Windows) وتُحفظ في `userData/secure/items.json`.
- `electron/ipc/secure-handlers.cjs`: قنوات `scd:secure:get|set|remove` و`scd:auth:available|prompt` بتحقق صارم (اسم `[A-Za-z0-9._-]{1,128}`، قيمة نصية ≤ 256KB، رفض الحقول الزائدة) خلف بوابات IPC الثلاث السابقة (قائمة بيضاء + مُرسل موثوق + حمولة صالحة).
- `shims/expo-secure-store.ts` و`shims/expo-local-authentication.ts`: بلا تعديل على `src` أو Android (يعمل عبر Metro alias على Windows فقط).
- `scripts/smoke-secure.cjs` + `.github/workflows/desktop-section7.yml`: فحص حقيقي لـ DPAPI على `windows-2022`.

## الخصائص الأمنية
- **فشل مغلق**: غياب `safeStorage` ⇒ `SECURE_UNAVAILABLE` ولا كتابة بنص عادي أبداً.
- **فك التشفير الفاشل لا يرجع `null`** (`SECURE_DECRYPT_FAILED`): كي لا يُنشئ `db.ts` مفتاح قاعدة جديداً بصمت فيفقد المستخدم بياناته أو تتعطل المرفقات المشفّرة.
- **ربط النص المشفّر باسمه**: نشفّر `{n,v}` ونتحقق من `n` عند القراءة، فتبديل نصَّين مشفّرين بين عنصرين يُكشف.
- **كتابة ذرّية** (ملف مؤقت + fsync + rename) مع `.bak` للاستعادة؛ ملف تالف بلا نسخة صالحة ⇒ `SECURE_STORE_CORRUPT` دون استبداله.
- **الجلسات (Windows فقط)**: عنصر `securecase_session_uid` ينتهي بعد 12 ساعة من الدخول (يُضبط بـ `SCD_SESSION_TTL_MINUTES` من 5 دقائق إلى 7 أيام)؛ المنتهي يُحذف ويُرجَع `null` فيعود التطبيق لشاشة الدخول. الخروج يحذفه كما في `AuthContext`.
- **كلمات المرور**: لا تُخزَّن إطلاقاً في هذا المخزن؛ `src` تقارن بصمتها كما في Android دون تغيير.
- **تشفير المرفقات وسجل التدقيق**: مفاتيحها (`attachment_master_key_v1`، مفاتيح HMAC، نقاط التحقق، أسماء النسخ الاحتياطي) تعبر نفس المخزن بأسمائها الأصلية، فلا تغيير على منطقها.
- القيم لا تُسجَّل في أي سجل.

## Winlator (بلا DPAPI حقيقي)
- تشغيل بـ `SCD_WINLATOR=1` يفعّل خلفية **اختبار برمجية** (AES-256-GCM بمفتاح ملف `secure/test-key.bin` بجوار البيانات). هي **ليست حماية** وموسومة `insecure` وتكتب تحذيراً في السجل.
- عناصر كُتبت بـ DPAPI لا تُقرأ بخلفية الاختبار والعكس (`SECURE_BACKEND_MISMATCH`) ولا خلط صامت. لا تنقل مجلد البيانات بين الوضعين.
- بدون هذا المتغير يعمل التطبيق على Winlator **فقط إن كان `safeStorage` متاحاً فعلاً**، وإلا يفشل مغلقاً.

## الدخول بالبصمة
Electron لا يوفّر Windows Hello. الـ shim يعلن «لا عتاد/لا تسجيل» فتخفي `src` خيار البصمة (`biometric-policy`) ويبقى الدخول بكلمة المرور. لا نجاح مزوَّر مطلقاً. دعم Windows Hello لاحقاً يتطلب وحدة WinRT أصلية.

## ما تحقق فعلاً
- محلياً (Linux): 20 اختبار للخدمة والـ IPC + 5 للـ shims، وكل الحزمة: 88 Electron (10 متخطاة: تحتاج محرك SQLCipher الحقيقي) + 110 ويب، كلها ناجحة؛ وفحص الملفات الأصلية (`src`) مطابق للنسخة الموثقة.
- **لم يُجرَّب على Windows حقيقي بعد**: `safeStorage` الحقيقي وترويسة OSCrypt يغطيها `npm run smoke:secure` في Actions. **لم يُجرَّب على Winlator**.

## أمور مفتوحة (خارج صلاحيتي دون تعديل `src`)
1. بصمة كلمة المرور في `src` هي SHA-256 بلا ملح (`AuthContext.login`). تحسينها يغيّر Android أيضاً فيحتاج قرارك صراحة.
2. حدود محاولات الدخول وقفل الخمول تُنفَّذ في `src` إن وُجدت؛ لم أضف قفل خمول على Windows.
3. `db_encryption_key` يعبر IPC نصاً داخل الجهاز كما في `db.ts`.
