// SECURECASEDESK_PHASE12_S3
// اختبارات 12.3 — فحص ثابت لشيفرة الواجهة: RTL والخطوط واللغة. تشغَّل بـ: npm run test:rtl
// حدود صادقة: فحص نصي لملفات .tsx فقط. الشكل الفعلي على الشاشة يُثبت بالبنود D21–D25 على الجهاز.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(path.join(ROOT, 'src/app')).concat(walk(path.join(ROOT, 'src/components')));
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');
const read = (f: string) => fs.readFileSync(f, 'utf8');
const layout = read(path.join(ROOT, 'src/app/_layout.tsx'));
const ADAPTIVE = "I18nManager.isRTL ? 'row' : 'row-reverse'";

describe('إعداد RTL على مستوى التطبيق', () => {
  test('_layout يفعّل allowRTL وforceRTL', () => {
    assert.match(layout, /I18nManager\.allowRTL\(true\)/); assert.match(layout, /I18nManager\.forceRTL\(true\)/);
  });
  test('app.json: الواجهة داكنة ولا يعطّل supportsRtl', () => {
    const app = JSON.parse(read(path.join(ROOT, 'app.json'))).expo;
    assert.equal(app.userInterfaceStyle, 'dark');
    assert.notEqual(app.android?.supportsRtl, false);
  });
  test('إعادة تحميل التطبيق بعد أول forceRTL على جهاز غير عربي', () => {
    assert.match(layout, /reloadAsync|RNRestart|DevSettings\.reload/);
  });
});

describe('الخطوط', () => {
  test('كل fontFamily حرفي هو خط Cairo محمَّل في _layout', () => {
    const loaded = new Set([...layout.matchAll(/\b(Cairo_\d+[A-Za-z]+)\b/g)].map((m) => m[1]));
    assert.ok(loaded.size >= 3);
    for (const f of files) for (const m of read(f).matchAll(/fontFamily:\s*'([^']+)'/g)) assert.ok(loaded.has(m[1]), rel(f) + ' يستخدم خطاً غير محمَّل: ' + m[1]);
  });
  test('أسماء الخطوط في theme.ts كلها محمَّلة', () => {
    const loaded = new Set([...layout.matchAll(/\b(Cairo_\d+[A-Za-z]+)\b/g)].map((m) => m[1]));
    const theme = read(path.join(ROOT, 'src/constants/theme.ts'));
    const block = /export const Fonts = \{([\s\S]*?)\}/.exec(theme)?.[1] ?? '';
    const names = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(names.length >= 3);
    for (const n of names) assert.ok(loaded.has(n), 'Fonts.* يشير لخط غير محمَّل: ' + n);
  });
});

describe('اتجاه الصفوف', () => {
  test('ثوابت ROW كلها بالنمط المتكيّف نفسه', () => {
    for (const f of files) for (const m of read(f).matchAll(/const ROW[^=]*=\s*([^;]+);/g)) assert.equal(m[1].trim(), ADAPTIVE, rel(f));
  });
  // خط أساس: الاستخدام المباشر لـ row-reverse خارج نمط ROW. لا يُسمح بزيادته (يمنع التفاقم).
  const BASELINE: Record<string, number> = {
    'src/app/audit-report.tsx': 4, 'src/app/audit-sync.tsx': 3,
  };
  const counts: Record<string, number> = {};
  for (const f of files) {
    const src = read(f).replace(/'row' \| 'row-reverse'/g, '').split(ADAPTIVE).join('');
    const n = (src.match(/row-reverse/g) ?? []).length;
    if (n) counts[rel(f)] = n;
  }
  test('لا ملف جديد يستخدم row-reverse مباشرة، ولا زيادة في الملفات المعروفة', (t) => {
    t.diagnostic('الاستخدام المباشر الحالي: ' + JSON.stringify(counts));
    for (const [f, n] of Object.entries(counts)) assert.ok(n <= (BASELINE[f] ?? 0), f + ': ' + n + ' استخدامات مباشرة (المسموح ' + (BASELINE[f] ?? 0) + ')');
  });
  test('الملفات المعروفة لم تُصلَح دون تحديث خط الأساس', () => {
    for (const [f, n] of Object.entries(BASELINE)) assert.equal(counts[f] ?? 0, n, f + ': تغيّر العدد — حدّث BASELINE');
  });
  test('إصلاح كامل: لا استخدام مباشر لـ row-reverse', { todo: 'فجوة معروفة G3: ' + Object.values(counts).reduce((a, b) => a + b, 0) + ' استخدامات في ' + Object.keys(counts).length + ' ملفات — البند D22' }, () => {
    assert.deepEqual(counts, {});
  });
});

describe('اللغة: واجهة عربية فقط', () => {
  const ALLOWED = /^(PDF|Word|DOCX|HTTPS|SHA|HMAC|AES|SQLCipher|SecureCaseDesk|Admin|API|AI|ID|URL|YYYY|MM|DD|UTC|APK|RTL|QR)$/i;
  test('نصوص JSX الظاهرة لا تحوي كلمات لاتينية غير الاختصارات المعتمدة', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/(?<![=\-])>([^<>{}=;()]*[\u0600-\u06FF][^<>{}=;()]*)<\//g)) {
        for (const w of m[1].match(/[A-Za-z]{2,}/g) ?? []) if (!ALLOWED.test(w)) bad.push(rel(f) + ': ' + w);
      }
    }
    assert.deepEqual(bad, []);
  });
  test('عناوين الشاشات (title / headerTitle) عربية', () => {
    for (const f of files) for (const m of read(f).matchAll(/(?:title|headerTitle)\s*[:=]\s*['"]([^'"]+)['"]/g)) {
      if (/^[\x00-\x7F]*$/.test(m[1]) && !/^(\s*|[\d\W]+)$/.test(m[1]) && !/^[a-z]+$/.test(m[1])) assert.fail(rel(f) + ': ' + m[1]);
    }
  });
});
