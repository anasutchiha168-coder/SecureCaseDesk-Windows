// SECURECASEDESK_PHASE10_S2
// محوّل Expo لإنشاء لقطة قاعدة البيانات. ⚠️ أسماء واجهات expo-file-system تحتاج تحقق tsc وجهاز فعلي.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as Crypto from 'expo-crypto';
import { FileMode, Paths } from 'expo-file-system';
import { getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import { inspectBackupReadiness } from './backup-runtime';
import { createDatabaseSnapshot, discardDatabaseSnapshot, type SnapshotFs } from './backup-snapshot';
import { BackupError, BACKUP_PERMISSION, type DatabaseSnapshot } from './backup-types';
import { fsFile, fsDir } from '@/modules/backup/fs-uri'; // SECURECASEDESK_FILE_URI_FIX

const CHUNK = 256 * 1024;

function removeIfExists(path: string) {
  const f = fsFile(path);
  if (f.exists) { f.delete(); return; }
  const d = fsDir(path);
  if (d.exists) d.delete();
}

const expoFs: SnapshotFs = {
  async ensureDir(path) { fsDir(path).create({ intermediates: true, idempotent: true }); },
  async exists(path) { return fsFile(path).exists; },
  async size(path) { const f = fsFile(path); return f.exists ? f.size : 0; },
  async copy(from, to) { removeIfExists(to); fsFile(from).copy(fsFile(to)); },
  async move(from, to) { removeIfExists(to); fsFile(from).move(fsFile(to)); },
  async remove(path) { removeIfExists(path); },
  async writeText(path, text) { const f = fsFile(path); if (!f.exists) f.create(); f.write(text); },
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

// فحص مزدوج للصلاحية + جاهزية بلا موانع، ثم لقطة متسقة في Paths.cache.
export async function createDatabaseBackupSnapshot(session: Session | null | undefined): Promise<DatabaseSnapshot> {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);

  const inventory = await inspectBackupReadiness(s);
  if (!inventory.ready) throw new BackupError('NOT_READY');

  return createDatabaseSnapshot({
    db,
    fs: expoFs,
    databasePath: db.databasePath,
    stagingRoot: Paths.cache.uri.replace(/^file:\/\//, ''),
    newId: () => Crypto.randomUUID(),
    now: () => Date.now(),
  });
}

export async function discardDatabaseBackupSnapshot(
  session: Session | null | undefined, snapshot: DatabaseSnapshot
): Promise<void> {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);
  await discardDatabaseSnapshot(
    { fs: expoFs, stagingRoot: Paths.cache.uri.replace(/^file:\/\//, '') }, snapshot
  );
}
