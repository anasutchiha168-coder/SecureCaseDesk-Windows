// فحص دخاني حقيقي لحزمة الويب الفعلية داخل Electron (القسم 3). يتطلب: npm run build:web ثم Electron مثبّتاً.
// يضع نسخة من web-dist في مجلد مؤقت ويحقن فيها سكربتي فحص (ملفان خارجيان: CSP لا تسمح بـ inline)،
// ثم يشغّل Electron بوضع SCD_SMOKE=1 على هذا الجذر. لا يُعدَّل web-dist نفسه.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(desktop, 'web-dist');
if (!existsSync(join(dist, 'index.html'))) { console.error('✘ web-dist غير موجود. شغّل: npm run build:web'); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), 'scd-web-smoke-'));
cpSync(dist, tmp, { recursive: true });
cpSync(join(desktop, 'electron', 'smoke', 'web-early.js'), join(tmp, '__scd_early.js'));
cpSync(join(desktop, 'electron', 'smoke', 'web-probe.js'), join(tmp, '__scd_probe.js'));
let html = readFileSync(join(tmp, 'index.html'), 'utf8');
html = html.replace(/<head[^>]*>/i, (m) => m + '<script src="/__scd_early.js"></script>').replace(/<\/body>/i, '<script src="/__scd_probe.js" defer></script></body>');
writeFileSync(join(tmp, 'index.html'), html);

const require = createRequire(import.meta.url);
const electron = require('electron');
const args = ['.'];
if (process.platform === 'linux') args.push('--no-sandbox'); // حاويات CI فقط
let out = '';
const child = spawn(electron, args, {
  cwd: desktop, stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, SCD_SMOKE: '1', SCD_WEB_ROOT: tmp },
});
child.stdout.on('data', (d) => { out += d; });
child.on('exit', (code) => {
  rmSync(tmp, { recursive: true, force: true });
  const line = out.split('\n').find((l) => l.startsWith('SCD_SMOKE_RESULT '));
  if (!line) { console.error('✘ لا نتيجة فحص من Electron\n' + out.slice(-2000)); process.exit(1); }
  const r = JSON.parse(line.slice('SCD_SMOKE_RESULT '.length));
  for (const c of r.checks ?? []) console.log(`${c.pass ? '✔' : c.informational ? '·' : '✘'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  if (r.errors?.length) console.log('\nأخطاء الواجهة المرصودة:\n' + r.errors.map((e) => '  ' + e).join('\n'));
  process.exit(r.ok && code === 0 ? 0 : 1);
});
