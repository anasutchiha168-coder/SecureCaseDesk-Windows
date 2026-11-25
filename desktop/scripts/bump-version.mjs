// رفع رقم الإصدار في كل الأماكن دفعة واحدة، وإضافة سطر في سجل التغييرات.
//   node scripts/bump-version.mjs patch "وصف التعديل"     (2.2.0 -> 2.2.1)
//   node scripts/bump-version.mjs minor "ميزة جديدة"      (2.2.0 -> 2.3.0)
//   node scripts/bump-version.mjs major "..."             (2.2.0 -> 3.0.0)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '..');
const [kind = 'patch', ...rest] = process.argv.slice(2);
const note = rest.join(' ').trim() || '(بلا وصف)';
if (!['patch', 'minor', 'major'].includes(kind)) { console.error('الاستخدام: bump-version.mjs patch|minor|major "وصف"'); process.exit(1); }

const targets = [join(desktop, 'package.json'), join(root, 'package.json')];
const appJson = join(root, 'app.json');
const bump = (v) => {
  const [a, b, c] = v.split('.').map(Number);
  return kind === 'major' ? `${a + 1}.0.0` : kind === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
};
const current = JSON.parse(readFileSync(targets[0], 'utf8')).version;
const next = bump(current);
for (const f of targets) {
  if (!existsSync(f)) continue;
  const raw = readFileSync(f, 'utf8');
  const out = raw.replace(new RegExp(`("version"\\s*:\\s*")${current.replace(/\./g, '\\.')}(")`), `$1${next}$2`);
  if (out === raw) { console.error(`✘ لم أجد الإصدار ${current} في ${f}`); process.exit(1); }
  writeFileSync(f, out);
  console.log(`✔ ${f.replace(root, '.')}  ${current} → ${next}`);
}
// Android: app.json يحمل الإصدار + versionCode (يجب أن يزيد في كل إصدار كي يقبل أندرويد التحديث فوق النسخة المثبتة).
// versionCode = major*10000 + minor*100 + patch  (2.2.0 → 20200، 2.2.1 → 20201، 2.3.0 → 20300).
if (existsSync(appJson)) {
  const a = JSON.parse(readFileSync(appJson, 'utf8'));
  const [x, y, z] = next.split('.').map(Number);
  a.expo.version = next;
  a.expo.android = { ...a.expo.android, versionCode: x * 10000 + y * 100 + z };
  writeFileSync(appJson, JSON.stringify(a, null, 2) + '\n');
  console.log(`✔ ./app.json  ${current} → ${next}  (android.versionCode = ${a.expo.android.versionCode})`);
}
const log = join(desktop, 'docs', 'CHANGELOG.md');
const head = '# سجل التغييرات\n\nكل إصدار جديد يُثبَّت فوق السابق ويحتفظ بالبيانات (%APPDATA%\\SecureCaseDesk).\n';
const old = existsSync(log) ? readFileSync(log, 'utf8').replace(head, '') : '';
writeFileSync(log, `${head}\n## ${next} — ${new Date().toISOString().slice(0, 10)}\n- ${note}\n${old}`);
console.log('✔ docs/CHANGELOG.md');
