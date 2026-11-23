// SECURECASEDESK_PHASE10_S5
// محوّل Expo لتجهيز الاستعادة (10.5). ⚠️ لم يُشغَّل على جهاز: يحتاج فحص tsc وتجربة على Android حقيقي (انظر docs/phase10/10.5-restore-preparation.md).
// لا يستبدل أي بيانات حية: يفك النسخة في Paths.cache ويفحصها وينشئ نسخة أمان فقط.
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Directory, FileMode, Paths } from 'expo-file-system';
import { getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import { readExternalCheckpoint } from '@/security/audit-integrity-guard';
import { flushAuditQueue } from '@/services/audit.service';
import { recordSystemEvent } from '@/modules/audit/audit-integration';
import { createEncryptedBackup } from './backup-package-runtime';
import type { PackageFs } from './backup-package';
import type { BackupCryptoProvider } from './backup-format';
import { BACKUP_PERMISSION, OPTIONAL_TABLES, REQUIRED_TABLES } from './backup-types';
import {
  COUNTED_TABLES, RESTORE_STAGING_DIR_NAME, RestorePrepError,
  activeRestorePlanIds, assertRestorePlanFresh, cleanupStaleRestoreStaging, discardRestorePlan, getRestorePlan, prepareRestore,
  type LiveSummary, type PrepareRestoreResult, type RestorePlanSummary, type RestorePrepDeps,
  type RestorePrepProgress, type StagedDbSummary, type StoredRestorePlan,
} from './backup-restore-prep';
import { fsFile, fsDir } from '@/modules/backup/fs-uri'; // SECURECASEDESK_FILE_URI_FIX

// ملاحظة: المزوّد والمحوّل أدناه نسخة من backup-package-runtime.ts (غير مصدَّرَين هناك) ويجب أن يبقيا مطابقين له.
const noblePackageCrypto: BackupCryptoProvider = {
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

const expoRestoreFs: PackageFs & { listDirs(path: string): Promise<string[]> } = {
  async ensureDir(path) { fsDir(path).create({ intermediates: true, idempotent: true }); },
  async exists(path) { return fsFile(path).exists; },
  async size(path) { const f = fsFile(path); return f.exists ? f.size : 0; },
  async remove(path) { removeIfExists(path); },
  async move(from, to) { removeIfExists(to); fsFile(from).move(fsFile(to)); },
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
  async listDirs(path) {
    const d = fsDir(path);
    if (!d.exists) return [];
    const names: string[] = [];
    for (const item of d.list()) if (item instanceof Directory) names.push(item.name);
    return names;
  },
};

// أسماء الجداول من ثوابت المشروع فقط (لا تُبنى من مدخلات).
const KNOWN_TABLES: readonly string[] = [...REQUIRED_TABLES, ...OPTIONAL_TABLES];
const quote = (n: string) => '"' + n + '"';

interface Queryable {
  getFirstAsync<T>(sql: string): Promise<T | null>;
  getAllAsync<T>(sql: string): Promise<T[]>;
}

async function tableSet(db: Queryable): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
  return new Set(rows.map((r) => r.name));
}

async function countTables(db: Queryable, existing: Set<string>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    if (!existing.has(t)) continue;
    const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM ' + quote(t));
    counts[t] = Number(row?.c ?? 0);
  }
  return counts;
}

async function readAuditMax(db: Queryable, existing: Set<string>): Promise<number> {
  if (!existing.has('audit_logs')) return 0;
  const row = await db.getFirstAsync<{ m: number | null }>('SELECT MAX(sequence_no) AS m FROM audit_logs');
  return Number(row?.m ?? 0);
}

async function readDeviceId(db: Queryable, existing: Set<string>): Promise<string | null> {
  if (!existing.has('audit_sync_state')) return null;
  const row = await db.getFirstAsync<{ device_id: string }>('SELECT device_id FROM audit_sync_state WHERE id = 1');
  return row?.device_id ?? null;
}

