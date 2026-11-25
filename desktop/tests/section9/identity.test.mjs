// بصمة التطبيق: ثبات المعرّف، وأن النسخة الجديدة ستُثبَّت فوق القديمة ولن تُنشئ برنامجاً منفصلاً.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const identity = JSON.parse(fs.readFileSync(path.join(desktop, 'identity.json'), 'utf8'));
const cfg = require(path.join(desktop, 'electron-builder.config.cjs'));

test('البصمة مقفولة: appId واسم المنتج ومجلد البيانات لا تتغير أبداً', () => {
  assert.equal(identity.appId, 'gov.moi.hajjah.securecasedesk');
  assert.equal(identity.productName, 'SecureCaseDesk');
  assert.equal(identity.dataFolderName, 'SecureCaseDesk');
  assert.equal(cfg.appId, identity.appId);
  assert.equal(cfg.productName, identity.productName);
  assert.equal(cfg.nsis.perMachine, identity.installerPerMachine);
});

test('المثبّت لا يُنشئ GUID مخصصاً (يُشتق من appId الثابت) ولا يحذف البيانات', () => {
  assert.equal(cfg.nsis.guid, undefined);
  assert.equal(cfg.nsis.deleteAppDataOnUninstall, false);
});

test('سكربت البصمة والرفع موجودان', () => {
  for (const f of ['scripts/stamp-build.mjs', 'scripts/bump-version.mjs']) assert.ok(fs.existsSync(path.join(desktop, f)), f);
});

test('Android: نفس المعرّف في app.json، وversionCode (إن وُجد) متسق مع الإصدار', () => {
  const app = JSON.parse(fs.readFileSync(path.join(desktop, '..', 'app.json'), 'utf8')).expo;
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  assert.equal(app.android.package, identity.appId);
  assert.equal(app.ios.bundleIdentifier, identity.appId);
  assert.equal(app.version, pkg.version);
  if (app.android.versionCode !== undefined) {
    const [x, y, z] = pkg.version.split('.').map(Number);
    assert.equal(app.android.versionCode, x * 10000 + y * 100 + z);
  }
});
