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
| `shims/` | بدائل وحدات Expo الأصلية على Windows (تُستبدل عبر Metro فقط) | 1 هيكل، 2–7 تنفيذ |
| `electron/` | Main / Preload / IPC / بروتوكول app:// / فحص ذاتي | 2 ✔ |
| `scripts/` | فحص النسخة الاحتياطية وتغطية الـ shims | 1 ✔ |
| `build/` | الأيقونات وموارد electron-builder | 9 |

## كيف تعمل طبقة Shims
`src` تستورد `expo-sqlite` وغيرها كما هي. عند البناء لـ Windows (`SCD_TARGET=windows` و`platform=web`)
يحوّل `shims/metro-alias.cjs` هذه الاستيرادات إلى ملفات `shims/*.ts` التي تتصل بـ Electron عبر `window.scd`.
أندرويد لا يتأثر لأن الاستبدال مشروط بالمنصة والمتغير معاً.
`shims/registry.json` يصنّف كل وحدة خارجية (shim / native-web / pure-js).

## الحالة
- القسم 1 مكتمل.
- القسم 2 مكتمل برمجياً: انظر `docs/section-2-report.md` (اختبارات المنطق 23/23؛ تشغيل Electron الفعلي يتحقق عبر `npm run smoke` في CI).
- shims الأقسام 3–7 تُرمي `DesktopNotImplementedError` صريحاً بدل الفشل الصامت.

```
cd desktop && npm install
npm run verify:section2   # نسخة احتياطية + shims + اختبارات
npm run smoke             # يشغّل Electron فعلياً (على Linux: xvfb-run)
```
