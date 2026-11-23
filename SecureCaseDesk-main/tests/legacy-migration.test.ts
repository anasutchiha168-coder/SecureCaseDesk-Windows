// SECURECASEDESK_PHASE10_S7
// اختبارات محرك ترحيل القواعد القديمة (10.7). تشغَّل بـ: npm run test:legacy-migration
// تستخدم SQLite حقيقية عبر node:sqlite (غير مشفرة) وملفات وبصمات حقيقية. المخطط القديم هنا مخطط اختبار
// مصطنع لاختبار المحرك فقط، وليس مخطط قاعدتك القديمة الفعلية.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LegacyMigrationError, inspectLegacyDatabase, migrateLegacyDatabase,
  type LegacyDb, type LegacyProfile, type MigrationDeps, type MigrationFs, type TargetDb,
} from '../src/modules/backup/legacy-migration';

const nodeFs: MigrationFs = {
  async exists(p) { return fs.existsSync(p); },
  async size(p) { return fs.existsSync(p) ? fs.statSync(p).size : 0; },
  async ensureDir(p) { fs.mkdirSync(p, { recursive: true }); },
  async copy(a, b) { fs.copyFileSync(a, b); },
  async remove(p) { fs.rmSync(p, { recursive: true, force: true }); },
  async readHeader(p, n) { const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, 0); fs.closeSync(fd); return new Uint8Array(b); },
  async sha256File(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); },
};

function wrap(db: DatabaseSync) {
  return {
    async getAllAsync<T>(sql: string, params: unknown[] = []) { return db.prepare(sql).all(...(params as never[])) as T[]; },
    async getFirstAsync<T>(sql: string, params: unknown[] = []) { return (db.prepare(sql).get(...(params as never[])) ?? null) as T | null; },
    async execAsync(sql: string) { db.exec(sql); },
    async runAsync(sql: string, params: unknown[] = []) { return db.prepare(sql).run(...(params as never[])); },
  };
}

// ملف قاعدة قديمة مصطنع: جدولان (أب/ابن) بمفتاح أجنبي
function makeLegacy(file: string, opts: { userVersion?: number; rows?: number; orphanChild?: boolean } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${opts.userVersion ?? 7};
    CREATE TABLE old_cases (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE old_notes (id INTEGER PRIMARY KEY, case_id INTEGER, body TEXT);`);
  const n = opts.rows ?? 3;
  for (let i = 1; i <= n; i++) {
    db.prepare('INSERT INTO old_cases (id, title) VALUES (?, ?)').run(i, 'قضية ' + i);
    db.prepare('INSERT INTO old_notes (id, case_id, body) VALUES (?, ?, ?)').run(i, i, 'ملاحظة ' + i);
  }
  if (opts.orphanChild) db.prepare('INSERT INTO old_notes (id, case_id, body) VALUES (99, 12345, ?)').run('يتيمة');
  db.close();
}

const testProfile: LegacyProfile = {
  id: 'test-legacy-v7', label: 'إصدار اختبار',
  detect: (p) => p.userVersion === 7 && !!p.tables.old_cases && p.tables.old_notes?.includes('case_id') === true,
  async migrate(ctx) {
    for (const c of await ctx.legacy.getAllAsync<{ id: number; title: string }>('SELECT id, title FROM old_cases ORDER BY id')) {
      await ctx.insertOnce('old_cases', c.id, (nid) => ({
        sql: 'INSERT INTO new_cases (id, title, created_by) VALUES (?, ?, ?)', params: [nid, c.title, ctx.actorUserId] }));
    }
    for (const n of await ctx.legacy.getAllAsync<{ id: number; case_id: number; body: string }>('SELECT id, case_id, body FROM old_notes ORDER BY id')) {
      const parent = await ctx.resolveId('old_cases', n.case_id);
      if (!parent) throw new Error('ORPHAN_NOTE:' + n.id);
      await ctx.insertOnce('old_notes', n.id, (nid) => ({
        sql: 'INSERT INTO new_notes (id, case_id, body) VALUES (?, ?, ?)', params: [nid, parent, n.body] }));
    }
  },
};

let root: string;
let src: string;
let targetDb: DatabaseSync;
let deps: MigrationDeps;
let safetyCalls = 0;

const count = (t: string) => (targetDb.prepare('SELECT COUNT(*) AS c FROM ' + t).get() as { c: number }).c;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-lm-'));
  src = path.join(root, 'old.db');
  makeLegacy(src);
  targetDb = new DatabaseSync(path.join(root, 'target.db'));
  targetDb.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE new_cases (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_by TEXT NOT NULL);
    CREATE TABLE new_notes (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES new_cases(id), body TEXT);`);
  const w = wrap(targetDb);
  const target: TargetDb = {
    ...w,
    async transaction(fn) {
      targetDb.exec('BEGIN');
      try { const r = await fn(); targetDb.exec('COMMIT'); return r; }
      catch (e) { targetDb.exec('ROLLBACK'); throw e; }
    },
  };
  safetyCalls = 0;
  deps = {
    fs: nodeFs, target, profiles: [testProfile],
    stagingRoot: path.join(root, 'cache'),
    async openLegacy(p) {
      const d = new DatabaseSync(p, { readOnly: true });
      const ww = wrap(d);
      const l: LegacyDb = { getAllAsync: ww.getAllAsync, getFirstAsync: ww.getFirstAsync, async close() { d.close(); } };
      return l;
    },
    async createSafetyCopy() { safetyCalls++; return { path: path.join(root, 'safety.db'), sha256: 'x' }; },
    newId: () => randomUUID(), now: () => Date.now(),
  };
});
afterEach(() => { try { targetDb.close(); } catch { /* */ } fs.rmSync(root, { recursive: true, force: true }); });

