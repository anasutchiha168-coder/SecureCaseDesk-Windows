// توافق سلوك أندرويد: المفاتيح الأجنبية معطّلة افتراضياً (الصف اليتيم يُقبل ويُكتشف بـ foreign_key_check).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createDbService } = require('../../electron/lib/db-service.cjs');
const { createFsService } = require('../../electron/lib/fs-service.cjs');
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* غير متاح */ }
const opts = { skip: !DatabaseSync && 'node:sqlite غير متاح' };
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-par-'));
const files = createFsService({ documentRoot: path.join(base, 'documents'), cacheRoot: path.join(base, 'cache') });
files.ensureRoots();
const driver = DatabaseSync && { available: false, allowPlaintextForTests: true, cipher: null, open: (f) => new DatabaseSync(f) };

test('foreign_keys معطّلة كما في أندرويد: صف يتيم يُقبل ويكشفه foreign_key_check', opts, () => {
  const s = createDbService({ files, driver });
  const { handle } = s.open({ name: 'fk.db' });
  s.exec({ handle, sql: 'CREATE TABLE p(id TEXT PRIMARY KEY); CREATE TABLE c(id TEXT PRIMARY KEY, pid TEXT REFERENCES p(id));' });
  s.run({ handle, sql: 'INSERT INTO c VALUES (?,?)', params: ['1', 'missing'] });
  assert.equal(s.all({ handle, sql: 'PRAGMA foreign_key_check', params: [] }).length, 1);
  assert.equal(s.first({ handle, sql: 'PRAGMA foreign_keys', params: [] }).foreign_keys, 0);
  s.close({ handle });
});
