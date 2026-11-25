// القسم 9: يبني حزمة الويب ثم مثبّت NSIS + Portable ويحسب SHA-256.
//   node scripts/dist-win.mjs          كامل (NSIS + Portable)
//   node scripts/dist-win.mjs --dir    مجلد مفكوك فقط (win-unpacked) للفحص السريع
//   --skip-web                          يستعمل web-dist الموجود
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(desktop, 'release');
const args = new Set(process.argv.slice(2));
const dirOnly = args.has('--dir');
const win = process.platform === 'win32';
const fail = (m) => { console.error('✘ ' + m); process.exit(1); };
const run = (cmd, a, env = {}) => {
  console.log(`\n$ ${cmd} ${a.join(' ')}`);
  const r = spawnSync(cmd, a, { cwd: desktop, stdio: 'inherit', shell: win, env: { ...process.env, CI: process.env.CI || '1', SCD_TARGET: 'windows', CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...env } });
  if (r.status !== 0) fail(`فشل: ${cmd} ${a.join(' ')} (رمز ${r.status})`);
};

if (!existsSync(join(desktop, 'build', 'icon.png'))) fail('build/icon.png مفقودة');
run('node', ['scripts/stamp-build.mjs']);
if (!args.has('--skip-web')) run('npm', ['run', 'build:web']);
if (!existsSync(join(desktop, 'web-dist', 'index.html'))) fail('web-dist/index.html مفقود — شغّل build:web');

rmSync(release, { recursive: true, force: true });
const cfg = ['--config', 'electron-builder.config.cjs', '--win', '--x64', '--publish', 'never'];
// الأهداف (nsis + portable) معرّفة في electron-builder.config.cjs؛ تمريرها كوسائط بعد --x64 يُرفض (Unknown arguments).
run('npx', ['electron-builder', ...cfg, ...(dirOnly ? ['--dir'] : [])]);

if (dirOnly) { console.log('✔ تم المجلد المفكوك: release/win-unpacked'); process.exit(0); }

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const isPe = (f) => { const b = Buffer.alloc(2); const fd = openSync(f, 'r'); readSync(fd, b, 0, 2, 0); closeSync(fd); return b.toString('latin1') === 'MZ'; };
const want = ['SecureCaseDesk-Setup.exe', 'SecureCaseDesk-Portable.exe'];
const lines = [];
for (const n of want) {
  const f = join(release, n);
  if (!existsSync(f)) fail(`لم يُنتَج: ${n}\nالموجود: ${readdirSync(release).join(', ')}`);
  const mb = statSync(f).size / 1048576;
  if (mb < 40) fail(`${n} صغير بشكل مريب (${mb.toFixed(1)}MB)`);
  if (!isPe(f)) fail(`${n} ليس ملف Windows تنفيذياً (لا ترويسة MZ)`);
  lines.push(`${sha(f)}  ${n}`);
  console.log(`✔ ${n}  ${mb.toFixed(1)}MB  sha256=${sha(f)}`);
}
writeFileSync(join(release, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log('✔ release/SHA256SUMS.txt');
