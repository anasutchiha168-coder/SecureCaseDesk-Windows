// SECURECASEDESK_PHASE10_S3
// محوّل Expo لإنشاء ملف النسخة الاحتياطية المشفّر.
// ⚠️ لم يُشغَّل على جهاز: يحتاج فحص tsc لأسماء expo-file-system (FileMode.WriteOnly, writeBytes, readBytesSync)
//    ولمكتبات @noble (scrypt.js) وقياس زمن scrypt على جهاز حقيقي.
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { FileMode, Paths } from 'expo-file-system';
import { getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import { inspectBackupReadiness } from './backup-runtime';
import { createDatabaseBackupSnapshot, discardDatabaseBackupSnapshot } from './backup-snapshot-runtime';
import { createBackupPackage, type AttachmentRow, type BackupPackageResult, type PackageFs, type PackageProgress } from './backup-package';
import { BACKUP_CHUNK_SIZE, BACKUP_KDF_DEFAULT, type BackupCryptoProvider } from './backup-format';
import {
  ATTACHMENTS_DIR_NAME, ATTACHMENT_STORAGE_NAME, BACKUP_OUTPUT_DIR_NAME, BACKUP_PERMISSION, BackupError,
} from './backup-types';
import { fsFile, fsDir } from '@/modules/backup/fs-uri'; // SECURECASEDESK_FILE_URI_FIX

const noblePackageCrypto: BackupCryptoProvider = {
  randomBytes: (n) => Crypto.getRandomBytes(n),
  sha256: () => sha256.create(),
  // asyncTick يمنع تجميد الواجهة أثناء الاشتقاق.
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

const expoPackageFs: PackageFs = {
  async ensureDir(path) { fsDir(path).create({ intermediates: true, idempotent: true }); },
  async exists(path) { return fsFile(path).exists; },
  async size(path) { const f = fsFile(path); return f.exists ? f.size : 0; },
  async remove(path) { removeIfExists(path); },
  async move(from, to) { removeIfExists(to); fsFile(from).move(fsFile(to)); },
  async openRead(path) {
    const h = fsFile(path).open(FileMode.ReadOnly);
    return {
      async read(max) { return h.readBytesSync(max); },
      async close() { h.close(); },
    };
  },
  async openWrite(path) {
    removeIfExists(path);
    const f = fsFile(path);
    f.create();
    const h = f.open(FileMode.WriteOnly);
    return {
      async write(bytes) { h.writeBytes(bytes); },
      async close() { h.close(); },
    };
  },
};

const stripScheme = (uri: string) => uri.replace(/^file:\/\//, '').replace(/\/+$/, '');

// فحص مزدوج للصلاحية + جاهزية بلا موانع + إنشاء ملف .scdbak في <document>/backups.
export async function createEncryptedBackup(
  session: Session | null | undefined,
  passphrase: string,
  passphraseConfirmation: string,
  onProgress?: (p: PackageProgress) => void
): Promise<BackupPackageResult> {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);

  const inventory = await inspectBackupReadiness(s);
  if (!inventory.ready) throw new BackupError('NOT_READY');

  const documentDir = stripScheme(Paths.document.uri);

  return createBackupPackage({
    crypto: noblePackageCrypto,
    fs: expoPackageFs,
    kdf: BACKUP_KDF_DEFAULT,
    chunkSize: BACKUP_CHUNK_SIZE,
    outputDir: documentDir + '/' + BACKUP_OUTPUT_DIR_NAME,
    takeSnapshot: () => createDatabaseBackupSnapshot(s),
    discardSnapshot: (snap) => discardDatabaseBackupSnapshot(s, snap),
    readAttachmentRows: () => db.getAllAsync<AttachmentRow>(
      'SELECT id, storage_name, status, sha256_cipher, size_bytes FROM attachments ORDER BY id'
    ),
    attachmentPath: (name) => {
      if (!ATTACHMENT_STORAGE_NAME.test(name)) throw new BackupError('PACKAGE_FAILED');
      return documentDir + '/' + ATTACHMENTS_DIR_NAME + '/' + name;
    },
    secretSpecs: inventory.secrets,
    readSecret: (name) => SecureStore.getItemAsync(name),
    newId: () => Crypto.randomUUID(),
    now: () => Date.now(),
    yieldTick: () => new Promise((r) => setTimeout(r, 0)),
    onProgress,
  }, passphrase, passphraseConfirmation);
}
