// SECURECASEDESK_PHASE10_S5
// اختبارات المرحلة 10 / القسم 10.5 — تجهيز الاستعادة ونسخة الأمان. تشغَّل بـ: npm run test:backup-restore-prep
// ملفات حقيقية على القرص + تشفير حقيقي (node:crypto). قاعدة البيانات مزيفة (SQLCipher غير متاح في Node) عبر دالة الفحص المحقونة.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createBackupPackage, type AttachmentRow, type BackupPackageResult, type PackageFs, type PackageManifest,
} from '../src/modules/backup/backup-package';
import { createDatabaseSnapshot, discardDatabaseSnapshot, type SnapshotFs } from '../src/modules/backup/backup-snapshot';
import {
  RECORD_KIND, SealedWriter, type BackupCryptoProvider,
} from '../src/modules/backup/backup-format';
import { BackupError, REQUIRED_TABLES, type SecretSpec } from '../src/modules/backup/backup-types';
import {
  RESTORE_PLAN_TTL_MS, RestorePrepError, _resetRestorePlansForTests, assertRestorePlanFresh,
  cleanupStaleRestoreStaging, discardRestorePlan, getRestorePlan, hashFile, prepareRestore, verifyBackupFileFully,
  type LiveSummary, type RestoreAuditEvent, type RestorePrepDeps, type StagedDbSummary,
} from '../src/modules/backup/backup-restore-prep';

const CHUNK = 4096;
const KDF = { logN: 10, r: 8, p: 1 };
const PASS = 'كلمة-مرور-النسخة-المصدر-123';
const SAFETY_PASS = 'كلمة-مرور-نسخة-الأمان-456';
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);

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

const snapFs: SnapshotFs = {
  async ensureDir(p) { fs.mkdirSync(p, { recursive: true }); },
  async exists(p) { return fs.existsSync(p); },
  async size(p) { return fs.existsSync(p) ? fs.statSync(p).size : 0; },
  async copy(a, b) { fs.copyFileSync(a, b); },
  async move(a, b) { fs.renameSync(a, b); },
  async remove(p) { fs.rmSync(p, { recursive: true, force: true }); },
  async writeText(p, t) { fs.writeFileSync(p, t, 'utf8'); },
  async sha256File(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); },
};

const nodeFs: PackageFs & { listDirs(p: string): Promise<string[]> } = {
  ...snapFs,
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
  async listDirs(p) {
    if (!fs.existsSync(p)) return [];
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  },
};

