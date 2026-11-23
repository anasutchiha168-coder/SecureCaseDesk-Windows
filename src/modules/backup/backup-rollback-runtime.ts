// SECURECASEDESK_PHASE10_S7
// محوّل Expo للتراجع الآمن. ⚠️ لم يُختبر على جهاز: أسماء واجهات expo-file-system (File/Directory/text/move)
// تحتاج فحص tsc وتجربة فعلية، كما في بقية أقسام المرحلة 10.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { closeDb, getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import {
  recoverInterruptedOperation, runWithRollback,
  type ProtectedResult, type RecoveryStatus, type RollbackDeps, type RollbackFs, type RollbackSecrets, type RollbackTarget,
} from './backup-rollback';
import {
  ATTACHMENTS_DIR_NAME, BACKUP_OUTPUT_DIR_NAME, BACKUP_PERMISSION, DATABASE_FILE_NAME, SECRET_NAMES, auditHmacKeyName,
} from './backup-types';
import { fsFile, fsDir } from '@/modules/backup/fs-uri'; // SECURECASEDESK_FILE_URI_FIX

const CHUNK = 256 * 1024;
const STASH_PREFIX = 'scd_rb_stash_';
const stripScheme = (uri: string) => uri.replace(/^file:\/\//, '');

function removeIfExists(path: string) {
  const f = fsFile(path);
  if (f.exists) { f.delete(); return; }
  const d = fsDir(path);
  if (d.exists) d.delete();
}

const expoFs: RollbackFs = {
  async ensureDir(path) { fsDir(path).create({ intermediates: true, idempotent: true }); },
  async exists(path) { return fsFile(path).exists || fsDir(path).exists; },
  async move(from, to) {
    removeIfExists(to);
    const f = fsFile(from);
    if (f.exists) { f.move(fsFile(to)); return; }
    fsDir(from).move(fsDir(to));
  },
  async remove(path) { removeIfExists(path); },
  async readText(path) { const f = fsFile(path); return f.exists ? await f.text() : null; },
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

// المخبأ يحفظ القيمة أو غيابها، فيعيد restore الحالة بالضبط (بما فيها حذف سر لم يكن موجوداً).
const expoSecrets: RollbackSecrets = {
  async stash(names) {
    for (const n of names) {
      const v = await SecureStore.getItemAsync(n);
      await SecureStore.setItemAsync(STASH_PREFIX + n, JSON.stringify(v === null ? { p: false } : { p: true, v }));
    }
  },
  async restore(names) {
    for (const n of names) {
      const raw = await SecureStore.getItemAsync(STASH_PREFIX + n);
      if (raw === null) continue;                       // لم يصل التخزين لهذا السر: لم يُمسّ
      const s = JSON.parse(raw) as { p: boolean; v?: string };
      if (s.p && typeof s.v === 'string') await SecureStore.setItemAsync(n, s.v);
      else await SecureStore.deleteItemAsync(n);
    }
  },
  async clear(names) { for (const n of names) await SecureStore.deleteItemAsync(STASH_PREFIX + n); },
};

// أسماء الأسرار المحمية: الثابتة + مفاتيح HMAC لكل إصدار حتى الإصدار النشط الحالي.
export async function protectedSecretNames(): Promise<string[]> {
  const names: string[] = [
    SECRET_NAMES.dbKey, SECRET_NAMES.attachmentMasterKey, SECRET_NAMES.auditActiveVersion,
    SECRET_NAMES.auditCheckpointKey, SECRET_NAMES.auditCheckpointLast,
  ];
  const active = Number(await SecureStore.getItemAsync(SECRET_NAMES.auditActiveVersion));
  const top = Number.isInteger(active) && active > 0 ? Math.min(active, 100) : 1;
  for (let v = 1; v <= top; v++) names.push(auditHmacKeyName(v));
  return names;
}

function buildDeps(): RollbackDeps {
  const documentDir = stripScheme(Paths.document.uri);
  const backups = documentDir.replace(/\/+$/, '') + '/' + BACKUP_OUTPUT_DIR_NAME;
  return {
    fs: expoFs, secrets: expoSecrets,
    journalPath: backups + '/rollback-journal.json',
    guardRoot: backups + '/rollback-guard',
    newId: () => Crypto.randomUUID(), now: () => Date.now(),
    closeDatabase: () => closeDb(),
    reopenDatabase: async () => { await getDb(); },
  };
}

function databaseFilePath(): string {
  return stripScheme(String(SQLite.defaultDatabaseDirectory)).replace(/\/+$/, '') + '/' + DATABASE_FILE_NAME;
}

// يُستدعى عند إقلاع التطبيق قبل أول getDb()/initDatabase(): يكمل الرجوع أو التثبيت لعملية انقطعت.
// بدون جلسة عمداً (يعمل قبل تسجيل الدخول). يرمي RollbackError('ROLLBACK_FAILED') إن تعذر الرجوع.
export async function recoverInterruptedRestore(): Promise<{ status: RecoveryStatus; journalId?: string }> {
  const dir = fsDir(stripScheme(Paths.document.uri).replace(/\/+$/, '') + '/' + BACKUP_OUTPUT_DIR_NAME);
  if (!dir.exists) return { status: 'none' };
  return recoverInterruptedOperation(buildDeps());
}

// ينفّذ action (يكتب الحالة الجديدة في مسارات القاعدة والمرفقات) تحت حماية الرجوع الكامل.
// 10.6 يمرّر منطق الاستبدال هنا، و verify يفتح القاعدة الجديدة ويتحقق منها.
export async function runProtectedReplacement<T>(
  session: Session | null | undefined,
  action: () => Promise<T>,
  verify: () => Promise<void>,
): Promise<ProtectedResult<T>> {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);

  const dbPath = databaseFilePath();
  const targets: RollbackTarget[] = [
    { path: dbPath, kind: 'file' },
    { path: dbPath + '-wal', kind: 'file' },
    { path: dbPath + '-shm', kind: 'file' },
    { path: stripScheme(Paths.document.uri).replace(/\/+$/, '') + '/' + ATTACHMENTS_DIR_NAME, kind: 'dir' },
  ];
  return runWithRollback(buildDeps(), { operation: 'replace-data', targets, secretNames: await protectedSecretNames() }, action, verify);
}
