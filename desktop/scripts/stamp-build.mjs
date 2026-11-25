// يولّد electron/build-info.json: بصمة هذا البناء (اسم، إصدار، commit، وقت البناء، رقم التشغيل).
// يُستدعى تلقائياً من dist-win.mjs. يظهر الناتج في scd:app:info (حقل build).
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const identity = JSON.parse(readFileSync(join(desktop, 'identity.json'), 'utf8'));
const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: desktop, encoding: 'utf8' });
const info = {
  appId: identity.appId,
  version: pkg.version,
  commit: process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : (git.status === 0 ? git.stdout.trim() : 'unknown'),
  run: process.env.GITHUB_RUN_NUMBER || null,
  builtAt: new Date().toISOString(),
};
writeFileSync(join(desktop, 'electron', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log('✔ build-info:', JSON.stringify(info));
