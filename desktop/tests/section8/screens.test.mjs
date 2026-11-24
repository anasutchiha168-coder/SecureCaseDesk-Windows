import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = path.join(root, 'src');
const read = (p) => fs.readFileSync(p, 'utf8');
const walk = (d, out = []) => {
  for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p, out) : out.push(p); }
  return out;
};
const EXT = ['', '.ts', '.tsx', '.js', '.json', '/index.ts', '/index.tsx', '/index.js'];
const resolves = (base) => EXT.some((e) => fs.existsSync(base + e) && fs.statSync(base + e).isFile());

const SCREENS = [
  'index', 'setup', 'reports', 'security-check', 'audit-report', 'audit-sync',
  'ai-drafting', 'ai-privacy', 'ai-search', 'ai-settings', 'ai-summary',
  '(tabs)/index', '(tabs)/cases', '(tabs)/detainees', '(tabs)/memos', '(tabs)/users', '(tabs)/audit', '(tabs)/settings',
];

test('كل الشاشات المتوقعة (' + SCREENS.length + ') موجودة', () => {
  for (const s of SCREENS) assert.ok(fs.existsSync(path.join(src, 'app', s + '.tsx')), 'شاشة مفقودة: ' + s);
});

test('لا شاشة جديدة غير مغطاة بهذه القائمة (تنبيه لتحديث الاختبار)', () => {
  const found = walk(path.join(src, 'app')).map((p) => path.relative(path.join(src, 'app'), p).split(path.sep).join('/').replace(/\.tsx$/, ''))
    .filter((p) => !p.endsWith('_layout'));
  const extra = found.filter((f) => !SCREENS.includes(f));
  assert.deepEqual(extra, [], 'شاشات غير مغطاة: ' + extra.join(', '));
});

test('كل شاشة تصدّر مكوّناً افتراضياً', () => {
  for (const s of SCREENS) assert.match(read(path.join(src, 'app', s + '.tsx')), /export\s+default\s/, 'لا export default في ' + s);
});

test('تبويبات (tabs) المعلنة في التخطيط تطابق الملفات', () => {
  const layout = read(path.join(src, 'app', '(tabs)', '_layout.tsx'));
  const declared = [...layout.matchAll(/Tabs\.Screen[\s\S]*?name="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length >= 7, 'عدد التبويبات المعلنة: ' + declared.length);
  for (const d of declared) assert.ok(fs.existsSync(path.join(src, 'app', '(tabs)', d + '.tsx')), 'تبويب بلا ملف: ' + d);
});

test('كل استيراد داخلي (@/ أو نسبي) في src يُحلّ إلى ملف موجود', () => {
  const re = /(?:from|import)\s+['"](@\/[^'"]+|\.{1,2}\/[^'"]*)['"]/g;
  const bad = [];
  for (const f of walk(src).filter((p) => /\.(ts|tsx)$/.test(p))) {
    for (const m of read(f).matchAll(re)) {
      const spec = m[1];
      const base = spec.startsWith('@/') ? path.join(src, spec.slice(2)) : path.resolve(path.dirname(f), spec);
      if (!resolves(base)) bad.push(path.relative(root, f) + ' → ' + spec);
    }
  }
  assert.deepEqual(bad, [], 'استيرادات مكسورة:\n' + bad.join('\n'));
});

test('واجهة عربية: ملفات الشاشات تحوي نصاً عربياً (لم تُفرَّغ)', () => {
  for (const s of SCREENS) {
    assert.match(read(path.join(src, 'app', s + '.tsx')), /[\u0600-\u06FF]/, 'لا نص عربي في ' + s);
  }
});
