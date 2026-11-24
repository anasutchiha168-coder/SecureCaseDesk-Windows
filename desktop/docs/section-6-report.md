# القسم 6 — قاعدة البيانات (SQLCipher عبر Electron IPC)

## ما نُفِّذ
- `electron/lib/db-service.cjs`: خدمة الاتصالات في العملية الرئيسية فقط (حد أقصى 16 اتصالاً، ذاكرة تخزين مؤقتة للعبارات، معاملات begin/commit/rollback، `closeAll` عند إعادة تحميل الواجهة أو انهيارها أو إغلاق التطبيق).
- `electron/ipc/db-handlers.cjs`: تحقق صارم من حمولات `scd:db:*` (handle، sql ≤ 2MB، params ≤ 5000، action محدّد).
- `shims/expo-sqlite.ts`: بديل `expo-sqlite` بنفس الواجهة التي تستعملها `src` (دون تعديل `src`). `databasePath` و`defaultDatabaseDirectory` نصوص عادية بشرطات أمامية (`C:/Users/.../documents/SQLite/securecase.db`).
- `main.cjs`/`handlers.cjs`: حقن الخدمة وربط الإغلاق (`did-start-loading`، `render-process-gone`، `closed`، `will-quit`).

## التشفير والتوافق مع أندرويد
- المحرك: `better-sqlite3-multiple-ciphers` بوضع `cipher='sqlcipher'` و`legacy=4` = إعدادات SQLCipher 4 (PBKDF2-HMAC-SHA512، 256000 تكرار، صفحة 4096، HMAC-SHA512). المفتاح عبارة سرّية كما في `db.ts` (`PRAGMA key = '...'`).
- فشل مغلق: غياب المحرك يرفض الفتح (`DB_ENGINE_MISSING`)، وقاعدة جديدة بلا مفتاح تُرفض (`DB_KEY_REQUIRED`)، ومفتاح فارغ يُرفض. لا رجوع لقاعدة غير مشفّرة أبداً.
- `PRAGMA cipher_version` يُجاب في الخدمة (sqlite3mc لا يوفّره): لا يعيد قيمة إلا إذا كان المفتاح مطبّقاً و`PRAGMA cipher` يعيد `sqlcipher` فعلاً؛ وإلا يعيد فارغاً فيرفض `db.ts` الفتح كما صُمِّم.
- `PRAGMA cipher_integrity_check` محاكى بـ `PRAGMA integrity_check` (sqlite3mc يتحقق من HMAC عند قراءة كل صفحة).

## ما تحقق منه فعلاً
محلياً (محرك node:sqlite بديل، بلا تشفير): خدمة القاعدة، التحقق من الحمولات، الـshim عبر جسر وهمي، المعاملات والأخطاء العربية وBLOB. هذا يختبر المنطق لا التشفير.
على GitHub Actions (`desktop-section6.yml`):
- `windows`: اختبارات المحرك الحقيقي (إلزامية)، ثم إعادة بناء الوحدة لـ Electron وتشغيل `smoke:db` فعلياً.
- `compat` (Ubuntu): قاعدة أنشأها `sqlcipher` الرسمي تُقرأ بمحركنا، وقاعدة أنشأها محركنا يقرؤها `sqlcipher` الرسمي. هذا أقرب فحص ممكن لتوافق نسخ أندرويد دون جهاز.

## أمور مفتوحة (لم تُحسم بعد)
1. **المفاتيح الأمنية**: `db.ts` يقرأ المفتاح من `expo-secure-store` وهو ما زال غير منفَّذ (القسم 7)؛ لذلك لن يفتح التطبيق الكامل القاعدة قبل القسم 7. المفتاح يعبر IPC نصاً داخل الجهاز كما يفعل `db.ts`.
2. **Foreign keys**: محرك Windows يفعّلها افتراضياً. لم أتحقق من القيمة الافتراضية في expo-sqlite على أندرويد؛ إن اختلفت قد تُرفض كتابات كانت تنجح هناك. تُفحص في القسم 8 بتشغيل `initDatabase` الحقيقي.
3. **الأداء**: better-sqlite3 متزامن فيحجب العملية الرئيسية أثناء الاستعلام. مقبول لحجم هذا التطبيق؛ العامل المنفصل (Worker) خيار لاحق.
4. **التحزيم (القسم 9)**: الوحدة الأصلية تحتاج `asarUnpack` وإعادة بناء لـ Electron في electron-builder.
5. **الاستعادة**: استبدال ملف القاعدة يتطلب إغلاق الاتصال أولاً (`closeDb` في `db.ts` يفعل). اختبار استعادة نسخة `.scdbak` كاملة من أندرويد يحتاج نسخة حقيقية؛ مؤجَّل للقسم 8.
