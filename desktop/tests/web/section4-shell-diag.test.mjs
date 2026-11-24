import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pointRouterImportToShim, ROUTER_LAYOUT_FILES } from '../../scripts/lib/stage.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(path.join(desktop, f), 'utf8');
const core = await import(pathToFileURL(path.join(desktop, 'shims', 'desktop-layout-core.ts')).href);

test('scdDiag: يعدّ ويسجّل القيم دون رمي أخطاء', () => {
  const g = {};
  core.scdDiag('hostRender', undefined, g); core.scdDiag('hostRender', undefined, g);
  core.scdDiag('refKind', 'dom', g);
  assert.equal(g.__SCD_DESKTOP__.diag.hostRender, 2);
  assert.equal(g.__SCD_DESKTOP__.diag.refKind, 'dom');
  assert.equal(g.__SCD_DESKTOP__.section, 4);
  assert.doesNotThrow(() => core.scdDiag('x', 1, null));
});

test('pointRouterImportToShim: يوجّه expo-router فقط، بعمق صحيح، ولا يمسّ المسارات الفرعية', () => {
  const a = pointRouterImportToShim("import { Stack } from 'expo-router';\nimport x from 'expo-router/entry';", 'src/app/_layout.tsx');
  assert.equal(a.count, 1);
  assert.match(a.source, /from '\.\.\/\.\.\/scd-shims\/expo-router'/);
  assert.match(a.source, /'expo-router\/entry'/);
  const b = pointRouterImportToShim('import { Tabs, Redirect } from "expo-router";', 'src/app/(tabs)/_layout.tsx');
  assert.equal(b.spec, '../../../scd-shims/expo-router');
  assert.equal(pointRouterImportToShim('const a = 1;', 'src/app/_layout.tsx').count, 0);
  assert.deepEqual(ROUTER_LAYOUT_FILES, ['src/app/_layout.tsx', 'src/app/(tabs)/_layout.tsx']);
});

test('الغلاف: وسم DOM عبر ref مع id احتياطي، والفحص الدخاني يطبع التشخيص', () => {
  const s = read('shims/desktop-shell.tsx');
  assert.match(s, /id=\{SHELL_DOM_ID\}/);
  assert.match(s, /document\.getElementById\(SHELL_DOM_ID\)/);
  assert.match(s, /scdDiag\('boundaryError'/);
  assert.match(read('shims/expo-router.tsx'), /scdDiag\('stackRender'\)/);
  assert.match(read('electron/smoke/web-probe.js'), /diag=' \+ JSON\.stringify\(dk && dk\.diag\)/);
});
