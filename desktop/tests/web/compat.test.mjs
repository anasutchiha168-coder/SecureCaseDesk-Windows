import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, classify } from '../../scripts/check-rnweb-compat.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(readFileSync(path.join(desktop, 'shims', 'rn-compat.json'), 'utf8')).names;

test('كل واجهات react-native في src الحقيقي مصنّفة (لا اسم مجهول)', () => {
  const { used, problems, stats } = scanSource(path.join(desktop, '..', 'src'));
  const { unknown } = classify(used, table);
  assert.deepEqual(problems, []);
  assert.deepEqual(unknown, []);
  assert.ok(used.has('Alert') && used.has('I18nManager') && used.has('Share'), 'يجب أن يلتقط الفحص الاستيراد متعدد الأسطر');
  assert.ok(stats.alertCalls >= 100, 'استدعاءات Alert.alert: ' + stats.alertCalls);
});

test('الماسح: متعدد الأسطر وalias وtype وnamespace', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scd-compat-'));
  writeFileSync(path.join(dir, 'a.tsx'), "import {\n  View,\n  Text as T,\n  type ViewStyle,\n  Brand,\n} from 'react-native';\nimport type { TextStyle } from 'react-native';\n");
  writeFileSync(path.join(dir, 'b.tsx'), "import * as RN from 'react-native';\n");
  const { used, problems } = scanSource(dir);
  assert.deepEqual([...used.keys()].sort(), ['Brand', 'Text', 'View']);
  assert.equal(problems.length, 1);
  assert.deepEqual(classify(used, table).unknown, ['Brand']);
});

test('كل shim مذكور في rn-compat موجود فعلاً', async () => {
  const { existsSync } = await import('node:fs');
  for (const [name, e] of Object.entries(table)) if (e.status === 'shim') assert.ok(existsSync(path.join(desktop, 'shims', e.file)), name);
});

test('react-native.tsx يصدّر كل ما صُنّف shim ويضبط RTL ويلفّ الجذر', () => {
  const s = readFileSync(path.join(desktop, 'shims', 'react-native.tsx'), 'utf8');
  for (const [name, e] of Object.entries(table)) if (e.status === 'shim') assert.match(s, new RegExp(`export const ${name}\\b`), name);
  assert.match(s, /export \* from 'react-native-web'/);
  assert.match(s, /setAttribute\('dir', 'rtl'\)/);
  assert.match(s, /registerComponent/);
  assert.match(s, /dir: 'rtl'/);
  assert.match(s, /__SCD_RN_WEB__/);
});

test('لا shim يستورد من src ولا يستعمل Node/require (يعمل داخل الواجهة المعزولة)', () => {
  for (const f of ['react-native.tsx', 'web-alert.ts', 'web-share.ts', 'web-i18n.ts', 'alert-core.ts']) {
    const s = readFileSync(path.join(desktop, 'shims', f), 'utf8');
    assert.ok(!/from\s+['"][./]*\/?src\//.test(s) && !s.includes("'@/"), f + ' يستورد من src');
    assert.ok(!/require\(|node:|process\./.test(s), f + ' يستعمل Node');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(s), f + ' يحقن HTML/eval');
  }
});
