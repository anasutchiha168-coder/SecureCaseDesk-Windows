// يتحقق أن النسخة الاحتياطية سليمة وأن ملفات المشروع الأصلية (src وغيرها) لم تتغير.
// الاستخدام:  node desktop/scripts/verify-backup.mjs   (يعمل على Windows وLinux)
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const root = resolve(desktop, '..');
const backup = join(desktop, 'backup');

const sha256 = (file) =>
  new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', fail).on('end', () => ok(h.digest('hex')));
  });

const errors = [];
const warnings = [];

// 1) سلامة الأرشيف
const archive = join(backup, 'SecureCaseDesk-original.zip');
const archiveLine = readFileSync(join(backup, 'SecureCaseDesk-original.zip.sha256'), 'utf8').trim().split(/\s+/)[0];
const archiveActual = await sha256(archive);
if (archiveActual !== archiveLine) errors.push(`الأرشيف تالف أو مُعدَّل: ${archiveActual} ≠ ${archiveLine}`);

// 2) الملفات الأصلية مقابل المانيفست
const allowed = new Set(
  readFileSync(join(backup, 'ALLOWED_CHANGES.txt'), 'utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')),
);
const manifest = new Map();
for (const line of readFileSync(join(backup, 'SHA256SUMS.original.txt'), 'utf8').split('\n')) {
  const m = /^([0-9a-f]{64})  (.+)$/.exec(line.trim());
  if (m) manifest.set(m[2], m[1]);
}
let checked = 0;
for (const [rel, expected] of manifest) {
  if (allowed.has(rel)) continue;
  const p = join(root, ...rel.split('/'));
  if (!existsSync(p)) { errors.push(`مفقود: ${rel}`); continue; }
  if ((await sha256(p)) !== expected) errors.push(`تغيّر: ${rel}`);
  checked++;
}

// 3) ملفات جديدة خارج desktop/ (تنبيه فقط)
const skip = new Set(['.git', 'node_modules', 'desktop']);
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const rel = relative(root, p).split(sep).join('/');
      if (!manifest.has(rel)) warnings.push(`ملف جديد خارج desktop/: ${rel}`);
    }
  }
};
walk(root);

console.log(`الأرشيف: ${archiveActual === archiveLine ? 'سليم ✔' : 'فاسد ✘'}`);
console.log(`ملفات أصلية تم فحصها: ${checked}/${manifest.size}`);
for (const w of warnings) console.warn('تنبيه:', w);
if (errors.length) { for (const e of errors) console.error('خطأ:', e); process.exit(1); }
console.log('النتيجة: كل الملفات الأصلية (بما فيها src) مطابقة للنسخة الموثقة ✔');
