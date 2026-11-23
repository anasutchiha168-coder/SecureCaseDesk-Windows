// تشغيل Electron على خادم Expo Web المحلي (تطوير فقط؛ لا يعمل مع نسخة مُحزَّمة).
// الاستخدام: SCD_DEV_URL=http://localhost:8081 npm run dev   (أو يمرَّر كوسيط أول)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const url = process.argv[2] || process.env.SCD_DEV_URL || 'http://localhost:8081';
const electron = require('electron'); // مسار الملف التنفيذي
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, SCD_DEV_URL: url } });
child.on('exit', (code) => process.exit(code ?? 0));