class FakeDb {
  async execAsync(_s: string) {}
  async getFirstAsync<T>(sql: string): Promise<T | null> {
    if (sql.includes('journal_mode')) return { journal_mode: 'delete' } as T;
    if (sql.includes('cipher_version')) return { cipher_version: '4.5.7 community' } as T;
    if (sql.includes('wal_autocheckpoint')) return { wal_autocheckpoint: 1000 } as T;
    return null;
  }
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const uuidName = () => crypto.randomUUID() + '.enc';

const DB_KEY = '3f2b8a40-6c1d-4e0f-9a7b-1d2c3e4f5a6b';
const GOOD_SECRETS: Record<string, string> = {
  db_encryption_key: DB_KEY,
  securecase_audit_active_version: '1',
  securecase_audit_hmac_key_v1: 'a1'.repeat(32),
  attachment_master_key_v1: 'b2'.repeat(32),
  securecase_audit_checkpoint_key_v1: 'c3'.repeat(32),
  securecase_audit_checkpoint_last: '{"sequence_no":5,"record_hash":"zz"}',
};
const SPECS: SecretSpec[] = [
  { name: 'db_encryption_key', cls: 'required', reason: '' },
  { name: 'securecase_audit_active_version', cls: 'required', reason: '' },
  { name: 'securecase_audit_hmac_key_v1', cls: 'required', reason: '' },
  { name: 'attachment_master_key_v1', cls: 'required', reason: '' },
  { name: 'securecase_audit_checkpoint_key_v1', cls: 'recommended', reason: '' },
  { name: 'securecase_audit_checkpoint_last', cls: 'review', reason: '' },
  { name: 'securecase_session_uid', cls: 'excluded', reason: '' },
];

// ===== بيئة الاختبار =====
let root: string, cacheDir: string, docsDir: string, backupsDir: string, liveDb: string, liveAttDir: string, srcDir: string;
let liveSeq: number;
let events: RestoreAuditEvent[];
let safetyCalls: number;
let ids = 0;
let sourceDb: Buffer;
let sourceAtts: { id: string; name: string; data: Buffer; status: 'active' | 'deleted' }[];
let liveSecrets: Record<string, string | null>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-restore-'));
  cacheDir = path.join(root, 'cache');
  docsDir = path.join(root, 'documents');
  backupsDir = path.join(docsDir, 'backups');
  liveAttDir = path.join(docsDir, 'attachments');
  srcDir = path.join(root, 'source');
  for (const d of [cacheDir, backupsDir, liveAttDir, srcDir]) fs.mkdirSync(d, { recursive: true });
  liveDb = path.join(docsDir, 'securecase.db');
  fs.writeFileSync(liveDb, randomBytes(9000));
  sourceDb = randomBytes(CHUNK * 3 + 123);
  sourceAtts = [
    { id: crypto.randomUUID(), name: uuidName(), data: randomBytes(5000), status: 'active' },
    { id: crypto.randomUUID(), name: uuidName(), data: randomBytes(CHUNK + 7), status: 'deleted' },
  ];
  liveSeq = 12;
  events = [];
  safetyCalls = 0;
  liveSecrets = { ...GOOD_SECRETS, db_encryption_key: '99999999-aaaa-4bbb-8ccc-dddddddddddd' };
  _resetRestorePlansForTests();
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

// ===== بناء ملفات النسخة =====
interface Rec { kind: number; name: string; data: Uint8Array; meta?: Record<string, unknown> }

async function writePackage(file: string, pass: string, recs: Rec[], opts: { backupId?: string; createdAt?: number } = {}) {
  const header = {
    backupId: opts.backupId ?? 'bk-' + randomBytes(5).toString('hex'), createdAt: opts.createdAt ?? NOW - 86_400_000,
    kdf: KDF, salt: new Uint8Array(randomBytes(16)), chunkSize: CHUNK,
  };
  const w = await SealedWriter.create(nodeCrypto, pass, header, async (b) => { fs.appendFileSync(file, b); });
  for (const r of recs) {
    const meta = new TextEncoder().encode(JSON.stringify({ name: r.name, size: r.data.length, ...(r.meta ?? {}) }));
    const head = new Uint8Array(5 + meta.length);
    head[0] = r.kind;
    new DataView(head.buffer).setUint32(1, meta.length);
    head.set(meta, 5);
    await w.write(head);
    await w.write(r.data);
    await w.write(new Uint8Array(createHash('sha256').update(r.data).digest()));
  }
  await w.finish();
  return header;
}

function stdRecords(over: {
  secrets?: Record<string, unknown>; db?: Buffer; atts?: typeof sourceAtts; backupId?: string; createdAt?: number;
  mutateManifest?: (m: PackageManifest) => void; attachmentName?: string;
} = {}): { recs: Rec[]; backupId: string; createdAt: number } {
  const backupId = over.backupId ?? 'bk-' + randomBytes(5).toString('hex');
  const createdAt = over.createdAt ?? NOW - 86_400_000;
  const db = over.db ?? sourceDb;
  const atts = over.atts ?? sourceAtts;
  const secretsBytes = Buffer.from(JSON.stringify(over.secrets ?? GOOD_SECRETS));
  const recs: Rec[] = [
    { kind: RECORD_KIND.database, name: 'securecase.db', data: db },
    { kind: RECORD_KIND.secrets, name: 'secrets.json', data: secretsBytes },
    ...atts.map((a) => ({
      kind: RECORD_KIND.attachment, name: over.attachmentName ?? a.name, data: a.data, meta: { id: a.id, status: a.status },
    })),
  ];
  const manifest: PackageManifest = {
    formatVersion: 1, kind: 'backup-package', backupId, createdAt, appName: 'SecureCaseDesk',
    database: { databaseFileName: 'securecase.db', size: db.length, sha256: sha(db), journalMode: 'delete', cipherVersion: '4.5.7', snapshotId: 's1' },
    secrets: [],
    attachments: {
      count: atts.length, totalBytes: atts.reduce((s, a) => s + a.data.length, 0),
      entries: atts.map((a) => ({ id: a.id, name: over.attachmentName ?? a.name, size: a.data.length, sha256: sha(a.data), status: a.status, matchesRecorded: true })),
      missing: [],
    },
    records: recs.map((r) => ({ kind: r.kind, name: r.name, size: r.data.length, sha256: sha(r.data) })),
  };
  over.mutateManifest?.(manifest);
  recs.push({ kind: RECORD_KIND.manifest, name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  return { recs, backupId, createdAt };
}

async function makeSource(over: Parameters<typeof stdRecords>[0] = {}, pass = PASS): Promise<string> {
  const file = path.join(srcDir, 'source-' + ++ids + '.scdbak');
  const { recs, backupId, createdAt } = stdRecords(over);
  await writePackage(file, pass, recs, { backupId, createdAt });
  return file;
}

// نسخة أمان حقيقية بواسطة createBackupPackage (نفس مسار 10.3).
async function realSafetyBackup(pass: string, confirm: string): Promise<BackupPackageResult> {
  safetyCalls++;
  const rows: AttachmentRow[] = [];
  const blobs: string[] = [];
  const d = createBackupPackageDeps(rows, blobs);
  return createBackupPackage(d, pass, confirm);
}

function createBackupPackageDeps(rows: AttachmentRow[], _b: string[]) {
  const stagingRoot = path.join(root, 'safety-staging');
  return {
    crypto: nodeCrypto, fs: nodeFs, kdf: KDF, chunkSize: CHUNK, outputDir: backupsDir,
    takeSnapshot: () => createDatabaseSnapshot({
      db: new FakeDb(), fs: snapFs, databasePath: liveDb, stagingRoot, newId: () => 'snap-' + ++ids, now: () => NOW,
    }),
    discardSnapshot: async (s: Parameters<typeof discardDatabaseSnapshot>[1]) => { await discardDatabaseSnapshot({ fs: snapFs, stagingRoot }, s); },
    readAttachmentRows: async () => rows.map((r) => ({ ...r })),
    attachmentPath: (n: string) => path.join(liveAttDir, n),
    secretSpecs: SPECS,
    readSecret: async (n: string) => liveSecrets[n] ?? null,
    newId: () => 'safety-' + randomBytes(6).toString('hex'),
    now: () => NOW,
  };
}

function goodSummary(over: Partial<StagedDbSummary> = {}): StagedDbSummary {
  return {
    cipherVersion: '4.5.7 community', integrityOk: true, tablesPresent: [...REQUIRED_TABLES],
    counts: { users: 2, cases: 40, memos: 11, detainees: 7, audit_logs: 10, attachments: 2 },
    activeAdmins: 1, auditMaxSeq: 10, auditKeyVersions: [1], deviceId: 'dev-backup',
    attachmentRows: sourceAtts.map((a) => ({ id: a.id, storage_name: a.name, status: a.status, sha256_cipher: sha(a.data) })),
    ...over,
  };
}

function mkDeps(over: Partial<RestorePrepDeps> & { summary?: () => Promise<StagedDbSummary>; live?: Partial<LiveSummary> } = {}): RestorePrepDeps {
  const { summary, live, ...rest } = over;
  return {
    crypto: nodeCrypto, fs: nodeFs, stagingRoot: cacheDir,
    newId: () => 'plan-' + randomBytes(6).toString('hex'),
    now: () => NOW,
    readSecret: async (n) => liveSecrets[n] ?? null,
    inspectStagedDatabase: summary ? async () => summary() : async () => goodSummary(),
    readLiveSummary: async () => ({
      counts: { users: 3, cases: 55, memos: 20, detainees: 9, audit_logs: 12 }, auditMaxSeq: liveSeq,
      externalCheckpointSeq: 12, deviceId: 'dev-live', ...(live ?? {}),
    }),
    createSafetyBackup: realSafetyBackup,
    flushAudit: async () => {},
    getLiveAuditSeq: async () => liveSeq,
    logEvent: async (e) => { events.push(e); liveSeq++; },
    ...rest,
  };
}

const input = (src: string, over: Record<string, unknown> = {}) => ({
  userId: 'admin-1', sourcePath: src, passphrase: PASS, safetyPassphrase: SAFETY_PASS, safetyPassphraseConfirmation: SAFETY_PASS, ...over,
});

const stagingDirs = () => (fs.existsSync(path.join(cacheDir, 'restore-staging')) ? fs.readdirSync(path.join(cacheDir, 'restore-staging')) : []);

async function rejectsWith(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (e: unknown) => (e as { code?: string }).code === code, 'متوقع الرمز ' + code);
}

// ===== الاختبارات =====
describe('10.5 — التجهيز الناجح', () => {
  test('نسخة 10.3 الحقيقية: تُفك بنفس البايتات وتُبنى خطة جاهزة', async () => {
    // مصدر حقيقي من createBackupPackage (وليس من كاتب الاختبار) لضمان توافق المحلّل مع مخرجات 10.3.
    const att = { id: crypto.randomUUID(), storage_name: uuidName(), status: 'active' as const };
    const attData = randomBytes(6000);
    fs.writeFileSync(path.join(liveAttDir, att.storage_name), attData);
    const rows: AttachmentRow[] = [{ ...att, sha256_cipher: sha(attData), size_bytes: attData.length }];
    const d = createBackupPackageDeps(rows, []);
    const outDir = path.join(srcDir, 'real');
    const made = await createBackupPackage({ ...d, outputDir: outDir }, PASS, PASS);

    const staged: string[] = [];
    const res = await prepareRestore(mkDeps({
      summary: async () => goodSummary({ attachmentRows: [{ id: att.id, storage_name: att.storage_name, status: 'active', sha256_cipher: sha(attData) }] }),
    }), input(made.filePath));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    const plan = getRestorePlan(res.plan.planId, 'admin-1', NOW);
    assert.equal(sha(fs.readFileSync(plan.staged.databasePath)), sha(fs.readFileSync(liveDb)));
    assert.deepEqual(fs.readFileSync(path.join(plan.staged.attachmentsDir, att.storage_name)), attData);
    staged.push(plan.staged.dir);
    assert.equal(res.plan.report.canProceed, true);
  });

  test('نسخة اختبارية: بايتات القاعدة والمرفقات مطابقة، والخطة والتقرير سليمان', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    const plan = getRestorePlan(res.plan.planId, 'admin-1', NOW);
    assert.deepEqual(fs.readFileSync(plan.staged.databasePath), sourceDb);
    for (const a of sourceAtts) assert.deepEqual(fs.readFileSync(path.join(plan.staged.attachmentsDir, a.name)), a.data);
    assert.equal(res.plan.stagedDatabaseSha256, sha(sourceDb));
    assert.equal(res.plan.expiresAt, NOW + RESTORE_PLAN_TTL_MS);
    assert.equal(res.plan.report.blockers.length, 0);
    assert.equal(res.plan.report.backup.attachmentsCount, 2);
    // checkpoint_last لا يُستعاد أبداً، والباقي معروف.
    assert.ok(!res.plan.report.decisions.secretsToRestore.includes('securecase_audit_checkpoint_last'));
    assert.deepEqual(res.plan.report.decisions.secretsIgnored, ['securecase_audit_checkpoint_last']);
    assert.equal(res.plan.report.decisions.deviceId, 'regenerate-always');
    assert.equal(res.plan.report.secrets.find((s) => s.name === 'db_encryption_key')?.status, 'different');
    assert.equal(res.plan.report.secrets.find((s) => s.name === 'securecase_audit_hmac_key_v1')?.status, 'same');
    assert.ok(res.plan.report.warnings.some((w) => w.code === 'DB_KEY_WILL_CHANGE'));
    assert.ok(res.plan.report.warnings.some((w) => w.code === 'BACKUP_FROM_OTHER_DEVICE'));
  });

  test('نسخة الأمان: ملف PreRestore-* يمرّ التحقق الكامل ويحوي الحالة الحية', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    assert.match(res.plan.safetyBackup.fileName, /^PreRestore-\d{8}-\d{6}-[0-9a-z]{8}\.scdbak$/);
    const plan = getRestorePlan(res.plan.planId, 'admin-1', NOW);
    assert.ok(fs.existsSync(plan.safety.filePath));
    assert.ok(!fs.readdirSync(backupsDir).some((n) => n.startsWith('SecureCaseDesk-')), 'لا يبقى الاسم القديم');
    await verifyBackupFileFully({ crypto: nodeCrypto, fs: nodeFs }, plan.safety.filePath, SAFETY_PASS,
      { backupId: plan.safety.backupId, sizeBytes: plan.safety.sizeBytes, sha256: plan.safety.sha256 });
    // الاستعادة لم تمسّ القاعدة الحية.
    assert.equal(fs.readFileSync(liveDb).length, 9000);
    assert.equal(safetyCalls, 1);
  });

  test('تسجيل التدقيق: أحداث بالترتيب، بلا قيم أسرار ولا كلمات مرور', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    assert.deepEqual(events.map((e) => e.operationType), ['backup_safety_create', 'restore_prepare']);
    const blob = JSON.stringify([events, res]);
    for (const secret of [DB_KEY, GOOD_SECRETS.securecase_audit_hmac_key_v1, GOOD_SECRETS.attachment_master_key_v1, PASS, SAFETY_PASS]) {
      assert.ok(!blob.includes(secret), 'تسرّب قيمة سرية');
    }
  });

