import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const { CHANNELS, EVENTS } = require('../../electron/channels.cjs');
const re = /'(scd:[a-z-]+:[a-z-]+)'/g;
const set = (s) => [...new Set([...s.matchAll(re)].map((m) => m[1]))].filter((c) => !c.startsWith('scd:event:')).sort();

test('القنوات: channels.cjs = preload.cjs = bridge-contract.ts', () => {
  const pre = read('electron/preload.cjs');
  const block = pre.slice(pre.indexOf('// <CHANNELS>'), pre.indexOf('// </CHANNELS>'));
  const expected = Object.keys(CHANNELS).sort();
  assert.deepEqual(set(block), expected, 'preload.cjs');
  assert.deepEqual(set(read('shims/bridge-contract.ts')), expected, 'bridge-contract.ts');
});

test('الأحداث: channels.cjs = preload = العقد', () => {
  assert.ok(read('electron/preload.cjs').includes(`new Set(['${EVENTS.join("', '")}'])`));
  assert.ok(read('shims/bridge-contract.ts').includes(EVENTS[0]));
});

test('أمان main.cjs: الإعدادات الإلزامية موجودة وغير الآمنة غائبة', () => {
  const m = read('electron/main.cjs');
  for (const must of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webSecurity: true',
    'allowRunningInsecureContent: false', 'webviewTag: false', 'setPermissionRequestHandler', 'setWindowOpenHandler',
    'will-navigate', 'will-attach-webview', 'requestSingleInstanceLock']) assert.ok(m.includes(must), must);
  for (const bad of ['nodeIntegration: true', 'contextIsolation: false', 'sandbox: false', 'webSecurity: false',
    'allowRunningInsecureContent: true', 'enableRemoteModule', "require('@electron/remote')", 'bypassCSP', 'loadFile(']) {
    assert.ok(!m.includes(bad), 'ممنوع: ' + bad);
  }
});

test('preload: لا يستورد غير electron ولا يكشف ipcRenderer', () => {
  const p = read('electron/preload.cjs');
  const reqs = [...p.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(reqs, ['electron']);
  const exposed = p.slice(p.indexOf('exposeInMainWorld'));
  assert.ok(!/ipcRenderer|shell|process\.env/.test(exposed.replace("platform: process.platform", '')));
});

test('shim expo-updates ينفّذ reloadAsync عبر القناة المثبّتة', () => {
  const s = read('shims/expo-updates.ts');
  assert.ok(s.includes('SCD_CHANNELS.app.reload'));
  assert.ok(!s.includes('notImplemented'));
});
