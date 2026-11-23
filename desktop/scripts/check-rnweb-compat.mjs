// يفحص أن كل واجهة react-native تستوردها src مصنّفة في shims/rn-compat.json (دعم react-native-web أو shim أو noop موثّق).
// يلتقط الاستيرادات متعددة الأسطر، ويتجاهل `type X`. أي اسم غير مصنّف أو استيراد namespace/default يُفشل الفحص.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSrc = resolve(desktop, '..', 'src');

export function scanSource(srcDir) {
  const used = new Map();     // name -> Set(files)
  const problems = [];
  const stats = { alertCalls: 0, shareCalls: 0, useNativeDriver: 0, elevation: 0, shadow: 0 };
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(n)) continue;
      const rel = relative(srcDir, p).split(sep).join('/');
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/import\s+(type\s+)?([^;]*?)\s+from\s+['"]react-native['"]/gs)) {
        if (m[1]) continue; // import type
        const clause = m[2].trim();
        const named = /\{([^}]*)\}/s.exec(clause);
        const outside = clause.replace(/\{[^}]*\}/s, '').replace(/,/g, '').trim();
        if (outside) problems.push(`${rel}: استيراد default/namespace من react-native غير مدعوم في الفحص: ${outside}`);
        if (!named) continue;
        for (const raw of named[1].split(',')) {
          let s = raw.trim();
          if (!s || /^type\s/.test(s)) continue;
          s = s.split(/\s+as\s+/)[0].trim();
          if (!used.has(s)) used.set(s, new Set());
          used.get(s).add(rel);
        }
      }
      stats.alertCalls += (text.match(/\bAlert\.alert\s*\(/g) || []).length;
      stats.shareCalls += (text.match(/\bShare\.share\s*\(/g) || []).length;
      stats.useNativeDriver += (text.match(/useNativeDriver\s*:\s*true/g) || []).length;
      stats.elevation += (text.match(/\belevation\s*:/g) || []).length;
      stats.shadow += (text.match(/\bshadow(Color|Offset|Opacity|Radius)\s*:/g) || []).length;
    }
  };
  walk(srcDir);
  return { used, problems, stats };
}

export function classify(used, table) {
  const rows = []; const unknown = [];
  for (const [name, files] of [...used].sort((a, b) => a[0].localeCompare(b[0]))) {
    const e = table[name];
    if (!e) { unknown.push(name); continue; }
    rows.push({ name, status: e.status, files: files.size, note: e.note, file: e.file });
  }
  return { rows, unknown };
}

if (import.meta.url === `file://${process.argv[1].split(sep).join('/')}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  const table = JSON.parse(readFileSync(join(desktop, 'shims', 'rn-compat.json'), 'utf8')).names;
  const { used, problems, stats } = scanSource(defaultSrc);
  const { rows, unknown } = classify(used, table);
  let bad = problems.length + unknown.length;
  for (const p of problems) console.error('✘ ' + p);
  for (const r of rows) {
    if (r.status === 'shim' && !existsSync(join(desktop, 'shims', r.file))) { console.error(`✘ ملف shim مفقود لـ ${r.name}: ${r.file}`); bad++; continue; }
    console.log(`✔ ${r.name.padEnd(22)} ${r.status.padEnd(10)} [${r.files} ملف]${r.note ? '  — ' + r.note : ''}`);
  }
  for (const u of unknown) console.error(`✘ غير مصنّفة: ${u}`);
  console.log(`\nAlert.alert: ${stats.alertCalls} استدعاء | Share.share: ${stats.shareCalls} | useNativeDriver:true: ${stats.useNativeDriver} | elevation: ${stats.elevation} | shadow*: ${stats.shadow}`);
  if (bad) process.exit(1);
  console.log(`كل واجهات react-native المستعملة (${rows.length}) مصنّفة ✔`);
}