  test('خطة جديدة تُلغي السابقة وتنظّف مجلدها', async () => {
    const src = await makeSource();
    const a = await prepareRestore(mkDeps(), input(src));
    const b = await prepareRestore(mkDeps(), input(src));
    assert.equal(a.status, 'ready'); assert.equal(b.status, 'ready');
    if (a.status !== 'ready' || b.status !== 'ready') return;
    assert.throws(() => getRestorePlan(a.plan.planId, 'admin-1', NOW), (e: unknown) => (e as RestorePrepError).code === 'PLAN_NOT_FOUND');
    assert.deepEqual(stagingDirs(), [b.plan.planId]);
  });
});

describe('10.5 — الإخفاق والتنظيف', () => {
  test('كلمة مرور خاطئة: خطأ مصادقة، لا مجلد تجهيز، ولا نسخة أمان', async () => {
    const src = await makeSource();
    await rejectsWith(() => prepareRestore(mkDeps(), input(src, { passphrase: 'كلمة-خاطئة-تماماً-999' })), 'PACKAGE_AUTH_FAILED');
    assert.deepEqual(stagingDirs(), []);
    assert.equal(safetyCalls, 0);
  });

  test('بايت مقلوب في النسخة أو ملف مبتور: يفشل وينظَّف', async () => {
    const src = await makeSource();
    const buf = fs.readFileSync(src);
    const flipped = Buffer.from(buf); flipped[buf.length - 40] ^= 0xff;
    const f1 = path.join(srcDir, 'flip.scdbak'); fs.writeFileSync(f1, flipped);
    const f2 = path.join(srcDir, 'cut.scdbak'); fs.writeFileSync(f2, buf.subarray(0, buf.length - 500));
    for (const f of [f1, f2]) {
      await assert.rejects(() => prepareRestore(mkDeps(), input(f)), (e: unknown) => e instanceof BackupError);
    }
    assert.deepEqual(stagingDirs(), []);
    assert.equal(safetyCalls, 0);
  });

  test('مدخلات غير صالحة: امتداد خاطئ/.partial/كلمة أمان ضعيفة أو غير مطابقة', async () => {
    const src = await makeSource();
    await rejectsWith(() => prepareRestore(mkDeps(), input(path.join(srcDir, 'x.zip'))), 'INVALID_INPUT');
    await rejectsWith(() => prepareRestore(mkDeps(), input(src + '.partial')), 'INVALID_INPUT');
    await rejectsWith(() => prepareRestore(mkDeps(), input(src, { safetyPassphrase: 'قصيرة', safetyPassphraseConfirmation: 'قصيرة' })), 'INVALID_PASSPHRASE');
    await rejectsWith(() => prepareRestore(mkDeps(), input(src, { safetyPassphraseConfirmation: SAFETY_PASS + 'x' })), 'INVALID_PASSPHRASE');
    await rejectsWith(() => prepareRestore(mkDeps(), input(path.join(srcDir, 'missing.scdbak'))), 'SOURCE_NOT_FOUND');
    assert.deepEqual(stagingDirs(), []);
  });

  test('فشل إنشاء نسخة الأمان: لا خطة ولا بقايا، والرمز SAFETY_BACKUP_FAILED', async () => {
    const src = await makeSource();
    await rejectsWith(() => prepareRestore(mkDeps({ createSafetyBackup: async () => { throw new Error('disk full'); } }), input(src)), 'SAFETY_BACKUP_FAILED');
    assert.deepEqual(stagingDirs(), []);
    assert.deepEqual(events, []);
  });

  test('نسخة أمان بصمتها لا تطابق ما كُتب: تُحذف ويُرفض', async () => {
    const src = await makeSource();
    let produced = '';
    const lying = async (p: string, c: string) => { const r = await realSafetyBackup(p, c); produced = r.filePath; return { ...r, sha256: '0'.repeat(64) }; };
    await rejectsWith(() => prepareRestore(mkDeps({ createSafetyBackup: lying }), input(src)), 'SAFETY_BACKUP_FAILED');
    assert.ok(produced && !fs.existsSync(produced), 'الملف غير الموثوق يجب أن يُحذف');
    assert.deepEqual(stagingDirs(), []);
  });

  test('نسخة أمان بها بايتات زائدة بعد النهاية: يرفضها التحقق الكامل', async () => {
    const r = await realSafetyBackup(SAFETY_PASS, SAFETY_PASS);
    fs.appendFileSync(r.filePath, Buffer.from([1, 2, 3]));
    await rejectsWith(() => verifyBackupFileFully({ crypto: nodeCrypto, fs: nodeFs }, r.filePath, SAFETY_PASS,
      { backupId: r.backupId, sizeBytes: r.sizeBytes + 3, sha256: r.sha256 }), 'SAFETY_BACKUP_FAILED');
  });

  test('تزامن: تجهيزان معاً → الثاني RESTORE_IN_PROGRESS والأول يكتمل', async () => {
    const src = await makeSource();
    const first = prepareRestore(mkDeps(), input(src));
    await rejectsWith(() => prepareRestore(mkDeps(), input(src)), 'RESTORE_IN_PROGRESS');
    assert.equal((await first).status, 'ready');
  });
});

