# تقرير القسم 4 — تحويل تصميم الواجهات لسطح المكتب

لم يُعدَّل أي ملف في `src/` أو Android (`verify-backup`: مطابق). كل شيء داخل `desktop/` + workflow `desktop-section4.yml`.

## ما أُنجز (عبر shims فقط، يعمل عند platform=web وSCD_TARGET=windows)
| المكوّن | الملف | السلوك |
|---|---|---|
| قائمة جانبية يمين (RTL) بدل شريط الهاتف | `expo-router.tsx` + `desktop-shell.tsx` | `Tabs` يخفي الشريط السفلي وينشر العناوين/الأيقونات/`href:null` (الصلاحيات) إلى مخزن؛ `Stack` يُلفّ بالغلاف. تبقى القائمة في شاشات Stack (تقارير، بحث ذكي…). |
| عمود محتوى مُوسَّط | `desktop-layout-core.ts` | حد أقصى 1280؛ الدخول/الإعداد 520 بلا قائمة. |
| قائمة موسّعة 248 / مطوية 76 | نفسه | تلقائي تحت 1180؛ زر طيّ يُحفظ في localStorage (`scd.sidebar`). |
| قوائم بعمودين | `react-native.tsx` (FlatList) | عند عرض محتوى ≥ 1000 (النافذة الافتراضية 1360 ⇒ عمودان)؛ العنوان بعرض كامل. |
| نوافذ سفلية كعمود مركزي (≤ 680) | `react-native.tsx` (Modal) | نوافذ `slide` فقط؛ لون التعتيم يُؤخذ من الأصل؛ النقر على الجانبين يغلق. `fade` (معاينة الصور، حوار الحذف) يمر كما هو. |
| بديل السحب للتحديث | `react-native.tsx` (RefreshControl) | زر عائم ↻ يستدعي `onRefresh` نفسه. |
| أشرطة تمرير ظاهرة + تركيز لوحة المفاتيح + CSS | ScrollView/FlatList + `installDesktopCss` | |
| اختصارات | `shortcutTarget` | Ctrl+1…9. |
| تكافؤ `textAlign` في RTL | `text-align-fix.ts` + `react-native.tsx` | يُقاس فعلياً عند الإقلاع؛ يُعوَّض القلب فقط إن حدث (وإلا `Text` الأصلي نفسه). |

الخط Cairo والألوان من الأصل: `desktop-theme.ts` نسخة مطابقة لـ `theme.ts/identity.ts` مع اختبار انحراف.
شبكة الأمان: خطأ في الغلاف ⇒ `ShellBoundary` يعرض المحتوى بلا قائمة.

## نتائج حقيقية (ما شُغّل هنا)
| الفحص | النتيجة |
|---|---|
| verify-backup | src مطابق |
| check-shims / rn-compat | 19 وحدة / 24 واجهة مصنّفة (ScrollView, FlatList, Modal, RefreshControl, Text, TextInput صارت shim) |
| Electron | 24/24 |
| الويب `tests/web` | 78/78 (17 جديدة للقسم 4) |
| `tsc --strict` على الملفات النقية | نظيف |
| **Chromium حقيقي** (`tests/browser`) على ملفات shim الفعلية | 27/27: القائمة يميناً، 1360⇒محتوى 1111، 1024⇒مطوية، 2560⇒1280 مُوسَّط، Ctrl+N، الطيّ والحفظ، دور viewer، بلا أخطاء |

## ما لم يُشغَّل (بصدق)
- **`expo export` وreact-native-web الحقيقي**: بلا شبكة هنا. اختبار Chromium يستعمل بدائل مصغّرة لـ react-native/expo-router، فلا يثبت: توافق `tabBar`/`display:none` مع نسخة react-navigation في SDK 58، ولا أن RNW يرسل `ref` لـ View، ولا الشكل البصري بخط Cairo.
- **قلب textAlign**: لا أعرف إن كان RNW يقلبه؛ القياس يقرر وقت التشغيل، والفحص الدخاني يطبع `flip=` ونتيجة تسمية «اسم المستخدم».
- Electron لا يصل لشاشات ما بعد الدخول في الفحص الدخاني (قاعدة البيانات = القسم 6)، لذا القائمة والقوائم بعمودين والنوافذ تُفحص بصرياً بعد القسم 6.
- المعيار: workflow `desktop-section4.yml` على windows-latest. إن فشل فالسجل يحدد (أرسله).
