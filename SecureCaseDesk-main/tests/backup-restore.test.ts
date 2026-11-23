// SECURECASEDESK_PHASE10_S6
// اختبارات المرحلة 10 / القسم 10.6 — تنفيذ الاستعادة. تشغَّل بـ: npm run test:backup-restore
// ملفات حقيقية على القرص + تشفير حقيقي (node:crypto). قاعدة SQLCipher وSecureStore محاكاة (غير متاحتين في Node).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackupPackage, type AttachmentRow, type PackageDeps } from '../src/modules/backup/backup-package';
import type { BackupCryptoProvider } from '../src/modules/backup/backup-format';
import {
  recoverInterruptedRestore, restoreBackupPackage, type DatabaseReport, type RestoreDeps, type RestoreFs, type RestoreJournal,
} from '../src/modules/backup/backup-restore';
import { BackupError, REQUIRED_TABLES, type BackupErrorCode, type DatabaseSnapshot, type SecretSpec } from '../src/modules/backup/backup-types';

const KDF = { logN: 10, r: 8, p: 1 };
const CHUNK = 4096;
const PASS = 'كلمة-مرور-قوية-للنسخة-123';

const nodeCrypto: BackupCryptoProvider = {
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
  sha256: () => { const h = createHash('sha256'); return { update: (b) => { h.update(b); }, digest: () => new Uint8Array(h.digest()) }; },
  scrypt: async (pw, salt, { N, r, p }, len) => new Uint8Array(scryptSync(pw, salt, len, { N, r, p, maxmem: 256 * 1024 * 1024 })),
  hkdfSha256: (m, s, i, l) => new Uint8Array(hkdfSync('sha256', m, s, i, l)),
  aeadEncrypt(key, nonce, aad, plain) {
    const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    c.setAAD(aad);
    return new Uint8Array(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]));
  },
  aeadDecrypt(key, nonce, aad, sealed) {
    const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    d.setAAD(aad);
    d.setAuthTag(sealed.slice(sealed.length - 16));
    return new Uint8Array(Buffer.concat([d.update(sealed.slice(0, sealed.length - 16)), d.final()]));
  },
};

const nodeFs: RestoreFs = {
  async ensureDir(p) { fs.mkdirSync(p, { recursive: true }); },
  async exists(p) { return fs.existsSync(p); },
  async size(p) { return fs.existsSync(p) ? fs.statSync(p).size : 0; },
  async remove(p) { fs.rmSync(p, { recursive: true, force: true }); },
  async move(a, b) { fs.rmSync(b, { recursive: true, force: true }); fs.renameSync(a, b); },
  async openRead(p) {
    const fd = fs.openSync(p, 'r');
    return {
      async read(max) { const b = Buffer.alloc(max); const n = fs.readSync(fd, b, 0, max, null); return new Uint8Array(b.subarray(0, n)); },
      async close() { fs.closeSync(fd); },
    };
  },
  async openWrite(p) {
    const fd = fs.openSync(p, 'w');
    return { async write(bytes) { fs.writeSync(fd, bytes); }, async close() { fs.closeSync(fd); } };
  },
  async list(p) { return fs.existsSync(p) ? fs.readdirSync(p) : []; },
  async readText(p) { return fs.readFileSync(p, 'utf8'); },
  async writeText(p, t) { fs.writeFileSync(p, t, 'utf8'); },
};

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const OK_REPORT: DatabaseReport = { cipherVersion: '4.5.7 community', integrity: 'ok', tables: [...REQUIRED_TABLES] };

const SPECS: SecretSpec[] = [
  { name: 'db_encryption_key', cls: 'required', reason: '' },
  { name: 'securecase_audit_active_version', cls: 'required', reason: '' },
  { name: 'securecase_audit_hmac_key_v1', cls: 'required', reason: '' },
  { name: 'attachment_master_key_v1', cls: 'required', reason: '' },
  { name: 'securecase_audit_checkpoint_key_v1', cls: 'recommended', reason: '' },
  { name: 'securecase_audit_checkpoint_last', cls: 'review', reason: '' },
  { name: 'securecase_session_uid', cls: 'excluded', reason: '' },
  { name: 'securecase_api_token', cls: 'excluded', reason: '' },
];