describe('10.5 — الموانع (لا تُنشأ نسخة أمان ولا تبقى بقايا)', () => {
  async function blockedWith(over: Parameters<typeof stdRecords>[0], dep: Parameters<typeof mkDeps>[0] = {}) {
    events.length = 0; _resetRestorePlansForTests();
    const src = await makeSource(over);
    const res = await prepareRestore(mkDeps(dep), input(src));
    assert.equal(res.status, 'blocked');
    assert.equal(safetyCalls, 0, 'لا نسخة أمان عند وجود مانع');
    assert.deepEqual(stagingDirs(), []);
    assert.deepEqual(events.map((e) => e.operationType), ['restore_prepare_blocked']);
    return res.status === 'blocked' ? res.report.blockers.map((b) => b.code) : [];
  }

  test('لا مدير نشط في قاعدة النسخة', async () => {
    assert.ok((await blockedWith({}, { summary: async () => goodSummary({ activeAdmins: 0 }) })).includes('NO_ACTIVE_ADMIN'));
  });
  test('مفتاح HMAC لإصدار مسجّل غير موجود', async () => {
    const { securecase_audit_hmac_key_v1: _x, ...rest } = GOOD_SECRETS; void _x;
    assert.ok((await blockedWith({ secrets: rest })).includes('AUDIT_KEY_MISSING'));
  });
  test('إصدار HMAC ثانٍ مسجّل في القاعدة ومفتاحه غائب', async () => {
    assert.ok((await blockedWith({}, { summary: async () => goodSummary({ auditKeyVersions: [1, 2] }) })).includes('AUDIT_KEY_MISSING'));
  });
  test('مفتاح القاعدة غائب', async () => {
    const { db_encryption_key: _x, ...rest } = GOOD_SECRETS; void _x;
    assert.ok((await blockedWith({ secrets: rest })).includes('DB_KEY_MISSING_IN_BACKUP'));
  });
  test('مفتاح قاعدة بصيغة حقن SQL: يُرفض ولا تُستدعى دالة الفحص أصلاً', async () => {
    let inspected = 0;
    const evil = { ...GOOD_SECRETS, db_encryption_key: "x'; DROP TABLE users; --" };
    const codes = await blockedWith({ secrets: evil }, { summary: async () => { inspected++; return goodSummary(); } });
    assert.ok(codes.includes('SECRET_VALUE_INVALID') || codes.includes('DB_KEY_INVALID'));
    assert.equal(inspected, 0);
  });
  test('مفتاح المرفقات غائب مع وجود مرفقات', async () => {
    const { attachment_master_key_v1: _x, ...rest } = GOOD_SECRETS; void _x;
    assert.ok((await blockedWith({ secrets: rest })).includes('ATTACHMENT_KEY_MISSING'));
  });
  test('القاعدة المجهّزة لا تُفتح / سلامتها فاشلة / جداول ناقصة', async () => {
    assert.ok((await blockedWith({}, { summary: async () => { throw new Error('file is not a database'); } })).includes('STAGED_DB_UNREADABLE'));
    assert.ok((await blockedWith({}, { summary: async () => goodSummary({ integrityOk: false }) })).includes('STAGED_DB_INTEGRITY_FAILED'));
    assert.ok((await blockedWith({}, { summary: async () => goodSummary({ tablesPresent: ['users'] }) })).includes('MISSING_TABLES'));
  });
  test('نسخة تحوي سرّ جلسة/API (مستبعداً): مرفوضة', async () => {
    assert.ok((await blockedWith({ secrets: { ...GOOD_SECRETS, securecase_session_uid: 'u-1' } })).includes('EXCLUDED_SECRET_IN_BACKUP'));
  });
});

