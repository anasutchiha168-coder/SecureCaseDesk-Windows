// مشغّل القسم 8: ينفّذ كل المراحل ويسجّل النتائج الحقيقية فقط. المتخطّى يُسجَّل بسببه ولا يُحتسب نجاحاً.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '..');
const logs = join(desktop, 'section8-logs');
const docs = join(desktop, 'docs');
mkdirSync(logs, { recursive: true }); mkdirSync(docs, { recursive: true });

const win = process.platform === 'win32';
const wantElectron = win || process.env.SCD_S8_ELECTRON === '1';
const skipBuild = process.env.SCD_S8_SKIP_BUILD === '1';
const rootOn = process.env.SCD_S8_ROOT !== '0';
const node = process.execPath;
const NT = ['--test'];
const NTS = ['--experimental-strip-types', '--test'];

const stages = [
  { id: 'backup', title: 'النسخة الموثقة SHA-256 (src وAndroid لم يتغيّرا)', cmd: node, args: ['scripts/verify-backup.mjs'] },
  { id: 'shims', title: 'تصنيف كل الوحدات الخارجية (Shims)', cmd: node, args: ['scripts/check-shims.mjs'] },
  { id: 'rnweb', title: 'توافق React Native Web', cmd: node, args: ['scripts/check-rnweb-compat.mjs'] },
  { id: 'electron-unit', title: 'اختبارات Electron: IPC/ملفات/طباعة/قاعدة بيانات/تشفير', cmd: node, args: [...NT, 'tests/electron/*.test.mjs'] },
  { id: 'web-unit', title: 'اختبارات الواجهة: الشاشات/RTL/التخطيط/Shims', cmd: node, args: [...NTS, 'tests/web/*.test.mjs'] },
  { id: 's8-unit', title: 'القسم 8: الشاشات + دورة حياة قاعدة البيانات والنسخ الاحتياطي', cmd: node, args: [...NT, 'tests/section8/*.test.mjs'] },
  { id: 'root-tests', title: 'منطق التطبيق في src (مرفقات/تقارير/نسخ احتياطي/أمان/ذكاء) على Windows', cwd: root, cmd: 'npm', args: ['run', 'test:all'], shell: true,
    skip: !rootOn ? 'SCD_S8_ROOT=0' : (!existsSync(join(root, 'node_modules', '.bin')) ? 'تبعيات الجذر غير مثبّتة (npm ci في الجذر)' : null) },
  { id: 'build-web', title: 'بناء حزمة الويب (expo export, SCD_TARGET=windows)', cmd: 'npm', args: ['run', 'build:web'], shell: true,
    skip: skipBuild ? 'SCD_S8_SKIP_BUILD=1' : null },
  { id: 'smoke-web', title: 'Electron على الحزمة الحقيقية (كل الشاشات تُحمَّل دون أخطاء)', cmd: 'npm', args: ['run', 'smoke:web'], shell: true, electron: true,
    skip: skipBuild ? 'SCD_S8_SKIP_BUILD=1' : null, needs: 'build-web' },
  { id: 'rebuild-native', title: 'إعادة بناء SQLCipher لإصدار Electron', cmd: 'npx', args: ['--yes', '@electron/rebuild', '-f', '-w', 'better-sqlite3-multiple-ciphers'], shell: true, electron: true },
  { id: 'smoke-files', title: 'Electron حقيقي: الملفات والمرفقات والطباعة وPDF', cmd: 'npm', args: ['run', 'smoke:files'], shell: true, electron: true },
  { id: 'smoke-db', title: 'Electron حقيقي: SQLCipher المشفّر', cmd: 'npm', args: ['run', 'smoke:db'], shell: true, electron: true, needs: 'rebuild-native' },
  { id: 'smoke-secure', title: 'Electron حقيقي: safeStorage / DPAPI', cmd: 'npm', args: ['run', 'smoke:secure'], shell: true, electron: true },
];

const results = [];
const byId = new Map();
const counts = (txt) => {
  const g = (k) => { const m = new RegExp('^# ' + k + ' (\\d+)', 'm').exec(txt); return m ? Number(m[1]) : null; };
  const c = { tests: g('tests'), pass: g('pass'), fail: g('fail'), skipped: g('skipped') };
  return c.tests === null ? null : c;
};

