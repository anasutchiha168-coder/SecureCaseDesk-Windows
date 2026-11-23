// SECURECASEDESK_PHASE10_S2
// اختبارات المرحلة 10 / القسم 10.2 — لقطة قاعدة البيانات. تشغَّل بـ: npm run test:backup-snapshot
// تستخدم ملفات حقيقية على القرص (node:fs) وبصمات SHA-256 حقيقية؛ قاعدة البيانات مزيفة لأن SQLCipher غير متاح في Node.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatabaseSnapshot, discardDatabaseSnapshot, type SnapshotDeps, type SnapshotFs,
} from '../src/modules/backup/backup-snapshot';
import {
  BackupError, SNAPSHOT_DB_FILE_NAME, SNAPSHOT_MANIFEST_FILE_NAME, type SnapshotManifest,
} from '../src/modules/backup/backup-types';

const nodeFs: SnapshotFs = {
  async ensureDir(p) { fs.mkdirSync(p, { recursive: true }); },
  async exists(p) { return fs.existsSync(p); },
  async size(p) { return fs.existsSync(p) ? fs.statSync(p).size : 0; },
  async copy(a, b) { fs.copyFileSync(a, b); },
  async move(a, b) { fs.renameSync(a, b); },
  async remove(p) { fs.rmSync(p, { recursive: true, force: true }); },
  async writeText(p, t) { fs.writeFileSync(p, t, 'utf8'); },
  async sha256File(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); },
};

class FakeDb {
  journalMode = 'wal';
  cipher = '4.5.7 community';
  autoCheckpoint = 1000;
  log: string[] = [];
  checkpointResult: () => { busy: number; log: number; checkpointed: number } = () => ({ busy: 0, log: 0, checkpointed: 0 });
  onCheckpoint: () => void = () => {};
  async execAsync(sql: string) {
    this.log.push(sql);
    const m = /wal_autocheckpoint\s*=\s*(\d+)/.exec(sql);
    if (m) this.autoCheckpoint = Number(m[1]);
  }
  async getFirstAsync<T>(sql: string): Promise<T | null> {
    this.log.push(sql);
    if (sql.includes('journal_mode')) return { journal_mode: this.journalMode } as T;
    if (sql.includes('cipher_version')) return { cipher_version: this.cipher } as T;
    if (sql.includes('wal_autocheckpoint')) return { wal_autocheckpoint: this.autoCheckpoint } as T;
    if (sql.includes('wal_checkpoint')) { this.onCheckpoint(); return this.checkpointResult() as unknown as T; }
    return null;
  }
}

let dir: string; let dbPath: string; let staging: string; let db: FakeDb; let original: Buffer; let ids: number;