let root: string, liveDir: string, dbPath: string, attDir: string, stagingRoot: string, safetyRoot: string, journalPath: string, outDir: string;
let store: Map<string, string>;
let ids = 0;
let closes = 0;

// ---- "النظام الحي" الحالي ----
const LIVE_DB = Buffer.from('LIVE-DATABASE-BYTES-' + 'x'.repeat(5000));
const LIVE_ATT_NAME = '11111111-1111-1111-1111-111111111111.enc';
const LIVE_ATT = Buffer.from('live-attachment-data');

// ---- محتوى النسخة ----
let bakDb: Buffer;
let bakAtts: { name: string; data: Buffer; row: AttachmentRow }[];
let bakSecrets: Record<string, string>;

function liveSetup() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, LIVE_DB);
  fs.writeFileSync(dbPath + '-wal', 'live-wal');
  fs.mkdirSync(attDir, { recursive: true });
  fs.writeFileSync(path.join(attDir, LIVE_ATT_NAME), LIVE_ATT);
  store = new Map([
    ['db_encryption_key', 'LIVE-KEY'],
    ['securecase_audit_active_version', '1'],
    ['securecase_audit_hmac_key_v1', 'LIVE-HMAC'],
    ['attachment_master_key_v1', 'LIVE-ATT-KEY'],
    ['securecase_audit_checkpoint_last', 'LIVE-CKPT'],   // غير موجود في النسخة → يجب حذفه ثم إعادته عند التراجع
    ['securecase_session_uid', 'SESSION-LIVE'],
    ['securecase_api_token', 'TOKEN-LIVE'],
  ]);
}

async function makePackage(over: { atts?: number; secrets?: Record<string, string>; specs?: SecretSpec[]; missingActive?: boolean } = {}): Promise<string> {
  const n = over.atts ?? 2;
  bakDb = Buffer.concat([Buffer.from('BACKUP-DATABASE-'), randomBytes(9000)]);
  bakAtts = [];
  const rows: AttachmentRow[] = [];
  const srcAtt = path.join(root, 'bak-src-att');
  fs.mkdirSync(srcAtt, { recursive: true });
  for (let i = 0; i < n; i++) {
    const name = crypto.randomUUID() + '.enc';
    const data = randomBytes(3000 + i * 1000);
    const row: AttachmentRow = { id: crypto.randomUUID(), storage_name: name, status: 'active', sha256_cipher: sha(data), size_bytes: data.length };
    if (!(over.missingActive && i === 0)) fs.writeFileSync(path.join(srcAtt, name), data);
    rows.push(row);
    if (!(over.missingActive && i === 0)) bakAtts.push({ name, data, row });
  }
  bakSecrets = over.secrets ?? {
    db_encryption_key: 'BAK-KEY', securecase_audit_active_version: '1', securecase_audit_hmac_key_v1: 'BAK-HMAC',
    attachment_master_key_v1: 'BAK-ATT-KEY', securecase_audit_checkpoint_key_v1: 'BAK-CKPT-KEY',
  };
  const snapDir = path.join(root, 'snap-' + (++ids));
  fs.mkdirSync(snapDir, { recursive: true });
  const snapDb = path.join(snapDir, 'database.snapshot');
  fs.writeFileSync(snapDb, bakDb);
  const snapshot: DatabaseSnapshot = {
    snapshotId: 'snap' + ids, directory: snapDir, databasePath: snapDb, manifestPath: '', attempts: 1,
    manifest: { formatVersion: 1, kind: 'database-snapshot', snapshotId: 'snap' + ids, createdAt: 1, databaseFileName: 'securecase.db',
      sizeBytes: bakDb.length, sha256: sha(bakDb), journalMode: 'delete', cipherVersion: '4.5.7' },
  };
  const pdeps: PackageDeps = {
    crypto: nodeCrypto, fs: nodeFs, kdf: KDF, chunkSize: CHUNK, outputDir: outDir,
    takeSnapshot: async () => snapshot, discardSnapshot: async () => {},
    readAttachmentRows: async () => rows,
    attachmentPath: (name) => path.join(srcAtt, name),
    secretSpecs: over.specs ?? SPECS,
    readSecret: async (name) => bakSecrets[name] ?? null,
    newId: () => 'bk-' + (++ids), now: () => 1_700_000_000_000 + ids,
  };
  const r = await createBackupPackage(pdeps, PASS, PASS);
  return r.filePath;
}

