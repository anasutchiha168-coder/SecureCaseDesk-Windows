// القسم 9: يفحص release/win-unpacked: محتوى asar، الوحدة الأصلية خارجه، ثم يشغّل الـ exe المُحزَّم بوضع الفحص.
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSmokeExe, fmtChecks } from './lib/run-smoke-exe.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = join(desktop, 'release', 'win-unpacked');
const require = createRequire(import.meta.url);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, pass: !!ok, detail }); console.log(`${ok ? '✔' : '✘'} ${name}${!ok && detail ? ' — ' + detail : ''}`); };
const walk = (d, out = []) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };

const exe = join(unpacked, 'SecureCaseDesk.exe');
const asarFile = join(unpacked, 'resources', 'app.asar');
check('SecureCaseDesk.exe موجود', existsSync(exe));
check('resources/app.asar موجود', existsSync(asarFile));

if (existsSync(asarFile)) {
  let asar; try { asar = require('@electron/asar'); } catch { try { asar = require('asar'); } catch { /* */ } }
  if (!asar) check('وحدة asar متاحة للفحص', false, 'ثبّت التبعيات: npm install');
  else {
    const list = asar.listPackage(asarFile, { isPack: false }).map((p) => p.replace(/\\/g, '/'));
    const has = (s) => list.some((p) => p.endsWith(s));
    for (const f of ['/web-dist/index.html', '/electron/main.cjs', '/electron/preload.cjs', '/electron/smoke/smoke.js', '/package.json']) check('في asar: ' + f, has(f));
    for (const bad of ['/src/', '/backup/', '/tests/', '/scripts/', '/docs/']) check('ليس في asar: ' + bad, !list.some((p) => p.startsWith(bad)), list.find((p) => p.startsWith(bad)));
    check('لا ملفات .zip/.map داخل asar', !list.some((p) => /\.(zip|map)$/.test(p)));
  }
}
const un = join(unpacked, 'resources', 'app.asar.unpacked');
const nodeFiles = existsSync(un) ? walk(un).filter((f) => f.endsWith('.node')) : [];
check('وحدة SQLCipher الأصلية (.node) خارج asar', nodeFiles.length > 0, un);
nodeFiles.slice(0, 3).forEach((f) => console.log('   ' + f.slice(unpacked.length)));

if (existsSync(exe)) {
  console.log('\n… تشغيل الـ exe المُحزَّم بوضع الفحص (SCD_SMOKE=1)');
  const r = await runSmokeExe(exe);
  console.log(fmtChecks(r)); if (r.error) console.log('   ' + r.error + (r.err ? '\n' + r.err : ''));
  check('الـ exe المُحزَّم يقلع وكل فحوص الأمان/IPC فيه ناجحة', r.ok, r.error);
}

const ok = checks.every((c) => c.pass);
writeFileSync(join(desktop, 'release', 'package-report.json'), JSON.stringify({ ok, checks }, null, 2));
console.log(ok ? '\n✔ الحزمة سليمة' : '\n✘ فشل فحص الحزمة');
process.exit(ok ? 0 : 1);
