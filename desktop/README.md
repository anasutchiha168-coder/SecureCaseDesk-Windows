# SecureCaseDesk — نسخة Windows (desktop/)

مشروع مستقل داخل `desktop/` يحوّل التطبيق إلى EXE عبر **Electron + Expo Web**.
**قاعدة ذهبية:** لا يُعدَّل `src/` ولا أي ملف أصلي خارج `desktop/`. يُفرض ذلك آلياً:

```
node desktop/scripts/verify-backup.mjs
```

## البنية
| المسار | الدور | القسم |
|---|---|---|
| `backup/` | نسخة أصلية zip + مانيفست SHA-256 لكل ملف | 1 ✔ |
| `shims/` | بدائل وحدات Expo/RN الأصلية على Windows (تُستبدل عبر Metro فقط) | 1 هيكل، 3 `react-native`، 5–7 تنفيذ |
| `electron/` | Main / Preload / IPC / بروتوكول app:// / فحص ذاتي | 2 ✔ |
| `scripts/` | فحص النسخة الاحتياطية وتغطية الـ shims | 1 ✔ |
| `scripts/build-web.mjs` | بناء الويب (Expo export) إلى `web-dist/` عبر مرحلة `.stage` | 3 ✔ |
| `build/` | الأيقونات وموارد electron-builder | 9 |

## كيف تعمل طبقة Shims
`src` تستورد `expo-sqlite` وغيرها كما هي. عند البناء لـ Windows (`SCD_TARGET=windows` و`platform=web`)
يحوّل `shims/metro-alias.cjs` هذه الاستيرادات إلى ملفات `shims/*.ts` التي تتصل بـ Electron عبر `window.scd`.
أندرويد لا يتأثر لأن الاستبدال مشروط بالمنصة والمتغير معاً.
`shims/registry.json` يصنّف كل وحدة خارجية (shim / native-web / pure-js).

## الحالة
- القسم 1 مكتمل.
- القسم 2 مكتمل برمجياً: انظر `docs/section-2-report.md` (اختبارات المنطق 23/23؛ تشغيل Electron الفعلي يتحقق عبر `npm run smoke` في CI).
- القسم 3 مكتمل برمجياً: انظر `docs/section-3-report.md` (اختبارات 35/35 + Chromium حقيقي؛ البناء الفعلي والفحص الدخاني يتحققان عبر `desktop-section3.yml`).
- القسم 4 مكتمل برمجياً: انظر `docs/section-4-report.md` (78/78 + Chromium 27/27؛ المعيار الحقيقي `desktop-section4.yml`).
- shims الأقسام 5–7 ترفض Promise بـ `DesktopNotImplementedError` صريحاً بدل الفشل الصامت (الدوال المتزامنة ترمي).

```
cd desktop && npm install
npm run verify:section2   # نسخة احتياطية + shims + اختبارات
npm run smoke             # يشغّل Electron فعلياً (على Linux: xvfb-run)
npm run verify:section3   # + توافق react-native-web واختبارات الويب
npm run build:web         # يحتاج شبكة: ينتج desktop/web-dist
npm run smoke:web         # يحمّل web-dist الحقيقي في Electron
npm run verify:section4   # كما section3 + اختبارات التخطيط
```
