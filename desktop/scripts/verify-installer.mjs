// القسم 9: تثبيت صامت حقيقي لـ SecureCaseDesk-Setup.exe على Windows، تشغيل المثبَّت بوضع الفحص، ثم إزالة صامتة،
// والتأكد أن مجلد البيانات %APPDATA%\SecureCaseDesk لا يُمَسّ عند الإزالة.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSmokeExe, fmtChecks } from './lib/run-smoke-exe.mjs';

if (process.platform !== 'win32') { console.log('· يتخطّى: التثبيت الصامت يعمل على Windows فقط'); process.exit(0); }
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const setup = join(desktop, 'release', 'SecureCaseDesk-Setup.exe');
if (!existsSync(setup)) { console.error('✘ المثبّت غير موجود: ' + setup); process.exit(1); }

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, pass: !!ok, detail }); console.log(`${ok ? '✔' : '✘'} ${name}${!ok && detail ? ' — ' + detail : ''}`); };
const kill = () => spawnSync('taskkill', ['/F', '/IM', 'SecureCaseDesk.exe'], { stdio: 'ignore' });
const dir = join(mkdtempSync(join(tmpdir(), 'scdi-')), 'SCD');
const dataDir = join(process.env.APPDATA || '', 'SecureCaseDesk');
const marker = join(dataDir, 'installer-test.marker');

console.log('… تثبيت صامت إلى ' + dir);
let r = spawnSync(setup, ['/S', '/D=' + dir], { stdio: 'inherit', timeout: 300000 });
check('المثبّت انتهى برمز 0', r.status === 0, String(r.status ?? r.error?.message));
const exe = join(dir, 'SecureCaseDesk.exe');
check('SecureCaseDesk.exe مثبَّت', existsSync(exe));
const uninst = join(dir, 'Uninstall SecureCaseDesk.exe');
check('أداة الإزالة مثبَّتة', existsSync(uninst));
const lnk = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
console.log('   · اختصارات قائمة ابدأ (معلومة): ' + (existsSync(lnk) ? readdirSync(lnk).filter((n) => /SecureCaseDesk/i.test(n)).join(', ') || 'لا يوجد' : 'المجلد غير موجود'));

kill(); // runAfterFinish قد يشغّل التطبيق بعد التثبيت الصامت
if (existsSync(exe)) {
  const s = await runSmokeExe(exe);
  console.log(fmtChecks(s)); if (s.error) console.log('   ' + s.error + (s.err ? '\n' + s.err : ''));
  check('التطبيق المثبَّت يقلع وفحوصه ناجحة', s.ok, s.error);
}

mkdirSync(dataDir, { recursive: true }); writeFileSync(marker, 'keep');
kill();
if (existsSync(uninst)) {
  r = spawnSync(uninst, ['/S', '_?=' + dir], { stdio: 'inherit', timeout: 300000 });
  check('الإزالة الصامتة انتهت برمز 0', r.status === 0, String(r.status ?? r.error?.message));
  try { rmSync(uninst, { force: true }); } catch { /* */ }
}
check('SecureCaseDesk.exe أُزيل', !existsSync(exe));
check('مجلد البيانات في AppData لم يُحذف عند الإزالة', existsSync(marker));
try { rmSync(marker, { force: true }); } catch { /* */ }

const ok = checks.every((c) => c.pass);
writeFileSync(join(desktop, 'release', 'installer-report.json'), JSON.stringify({ ok, checks }, null, 2));
console.log(ok ? '\n✔ المثبّت سليم' : '\n✘ فشل فحص المثبّت');
process.exit(ok ? 0 : 1);
