// SECURECASEDESK_PHASE10_S8
// اختبار تكاملي (10.8): ترحيل قاعدة قديمة ثم التراجع عنه عبر الحماية، بقواعد SQLite وملفات حقيقية.
// تشغَّل بـ: npm run test:backup-integration  (يتطلب Node >= 22.5). SQLite عادية لا SQLCipher.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RollbackError, runWithRollback, type RollbackDeps, type RollbackFs } from '../src/modules/backup/backup-rollback';
import {
  migrateLegacyDatabase, type LegacyProfile, type MigrationDeps, type MigrationFs, type TargetDb,
} from '../src/modules/backup/legacy-migration';

const sha = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rbFs: RollbackFs & MigrationFs = {
  async ensureDir(p) { fs.mkdirSync(p, { recursive: true }); },
  async exists(p) { return fs.existsSync(p); },
  async size(p) { return fs.existsSync(p) ? fs.statSync(p).size : 0; },
  async copy(a, b) { fs.copyFileSync(a, b); },
  async move(a, b) { fs.rmSync(b, { recursive: true, force: true }); fs.renameSync(a, b); },
  async remove(p) { fs.rmSync(p, { recursive: true, force: true }); },
  async readText(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; },
  async writeText(p, t) { fs.writeFileSync(p, t, 'utf8'); },
  async readHeader(p, n) { const b = Buffer.alloc(n); const fd = fs.openSync(p, 'r'); fs.readSync(fd, b, 0, n, 0); fs.closeSync(fd); return new Uint8Array(b); },
  async sha256File(p) { return sha(p); },
};

let root: string, live: string, legacySrc: string, safety: string;
let liveDb: DatabaseSync | null = null;
const rows = (p: string) => { const d = new DatabaseSync(p); try { return (d.prepare('SELECT COUNT(*) AS c FROM new_cases').get() as { c: number }).c; } finally { d.close(); } };

const profile: LegacyProfile = {
  id: 'it-v1', label: 'اختبار',
  detect: (p) => !!p.tables.old_cases,
  async migrate(ctx) {
    for (const c of await ctx.legacy.getAllAsync<{ id: number; title: string }>('SELECT id, title FROM old_cases')) {
      await ctx.insertOnce('old_cases', c.id, (nid) => ({ sql: 'INSERT INTO new_cases (id, title) VALUES (?, ?)', params: [nid, c.title] }));
    }
  },
};

function openLive() { liveDb = new DatabaseSync(live); }
function closeLive() { liveDb?.close(); liveDb = null; }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-it-'));
  live = path.join(root, 'securecase.db'); legacySrc = path.join(root, 'old.db'); safety = path.join(root, 'pre.db');
  const l = new DatabaseSync(legacySrc);
  l.exec('CREATE TABLE old_cases (id INTEGER PRIMARY KEY, title TEXT)');
  for (let i = 1; i <= 4; i++) l.prepare('INSERT INTO old_cases VALUES (?, ?)').run(i, 'ق' + i);
  l.close();
  openLive();
  liveDb!.exec('CREATE TABLE new_cases (id TEXT PRIMARY KEY, title TEXT)');
  liveDb!.prepare('INSERT INTO new_cases VALUES (?, ?)').run('existing', 'قائمة');
  fs.mkdirSync(path.join(root, 'attachments')); fs.writeFileSync(path.join(root, 'attachments', 'a.enc'), 'ATT');
});
afterEach(() => { closeLive(); fs.rmSync(root, { recursive: true, force: true }); });

function migrationDeps(): MigrationDeps {
  const d = liveDb!;
  const target: TargetDb = {
    async getAllAsync<T>(s: string, p: unknown[] = []) { return d.prepare(s).all(...(p as never[])) as T[]; },
    async getFirstAsync<T>(s: string, p: unknown[] = []) { return (d.prepare(s).get(...(p as never[])) ?? null) as T | null; },
    async execAsync(s) { d.exec(s); },
    async runAsync(s, p = []) { return d.prepare(s).run(...(p as never[])); },
    async transaction(fn) { d.exec('BEGIN'); try { const r = await fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; } },
  };
  return {
    fs: rbFs, target, profiles: [profile], stagingRoot: path.join(root, 'cache'),
    async openLegacy(p) {
      const o = new DatabaseSync(p, { readOnly: true });
      return {
        async getAllAsync<T>(s: string, q: unknown[] = []) { return o.prepare(s).all(...(q as never[])) as T[]; },
        async getFirstAsync<T>(s: string, q: unknown[] = []) { return (o.prepare(s).get(...(q as never[])) ?? null) as T | null; },
        async close() { o.close(); },
      };
    },
    async createSafetyCopy() { fs.copyFileSync(live, safety); return { path: safety, sha256: sha(safety) }; },
    newId: () => randomUUID(), now: () => Date.now(),
  };
}