interface Hooks {
  validate?: (p: string, key: string) => Promise<DatabaseReport>;
  reopen?: () => Promise<DatabaseReport>;
  moveFailAfter?: number;          // بعد N عمليات move تفشل كل الباقي (يحاكي موت العملية)
  flush?: () => Promise<void>;
}

let moves = 0;
let moveBroken = false;
function rdeps(h: Hooks = {}): RestoreDeps {
  moves = 0;
  moveBroken = false;
  const faultyFs: RestoreFs = {
    ...nodeFs,
    async move(a, b) {
      if (moveBroken || (h.moveFailAfter !== undefined && ++moves > h.moveFailAfter)) { moveBroken = true; throw new Error('io error'); }
      return nodeFs.move(a, b);
    },
  };
  return {
    crypto: nodeCrypto, fs: faultyFs, stagingRoot, safetyRoot, journalPath, dbPath, attachmentsDir: attDir,
    secretSpecs: SPECS,
    readSecret: async (n) => store.get(n) ?? null,
    writeSecret: async (n, v) => { store.set(n, v); },
    deleteSecret: async (n) => { store.delete(n); },
    validateStagedDatabase: h.validate ?? (async (p) => {
      assert.ok(fs.readFileSync(p).equals(bakDb), 'staged db must equal backup db');
      return OK_REPORT;
    }),
    closeDatabase: async () => { closes++; },
    reopenAndVerify: h.reopen ?? (async () => OK_REPORT),
    flushPending: h.flush,
    newId: () => 'rs-' + (++ids), now: () => 1_800_000_000_000 + ids,
  };
}

const run = (d: RestoreDeps, file: string, pass = PASS, confirmed = true) =>
  restoreBackupPackage(d, { filePath: file, passphrase: pass, confirmed });

async function code(p: Promise<unknown>): Promise<BackupErrorCode> {
  try { await p; } catch (e) { if (e instanceof BackupError) return e.code; throw e; }
  throw new Error('expected BackupError');
}

