// SECURECASEDESK_PHASE10_S7
// محوّل Expo لترحيل قاعدة قديمة. ⚠️ لم يُختبر على جهاز: يحتاج فحص tsc وتجربة فعلية
// (فتح قاعدة بالاسم من مجلد expo-sqlite الافتراضي، withTransactionAsync مع SQLCipher، واجهات expo-file-system).
// المعاملة تستخدم الاتصال الرئيسي المفتوح بمفتاح SQLCipher عمداً (withExclusiveTransactionAsync يفتح اتصالاً جديداً بلا مفتاح).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import { FileMode, Paths } from 'expo-file-system';
import { getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import { createDatabaseBackupSnapshot, discardDatabaseBackupSnapshot } from './backup-snapshot-runtime';
import { BACKUP_OUTPUT_DIR_NAME, BACKUP_PERMISSION } from './backup-types';
import {
  LegacyMigrationError, inspectLegacyDatabase, migrateLegacyDatabase,
  type LegacyDb, type LegacyInspection, type MigrationDeps, type MigrationFs, type MigrationReport, type TargetDb,
} from './legacy-migration';
import { LEGACY_PROFILES } from './legacy-profiles';
import { fsFile, fsDir } from '@/modules/backup/fs-uri'; // SECURECASEDESK_FILE_URI_FIX

const CHUNK = 256 * 1024;
const stripScheme = (uri: string) => uri.replace(/^file:\/\//, '');

function removeIfExists(path: string) {
  const f = fsFile(path);
  if (f.exists) { f.delete(); return; }
  const d = fsDir(path);
  if (d.exists) d.delete();
}

const expoMigrationFs: MigrationFs = {
  async exists(path) { return fsFile(path).exists; },
  async size(path) { const f = fsFile(path); return f.exists ? f.size : 0; },
  async ensureDir(path) { fsDir(path).create({ intermediates: true, idempotent: true }); },
  async copy(from, to) { removeIfExists(to); fsFile(from).copy(fsFile(to)); },
  async remove(path) { removeIfExists(path); },
  async readHeader(path, bytes) {
    const h = fsFile(path).open(FileMode.ReadOnly);
    try { return h.readBytesSync(bytes); } finally { h.close(); }
  },
  async sha256File(path) {
    const f = fsFile(path);
    const total = f.size;
    const h = sha256.create();
    const handle = f.open(FileMode.ReadOnly);
    try {
      let read = 0;
      while (read < total) {
        const bytes = handle.readBytesSync(Math.min(CHUNK, total - read));
        if (bytes.length === 0) break;
        h.update(bytes);
        read += bytes.length;
      }
      if (read !== total) throw new Error('SHORT_READ');
    } finally { handle.close(); }
    return bytesToHex(h.digest());
  },
};

// expo-sqlite يفتح القواعد بالاسم من مجلده الافتراضي: ننسخ النسخة المؤقتة إليه، ونحذفها عند الإغلاق.
async function openLegacyExpo(stagedPath: string, key?: string): Promise<LegacyDb> {
  const name = 'legacy-staging-' + Crypto.randomUUID() + '.db';
  const dir = stripScheme(String(SQLite.defaultDatabaseDirectory)).replace(/\/+$/, '');
  const copyPath = dir + '/' + name;
  fsFile(stagedPath).copy(fsFile(copyPath));
  const cleanup = () => { for (const suffix of ['', '-wal', '-shm', '-journal']) removeIfExists(copyPath + suffix); };
  try {
    const db = await SQLite.openDatabaseAsync(name);
    if (key) await db.execAsync("PRAGMA key = '" + key.replace(/'/g, "''") + "';");
    return {
      getAllAsync: (sql, params = []) => db.getAllAsync(sql, params as never[]),
      getFirstAsync: (sql, params = []) => db.getFirstAsync(sql, params as never[]),
      async close() { try { await db.closeAsync(); } finally { cleanup(); } },
    };
  } catch (e) { cleanup(); throw e; }
}

async function authorize(session: Session | null | undefined) {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);
  return { s, db };
}

function localPath(uri: string): string {
  if (!uri.startsWith('file://') && !uri.startsWith('/')) throw new LegacyMigrationError('LEGACY_FILE_MISSING', 'URI_NOT_LOCAL_FILE');
  return stripScheme(uri);
}

async function buildDeps(session: Session, db: Awaited<ReturnType<typeof getDb>>): Promise<MigrationDeps> {
  const target: TargetDb = {
    getAllAsync: (sql, params = []) => db.getAllAsync(sql, params as never[]),
    getFirstAsync: (sql, params = []) => db.getFirstAsync(sql, params as never[]),
    execAsync: (sql) => db.execAsync(sql),
    runAsync: (sql, params = []) => db.runAsync(sql, params as never[]),
    async transaction(fn) {
      let result: unknown;
      await db.withTransactionAsync(async () => { result = await fn(); });
      return result as never;
    },
  };
  return {
    fs: expoMigrationFs, target, profiles: LEGACY_PROFILES,
    stagingRoot: stripScheme(Paths.cache.uri),
    openLegacy: openLegacyExpo,
    // لقطة 10.2 تُنقل من cache (قد يمسحه النظام) إلى document لتبقى متاحة بعد الترحيل.
    async createSafetyCopy() {
      const snap = await createDatabaseBackupSnapshot(session);
      try {
        const dir = stripScheme(Paths.document.uri).replace(/\/+$/, '') + '/' + BACKUP_OUTPUT_DIR_NAME + '/pre-migration';
        fsDir(dir).create({ intermediates: true, idempotent: true });
        const dest = dir + '/' + snap.snapshotId + '.db';
        fsFile(snap.databasePath).copy(fsFile(dest));
        if ((await expoMigrationFs.sha256File(dest)) !== snap.manifest.sha256) throw new Error('SAFETY_COPY_MISMATCH');
        return { path: dest, sha256: snap.manifest.sha256 };
      } finally {
        await discardDatabaseBackupSnapshot(session, snap).catch(() => {});
      }
    },
    newId: () => Crypto.randomUUID(), now: () => Date.now(),
  };
}

// معاينة فقط: لا ترحيل. تعرض الإصدار المكتشف والجداول والتحذيرات.
export async function inspectLegacyDatabaseFile(
  session: Session | null | undefined, sourceUri: string, key?: string,
): Promise<LegacyInspection> {
  const { s, db } = await authorize(session);
  return inspectLegacyDatabase(await buildDeps(s, db), localPath(sourceUri), key);
}

export async function migrateLegacyDatabaseFile(
  session: Session | null | undefined, sourceUri: string, opts: { confirm: boolean; key?: string },
): Promise<MigrationReport> {
  const { s, db } = await authorize(session);
  return migrateLegacyDatabase(await buildDeps(s, db), {
    sourcePath: localPath(sourceUri), key: opts.key, actorUserId: s.userId, confirm: opts.confirm,
  });
}