describe('10.5 — حماية البنية (نسخة خبيثة أو مشوّهة)', () => {
  const mustBeInvalid = async (src: string) => {
    await rejectsWith(() => prepareRestore(mkDeps(), input(src)), 'CONTENT_INVALID');
    assert.deepEqual(stagingDirs(), []);
    assert.equal(safetyCalls, 0);
  };

  test('اسم مرفق باجتياز مسار لا يكتب خارج مجلد التجهيز', async () => {
    const src = await makeSource({ attachmentName: '../../evil.enc' });
    await mustBeInvalid(src);
    assert.ok(!fs.existsSync(path.join(root, 'evil.enc')) && !fs.existsSync(path.join(cacheDir, 'evil.enc')));
  });
  test('بصمة قاعدة في البيان تخالف المفكوكة', async () => {
    await mustBeInvalid(await makeSource({ mutateManifest: (m) => { m.database.sha256 = '0'.repeat(64); } }));
  });
  test('بيان يصف مرفقاً غير الموجود', async () => {
    await mustBeInvalid(await makeSource({ mutateManifest: (m) => { m.attachments.entries[0].sha256 = 'f'.repeat(64); } }));
  });
  test('معرّف نسخة في البيان يخالف الترويسة', async () => {
    await mustBeInvalid(await makeSource({ mutateManifest: (m) => { m.backupId = 'other'; } }));
  });
  test('سجلات البيان لا تطابق ما فُكّ (حذف سجل)', async () => {
    await mustBeInvalid(await makeSource({ mutateManifest: (m) => { m.records.pop(); } }));
  });
  test('ترتيب مخالف: الأسرار قبل القاعدة', async () => {
    const { recs, backupId, createdAt } = stdRecords();
    [recs[0], recs[1]] = [recs[1], recs[0]];
    const f = path.join(srcDir, 'order.scdbak');
    await writePackage(f, PASS, recs, { backupId, createdAt });
    await mustBeInvalid(f);
  });
  test('بلا بيان في النهاية', async () => {
    const { recs, backupId, createdAt } = stdRecords();
    recs.pop();
    const f = path.join(srcDir, 'nomanifest.scdbak');
    await writePackage(f, PASS, recs, { backupId, createdAt });
    await mustBeInvalid(f);
  });
  test('مرفق مكرر الاسم', async () => {
    const dup = [sourceAtts[0], { ...sourceAtts[0], id: crypto.randomUUID() }];
    await mustBeInvalid(await makeSource({ atts: dup }));
  });
  test('أسرار بقيم غير نصية أو بنية غير كائن', async () => {
    await mustBeInvalid(await makeSource({ secrets: { ...GOOD_SECRETS, x: 5 } }));
    await mustBeInvalid(await makeSource({ secrets: ['a'] as unknown as Record<string, unknown> }));
  });
  test('سر غير معروف: يُتجاهل بتحذير ولا يُستعاد', async () => {
    const src = await makeSource({ secrets: { ...GOOD_SECRETS, future_feature_key: 'abc' } });
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    assert.ok(res.plan.report.warnings.some((w) => w.code === 'UNKNOWN_SECRET_IGNORED'));
    assert.ok(!res.plan.report.decisions.secretsToRestore.includes('future_feature_key'));
  });
});