const ok = { actorUserId: 'admin-1', confirm: true };
const codeIs = (c: string) => (e: unknown) => e instanceof LegacyMigrationError && e.code === c;

describe('10.7 ترحيل القواعد القديمة', () => {
  test('معاينة: تكتشف الإصدار والجداول ولا تكتب بيانات ولا تغيّر الأصل', async () => {
    const before = fs.readFileSync(src);
    const r = await inspectLegacyDatabase(deps, src);
    assert.equal(r.matchedProfile?.id, 'test-legacy-v7');
    assert.equal(r.userVersion, 7);
    assert.deepEqual(r.tables.old_cases, ['id', 'title']);
    assert.equal(r.alreadyMigrated, false);
    assert.equal(r.plaintext, true);
    assert.equal(count('new_cases'), 0);
    assert.ok(before.equals(fs.readFileSync(src)));
    assert.equal(fs.existsSync(path.join(root, 'cache', 'legacy-staging', fs.readdirSync(path.join(root, 'cache', 'legacy-staging'))[0] ?? 'x')), false);
  });

  test('ترحيل كامل: الصفوف والمفاتيح الأجنبية والسجل والعدّادات', async () => {
    const r = await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    assert.equal(count('new_cases'), 3);
    assert.equal(count('new_notes'), 3);
    assert.deepEqual(r.counts.old_cases, { inserted: 3, skipped: 0 });
    assert.equal(count('legacy_id_map'), 6);
    const log = targetDb.prepare('SELECT * FROM legacy_migrations').all() as Array<Record<string, unknown>>;
    assert.equal(log.length, 1);
    assert.equal(log[0].status, 'completed');
    assert.equal(log[0].source_sha256, r.sourceSha256);
    assert.equal(r.targetForeignKeyViolationsAfter, 0);
    assert.equal(safetyCalls, 1);
  });

  test('الملف الأصلي لا يتغير بايتاً بايت', async () => {
    const before = createHash('sha256').update(fs.readFileSync(src)).digest('hex');
    await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    assert.equal(createHash('sha256').update(fs.readFileSync(src)).digest('hex'), before);
  });

  test('منع التكرار: نفس الملف مرة ثانية = ALREADY_MIGRATED بلا صفوف إضافية', async () => {
    await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: src, ...ok }), codeIs('ALREADY_MIGRATED'));
    assert.equal(count('new_cases'), 3);
    assert.equal((await inspectLegacyDatabase(deps, src)).alreadyMigrated, true);
  });

  test('منع تكرار الصفوف: نسخة أحدث من نفس القاعدة تضيف الجديد فقط', async () => {
    await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    const src2 = path.join(root, 'old2.db');
    makeLegacy(src2, { rows: 5 });
    const r = await migrateLegacyDatabase(deps, { sourcePath: src2, ...ok });
    assert.equal(count('new_cases'), 5);
    assert.deepEqual(r.counts.old_cases, { inserted: 2, skipped: 3 });
  });

  test('فشل في منتصف الترحيل: ROLLBACK كامل ولا صف جزئي، وتُسجَّل محاولة فاشلة', async () => {
    const bad: LegacyProfile = { ...testProfile, async migrate(ctx) {
      await testProfile.migrate(ctx);
      throw new Error('late-failure');
    } };
    await assert.rejects(migrateLegacyDatabase({ ...deps, profiles: [bad] }, { sourcePath: src, ...ok }), codeIs('MIGRATION_FAILED'));
    assert.equal(count('new_cases'), 0);
    assert.equal(count('new_notes'), 0);
    assert.equal(count('legacy_id_map'), 0);
    const log = targetDb.prepare('SELECT status, error_code FROM legacy_migrations').all() as Array<{ status: string; error_code: string }>;
    assert.deepEqual(log.map((x) => ({ ...x })), [{ status: 'failed', error_code: 'MIGRATION_FAILED' }]);
    // بعد فشل يمكن إعادة المحاولة بنجاح (الفاشلة لا تمنع)
    await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    assert.equal(count('new_cases'), 3);
  });

  test('صف يتيم في القديمة يُوقف الترحيل كاملاً ولا يُرحَّل نصفه', async () => {
    const src3 = path.join(root, 'orphan.db');
    makeLegacy(src3, { orphanChild: true });
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: src3, ...ok }), codeIs('MIGRATION_FAILED'));
    assert.equal(count('new_cases'), 0);
  });

  test('مخالفات مفاتيح أجنبية جديدة في الهدف تُلغي الترحيل (POST_CHECK_FAILED)', async () => {
    targetDb.exec('PRAGMA foreign_keys = OFF');   // يحاكي هدفاً لا يفرض المفاتيح؛ التحقق بعد الترحيل شبكة أمان
    const sneaky: LegacyProfile = { ...testProfile, async migrate(ctx) {
      await ctx.insertOnce('old_notes', 1, (nid) => ({ sql: 'INSERT INTO new_notes (id, case_id, body) VALUES (?, ?, ?)', params: [nid, 'no-such-parent', 'x'] }));
    } };
    await assert.rejects(migrateLegacyDatabase({ ...deps, profiles: [sneaky] }, { sourcePath: src, ...ok }), codeIs('POST_CHECK_FAILED'));
    assert.equal(count('new_notes'), 0);
    assert.equal(count('legacy_id_map'), 0);
  });

  test('إصدار غير معروف / بلا profile: UNSUPPORTED ولا كتابة', async () => {
    await assert.rejects(migrateLegacyDatabase({ ...deps, profiles: [] }, { sourcePath: src, ...ok }), codeIs('UNSUPPORTED_LEGACY_VERSION'));
    const src4 = path.join(root, 'v9.db'); makeLegacy(src4, { userVersion: 9 });
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: src4, ...ok }), codeIs('UNSUPPORTED_LEGACY_VERSION'));
    assert.equal(count('new_cases'), 0);
    assert.equal(safetyCalls, 0);
    const insp = await inspectLegacyDatabase({ ...deps, profiles: [] }, src);
    assert.equal(insp.matchedProfile, null);          // المعاينة تعرض البنية لكتابة profile
    assert.ok(insp.tables.old_cases);
  });

  test('إصداران يطابقان معاً = AMBIGUOUS', async () => {
    await assert.rejects(
      migrateLegacyDatabase({ ...deps, profiles: [testProfile, { ...testProfile, id: 'other' }] }, { sourcePath: src, ...ok }),
      codeIs('AMBIGUOUS_LEGACY_VERSION'));
  });

  test('بلا تأكيد صريح لا يحدث شيء', async () => {
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: src, actorUserId: 'a', confirm: false as unknown as true }), codeIs('CONFIRMATION_REQUIRED'));
    assert.equal(safetyCalls, 0);
  });

  test('ملف مفقود / فارغ / ليس SQLite', async () => {
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: path.join(root, 'nope.db'), ...ok }), codeIs('LEGACY_FILE_MISSING'));
    const empty = path.join(root, 'empty.db'); fs.writeFileSync(empty, '');
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: empty, ...ok }), codeIs('LEGACY_FILE_MISSING'));
    const junk = path.join(root, 'junk.db'); fs.writeFileSync(junk, Buffer.alloc(4096, 7));
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: junk, ...ok }), codeIs('LEGACY_NOT_SQLITE'));
  });

  test('ملف مشفر بمفتاح خاطئ: LEGACY_OPEN_FAILED وتنظيف المجلد المؤقت', async () => {
    const junk = path.join(root, 'enc.db'); fs.writeFileSync(junk, Buffer.alloc(4096, 9));
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: junk, key: 'wrong', ...ok }), codeIs('LEGACY_OPEN_FAILED'));
    const stage = path.join(root, 'cache', 'legacy-staging');
    assert.deepEqual(fs.existsSync(stage) ? fs.readdirSync(stage) : [], []);
  });

  test('فشل نسخة الأمان يمنع الترحيل قبل أي كتابة', async () => {
    await assert.rejects(
      migrateLegacyDatabase({ ...deps, async createSafetyCopy() { throw new Error('disk'); } }, { sourcePath: src, ...ok }),
      codeIs('SAFETY_COPY_FAILED'));
    assert.equal(count('new_cases'), 0);
  });

  test('تغيّر الملف الأصلي أثناء الترحيل يُلغي العملية (SOURCE_CHANGED)', async () => {
    const mutating: LegacyProfile = { ...testProfile, async migrate(ctx) {
      await testProfile.migrate(ctx);
      fs.appendFileSync(src, 'tamper');
    } };
    await assert.rejects(migrateLegacyDatabase({ ...deps, profiles: [mutating] }, { sourcePath: src, ...ok }), codeIs('SOURCE_CHANGED'));
    assert.equal(count('new_cases'), 0);
  });

  test('سجل الترحيل وخريطة المعرّفات لا يقبلان التعديل ولا الحذف', async () => {
    await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    for (const sql of [
      `UPDATE legacy_migrations SET status = 'failed'`, 'DELETE FROM legacy_migrations',
      `UPDATE legacy_id_map SET new_id = 'x'`, 'DELETE FROM legacy_id_map',
    ]) assert.throws(() => targetDb.exec(sql), /ممنوع/);
  });

  test('عمليتان متزامنتان: الثانية MIGRATION_IN_PROGRESS', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow: LegacyProfile = { ...testProfile, async migrate(ctx) { await gate; await testProfile.migrate(ctx); } };
    const p1 = migrateLegacyDatabase({ ...deps, profiles: [slow] }, { sourcePath: src, ...ok });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: src, ...ok }), codeIs('MIGRATION_IN_PROGRESS'));
    release(); await p1;
  });
});
