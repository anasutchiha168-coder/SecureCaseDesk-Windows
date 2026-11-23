// يتأكد أن كل وحدة خارجية مستوردة في src مصنّفة في registry.json، وأن ملفات الـ shims موجودة.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(desktop, '..', 'src');
const reg = JSON.parse(readFileSync(join(desktop, 'shims', 'registry.json'), 'utf8')).modules;

const found = new Map();
const re = /from\s+['"]([^'".\/@][^'"]*|@[^'"\/]+\/[^'"]+)['"]/g;
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(n)) {
      for (const m of readFileSync(p, 'utf8').matchAll(re)) {
        const pkg = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
        found.set(pkg, (found.get(pkg) ?? 0) + 1);
      }
    }
  }
};
walk(src);

let bad = 0;
for (const [pkg, n] of [...found].sort()) {
  const e = reg[pkg];
  if (!e) { console.error(`✘ غير مصنّف: ${pkg} (${n})`); bad++; continue; }
  if (e.action === 'shim' && !existsSync(join(desktop, 'shims', e.file))) { console.error(`✘ ملف shim مفقود: ${e.file}`); bad++; continue; }
  console.log(`✔ ${pkg.padEnd(34)} ${e.action}${e.section ? ` (قسم ${e.section})` : ''}  [${n} استيراد]`);
}
if (bad) process.exit(1);
console.log(`\nكل الوحدات الخارجية (${found.size}) مصنّفة ✔`);