describe('10.5 — التراجع في سلسلة التدقيق', () => {
  test('نسخة أقدم من الحالة الحية: تتطلب قبول التراجع وتُظهر عدد السجلات المفقودة', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    assert.equal(res.plan.requiresRollbackAcceptance, true);
    assert.ok(res.plan.report.audit.entriesLostIfRestored >= 2);
    assert.ok(res.plan.report.warnings.some((w) => w.code === 'AUDIT_ROLLBACK'));
    assert.ok(res.plan.report.warnings.some((w) => w.code === 'CHECKPOINT_ROLLBACK'));
  });
  test('نسخة أحدث من الحالة الحية ولا checkpoint أعلى: لا تراجع', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps({ summary: async () => goodSummary({ auditMaxSeq: 500 }), live: { externalCheckpointSeq: null } }), input(src));
    assert.equal(res.status, 'ready');
    if (res.status !== 'ready') return;
    assert.equal(res.plan.requiresRollbackAcceptance, false);
    assert.equal(res.plan.report.audit.entriesLostIfRestored, 0);
  });
  test('نسخة عمرها فوق 30 يوماً: تحذير BACKUP_OLD فقط', async () => {
    const src = await makeSource({ createdAt: NOW - 45 * 86_400_000 });
    const res = await prepareRestore(mkDeps(), input(src));
    assert.equal(res.status, 'ready');
    if (res.status === 'ready') assert.ok(res.plan.report.warnings.some((w) => w.code === 'BACKUP_OLD'));
  });
});

