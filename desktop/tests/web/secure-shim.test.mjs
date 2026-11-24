// يختبر shimَّي expo-secure-store و expo-local-authentication مقابل معالجات Electron الحقيقية عبر جسر وهمي (structuredClone كـ IPC).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register, createRequire } from 'node:module';
register('./_ts-resolve.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const { buildHandlers } = require('../../electron/ipc/handlers.cjs');
const { createSecureService, createAuthService } = require('../../electron/lib/secure-service.cjs');

const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scd-secshim-')), 'secure');
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('E' + s), decryptString: (b) => b.toString().slice(1) };
const handlers = buildHandlers({ app: {}, getWindow: () => null, versions: {}, platform: 'win32', arch: 'x64', secure: createSecureService({ safeStorage, dir }), auth: createAuthService() });
globalThis.window = {
  scd: {
    isDesktop: true, platform: 'win32',
    invoke: async (ch, p) => { const e = handlers.get(ch); try { return structuredClone(await e.run(e.validate(structuredClone(p)))); } catch (err) { throw new Error(`[${err.code || 'INTERNAL'}] ${err.message}`); } },
  },
};
const SS = await import('../../shims/expo-secure-store.ts');
const LA = await import('../../shims/expo-local-authentication.ts');

test('secure-store: set/get/delete كما تستعملها src', async () => {
  assert.equal(await SS.getItemAsync('securecase_session_uid'), null);
  await SS.setItemAsync('securecase_session_uid', 'u-1');
  assert.equal(await SS.getItemAsync('securecase_session_uid'), 'u-1');
  await SS.setItemAsync('securecase_session_uid', 'u-2', { keychainService: 'x', requireAuthentication: true }); // خيارات expo تُتجاهل
  assert.equal(await SS.getItemAsync('securecase_session_uid', { keychainService: 'x' }), 'u-2');
  await SS.deleteItemAsync('securecase_session_uid');
  assert.equal(await SS.getItemAsync('securecase_session_uid'), null);
  await SS.deleteItemAsync('never-existed'); // لا يرمي
});
test('secure-store: أسماء المفاتيح التي تستعملها src كلها مقبولة', async () => {
  for (const k of ['db_encryption_key', 'attachment_master_key_v1', 'securecase_biometric_uid', 'securecase_session_uid']) {
    await SS.setItemAsync(k, 'v'); assert.equal(await SS.getItemAsync(k), 'v');
  }
});
test('secure-store: مفاتيح/قيم غير صالحة ترفض بخطأ DesktopSecureError', async () => {
  for (const k of ['', 'a b', 'a/b', 5, null]) await assert.rejects(() => SS.getItemAsync(k), (e) => e.name === 'DesktopSecureError' && e.code === 'INVALID_PAYLOAD');
  await assert.rejects(() => SS.setItemAsync('k', 5), { code: 'INVALID_PAYLOAD' });
});
test('secure-store: بلا جسر = NO_BRIDGE', async () => {
  const w = globalThis.window; globalThis.window = {};
  await assert.rejects(() => SS.getItemAsync('k'), { code: 'NO_BRIDGE' });
  assert.equal(await SS.isAvailableAsync(), false);
  globalThis.window = w;
});
test('local-authentication: لا عتاد ولا تسجيل ولا نجاح مزوّر', async () => {
  assert.equal(await LA.hasHardwareAsync(), false);
  assert.equal(await LA.isEnrolledAsync(), false);
  assert.deepEqual(await LA.authenticateAsync({ promptMessage: 'x', disableDeviceFallback: true }), { success: false, error: 'not_available' });
});