// يفحص نسخة مؤقتة من القاعدة المجهّزة (الملف المجهّز نفسه لا يُفتح كي لا تتغير بصمته).
// مفتاح القاعدة مُتحقَّق من صيغته (UUID) في الطبقة الصرفة قبل الوصول إلى هنا؛ يُهرَّب الاقتباس احتياطاً.
async function inspectStagedDatabase(databasePath: string, dbKey: string): Promise<StagedDbSummary> {
  const slash = databasePath.lastIndexOf('/');
  const dir = databasePath.slice(0, slash);
  const copyName = 'inspect.db';
  const copyPath = dir + '/' + copyName;
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) { try { removeIfExists(copyPath + suffix); } catch { /* تنظيف فقط */ } }
  };
  cleanup();
  fsFile(databasePath).copy(fsFile(copyPath));
  let db: SQLite.SQLiteDatabase | null = null;
  try {
    db = await SQLite.openDatabaseAsync(copyName, { useNewConnection: true }, dir);
    await db.execAsync("PRAGMA key = '" + dbKey.replace(/'/g, "''") + "';");
    const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version;');
    // أول قراءة فعلية للمخطط: تفشل إن كان المفتاح خاطئاً أو الملف تالفاً.
    const existing = await tableSet(db);

    const integrity = await db.getAllAsync<{ integrity_check: string }>('PRAGMA integrity_check;');
    let integrityOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
    try {
      const pages = await db.getAllAsync<Record<string, unknown>>('PRAGMA cipher_integrity_check;');
      if (pages.length > 0) integrityOk = false;
    } catch { /* الأمر مساعد؛ فشل تنفيذه لا يُعدّ فشل سلامة */ }

    const counts = await countTables(db, existing);
    let activeAdmins = 0;
    if (existing.has('users')) {
      const a = await db.getFirstAsync<{ c: number }>(
        `SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND COALESCE(is_active, 1) = 1`
      );
      activeAdmins = Number(a?.c ?? 0);
    }
    let auditKeyVersions: number[] = [];
    if (existing.has('audit_key_registry')) {
      const rows = await db.getAllAsync<{ version: number }>('SELECT version FROM audit_key_registry ORDER BY version');
      auditKeyVersions = rows.map((r) => Number(r.version)).filter((v) => Number.isInteger(v) && v > 0);
    }
    const attachmentRows = existing.has('attachments')
      ? await db.getAllAsync<{ id: string; storage_name: string; status: string; sha256_cipher: string }>(
          'SELECT id, storage_name, status, sha256_cipher FROM attachments')
      : [];
    return {
      cipherVersion: cipher?.cipher_version ?? '',
      integrityOk,
      tablesPresent: KNOWN_TABLES.filter((t) => existing.has(t)),
      counts, activeAdmins,
      auditMaxSeq: await readAuditMax(db, existing),
      auditKeyVersions,
      deviceId: await readDeviceId(db, existing),
      attachmentRows,
    };
  } finally {
    try { await db?.closeAsync(); } catch { /* تنظيف فقط */ }
    cleanup();
  }
}

async function readLiveSummary(): Promise<LiveSummary> {
  const db = await getDb();
  const existing = await tableSet(db);
  const ext = await readExternalCheckpoint();
  return {
    counts: await countTables(db, existing),
    auditMaxSeq: await readAuditMax(db, existing),
    externalCheckpointSeq: ext.state === 'present' && ext.record ? ext.record.sequence_no : null,
    deviceId: await readDeviceId(db, existing),
  };
}

async function getLiveAuditSeq(): Promise<number> {
  const db = await getDb();
  return readAuditMax(db, await tableSet(db));
}

function buildDeps(
  s: Session, onProgress?: (p: RestorePrepProgress) => void
): RestorePrepDeps {
  return {
    crypto: noblePackageCrypto,
    fs: expoRestoreFs,
    stagingRoot: stripScheme(Paths.cache.uri),
    newId: () => Crypto.randomUUID(),
    now: () => Date.now(),
    yieldTick: () => new Promise((r) => setTimeout(r, 0)),
    onProgress,
    readSecret: (name) => SecureStore.getItemAsync(name),
    inspectStagedDatabase,
    readLiveSummary,
    createSafetyBackup: (pass, confirm) => createEncryptedBackup(s, pass, confirm),
    flushAudit: () => flushAuditQueue(),
    getLiveAuditSeq,
    // غير صارم عمداً: التجهيز غير مدمّر، وقد تكون السلسلة نفسها هي سبب الاستعادة. التسجيل الصارم في 10.6.
    logEvent: (e) => recordSystemEvent(s, BACKUP_PERMISSION, {
      operationType: e.operationType, entityType: e.entityType, entityId: e.entityId, newValues: e.newValues, reason: e.reason ?? null,
    }, false),
  };
}

async function authorize(session: Session | null | undefined): Promise<Session> {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);
  return s;
}

// المسار الذي يختاره المدير (محدد ملفات) يُحوَّل إلى مسار نظام ملفات بلا مخطط.
export async function prepareRestoreFromBackup(
  session: Session | null | undefined,
  input: { sourceUri: string; passphrase: string; safetyPassphrase: string; safetyPassphraseConfirmation: string },
  onProgress?: (p: RestorePrepProgress) => void
): Promise<PrepareRestoreResult> {
  const s = await authorize(session);
  return prepareRestore(buildDeps(s, onProgress), {
    userId: s.userId,
    sourcePath: stripScheme(decodeURI(input.sourceUri)),
    passphrase: input.passphrase,
    safetyPassphrase: input.safetyPassphrase,
    safetyPassphraseConfirmation: input.safetyPassphraseConfirmation,
  });
}

export async function getPreparedRestore(session: Session | null | undefined, planId: string): Promise<RestorePlanSummary> {
  const s = await authorize(session);
  const p = getRestorePlan(planId, s.userId, Date.now());
  return summaryOf(p);
}

function summaryOf(p: StoredRestorePlan): RestorePlanSummary {
  const { userId: _u, staged: _s, safety: _f, liveAuditSeqAtPlan: _l, ...summary } = p;
  void _u; void _s; void _f; void _l;
  return summary;
}

// تستدعيها 10.6 قبل الاستبدال مباشرة.
export async function assertPreparedRestoreFresh(session: Session | null | undefined, planId: string): Promise<StoredRestorePlan> {
  const s = await authorize(session);
  return assertRestorePlanFresh(buildDeps(s), planId, s.userId);
}

export async function discardPreparedRestore(session: Session | null | undefined, planId: string): Promise<void> {
  const s = await authorize(session);
  await discardRestorePlan(buildDeps(s), planId, s.userId);
}

// عند بدء التطبيق: الخطط في الذاكرة فقط، فأي مجلد تجهيز متبقٍ هو بقايا تشغيل سابق (الخطط النشطة تُستثنى). لا تتطلب جلسة ولا تمس بيانات حية.
export async function cleanupRestoreStagingOnStartup(): Promise<number> {
  try {
    return await cleanupStaleRestoreStaging(
      { fs: expoRestoreFs, stagingRoot: stripScheme(Paths.cache.uri), now: () => Date.now() }, activeRestorePlanIds()
    );
  } catch {
    return 0;
  }
}

export { RestorePrepError, RESTORE_STAGING_DIR_NAME };
