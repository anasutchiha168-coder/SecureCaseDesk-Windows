// SECURECASEDESK_PHASE10_S6
// محوّل Expo لاستعادة النسخة الاحتياطية.
// ⚠️ لم يُشغَّل على جهاز: يحتاج فحص tsc وتجربة فعلية لـ:
//    Directory.move / File.move على مجلدات، Directory.list، File.text()، وفتح قاعدة من مجلد مخصص
//    عبر SQLite.openDatabaseAsync(name, options, directory).
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { closeDb, getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import { flushAuditQueue, recordAuditEvent } from '@/services/audit.service';
import { inspectBackupReadiness } from './backup-runtime';
import type { BackupCryptoProvider } from './backup-format';
import {
  restoreBackupPackage, recoverInterruptedRestore,
  type DatabaseReport, type RestoreDeps, type RestoreFs, type RestoreProgress, type RestoreResult,
} from './backup-restore';
import {
  ATTACHMENTS_DIR_NAME, BACKUP_PERMISSION,
  RESTORE_JOURNAL_FILE_NAME, RESTORE_SAFETY_DIR_NAME, RESTORE_STAGING_DIR_NAME,
} from './backup-types';
import { fsFile, fsDir } from '@/modules/backup/fs-uri'; // SECURECASEDESK_FILE_URI_FIX

const cryptoProvider: BackupCryptoProvider = {
  randomBytes: (n) => Crypto.getRandomBytes(n),
  sha256: () => sha256.create(),
  scrypt: (pw, salt, { N, r, p }, len) => scryptAsync(pw, salt, { N, r, p, dkLen: len, asyncTick: 10 }),
  hkdfSha256: (master, salt, info, len) => hkdf(sha256, master, salt, info, len),
  aeadEncrypt: (key, nonce, aad, plain) => chacha20poly1305(key, nonce, aad).encrypt(plain),
  aeadDecrypt: (key, nonce, aad, ct) => chacha20poly1305(key, nonce, aad).decrypt(ct),
};

function removeIfExists(path: string) {
  const f = fsFile(path);
  if (f.exists) { f.delete(); return; }
  const d = fsDir(path);
  if (d.exists) d.delete();
}

const stripScheme = (uri: string) => uri.replace(/^file:\/\//, '').replace(/\/+$/, '');

const expoRestoreFs: RestoreFs = {
  async ensureDir(path) { fsDir(path).create({ intermediates: true, idempotent: true }); },
  async exists(path) { return fsFile(path).exists || fsDir(path).exists; },
  async size(path) { const f = fsFile(path); return f.exists ? f.size : 0; },
  async remove(path) { removeIfExists(path); },
  async move(from, to) {
    removeIfExists(to);
    const f = fsFile(from);
    if (f.exists) { f.move(fsFile(to)); return; }
    const d = fsDir(from);
    if (d.exists) { d.move(fsDir(to)); return; }
    throw new Error('MOVE_SOURCE_MISSING');
  },
  async openRead(path) {
    const h = fsFile(path).open(FileMode.ReadOnly);
    return { async read(max) { return h.readBytesSync(max); }, async close() { h.close(); } };
  },
  async openWrite(path) {
    removeIfExists(path);
    const f = fsFile(path);
    f.create();
    const h = f.open(FileMode.WriteOnly);
    return { async write(bytes) { h.writeBytes(bytes); }, async close() { h.close(); } };
  },
  async list(dir) {
    const d = fsDir(dir);
    return d.exists ? d.list().map((x) => x.name) : [];
  },
  async readText(path) { return await fsFile(path).text(); },
  async writeText(path, text) {
    const f = fsFile(path);
    if (f.exists) f.delete();
    f.create();
    f.write(text);
  },
};

async function inspectOpenDatabase(db: SQLite.SQLiteDatabase): Promise<DatabaseReport> {
  const c = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version;');
  const q = await db.getFirstAsync<{ quick_check: string }>('PRAGMA quick_check;');
  const t = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  return { cipherVersion: c?.cipher_version ?? '', integrity: q?.quick_check ?? 'unknown', tables: t.map((x) => x.name) };
}

function buildDeps(): RestoreDeps {
  const documentDir = stripScheme(Paths.document.uri);
  const cacheDir = stripScheme(Paths.cache.uri);
  return {
    crypto: cryptoProvider,
    fs: expoRestoreFs,
    stagingRoot: cacheDir + '/' + RESTORE_STAGING_DIR_NAME,
    // نسخة الأمان في document (نفس وحدة التخزين → النقل إعادة تسمية سريعة وذرّية).
    safetyRoot: documentDir + '/' + RESTORE_SAFETY_DIR_NAME,
    journalPath: documentDir + '/' + RESTORE_JOURNAL_FILE_NAME,
    dbPath: '', // يُضبط في التنفيذ من مسار قاعدة البيانات الحالية
    attachmentsDir: documentDir + '/' + ATTACHMENTS_DIR_NAME,
    secretSpecs: [],
    readSecret: (n) => SecureStore.getItemAsync(n),
    writeSecret: (n, v) => SecureStore.setItemAsync(n, v),
    deleteSecret: (n) => SecureStore.deleteItemAsync(n),
    validateStagedDatabase: async (path, dbKey) => {
      const slash = path.lastIndexOf('/');
      const dir = path.slice(0, slash);
      const name = path.slice(slash + 1);
      const sdb = await SQLite.openDatabaseAsync(name, undefined, dir);
      try {
        await sdb.execAsync(`PRAGMA key = '${dbKey.replace(/'/g, "''")}';`);
        return await inspectOpenDatabase(sdb);
      } finally { await sdb.closeAsync(); }
    },
    closeDatabase: () => closeDb(),
    reopenAndVerify: async () => inspectOpenDatabase(await getDb()),
    flushPending: () => flushAuditQueue(),
    newId: () => Crypto.randomUUID(),
    now: () => Date.now(),
    yieldTick: () => new Promise((r) => setTimeout(r, 0)),
  };
}

// صلاحية مزدوجة + تأكيد صريح + استعادة. بعد النجاح يجب على الواجهة إنهاء الجلسة (requiresRelogin).
export async function restoreEncryptedBackup(
  session: Session | null | undefined,
  filePath: string,
  passphrase: string,
  confirmed: boolean,
  onProgress?: (p: RestoreProgress) => void,
  preRestoreSafetyBackup?: () => Promise<void>
): Promise<RestoreResult & { auditLogged: boolean }> {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);

  // التصنيف الحالي للأسرار (الأسماء فقط) + اسم المستخدم قبل استبدال جدول المستخدمين.
  const inventory = await inspectBackupReadiness(s);
  const actorRow = await db.getFirstAsync<{ username: string }>('SELECT username FROM users WHERE id = ?', [s.userId]);

  const deps = buildDeps();
  deps.dbPath = db.databasePath;
  deps.secretSpecs = inventory.secrets;
  deps.onProgress = onProgress;
  deps.preRestoreSafetyBackup = preRestoreSafetyBackup;

  const result = await restoreBackupPackage(deps, { filePath, passphrase, confirmed });

  // التسجيل في سلسلة التدقيق المستعادة (حدث جديد يُلحق؛ لا تعديل لسجلات قديمة). فشله لا يُبطل الاستعادة.
  let auditLogged = true;
  try {
    await recordAuditEvent({
      operationType: 'backup_restore', entityType: 'backup', entityId: result.backupId,
      actor: { id: s.userId, username: actorRow?.username ?? null },
      newValues: {
        restoreId: result.restoreId, backupCreatedAt: result.backupCreatedAt,
        attachmentsRestored: result.attachmentsRestored, warnings: result.warnings.map((w) => w.code),
      },
      eventKey: 'backup_restore:' + result.restoreId,
    });
    await flushAuditQueue();
  } catch { auditLogged = false; }
  return { ...result, auditLogged };
}

// يُستدعى مرة عند إقلاع التطبيق قبل initDatabase(): يكمل التراجع إن انقطعت استعادة سابقة.
export async function recoverRestoreOnStartup(): Promise<{ action: 'none' | 'rolled-back'; restoreId?: string }> {
  // المسارات تُؤخذ من سجل الاستعادة نفسه (كُتب بمسار القاعدة الفعلي وقت الاستعادة).
  return recoverInterruptedRestore(buildDeps());
}