function rollbackDeps(): RollbackDeps {
  const stash = new Map<string, string | null>();
  return {
    fs: rbFs,
    secrets: { async stash(n) { n.forEach((x) => stash.set(x, 'v')); }, async restore() {}, async clear() { stash.clear(); } },
    journalPath: path.join(root, 'journal.json'), guardRoot: path.join(root, 'guard'),
    newId: () => randomUUID(), now: () => Date.now(),
    async closeDatabase() { closeLive(); }, async reopenDatabase() { openLive(); },
  };
}
const plan = () => ({ operation: 'restore', secretNames: ['db_encryption_key'], targets: [
  { path: live, kind: 'file' as const }, { path: live + '-wal', kind: 'file' as const },
  { path: path.join(root, 'attachments'), kind: 'dir' as const }] });

test('ترحيل ثم التراجع عنه باستعادة نسخة الأمان: القاعدة تعود بايتاً بايت', async () => {
  const report = await migrateLegacyDatabase(migrationDeps(), { sourcePath: legacySrc, actorUserId: 'a', confirm: true });
  assert.equal(report.safetyCopyPath, safety);
  closeLive(); assert.equal(rows(live), 5); openLive();
  const preSha = sha(safety);

  await runWithRollback(rollbackDeps(), plan(), async () => {
    fs.copyFileSync(safety, live); fs.mkdirSync(path.join(root, 'attachments')); fs.writeFileSync(path.join(root, 'attachments', 'a.enc'), 'ATT');
  }, async () => { assert.equal(liveDb!.prepare('SELECT COUNT(*) AS c FROM new_cases').get()!.c, 1); });

  closeLive();
  assert.equal(sha(live), preSha);
  assert.equal(rows(live), 1);
  assert.equal(fs.readFileSync(path.join(root, 'attachments', 'a.enc'), 'utf8'), 'ATT');
});

test('استبدال فاشل التحقق بعد الترحيل: تبقى القاعدة المُرحَّلة كما هي (5 صفوف) والمرفقات سليمة', async () => {
  await migrateLegacyDatabase(migrationDeps(), { sourcePath: legacySrc, actorUserId: 'a', confirm: true });
  closeLive(); const postSha = sha(live); openLive();

  await assert.rejects(runWithRollback(rollbackDeps(), plan(), async () => {
    fs.writeFileSync(live, 'GARBAGE-NOT-A-DB'); fs.mkdirSync(path.join(root, 'attachments'));
  }, async () => { liveDb!.prepare('SELECT COUNT(*) FROM new_cases').get(); }),
  (e) => e instanceof RollbackError && e.code === 'VERIFY_FAILED_ROLLED_BACK');

  closeLive();
  assert.equal(sha(live), postSha);
  assert.equal(rows(live), 5);
  assert.equal(fs.readFileSync(path.join(root, 'attachments', 'a.enc'), 'utf8'), 'ATT');
  assert.deepEqual(fs.readdirSync(path.join(root, 'guard')), []);   // نسخة الأمان نُظّفت بعد الرجوع
});

test('ترحيل فاشل لا يترك أثراً، ثم ترحيل ناجح يعمل على نفس القاعدة', async () => {
  const bad: LegacyProfile = { ...profile, async migrate(ctx) { await profile.migrate(ctx); throw new Error('late'); } };
  await assert.rejects(migrateLegacyDatabase({ ...migrationDeps(), profiles: [bad] }, { sourcePath: legacySrc, actorUserId: 'a', confirm: true }));
  closeLive(); assert.equal(rows(live), 1); openLive();
  await migrateLegacyDatabase(migrationDeps(), { sourcePath: legacySrc, actorUserId: 'a', confirm: true });
  closeLive(); assert.equal(rows(live), 5);
});