function assertLiveUntouched() {
  assert.ok(fs.readFileSync(dbPath).equals(LIVE_DB));
  assert.equal(fs.readFileSync(dbPath + '-wal', 'utf8'), 'live-wal');
  assert.deepEqual(fs.readdirSync(attDir), [LIVE_ATT_NAME]);
  assert.ok(fs.readFileSync(path.join(attDir, LIVE_ATT_NAME)).equals(LIVE_ATT));
  assert.equal(store.get('db_encryption_key'), 'LIVE-KEY');
  assert.equal(store.get('securecase_audit_hmac_key_v1'), 'LIVE-HMAC');
  assert.equal(store.get('securecase_audit_checkpoint_last'), 'LIVE-CKPT');
  assert.equal(store.get('securecase_session_uid'), 'SESSION-LIVE');
  assert.equal(store.get('securecase_api_token'), 'TOKEN-LIVE');
  assert.equal([...store.keys()].filter((k) => k.startsWith('restore_safety_')).length, 0, 'no stash leftovers');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-restore-'));
  liveDir = path.join(root, 'live');
  dbPath = path.join(liveDir, 'SQLite', 'securecase.db');
  attDir = path.join(liveDir, 'attachments');
  stagingRoot = path.join(root, 'cache', 'restore-staging');
  safetyRoot = path.join(liveDir, 'restore-safety');
  journalPath = path.join(liveDir, 'restore-journal.json');
  outDir = path.join(root, 'backups');
  closes = 0;
  liveSetup();
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('10.6 الاستعادة — المسار الناجح', () => {
  test('استبدال كامل: القاعدة والمرفقات والأسرار، وبقاء excluded', async () => {
    const file = await makePackage();
    const res = await run(rdeps(), file);

    assert.ok(fs.readFileSync(dbPath).equals(bakDb));
    assert.equal(fs.existsSync(dbPath + '-wal'), false, 'لا مصاحبات قاعدة قديمة');
    const names = fs.readdirSync(attDir).sort();
    assert.deepEqual(names, bakAtts.map((a) => a.name).sort());
    for (const a of bakAtts) assert.ok(fs.readFileSync(path.join(attDir, a.name)).equals(a.data));

    assert.equal(store.get('db_encryption_key'), 'BAK-KEY');
    assert.equal(store.get('securecase_audit_hmac_key_v1'), 'BAK-HMAC');
    assert.equal(store.get('attachment_master_key_v1'), 'BAK-ATT-KEY');
    assert.equal(store.has('securecase_audit_checkpoint_last'), false, 'سر القاعدة القديمة غير الموجود في النسخة يُحذف');
    assert.equal(store.get('securecase_session_uid'), 'SESSION-LIVE');
    assert.equal(store.get('securecase_api_token'), 'TOKEN-LIVE');

    assert.equal(res.requiresRelogin, true);
    assert.equal(res.attachmentsRestored, 2);
    assert.equal(res.warnings.length, 0);
    assert.ok(closes >= 1);
  });

  test('نسخة الأمان تحوي القاعدة والمرفقات والأسرار الأصلية، والسجل committed، والتجهيز محذوف', async () => {
    const file = await makePackage();
    const res = await run(rdeps(), file);
    assert.ok(fs.readFileSync(path.join(res.safetyDir, 'securecase.db')).equals(LIVE_DB));
    assert.equal(fs.readFileSync(path.join(res.safetyDir, 'securecase.db-wal'), 'utf8'), 'live-wal');
    assert.ok(fs.readFileSync(path.join(res.safetyDir, 'attachments', LIVE_ATT_NAME)).equals(LIVE_ATT));
    const j = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as RestoreJournal;
    assert.equal(j.state, 'committed');
    assert.ok(j.stashedSecrets.includes('db_encryption_key'));
    assert.equal(JSON.stringify(j).includes('LIVE-KEY'), false, 'السجل لا يحوي قيم أسرار');
    const stash = [...store.entries()].filter(([k]) => k.startsWith('restore_safety_'));
    assert.ok(stash.some(([, v]) => v === 'LIVE-KEY'));
    assert.equal(fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).length : 0, 0);
  });

  test('نسخة بلا مرفقات', async () => {
    const file = await makePackage({ atts: 0 });
    await run(rdeps(), file);
    assert.deepEqual(fs.readdirSync(attDir), []);
    assert.ok(fs.readFileSync(dbPath).equals(bakDb));
  });

  test('مرفق نشط ناقص وقت النسخ: تنجح الاستعادة مع تحذير', async () => {
    const file = await makePackage({ atts: 2, missingActive: true });
    const res = await run(rdeps(), file);
    assert.equal(res.attachmentsRestored, 1);
    assert.equal(res.warnings[0].code, 'ATTACHMENT_FILE_MISSING');
  });

  test('يستدعي flushPending قبل لمس البيانات', async () => {
    const file = await makePackage();
    let flushed = false;
    await run(rdeps({ flush: async () => { flushed = true; assert.ok(fs.readFileSync(dbPath).equals(LIVE_DB)); } }), file);
    assert.equal(flushed, true);
  });
});

