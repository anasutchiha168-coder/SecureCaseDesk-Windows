import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ws = require('../../electron/lib/window-state.cjs');
const A = [{ x: 0, y: 0, width: 1920, height: 1040 }];

test('افتراضي عند عدم وجود حالة', () => {
  const s = ws.sanitizeState(null, A);
  assert.deepEqual(s, { width: 1360, height: 860, maximized: false });
});
test('يرفع الأبعاد الصغيرة للحد الأدنى ويقيّد الكبيرة بالشاشة', () => {
  assert.equal(ws.sanitizeState({ width: 100, height: 100 }, A).width, ws.MIN.width);
  assert.equal(ws.sanitizeState({ width: 9000, height: 9000 }, A).width, 1920);
  assert.equal(ws.sanitizeState({ width: 'x', height: NaN }, A).height, 860);
});
test('يُسقط الموضع إن صار خارج كل الشاشات، ويبقيه إن كان داخلها', () => {
  assert.equal(ws.sanitizeState({ x: 5000, y: 5000, width: 1200, height: 800 }, A).x, undefined);
  assert.deepEqual([ws.sanitizeState({ x: 100, y: 50, width: 1200, height: 800 }, A).x, ws.sanitizeState({ x: 100, y: 50, width: 1200, height: 800 }, A).y], [100, 50]);
  const two = [...A, { x: 1920, y: 0, width: 1920, height: 1040 }];
  assert.equal(ws.sanitizeState({ x: 2000, y: 10, width: 1200, height: 800 }, two).x, 2000);
});
test('loadState يتحمل ملفاً تالفاً', () => {
  const bad = { readFileSync: () => '{not json' };
  assert.equal(ws.loadState('x', A, bad).width, 1360);
});
test('saveState لا يرمي عند فشل الكتابة', () => {
  const bad = { mkdirSync: () => { throw new Error('EACCES'); }, writeFileSync: () => {} };
  assert.doesNotThrow(() => ws.saveState('C:/x/y.json', { width: 1 }, bad));
});
