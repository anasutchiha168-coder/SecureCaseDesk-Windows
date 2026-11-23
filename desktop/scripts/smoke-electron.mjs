// فحص ذاتي حقيقي لـ Electron (يحتاج Electron مثبّتاً وشاشة: على Linux استخدم xvfb-run).
// يشغّل التطبيق بوضع SCD_SMOKE=1 فيحمّل electron/smoke تحت نفس CSP/preload ويطبع النتيجة.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const args = ['.'];
if (process.platform === 'linux') args.push('--no-sandbox'); // حاويات CI فقط؛ sandbox الواجهة يبقى مفعّلاً في الكود
let out = '';
const child = spawn(electron, args, { env: { ...process.env, SCD_SMOKE: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.on('exit', (code) => {
  const line = out.split('\n').find((l) => l.startsWith('SCD_SMOKE_RESULT '));
  if (!line) { console.error('✘ لا نتيجة فحص من Electron'); process.exit(1); }
  const r = JSON.parse(line.slice('SCD_SMOKE_RESULT '.length));
  for (const c of r.checks ?? []) console.log(`${c.pass ? '✔' : '✘'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  process.exit(r.ok && code === 0 ? 0 : 1);
});