describe('10.6 الاستعادة — رفض قبل أي تعديل', () => {
  test('بلا تأكيد صريح', async () => {
    const file = await makePackage();
    assert.equal(await code(run(rdeps(), file, PASS, false)), 'RESTORE_NOT_CONFIRMED');
    assertLiveUntouched();
  });

  test('كلمة مرور خاطئة', async () => {
    const file = await makePackage();
    assert.equal(await code(run(rdeps(), file, 'كلمة-خاطئة-تماماً-999')), 'PACKAGE_AUTH_FAILED');
    assertLiveUntouched();
  });

  test('كلمة مرور فارغة', async () => {
    const file = await makePackage();
    assert.equal(await code(run(rdeps(), file, '')), 'INVALID_PASSPHRASE');
    assertLiveUntouched();
  });

  test('ملف غير موجود', async () => {
    assert.equal(await code(run(rdeps(), path.join(root, 'nope.scdbak'))), 'PACKAGE_FORMAT_INVALID');
    assertLiveUntouched();
  });

  test('قلب بايت داخل الملف', async () => {
    const file = await makePackage();
    const buf = fs.readFileSync(file);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    fs.writeFileSync(file, buf);
    const c = await code(run(rdeps(), file));
    assert.ok(c === 'PACKAGE_AUTH_FAILED' || c === 'PACKAGE_FORMAT_INVALID');
    assertLiveUntouched();
  });

  test('ملف مبتور', async () => {
    const file = await makePackage();
    const buf = fs.readFileSync(file);
    fs.writeFileSync(file, buf.subarray(0, buf.length - 100));
    const c = await code(run(rdeps(), file));
    assert.ok(c === 'PACKAGE_AUTH_FAILED' || c === 'PACKAGE_FORMAT_INVALID');
    assertLiveUntouched();
  });

  test('ملف ليس نسخة أصلاً', async () => {
    const file = path.join(root, 'junk.scdbak');
    fs.writeFileSync(file, randomBytes(500));
    assert.equal(await code(run(rdeps(), file)), 'PACKAGE_FORMAT_INVALID');
    assertLiveUntouched();
  });

  test('قاعدة مجهّزة لا تُفتح', async () => {
    const file = await makePackage();
    const c = await code(run(rdeps({ validate: async () => { throw new Error('file is not a database'); } }), file));
    assert.equal(c, 'RESTORE_DATABASE_INVALID');
    assertLiveUntouched();
  });

  test('قاعدة مجهّزة فشل فحص سلامتها أو ينقصها جدول', async () => {
    const file = await makePackage();
    assert.equal(await code(run(rdeps({ validate: async () => ({ ...OK_REPORT, integrity: 'row 3 missing' }) }), file)), 'RESTORE_DATABASE_INVALID');
    assert.equal(await code(run(rdeps({ validate: async () => ({ ...OK_REPORT, tables: ['users'] }) }), file)), 'RESTORE_DATABASE_INVALID');
    assert.equal(await code(run(rdeps({ validate: async () => ({ ...OK_REPORT, cipherVersion: '' }) }), file)), 'RESTORE_DATABASE_INVALID');
    assertLiveUntouched();
  });

  test('نسخة تنقصها أسرار إلزامية', async () => {
    // المُنشئ نفسه يرفض غياب السر الإلزامي، فنخفّض تصنيفه وقت الإنشاء فقط لنحاكي نسخة ناقصة.
    const specs = SPECS.map((s) => (s.name === 'attachment_master_key_v1' ? { ...s, cls: 'recommended' as const } : s));
    const file = await makePackage({ specs, secrets: { db_encryption_key: 'K', securecase_audit_active_version: '1', securecase_audit_hmac_key_v1: 'H' } });
    assert.equal(await code(run(rdeps(), file)), 'RESTORE_SECRETS_INCOMPLETE');
    assertLiveUntouched();
  });

  test('نسخة تحمل سراً مستبعداً (excluded) تُرفض', async () => {
    const specs = SPECS.map((s) => (s.name === 'securecase_session_uid' ? { ...s, cls: 'recommended' as const } : s));
    const file = await makePackage({ specs, secrets: {
      db_encryption_key: 'K', securecase_audit_active_version: '1', securecase_audit_hmac_key_v1: 'H',
      attachment_master_key_v1: 'A', securecase_session_uid: 'EVIL-SESSION' } });
    assert.equal(await code(run(rdeps(), file)), 'RESTORE_PACKAGE_INVALID');
    assertLiveUntouched();
  });

  test('فشل flushPending يوقف الاستعادة قبل اللمس', async () => {
    const file = await makePackage();
    assert.equal(await code(run(rdeps({ flush: async () => { throw new Error('x'); } }), file)), 'RESTORE_FAILED');
    assertLiveUntouched();
  });

  test('استعادتان متزامنتان: الثانية تُرفض', async () => {
    const file = await makePackage();
    const [a, b] = await Promise.allSettled([run(rdeps(), file), run(rdeps(), file)]);
    const codes = [a, b].map((r) => (r.status === 'rejected' ? (r.reason as BackupError).code : 'ok'));
    assert.ok(codes.includes('ok'));
    assert.ok(codes.includes('RESTORE_IN_PROGRESS'));
  });
});

