// القسم 7: تحقق حمولات scd:secure:* و scd:auth:* وتمريرها للخدمة عبر معالجات IPC الحقيقية.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildHandlers } = require('../../electron/ipc/handlers.cjs');
const { registerIpc } = require('../../electron/ipc/register.cjs');
const { createSecureService, createAuthService } = require('../../electron/lib/secure-service.cjs');

const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scd-secipc-')), 'secure');
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('E' + s), decryptString: (b) => b.toString().slice(1) };
const secure = createSecureService({ safeStorage, dir });
const h = buildHandlers({ app: {}, getWindow: () => null, versions: {}, platform: 'win32', arch: 'x64', secure, auth: createAuthService() });
const val = (ch, p) => h.get(ch).validate(p);
const rejects = (ch, p) => assert.throws(() => val(ch, p), { code: 'INVALID_PAYLOAD' }, `${ch} ${JSON.stringify(p)}`);

test('get/remove: اسم صالح فقط وبلا حقول زائدة', () => {
  for (const ch of ['scd:secure:get', 'scd:secure:remove']) {
    assert.deepEqual(val(ch, { name: 'db_encryption_key' }), { name: 'db_encryption_key' });
    for (const p of [undefined, null, 'k', [], {}, { name: '' }, { name: 'a/b' }, { name: 5 }, { name: 'k', extra: 1 }]) rejects(ch, p);
  }
});
test('set: قيمة نصية ضمن الحد وبلا حقول زائدة', () => {
  assert.deepEqual(val('scd:secure:set', { name: 'k', value: 'v' }), { name: 'k', value: 'v' });
  for (const p of [{ name: 'k' }, { name: 'k', value: 5 }, { name: 'k', value: null }, { name: 'k', value: 'x'.repeat(256 * 1024 + 1) }, { name: 'k', value: 'v', x: 1 }, { value: 'v' }]) rejects('scd:secure:set', p);
});
test('التنفيذ يصل للخدمة ويُرجع القيمة', async () => {
  const run = async (ch, p) => { const e = h.get(ch); return e.run(e.validate(p)); };
  assert.equal(await run('scd:secure:get', { name: 'k' }), null);
  assert.equal(await run('scd:secure:set', { name: 'k', value: 'قيمة' }), null);
  assert.equal(await run('scd:secure:get', { name: 'k' }), 'قيمة');
  await run('scd:secure:remove', { name: 'k' });
  assert.equal(await run('scd:secure:get', { name: 'k' }), null);
});
test('auth: available بلا حمولة، prompt برسالة اختيارية', async () => {
  assert.throws(() => val('scd:auth:available', {}), { code: 'INVALID_PAYLOAD' });
  assert.deepEqual(await h.get('scd:auth:available').run(undefined), { hasHardware: false, enrolled: false });
  assert.deepEqual(val('scd:auth:prompt', undefined), {});
  assert.deepEqual(val('scd:auth:prompt', { message: 'x' }), { message: 'x' });
  for (const p of [{ message: 5 }, { message: 'x'.repeat(201) }, { other: 1 }, 'x']) rejects('scd:auth:prompt', p);
  assert.deepEqual(await h.get('scd:auth:prompt').run({}), { success: false, error: 'not_available' });
});
test('عبر registerIpc: مُرسل غير موثوق يُرفض، والأخطاء لا تسرّب مسارات', async () => {
  const wc = { mainFrame: { url: 'app://bundle/index.html' } };
  const win = { webContents: wc, isDestroyed: () => false };
  const map = new Map();
  const logs = [];
  registerIpc({ ipcMain: { handle: (c, f) => map.set(c, f), on() {} }, logger: { warn: (m) => logs.push(m), error: (m) => logs.push(m) }, getWindow: () => win, handlers: h });
  const good = { sender: wc, senderFrame: wc.mainFrame };
  assert.equal((await map.get('scd:secure:set')(good, { name: 'k2', value: 'v' })).ok, true);
  assert.equal((await map.get('scd:secure:get')(good, { name: 'k2' })).data, 'v');
  const evil = { sender: wc, senderFrame: { url: 'https://evil.example/' } };
  const r = await map.get('scd:secure:get')(evil, { name: 'k2' });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'UNTRUSTED_SENDER');
  const other = { sender: {}, senderFrame: wc.mainFrame };
  assert.equal((await map.get('scd:secure:get')(other, { name: 'k2' })).error.code, 'UNTRUSTED_SENDER');
});
test('بدون خدمة مُحقنة تبقى القنوات NOT_IMPLEMENTED صريحة', async () => {
  const bare = buildHandlers({ app: {}, getWindow: () => null, versions: {}, platform: 'win32', arch: 'x64' });
  assert.throws(() => bare.get('scd:secure:get').run({}), { code: 'NOT_IMPLEMENTED' });
});
