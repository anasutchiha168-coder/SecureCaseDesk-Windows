// SECURECASEDESK_PHASE10_S2
// إنشاء لقطة متسقة لملف قاعدة البيانات (SQLCipher) داخل مجلد مؤقت. بالحقن الكامل (قابل للاختبار في Node).
//
// الطريقة: (1) إيقاف الدمج التلقائي مؤقتاً، (2) wal_checkpoint(TRUNCATE) فيصبح الملف الرئيسي
// شاملاً كل العمليات المثبتة، (3) نسخ الملف كاملاً (يحفظ المشغلات والملح والتشفير كما هي)،
// (4) التحقق: بصمة المصدر قبل النسخ = بصمة النسخة = بصمة المصدر بعد النسخ، وإلا تُعاد المحاولة،
// (5) إعادة إعداد الدمج التلقائي دائماً (حتى عند الفشل).
// لا تعديل ولا حذف لأي بيانات أصلية. اللقطة تبقى مشفّرة بمفتاح القاعدة؛ تغليفها بكلمة مرور في 10.3.

import {
  BackupError, DATABASE_FILE_NAME, BACKUP_FORMAT_VERSION,
  SNAPSHOT_DB_FILE_NAME, SNAPSHOT_MANIFEST_FILE_NAME, SNAPSHOT_MAX_ATTEMPTS,
  SNAPSHOT_PARTIAL_SUFFIX, SNAPSHOT_STAGING_DIR_NAME,
  type DatabaseSnapshot, type SnapshotManifest,
} from './backup-types';

export interface SnapshotDb {
  execAsync(sql: string): Promise<void>;
  getFirstAsync<T>(sql: string): Promise<T | null>;
}

export interface SnapshotFs {
  ensureDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  size(path: string): Promise<number>;
  copy(from: string, to: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;          // ملف أو مجلد؛ لا خطأ إن غاب
  writeText(path: string, text: string): Promise<void>;
  sha256File(path: string): Promise<string>;
}

export interface SnapshotDeps {
  db: SnapshotDb;
  fs: SnapshotFs;
  databasePath: string;
  stagingRoot: string;        // مجلد مؤقت (cache) وليس document
  newId(): string;
  now(): number;
}

let inFlight = false;

const join = (a: string, b: string) => a.replace(/\/+$/, '') + '/' + b;

async function readPragmaNumber(db: SnapshotDb, name: string): Promise<number> {
  const row = await db.getFirstAsync<Record<string, unknown>>('PRAGMA ' + name);
  const v = row ? Object.values(row)[0] : undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function readPragmaText(db: SnapshotDb, name: string): Promise<string> {
  const row = await db.getFirstAsync<Record<string, unknown>>('PRAGMA ' + name);
  const v = row ? Object.values(row)[0] : undefined;
  return typeof v === 'string' ? v : String(v ?? '');
}

export async function createDatabaseSnapshot(deps: SnapshotDeps): Promise<DatabaseSnapshot> {
  if (inFlight) throw new BackupError('SNAPSHOT_IN_PROGRESS');
  inFlight = true;

  const { db, fs } = deps;
  const snapshotId = deps.newId();
  const directory = join(join(deps.stagingRoot, SNAPSHOT_STAGING_DIR_NAME), snapshotId);
  const finalDb = join(directory, SNAPSHOT_DB_FILE_NAME);
  const partialDb = finalDb + SNAPSHOT_PARTIAL_SUFFIX;
  const manifestPath = join(directory, SNAPSHOT_MANIFEST_FILE_NAME);

  let originalAutoCheckpoint: number | null = null;
  let succeeded = false;

  try {
    const journalMode = (await readPragmaText(db, 'journal_mode')).toLowerCase();
    const cipherVersion = await readPragmaText(db, 'cipher_version');
    if (!cipherVersion) throw new BackupError('SNAPSHOT_FAILED'); // لا نسخ دون تأكيد SQLCipher

    originalAutoCheckpoint = await readPragmaNumber(db, 'wal_autocheckpoint');
    await db.execAsync('PRAGMA wal_autocheckpoint = 0;');

    await fs.ensureDir(directory);

    let lastError: BackupError = new BackupError('SNAPSHOT_UNSTABLE');
    for (let attempt = 1; attempt <= SNAPSHOT_MAX_ATTEMPTS; attempt++) {
      await fs.remove(partialDb);

      // 1) دمج WAL في الملف الرئيسي.
      if (journalMode === 'wal') {
        const cp = await db.getFirstAsync<Record<string, unknown>>('PRAGMA wal_checkpoint(TRUNCATE)');
        const vals = cp ? Object.values(cp).map(Number) : [1, -1, -1];
        const [busy, logFrames, checkpointed] = vals;
        if (busy !== 0 || logFrames !== checkpointed) {
          lastError = new BackupError('CHECKPOINT_FAILED');
          continue;
        }
        const walPath = deps.databasePath + '-wal';
        if ((await fs.exists(walPath)) && (await fs.size(walPath)) > 0) {
          lastError = new BackupError('CHECKPOINT_FAILED');
          continue;
        }
      }

      if (!(await fs.exists(deps.databasePath))) throw new BackupError('SNAPSHOT_FAILED');

      // 2) نسخ + مطابقة ثلاثية.
      const before = await fs.sha256File(deps.databasePath);
      await fs.copy(deps.databasePath, partialDb);
      const copyHash = await fs.sha256File(partialDb);
      const after = await fs.sha256File(deps.databasePath);

      const srcSize = await fs.size(deps.databasePath);
      const copySize = await fs.size(partialDb);

      if (before !== after || before !== copyHash || srcSize !== copySize) {
        lastError = new BackupError('SNAPSHOT_UNSTABLE');
        continue;
      }

      // 3) تثبيت اللقطة والبيان.
      await fs.move(partialDb, finalDb);
      const manifest: SnapshotManifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        kind: 'database-snapshot',
        snapshotId,
        createdAt: deps.now(),
        databaseFileName: DATABASE_FILE_NAME,
        sizeBytes: copySize,
        sha256: copyHash,
        journalMode,
        cipherVersion,
      };
      await fs.writeText(manifestPath, JSON.stringify(manifest, null, 2));
      succeeded = true;
      return { snapshotId, directory, databasePath: finalDb, manifestPath, manifest, attempts: attempt };
    }
    throw lastError;
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError('SNAPSHOT_FAILED');
  } finally {
    // إعادة الإعداد الأصلي دائماً، وتنظيف المؤقت عند الفشل فقط.
    if (originalAutoCheckpoint !== null) {
      try { await db.execAsync('PRAGMA wal_autocheckpoint = ' + Math.trunc(originalAutoCheckpoint) + ';'); } catch { /* لا نخفي الخطأ الأصلي */ }
    }
    if (!succeeded) {
      try { await fs.remove(directory); } catch { /* تنظيف مؤقت فقط */ }
    }
    inFlight = false;
  }
}

// يحذف مجلد لقطة مؤقتاً بعد استهلاكها (10.3). يرفض أي مسار خارج مجلد التجهيز.
export async function discardDatabaseSnapshot(
  deps: Pick<SnapshotDeps, 'fs' | 'stagingRoot'>, snapshot: Pick<DatabaseSnapshot, 'directory' | 'snapshotId'>
): Promise<void> {
  const root = join(deps.stagingRoot, SNAPSHOT_STAGING_DIR_NAME) + '/';
  if (!snapshot.directory.startsWith(root) || snapshot.directory.slice(root.length) !== snapshot.snapshotId) {
    throw new BackupError('SNAPSHOT_FAILED');
  }
  await deps.fs.remove(snapshot.directory);
}
