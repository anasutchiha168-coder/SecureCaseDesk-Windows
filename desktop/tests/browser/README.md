# فحص تخطيط سطح المكتب في Chromium (اختياري، خارج CI)
يبني ملفات الـ shim الحقيقية (desktop-shell وexpo-router) مع بدائل مصغّرة لـ react-native/expo-router/lucide، ثم يفحص في Chromium:
موضع القائمة يميناً، عروض الأعمدة (1024/1360/2560)، Ctrl+1…9، الطيّ والحفظ، إخفاء عناصر href:null، بقاء القائمة في شاشات Stack.
لا يختبر react-native-web الحقيقي (يُختبر عبر `npm run smoke:web` في CI).
```
npm i --no-save esbuild playwright react react-dom && npx playwright install chromium
cd desktop/tests/browser && node build.cjs && node run.cjs
```