for (const st of stages) {
  const rec = { id: st.id, title: st.title, status: 'pass', seconds: 0 };
  let why = st.skip || null;
  if (!why && st.electron && !wantElectron) why = 'يحتاج Windows أو SCD_S8_ELECTRON=1 (لا شاشة هنا)';
  if (!why && st.needs && byId.get(st.needs)?.status !== 'pass') why = 'تعتمد على مرحلة لم تنجح: ' + st.needs;
  if (why) { rec.status = 'skipped'; rec.reason = why; }
  else {
    console.log(`\n━━ ${st.id}: ${st.title}`);
    const t0 = Date.now();
    const r = spawnSync(st.cmd, st.args, {
      cwd: st.cwd || desktop, shell: !!st.shell, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, CI: process.env.CI || '1', SCD_TARGET: 'windows' },
    });
    rec.seconds = Math.round((Date.now() - t0) / 100) / 10;
    const out = (r.stdout || '') + (r.stderr || '') + (r.error ? '\n' + r.error.message : '');
    writeFileSync(join(logs, st.id + '.log'), out);
    const c = counts(out); if (c) rec.counts = c;
    if (r.status !== 0 || r.error) { rec.status = 'fail'; rec.exit = r.status; rec.tail = out.split('\n').slice(-40).join('\n'); }
    console.log(`${rec.status === 'pass' ? '✔' : '✘'} ${st.id} (${rec.seconds}s)${c ? ` — ${c.pass} ناجح / ${c.fail} فاشل / ${c.skipped} متخطّى` : ''}`);
  }
  results.push(rec); byId.set(st.id, rec);
}

const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skipped');
const env = { platform: process.platform, release: os.release(), node: process.version, runner: process.env.RUNNER_OS || null, image: process.env.ImageOS || process.env.ImageVersion || null, sqlcipherRequired: process.env.SCD_REQUIRE_SQLCIPHER === '1' };
const summary = { generatedAt: new Date().toISOString(), env, ok: failed.length === 0, passed: results.filter((r) => r.status === 'pass').length, failed: failed.length, skipped: skipped.length, stages: results };
writeFileSync(join(docs, 'section-8-results.json'), JSON.stringify(summary, null, 2));

const icon = { pass: '✔', fail: '✘', skipped: '·' };
const md = [
  '# القسم 8 — نتائج الاختبار الحقيقية', '',
  `- التاريخ: ${summary.generatedAt}`, `- البيئة: ${env.platform} ${env.release} | Node ${env.node}${env.image ? ' | ' + env.image : ''}`,
  `- النتيجة: **${summary.ok ? 'كل المراحل المنفَّذة نجحت' : 'توجد مراحل فاشلة'}** — ناجحة ${summary.passed} | فاشلة ${summary.failed} | متخطّاة ${summary.skipped}`, '',
  '| المرحلة | الحالة | الزمن | التفاصيل |', '|---|---|---|---|',
  ...results.map((r) => `| ${r.title} | ${icon[r.status]} ${r.status} | ${r.seconds}s | ${r.counts ? `${r.counts.pass}/${r.counts.tests} ناجح، ${r.counts.skipped} متخطّى` : (r.reason || '')} |`), '',
  ...(failed.length ? ['## الأخطاء', ...failed.flatMap((r) => ['', `### ${r.id}`, '```', r.tail, '```'])] : []),
  ...(skipped.length ? ['', '## ملاحظة', 'المراحل المتخطّاة **لم تُنفَّذ** ولا تُعدّ نجاحاً؛ سببها مكتوب في الجدول.'] : []), '',
].join('\n');
writeFileSync(join(docs, 'section-8-report.md'), md);
if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); } catch { /* اختياري */ } }

console.log(`\n══ ناجحة ${summary.passed} | فاشلة ${summary.failed} | متخطّاة ${summary.skipped}`);
for (const r of skipped) console.log(`   · ${r.id}: ${r.reason}`);
for (const r of failed) console.log(`   ✘ ${r.id} (السجل: section8-logs/${r.id}.log)`);
process.exit(failed.length ? 1 : 0);