describe('10.6 الاستعادة — التراجع التلقائي', () => {
  test('فشل التحقق بعد إعادة الفتح → عودة كاملة للحالة الأصلية', async () => {
    const file = await makePackage();
    let calls = 0;
    const c = await code(run(rdeps({ reopen: async () => {
      calls++;
      if (calls === 1) return { ...OK_REPORT, integrity: 'corrupt' };
      return OK_REPORT;
    } }), file));
    assert.equal(c, 'RESTORE_ROLLED_BACK');
    assertLiveUntouched();
    const j = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as RestoreJournal;
    assert.equal(j.state, 'rolled-back');
    assert.equal(fs.existsSync(safetyRoot) ? fs.readdirSync(safetyRoot).length : 0, 0);
  });

  test('فشل أثناء نقل المرفقات الجديدة → تراجع', async () => {
    const file = await makePackage();
    // حركات: wal، قاعدة، مرفقات حالية (3)، ثم قاعدة جديدة (4)، مرفقات جديدة (5 ← تفشل)
    const d = rdeps();
    let n = 0;
    const origMove = d.fs.move;
    d.fs = { ...d.fs, move: async (a, b) => {
      if (a.endsWith(path.join('restore-staging').slice(0)) ) return origMove(a, b);
      if (path.basename(b) === 'attachments' && a.includes('restore-')) { n++; throw new Error('io error at install attachments'); }
      return origMove(a, b);
    } };
    assert.equal(await code(run(d, file)), 'RESTORE_ROLLED_BACK');
    assert.ok(n >= 1);
    assertLiveUntouched();
  });

  test('انقطاع دائم أثناء التبديل: RESTORE_ROLLBACK_FAILED ثم recoverInterruptedRestore يكمل التراجع', async () => {
    const file = await makePackage();
    // 1: journal.tmp، 2: journal.tmp، 3: wal إلى الأمان، 4: القاعدة، ثم تموت كل العمليات.
    const c = await code(run(rdeps({ moveFailAfter: 4 }), file));
    assert.equal(c, 'RESTORE_ROLLBACK_FAILED');
    const j = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as RestoreJournal;
    assert.ok(j.state === 'swapping' || j.state === 'rollback-failed');
    assert.equal(fs.existsSync(path.join(j.safetyDir, 'securecase.db')), true, 'القاعدة الأصلية آمنة في نسخة الأمان');

    // استعادة جديدة محجوبة حتى يكتمل التراجع
    assert.equal(await code(run(rdeps(), file)), 'RESTORE_PENDING_RECOVERY');

    // إعادة التشغيل: IO سليم
    const out = await recoverInterruptedRestore(rdeps());
    assert.equal(out.action, 'rolled-back');
    assertLiveUntouched();

    // التعافي مثالي التكرار
    assert.equal((await recoverInterruptedRestore(rdeps())).action, 'none');
    // والاستعادة تعمل بعده
    await run(rdeps(), file);
    assert.ok(fs.readFileSync(dbPath).equals(bakDb));
  });

  test('لا شيء للتعافي عند عدم وجود سجل', async () => {
    assert.equal((await recoverInterruptedRestore(rdeps())).action, 'none');
  });

  test('سجل تالف يحجب الاستعادة', async () => {
    fs.writeFileSync(journalPath, '{not json');
    const file = await makePackage();
    assert.equal(await code(run(rdeps(), file)), 'RESTORE_PENDING_RECOVERY');
    assertLiveUntouched();
  });

  test('الاستعادة بعد استعادة ناجحة سابقة (committed) مسموحة', async () => {
    const f1 = await makePackage();
    await run(rdeps(), f1);
    const f2 = await makePackage();
    const r = await run(rdeps(), f2);
    assert.ok(fs.readFileSync(dbPath).equals(bakDb));
    assert.ok(r.restoreId);
  });
});
