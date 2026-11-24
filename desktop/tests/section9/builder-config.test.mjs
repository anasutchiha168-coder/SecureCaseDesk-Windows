// القسم 9: فحص إعداد التحزيم قبل البناء (بلا شبكة): الاسم/الإصدار/الأيقونة/الأهداف/محتوى الحزمة/حماية البيانات.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(desktop, '..');
const cfg = require(path.join(desktop, 'electron-builder.config.cjs'));
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));

test('الاسم والمعرّف والإصدار متسقة مع المشروع الأصلي', () => {
  assert.equal(cfg.productName, 'SecureCaseDesk');
  assert.equal(pkg.productName, 'SecureCaseDesk');
  assert.equal(cfg.appId, appJson.expo.android.package);
  assert.equal(pkg.version, rootPkg.version);
  assert.equal(cfg.buildVersion, pkg.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test('الأهداف: NSIS وPortable بمعمارية x64 فقط، بأسماء الملفات المطلوبة', () => {
  const t = Object.fromEntries(cfg.win.target.map((x) => [x.target, x.arch]));
  assert.deepEqual(Object.keys(t).sort(), ['nsis', 'portable']);
  assert.deepEqual(t.nsis, ['x64']); assert.deepEqual(t.portable, ['x64']);
  assert.equal(cfg.nsis.artifactName, 'SecureCaseDesk-Setup.${ext}');
  assert.equal(cfg.portable.artifactName, 'SecureCaseDesk-Portable.${ext}');
});

test('الأيقونة PNG حقيقية بمقاس ≥ 256 (تُحوَّل إلى ico)', () => {
  const f = path.join(desktop, cfg.win.icon);
  const b = fs.readFileSync(f);
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(b.readUInt32BE(16) >= 256 && b.readUInt32BE(20) >= 256, 'المقاس أصغر من 256');
});

test('محتوى الحزمة: الواجهة والـ main فقط، ولا src/backup/tests/scripts/docs', () => {
  assert.ok(cfg.files.includes('electron/**/*') && cfg.files.includes('web-dist/**/*'));
  for (const bad of ['src', 'backup', 'tests', 'scripts', 'docs', '.stage']) assert.ok(!cfg.files.some((f) => f.startsWith(bad) && !f.startsWith('!')), 'يجب ألا تُضمَّن: ' + bad);
  assert.equal(pkg.main, 'electron/main.cjs');
  assert.ok(fs.existsSync(path.join(desktop, pkg.main)));
});

test('SQLCipher الأصلية خارج asar ومعاد بناؤها لإصدار Electron', () => {
  assert.equal(cfg.asar, true);
  assert.ok(cfg.asarUnpack.some((p) => p.includes('better-sqlite3-multiple-ciphers')));
  assert.equal(cfg.npmRebuild, true);
  assert.ok(pkg.optionalDependencies['better-sqlite3-multiple-ciphers']);
});

test('أمان المثبّت: بلا صلاحيات مدير، وبيانات القضايا لا تُحذف عند الإزالة', () => {
  assert.equal(cfg.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(cfg.portable.requestExecutionLevel, 'user');
  assert.equal(cfg.nsis.deleteAppDataOnUninstall, false);
  assert.equal(cfg.nsis.perMachine, false);
  assert.equal(cfg.nsis.oneClick, false);
});

test('مجلد البيانات: %APPDATA%\\SecureCaseDesk افتراضياً مع تجاوز SCD_DATA_DIR في main.cjs', () => {
  const m = fs.readFileSync(path.join(desktop, 'electron', 'main.cjs'), 'utf8');
  assert.match(m, /SCD_DATA_DIR/);
  assert.match(m, /app\.setName\('SecureCaseDesk'\)/);
  assert.match(m, /!SMOKE && process\.env\.SCD_DATA_DIR/);
});

test('electron-builder وelectron مصرَّحان في devDependencies وبسكربتات التشغيل', () => {
  assert.ok(pkg.devDependencies.electron, 'electron');
  assert.ok(pkg.devDependencies['electron-builder'], 'electron-builder (شغّل: npm i -D electron-builder)');
  for (const s of ['dist:win', 'dist:dir', 'verify:package', 'verify:installer', 'verify:section9']) assert.ok(pkg.scripts[s], 'سكربت مفقود: ' + s);
});

test('Windows 10/11: إصدار Electron المثبَّت يدعمهما (≥ 23)', () => {
  const v = /(\d+)/.exec(pkg.devDependencies.electron)[1];
  assert.ok(Number(v) >= 23, 'Electron ' + v + ' لا يدعم Windows 10/11 فقط');
});