const deps = (over: Partial<SnapshotDeps> = {}): SnapshotDeps => ({
  db, fs: nodeFs, databasePath: dbPath, stagingRoot: staging,
  newId: () => 'snap-' + ++ids, now: () => 1_700_000_000_000, ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-snap-'));
  dbPath = path.join(dir, 'securecase.db');
  staging = path.join(dir, 'cache');
  original = randomBytes(20_000);
  fs.writeFileSync(dbPath, original);
  db = new FakeDb(); ids = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('10.2 — لقطة سليمة', () => {
  test('تنسخ الملف كاملاً بنفس البايتات وتكتب بياناً صحيحاً', async () => {
    const snap = await createDatabaseSnapshot(deps());
    assert.deepEqual(fs.readFileSync(snap.databasePath), original);
    assert.equal(path.basename(snap.databasePath), SNAPSHOT_DB_FILE_NAME);
    const m: SnapshotManifest = JSON.parse(fs.readFileSync(snap.manifestPath, 'utf8'));
    assert.equal(path.basename(snap.manifestPath), SNAPSHOT_MANIFEST_FILE_NAME);
    assert.equal(m.sha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(m.sizeBytes, original.length);
    assert.equal(m.kind, 'database-snapshot');
    assert.equal(m.journalMode, 'wal');
    assert.equal(snap.attempts, 1);
  });

  test('لا تعدّل الملف الأصلي', async () => {
    await createDatabaseSnapshot(deps());
    assert.deepEqual(fs.readFileSync(dbPath), original);
  });

  test('تستدعي checkpoint(TRUNCATE) وتوقف الدمج التلقائي ثم تعيده لقيمته الأصلية', async () => {
    await createDatabaseSnapshot(deps());
    assert.ok(db.log.some((s) => s.includes('wal_checkpoint(TRUNCATE)')));
    const off = db.log.findIndex((s) => s.includes('wal_autocheckpoint = 0'));
    const cp = db.log.findIndex((s) => s.includes('wal_checkpoint'));
    assert.ok(off >= 0 && off < cp);
    assert.equal(db.autoCheckpoint, 1000);
  });

  test('الوضع غير WAL: لا checkpoint ويعمل النسخ', async () => {
    db.journalMode = 'delete';
    const snap = await createDatabaseSnapshot(deps());
    assert.ok(!db.log.some((s) => s.includes('wal_checkpoint(')));
    assert.equal(snap.manifest.journalMode, 'delete');
  });

  test('لا يبقى ملف .partial بعد النجاح', async () => {
    const snap = await createDatabaseSnapshot(deps());
    assert.deepEqual(fs.readdirSync(snap.directory).sort(), [SNAPSHOT_MANIFEST_FILE_NAME, SNAPSHOT_DB_FILE_NAME].sort());
  });

  test('لقطتان متتاليتان في مجلدين مختلفين', async () => {
    const a = await createDatabaseSnapshot(deps());
    const b = await createDatabaseSnapshot(deps());
    assert.notEqual(a.directory, b.directory);
  });
});

describe('10.2 — الفشل والتناسق', () => {
  test('تغيّر المصدر أثناء النسخ → إعادة المحاولة ثم نجاح', async () => {
    let calls = 0;
    const flaky: SnapshotFs = {
      ...nodeFs,
      async copy(a, b) {
        fs.copyFileSync(a, b);
        if (++calls === 1) fs.appendFileSync(dbPath, Buffer.from([1, 2, 3])); // كتابة متزامنة
      },
    };
    const snap = await createDatabaseSnapshot(deps({ fs: flaky }));
    assert.equal(snap.attempts, 2);
    assert.deepEqual(fs.readFileSync(snap.databasePath), fs.readFileSync(dbPath));
  });

  test('عدم الاستقرار الدائم → SNAPSHOT_UNSTABLE وتنظيف كامل', async () => {
    const flaky: SnapshotFs = {
      ...nodeFs,
      async copy(a, b) { fs.copyFileSync(a, b); fs.appendFileSync(dbPath, Buffer.from([9])); },
    };
    await assert.rejects(createDatabaseSnapshot(deps({ fs: flaky })),
      (e: unknown) => e instanceof BackupError && e.code === 'SNAPSHOT_UNSTABLE');
    assert.equal(fs.existsSync(path.join(staging, 'backup-staging', 'snap-1')), false);
    assert.equal(db.autoCheckpoint, 1000);
  });

  test('checkpoint مشغول → CHECKPOINT_FAILED ولا نسخ', async () => {
    db.checkpointResult = () => ({ busy: 1, log: 5, checkpointed: 2 });
    await assert.rejects(createDatabaseSnapshot(deps()),
      (e: unknown) => e instanceof BackupError && e.code === 'CHECKPOINT_FAILED');
    assert.equal(fs.existsSync(path.join(staging, 'backup-staging', 'snap-1')), false);
    assert.equal(db.autoCheckpoint, 1000);
  });

  test('ملف WAL غير فارغ بعد checkpoint يُرفض', async () => {
    fs.writeFileSync(dbPath + '-wal', Buffer.from([1]));
    await assert.rejects(createDatabaseSnapshot(deps()),
      (e: unknown) => e instanceof BackupError && e.code === 'CHECKPOINT_FAILED');
  });

  test('غياب ملف القاعدة → SNAPSHOT_FAILED', async () => {
    fs.rmSync(dbPath);
    await assert.rejects(createDatabaseSnapshot(deps()),
      (e: unknown) => e instanceof BackupError && e.code === 'SNAPSHOT_FAILED');
  });

  test('غياب SQLCipher يمنع النسخ', async () => {
    db.cipher = '';
    await assert.rejects(createDatabaseSnapshot(deps()),
      (e: unknown) => e instanceof BackupError && e.code === 'SNAPSHOT_FAILED');
  });

  test('خطأ نظام ملفات (قرص ممتلئ) يتحول إلى SNAPSHOT_FAILED ويعيد الإعدادات وينظّف', async () => {
    const full: SnapshotFs = { ...nodeFs, async copy() { throw new Error('ENOSPC'); } };
    await assert.rejects(createDatabaseSnapshot(deps({ fs: full })),
      (e: unknown) => e instanceof BackupError && e.code === 'SNAPSHOT_FAILED');
    assert.equal(db.autoCheckpoint, 1000);
    assert.deepEqual(fs.readFileSync(dbPath), original);
  });

  test('عمليتان متزامنتان: الثانية SNAPSHOT_IN_PROGRESS، ثم يُحرَّر القفل', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: SnapshotFs = { ...nodeFs, async copy(a, b) { await gate; fs.copyFileSync(a, b); } };
    const first = createDatabaseSnapshot(deps({ fs: slow }));
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(createDatabaseSnapshot(deps()),
      (e: unknown) => e instanceof BackupError && e.code === 'SNAPSHOT_IN_PROGRESS');
    release();
    await first;
    await createDatabaseSnapshot(deps());
  });
});

describe('10.2 — التنظيف', () => {
  test('discard يحذف مجلد اللقطة فقط', async () => {
    const snap = await createDatabaseSnapshot(deps());
    await discardDatabaseSnapshot({ fs: nodeFs, stagingRoot: staging }, snap);
    assert.equal(fs.existsSync(snap.directory), false);
    assert.ok(fs.existsSync(dbPath));
  });

  test('discard يرفض مساراً خارج مجلد التجهيز', async () => {
    await assert.rejects(
      discardDatabaseSnapshot({ fs: nodeFs, stagingRoot: staging }, { directory: dir, snapshotId: randomUUID() }),
      (e: unknown) => e instanceof BackupError);
    assert.ok(fs.existsSync(dbPath));
  });

  test('discard يرفض معرّفاً لا يطابق المجلد (حماية من ../)', async () => {
    await assert.rejects(
      discardDatabaseSnapshot({ fs: nodeFs, stagingRoot: staging },
        { directory: path.join(staging, 'backup-staging', '..', 'x'), snapshotId: '..' + '/x' }),
      (e: unknown) => e instanceof BackupError);
  });
});