describe('10.5 — دورة حياة الخطة', () => {
  test('خطة مستخدم آخر أو منتهية الصلاحية أو ملغاة', async () => {
    const src = await makeSource();
    const res = await prepareRestore(mkDeps(), input(src));
    if (res.status !== 'ready') throw new Error('expected ready');
    const id = res.plan.planId;
    assert.throws(() => getRestorePlan(id, 'someone-else', NOW), (e: unknown) => (e as RestorePrepError).code === 'PLAN_NOT_FOUND');
    assert.throws(() => getRestorePlan(id, 'admin-1', NOW + RESTORE_PLAN_TTL_MS + 1), (e: unknown) => (e as RestorePrepError).code === 'PLAN_EXPIRED');
    await discardRestorePlan({ fs: nodeFs, stagingRoot: cacheDir }, id, 'someone-else');
    assert.ok(getRestorePlan(id, 'admin-1', NOW));
    await discardRestorePlan({ fs: nodeFs, stagingRoot: cacheDir }, id, 'admin-1');
    assert.throws(() => getRestorePlan(id, 'admin-1', NOW), (e: unknown) => (e as RestorePrepError).code === 'PLAN_NOT_FOUND');
    assert.deepEqual(stagingDirs(), []);
  });

  test('الطزاجة: سليمة فور التجهيز، وتفشل إن تغيّرت البيانات الحية', async () => {
    const src = await makeSource();
    const deps = mkDeps();
    const res = await prepareRestore(deps, input(src));
    if (res.status !== 'ready') throw new Error('expected ready');
    const ok = await assertRestorePlanFresh(deps, res.plan.planId, 'admin-1');
    assert.equal(ok.planId, res.plan.planId);
    liveSeq += 1; // عملية جديدة بعد نسخة الأمان
    await rejectsWith(() => assertRestorePlanFresh(deps, res.plan.planId, 'admin-1'), 'SAFETY_BACKUP_STALE');
  });

  test('الطزاجة: العبث بقاعدة التجهيز أو حذف نسخة الأمان يُكشف', async () => {
    const src = await makeSource();
    const deps = mkDeps();
    const res = await prepareRestore(deps, input(src));
    if (res.status !== 'ready') throw new Error('expected ready');
    const plan = getRestorePlan(res.plan.planId, 'admin-1', NOW);
    const bytes = fs.readFileSync(plan.staged.databasePath); bytes[10] ^= 1;
    fs.writeFileSync(plan.staged.databasePath, bytes);
    await rejectsWith(() => assertRestorePlanFresh(deps, res.plan.planId, 'admin-1'), 'STAGING_TAMPERED');
    fs.writeFileSync(plan.staged.databasePath, sourceDb);
    fs.rmSync(plan.safety.filePath);
    await rejectsWith(() => assertRestorePlanFresh(deps, res.plan.planId, 'admin-1'), 'STAGING_TAMPERED');
  });

  test('تنظيف البقايا: يحذف المجلدات اليتيمة ويستثني الخطط النشطة', async () => {
    const orphan = path.join(cacheDir, 'restore-staging', 'orphan-plan-1');
    fs.mkdirSync(orphan, { recursive: true }); fs.writeFileSync(path.join(orphan, 'database.restore'), 'x');
    const keep = path.join(cacheDir, 'restore-staging', 'keep-plan-22');
    fs.mkdirSync(keep, { recursive: true });
    const n = await cleanupStaleRestoreStaging({ fs: nodeFs, stagingRoot: cacheDir, now: () => NOW }, ['keep-plan-22']);
    assert.equal(n, 1);
    assert.ok(!fs.existsSync(orphan) && fs.existsSync(keep));
  });

  test('hashFile: يطابق sha256 الحقيقي لملف أكبر من قطعة القراءة', async () => {
    const f = path.join(root, 'big.bin'); const data = randomBytes(700_000); fs.writeFileSync(f, data);
    assert.equal(await hashFile(nodeCrypto, nodeFs, f), sha(data));
  });
});
