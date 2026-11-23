// بناء واجهة الويب لنسخة Windows (القسم 3) إلى desktop/web-dist.
//   node scripts/build-web.mjs                 بناء كامل (يحتاج شبكة: npm + expo)
//   node scripts/build-web.mjs --stage-only    تجهيز desktop/.stage فقط (بلا تثبيت/بناء) — للفحص دون شبكة
//   node scripts/build-web.mjs --skip-install  إعادة بناء على مرحلة مثبّتة سابقاً
// لا يمسّ أي ملف خارج desktop/. تعمل على Windows وLinux.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGE_COPY, WEB_DEPS, buildStagedAppJson, buildMetroConfig, patchIndexHtml, verifyWebDist } from './lib/stage.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '..');
const stage = join(desktop, '.stage', 'app');
const outDir = join(desktop, 'web-dist');
const args = new Set(process.argv.slice(2));

const run = (cmd, argv, extraEnv = {}) => {
  console.log(`\n$ ${cmd} ${argv.join(' ')}`);
  const r = spawnSync(cmd, argv, {
    cwd: stage, stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', SCD_TARGET: 'windows', ...extraEnv },
  });
  if (r.status !== 0) { console.error(`✘ فشل: ${cmd} ${argv.join(' ')} (رمز ${r.status})`); process.exit(r.status || 1); }
};

function listFiles(dir) {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : out.push(relative(dir, p).split(sep).join('/')); } };
  walk(dir);
  return out;
}

// 1) المرحلة
if (!args.has('--skip-install')) {
  rmSync(join(desktop, '.stage'), { recursive: true, force: true });
}
mkdirSync(stage, { recursive: true });
for (const item of STAGE_COPY) {
  const from = join(root, item);
  if (!existsSync(from)) { if (item === 'package-lock.json' || item === '.npmrc') continue; console.error('✘ مفقود في الجذر: ' + item); process.exit(1); }
  cpSync(from, join(stage, item), { recursive: true });
}
rmSync(join(stage, 'scd-shims'), { recursive: true, force: true });
cpSync(join(desktop, 'shims'), join(stage, 'scd-shims'), { recursive: true });
writeFileSync(join(stage, 'app.json'), JSON.stringify(buildStagedAppJson(JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'))), null, 2) + '\n');
writeFileSync(join(stage, 'metro.config.js'), buildMetroConfig());
console.log('✔ المرحلة جاهزة: ' + relative(root, stage));
if (args.has('--stage-only')) process.exit(0);

// 2) التثبيت
if (!args.has('--skip-install')) {
  run('npm', ['install', '--no-audit', '--no-fund']);
  run('npx', ['expo', 'install', ...WEB_DEPS]);
}

// 3) التصدير
rmSync(join(stage, 'dist'), { recursive: true, force: true });
run('npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'dist']);

// 4) النشر إلى web-dist
const dist = join(stage, 'dist');
if (!existsSync(join(dist, 'index.html'))) { console.error('✘ لم يُنتَج index.html'); process.exit(1); }
writeFileSync(join(dist, 'index.html'), patchIndexHtml(readFileSync(join(dist, 'index.html'), 'utf8')));
rmSync(outDir, { recursive: true, force: true });
cpSync(dist, outDir, { recursive: true });

// 5) فحص ثابت
const files = listFiles(outDir);
const errors = verifyWebDist({ files, readText: (f) => readFileSync(join(outDir, ...f.split('/')), 'utf8') });
console.log(`\nweb-dist: ${files.length} ملفاً`);
if (errors.length) { for (const e of errors) console.error('✘ ' + e); process.exit(1); }
console.log('✔ فحص مخرجات الويب سليم');
if (!args.has('--keep-stage')) {
  // المرحلة تحوي node_modules ونسخة من src؛ نحذفها كي لا يلتقطها tsc/jest في الجذر (tsconfig الجذر يشمل **/*.ts).
  rmSync(join(desktop, '.stage'), { recursive: true, force: true });
  console.log('✔ حُذفت desktop/.stage (استعمل --keep-stage للإبقاء عليها)');
}
