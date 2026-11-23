// SECURECASEDESK_PHASE10_S3
// اختبارات المرحلة 10 / القسم 10.3 — ملف النسخة المشفّر. تشغَّل بـ: npm run test:backup-package
// ملفات حقيقية على القرص + تشفير حقيقي (ChaCha20-Poly1305 + scrypt عبر node:crypto). قاعدة البيانات مزيفة (SQLCipher غير متاح في Node).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createBackupPackage, type AttachmentRow, type PackageDeps, type PackageFs, type PackageManifest,
} from '../src/modules/backup/backup-package';
import { createDatabaseSnapshot, discardDatabaseSnapshot, type SnapshotFs } from '../src/modules/backup/backup-snapshot';
import {
  PackageReader, RECORD_KIND, type BackupCryptoProvider, type ByteSource,
} from '../src/modules/backup/backup-format';
import { BackupError, type BackupErrorCode, type SecretSpec } from '../src/modules/backup/backup-types';

const CHUNK = 4096;
const KDF = { logN: 10, r: 8, p: 1 };
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

function makeFs(over: { failWriteAt?: number } = {}): PackageFs {
  let writes = 0;
  return {
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
      return {
        async write(bytes) {
          if (over.failWriteAt !== undefined && ++writes === over.failWriteAt) throw new Error('disk full');
          fs.writeSync(fd, bytes);
        },
        async close() { fs.closeSync(fd); },
      };
    },
  };
}

class FakeDb {
  async execAsync(_s: string) {}
  async getFirstAsync<T>(sql: string): Promise<T | null> {
    if (sql.includes('journal_mode')) return { journal_mode: 'delete' } as T;
    if (sql.includes('cipher_version')) return { cipher_version: '4.5.7 community' } as T;
    if (sql.includes('wal_autocheckpoint')) return { wal_autocheckpoint: 1000 } as T;
    return null;
  }
}

const uuidName = () => crypto.randomUUID() + '.enc';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let root: string, dbPath: string, attDir: string, outDir: string, stagingRoot: string;
let dbBytes: Buffer;
let rows: AttachmentRow[];
let blobs: Map<string, Buffer>;
let secretValues: Record<string, string>;
let secretReads: string[];
let discarded: number;
let ids = 0;

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

function addAttachment(size: number, status: 'active' | 'deleted' = 'active', writeFile = true): AttachmentRow {
  const name = uuidName();
  const data = randomBytes(size);
  if (writeFile) { fs.writeFileSync(path.join(attDir, name), data); blobs.set(name, data); }
  const row: AttachmentRow = { id: crypto.randomUUID(), storage_name: name, status, sha256_cipher: sha(data), size_bytes: size };
  rows.push(row);
  return row;
}

const deps = (over: Partial<PackageDeps> = {}): PackageDeps => ({
  crypto: nodeCrypto, fs: makeFs(), kdf: KDF, chunkSize: CHUNK, outputDir: outDir,
  takeSnapshot: () => createDatabaseSnapshot({
    db: new FakeDb(), fs: snapFs, databasePath: dbPath, stagingRoot, newId: () => 'snap-' + ++ids, now: () => 1_700_000_000_000,
  }),
  discardSnapshot: async (s) => { discarded++; await discardDatabaseSnapshot({ fs: snapFs, stagingRoot }, s); },
  readAttachmentRows: async () => rows.map((r) => ({ ...r })),
  attachmentPath: (n) => path.join(attDir, n),
  secretSpecs: SPECS,
  readSecret: async (n) => { secretReads.push(n); return secretValues[n] ?? null; },
  newId: () => 'backup-' + randomBytes(6).toString('hex'),
  now: () => Date.UTC(2026, 10, 20, 12, 30, 45),
  ...over,
});

function sourceOf(buf: Uint8Array): ByteSource {
  let pos = 0;
  return { async read(max) { const part = buf.subarray(pos, pos + max); pos += part.length; return part; } };
}

async function readAll(buf: Uint8Array, pass = PASS) {
  const r = await PackageReader.open(nodeCrypto, pass, sourceOf(buf));
  const out: { kind: number; name: string; meta: Record<string, unknown>; data: Buffer; sha: string }[] = [];
  for (let h = await r.nextRecord(); h; h = await r.nextRecord()) {
    const parts: Uint8Array[] = [];
    const sha256 = await r.readData((c) => { parts.push(c.slice()); });
    out.push({ kind: h.kind, name: h.meta.name, meta: h.meta, data: Buffer.concat(parts), sha: sha256 });
  }
  r.close();
  return { header: r.header, records: out };
}

async function code(p: Promise<unknown>): Promise<BackupErrorCode> {
  try { await p; } catch (e) { assert.ok(e instanceof BackupError, String(e)); return e.code; }
  assert.fail('كان يجب أن يفشل');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-pkg-'));
  dbPath = path.join(root, 'securecase.db');
  attDir = path.join(root, 'attachments');
  outDir = path.join(root, 'backups');
  stagingRoot = path.join(root, 'cache');
  fs.mkdirSync(attDir);
  dbBytes = randomBytes(CHUNK * 5 + 123);
  fs.writeFileSync(dbPath, dbBytes);
  rows = []; blobs = new Map(); secretReads = []; discarded = 0; ids = 0;
  secretValues = {
    db_encryption_key: 'DB-KEY-11111111-2222-3333-4444-555555555555',
    securecase_audit_active_version: '1',
    securecase_audit_hmac_key_v1: 'hmac-secret-value-v1',
    attachment_master_key_v1: 'a'.repeat(64),
    securecase_audit_checkpoint_key_v1: 'checkpoint-key-value',
    securecase_audit_checkpoint_last: '{"seq":5}',
    securecase_session_uid: 'SESSION-USER-SECRET',
    securecase_api_token: 'API-TOKEN-SECRET',
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const outFiles = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir) : []);
const stagingLeft = () => (fs.existsSync(path.join(stagingRoot, 'backup-staging')) ? fs.readdirSync(path.join(stagingRoot, 'backup-staging')) : []);

describe('10.3 — إنشاء الملف والدورة الكاملة', () => {
  test('قاعدة + مرفقات + أسرار تُسترجع بنفس البايتات وبالترتيب والبيان المطابق', async () => {
    addAttachment(10);
    addAttachment(CHUNK);               // مضاعف دقيق لحجم الإطار
    addAttachment(CHUNK * 2);
    addAttachment(CHUNK * 3 + 7);
    addAttachment(50, 'deleted');       // محذوف منطقياً وملفه ما زال موجوداً
    const res = await createBackupPackage(deps(), PASS, PASS);

    assert.equal(res.attachmentsIncluded, 5);
    assert.deepEqual(res.warnings, []);
    assert.match(res.fileName, /^SecureCaseDesk-20261120-123045-[0-9a-zA-Z]{1,8}\.scdbak$/);
    const file = fs.readFileSync(res.filePath);
    assert.equal(res.sizeBytes, file.length);
    assert.equal(res.sha256, sha(file));
    assert.deepEqual(outFiles(), [res.fileName]);

    const { records } = await readAll(file);
    assert.deepEqual(records.map((r) => r.kind),
      [RECORD_KIND.database, RECORD_KIND.secrets, ...rows.map(() => RECORD_KIND.attachment), RECORD_KIND.manifest]);
    assert.deepEqual(records[0].data, dbBytes);
    const secrets = JSON.parse(records[1].data.toString('utf8'));
    for (const n of ['db_encryption_key', 'securecase_audit_hmac_key_v1', 'attachment_master_key_v1', 'securecase_audit_checkpoint_last']) {
      assert.equal(secrets[n], secretValues[n]);
    }
    const atts = records.filter((r) => r.kind === RECORD_KIND.attachment);
    for (const a of atts) assert.deepEqual(a.data, blobs.get(a.name as string));

    const m: PackageManifest = JSON.parse(records[records.length - 1].data.toString('utf8'));
    assert.equal(m.kind, 'backup-package');
    assert.equal(m.attachments.count, 5);
    assert.equal(m.database.sha256, sha(dbBytes));
    assert.equal(m.records.length, records.length - 1);
    m.records.forEach((r, i) => { assert.equal(r.sha256, records[i].sha); assert.equal(r.size, records[i].data.length); });
    assert.ok(m.attachments.entries.every((e) => e.matchesRecorded));
    assert.equal(stagingLeft().length, 0, 'اللقطة المؤقتة تُحذف');
  });

  test('بلا مرفقات: ملف صحيح وعدّاد صفر', async () => {
    const res = await createBackupPackage(deps(), PASS, PASS);
    const { records } = await readAll(fs.readFileSync(res.filePath));
    const m: PackageManifest = JSON.parse(records[records.length - 1].data.toString('utf8'));
    assert.equal(m.attachments.count, 0);
    assert.equal(records.length, 3);
  });

  test('الملف لا يحوي أي نص صريح: القاعدة، الأسرار، المرفقات، أسماء الجداول', async () => {
    addAttachment(2000);
    const res = await createBackupPackage(deps(), PASS, PASS);
    const file = fs.readFileSync(res.filePath);
    assert.equal(file.subarray(0, 6).toString('ascii'), 'SCDBAK');
    const probes: Buffer[] = [
      dbBytes.subarray(0, 64), dbBytes.subarray(CHUNK * 2, CHUNK * 2 + 64),
      Buffer.from('DB-KEY-11111111'), Buffer.from('hmac-secret-value'), Buffer.from(secretValues.attachment_master_key_v1),
      Buffer.from(rows[0].storage_name), Buffer.from(rows[0].id), blobs.get(rows[0].storage_name)!.subarray(0, 64),
      Buffer.from('manifest'), Buffer.from('securecase.db'), Buffer.from('SecureCaseDesk\"'),
    ];
    for (const p of probes) assert.equal(file.indexOf(p), -1, 'تسريب: ' + p.toString('utf8', 0, 24));
  });

  test('نسختان متطابقتا المحتوى تختلفان كلياً (ملح ومفتاح مختلفان)', async () => {
    const a = fs.readFileSync((await createBackupPackage(deps(), PASS)).filePath);
    const b = fs.readFileSync((await createBackupPackage(deps(), PASS)).filePath);
    assert.notDeepEqual(a.subarray(60), b.subarray(60));
    assert.equal(a.length, b.length);
  });
});

describe('10.3 — الأسرار', () => {
  test('المستبعدة لا تُقرأ ولا تُكتب أبداً', async () => {
    const res = await createBackupPackage(deps(), PASS);
    assert.ok(!secretReads.includes('securecase_session_uid'));
    assert.ok(!secretReads.includes('securecase_api_token'));
    const file = fs.readFileSync(res.filePath);
    const { records } = await readAll(file);
    const txt = records[1].data.toString('utf8');
    assert.ok(!txt.includes('SESSION-USER-SECRET') && !txt.includes('API-TOKEN-SECRET'));
    assert.ok(!res.secretsIncluded.includes('securecase_api_token'));
    const m: PackageManifest = JSON.parse(records[records.length - 1].data.toString('utf8'));
    assert.ok(m.secrets.every((s) => s.cls !== 'excluded'));
    assert.deepEqual(m.secrets.find((s) => s.name === 'securecase_audit_checkpoint_last')?.cls, 'review');
  });

  test('سر إلزامي مفقود: NOT_READY دون أي ملف ولا لقطة', async () => {
    delete secretValues.securecase_audit_hmac_key_v1;
    assert.equal(await code(createBackupPackage(deps(), PASS)), 'NOT_READY');
    assert.deepEqual(outFiles(), []);
    assert.equal(stagingLeft().length, 0);
  });

  test('سر موصى به مفقود لا يمنع النسخ', async () => {
    delete secretValues.securecase_audit_checkpoint_key_v1;
    const res = await createBackupPackage(deps(), PASS);
    assert.ok(!res.secretsIncluded.includes('securecase_audit_checkpoint_key_v1'));
  });
});

describe('10.3 — كلمة المرور', () => {
  test('كلمات مرفوضة لا تلمس شيئاً', async () => {
    for (const bad of ['قصيرة', 'aaaaaaaaaaaaaaaa', '            ', 'abababababab']) {
      assert.equal(await code(createBackupPackage(deps(), bad)), 'INVALID_PASSPHRASE', bad);
    }
    assert.equal(await code(createBackupPackage(deps(), PASS, PASS + 'x')), 'INVALID_PASSPHRASE');
    assert.equal(secretReads.length, 0);
    assert.deepEqual(outFiles(), []);
    assert.equal(stagingLeft().length, 0);
  });

  test('التطبيع NFKC: نفس الكلمة بصيغتين يونيكود تفتح النسخة', async () => {
    const composed = 'Pässwörd-Ünïcode-123';
    const decomposed = composed.normalize('NFD');
    const res = await createBackupPackage(deps(), composed);
    const { records } = await readAll(fs.readFileSync(res.filePath), decomposed);
    assert.equal(records.length, 3);
  });

  test('كلمة مرور خاطئة: PACKAGE_AUTH_FAILED', async () => {
    const res = await createBackupPackage(deps(), PASS);
    assert.equal(await code(readAll(fs.readFileSync(res.filePath), PASS + '!')), 'PACKAGE_AUTH_FAILED');
  });
});

describe('10.3 — العبث والترويسة والبث', () => {
  let file: Buffer;
  beforeEach(async () => {
    addAttachment(CHUNK * 3);
    file = fs.readFileSync((await createBackupPackage(deps(), PASS)).filePath);
  });

  test('قلب بايت في منتصف الإطارات يُكتشف', async () => {
    const t = Buffer.from(file);
    t[Math.floor(t.length / 2)] ^= 1;
    assert.equal(await code(readAll(t)), 'PACKAGE_AUTH_FAILED');
  });

  test('تعديل أي بايت في JSON الترويسة يُكتشف (مفتاح/AAD)', async () => {
    const jsonStart = 11;
    const jsonLen = file.readUInt32BE(7);
    for (const off of [0, 20, jsonLen - 3]) {
      const t = Buffer.from(file);
      t[jsonStart + off] = t[jsonStart + off] === 0x31 ? 0x32 : 0x31;
      const c = await code(readAll(t));
      assert.ok(c === 'PACKAGE_AUTH_FAILED' || c === 'PACKAGE_FORMAT_INVALID', c);
    }
  });

  test('بتر الملف (إسقاط الإطار الأخير أو أي جزء) يُكتشف', async () => {
    for (const cut of [1, 17, 4000, file.length - 100]) {
      const c = await code(readAll(file.subarray(0, file.length - cut)));
      assert.ok(c === 'PACKAGE_AUTH_FAILED' || c === 'PACKAGE_FORMAT_INVALID', c);
    }
  });

  test('إضافة بايتات بعد النهاية تُكتشف', async () => {
    const c = await code(readAll(Buffer.concat([file, randomBytes(40)])));
    assert.ok(c === 'PACKAGE_AUTH_FAILED' || c === 'PACKAGE_FORMAT_INVALID', c);
  });

  test('تبديل ترتيب إطارين يُكتشف', async () => {
    const jsonLen = file.readUInt32BE(7);
    let p = 11 + jsonLen;
    const frames: Buffer[] = [];
    while (p < file.length) { const l = file.readUInt32BE(p); frames.push(file.subarray(p, p + 4 + l)); p += 4 + l; }
    assert.ok(frames.length > 4);
    [frames[1], frames[2]] = [frames[2], frames[1]];
    const t = Buffer.concat([file.subarray(0, 11 + jsonLen), ...frames]);
    assert.equal(await code(readAll(t)), 'PACKAGE_AUTH_FAILED');
  });

  test('ملف ليس نسخة / سحر خاطئ / إصدار خاطئ / ترويسة KDF خبيثة', async () => {
    assert.equal(await code(readAll(randomBytes(300))), 'PACKAGE_FORMAT_INVALID');
    assert.equal(await code(readAll(Buffer.alloc(0))), 'PACKAGE_FORMAT_INVALID');
    const v = Buffer.from(file); v[6] = 99;
    assert.equal(await code(readAll(v)), 'PACKAGE_FORMAT_INVALID');
    const jsonLen = file.readUInt32BE(7);
    const json = file.subarray(11, 11 + jsonLen).toString('utf8');
    for (const evil of [json.replace('"logN":10', '"logN":30'), json.replace('"logN":10', '"logN":2'), json.replace('"chunk":4096', '"chunk":99999999999')]) {
      const b = Buffer.from(evil);
      const hdr = Buffer.alloc(11); file.copy(hdr, 0, 0, 11); hdr.writeUInt32BE(b.length, 7);
      assert.equal(await code(readAll(Buffer.concat([hdr, b, file.subarray(11 + jsonLen)]))), 'PACKAGE_FORMAT_INVALID');
    }
  });

  test('القراءة بقطع صغيرة جداً (1 بايت) تعطي النتيجة نفسها', async () => {
    const slow: ByteSource = (() => { let pos = 0; return { async read() { const p = file.subarray(pos, pos + 1); pos += p.length; return p; } }; })();
    const r = await PackageReader.open(nodeCrypto, PASS, slow);
    let n = 0;
    for (let h = await r.nextRecord(); h; h = await r.nextRecord()) { await r.readData(() => {}); n++; }
    assert.equal(n, 4);
  });
});

describe('10.3 — المرفقات: النقص لا يُخفى', () => {
  test('نشط بلا ملف → تحذير وتسجيل في البيان؛ محذوف بلا ملف → طبيعي', async () => {
    addAttachment(100);
    const lost = addAttachment(100, 'active', false);
    addAttachment(100, 'deleted', false);
    const res = await createBackupPackage(deps(), PASS);
    assert.equal(res.attachmentsIncluded, 1);
    assert.deepEqual(res.warnings.map((w) => [w.code, w.ids]), [['ATTACHMENT_FILE_MISSING', [lost.id]]]);
    const { records } = await readAll(fs.readFileSync(res.filePath));
    const m: PackageManifest = JSON.parse(records[records.length - 1].data.toString('utf8'));
    assert.equal(m.attachments.missing.length, 2);
  });

  test('بصمة مخالفة: يُنسخ الملف كما هو ويُسجَّل التحذير', async () => {
    const r = addAttachment(500);
    r.sha256_cipher = '0'.repeat(64);
    const res = await createBackupPackage(deps(), PASS);
    assert.equal(res.attachmentsIncluded, 1);
    assert.deepEqual(res.warnings.map((w) => w.code), ['ATTACHMENT_HASH_MISMATCH']);
    const { records } = await readAll(fs.readFileSync(res.filePath));
    const m: PackageManifest = JSON.parse(records[records.length - 1].data.toString('utf8'));
    assert.equal(m.attachments.entries[0].matchesRecorded, false);
  });

  test('اسم تخزين مشبوه (اجتياز مسار) لا يُقرأ أبداً', async () => {
    fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP');
    rows.push({ id: 'x', storage_name: '../secret.txt', status: 'active', sha256_cipher: '0'.repeat(64), size_bytes: 3 });
    const touched: string[] = [];
    const res = await createBackupPackage(deps({ attachmentPath: (n) => { touched.push(n); return path.join(attDir, n); } }), PASS);
    assert.deepEqual(touched, []);
    assert.deepEqual(res.warnings.map((w) => w.code), ['ATTACHMENT_NAME_INVALID']);
  });

  test('ملفات يتيمة وبقايا .tmp في المجلد لا تدخل النسخة', async () => {
    addAttachment(100);
    fs.writeFileSync(path.join(attDir, uuidName()), randomBytes(77));
    fs.writeFileSync(path.join(attDir, uuidName() + '.tmp'), randomBytes(77));
    const res = await createBackupPackage(deps(), PASS);
    assert.equal(res.attachmentsIncluded, 1);
  });
});

describe('10.3 — الاتساق والفشل والتنظيف', () => {
  test('مرفق أُضيف أثناء اللقطة: تُعاد المحاولة وتنجح', async () => {
    addAttachment(100);
    let calls = 0;
    const res = await createBackupPackage(deps({
      readAttachmentRows: async () => { if (++calls === 2) addAttachment(10); return rows.map((r) => ({ ...r })); },
    }), PASS);
    assert.equal(res.attachmentsIncluded, 2);
    assert.equal(discarded >= 2, true);   // لقطة المحاولة الأولى حُذفت + الأخيرة بعد النجاح
  });

  test('تغيّر مستمر: ATTACHMENTS_CHANGED بلا ملف ولا بقايا', async () => {
    addAttachment(100);
    let calls = 0;
    assert.equal(await code(createBackupPackage(deps({
      readAttachmentRows: async () => { if (++calls % 2 === 0) addAttachment(10); return rows.map((r) => ({ ...r })); },
    }), PASS)), 'ATTACHMENTS_CHANGED');
    assert.deepEqual(outFiles(), []);
    assert.equal(stagingLeft().length, 0);
  });

  test('قرص ممتلئ في منتصف الكتابة: لا ملف ناقص ولا لقطة، والمحاولة التالية تنجح', async () => {
    addAttachment(CHUNK * 4);
    for (const at of [1, 3, 9]) {
      assert.equal(await code(createBackupPackage(deps({ fs: makeFs({ failWriteAt: at }) }), PASS)), 'PACKAGE_FAILED');
      assert.deepEqual(outFiles(), [], 'at=' + at);
      assert.equal(stagingLeft().length, 0);
    }
    const ok = await createBackupPackage(deps(), PASS);
    assert.equal(outFiles().length, 1);
    assert.ok(ok.sizeBytes > 0);
  });

  test('تلف اللقطة بعد إنشائها يُكتشف (بصمة القاعدة)', async () => {
    const d = deps();
    const take = d.takeSnapshot;
    d.takeSnapshot = async () => {
      const s = await take();
      const b = fs.readFileSync(s.databasePath); b[10] ^= 0xff; fs.writeFileSync(s.databasePath, b);
      return s;
    };
    assert.equal(await code(createBackupPackage(d, PASS)), 'PACKAGE_FAILED');
    assert.deepEqual(outFiles(), []);
    assert.equal(stagingLeft().length, 0);
  });

  test('ملف مرفق أقصر مما أُعلن أثناء القراءة: فشل نظيف', async () => {
    addAttachment(CHUNK * 2);
    const base = makeFs();
    const shortFs: PackageFs = { ...base, async size(p) { return p.includes('attachments') ? (await base.size(p)) + 500 : base.size(p); } };
    assert.equal(await code(createBackupPackage(deps({ fs: shortFs }), PASS)), 'PACKAGE_FAILED');
    assert.deepEqual(outFiles(), []);
  });

  test('عمليتان متزامنتان: الثانية BACKUP_IN_PROGRESS والأولى تنجح', async () => {
    addAttachment(CHUNK);
    const first = createBackupPackage(deps(), PASS);
    assert.equal(await code(createBackupPackage(deps(), PASS)), 'BACKUP_IN_PROGRESS');
    await first;
    assert.equal(outFiles().length, 1);
  });

  test('التقدم يُبلَّغ بالمراحل بالترتيب', async () => {
    addAttachment(10);
    const stages: string[] = [];
    await createBackupPackage(deps({ onProgress: (p) => { if (stages[stages.length - 1] !== p.stage) stages.push(p.stage); } }), PASS);
    assert.deepEqual(stages, ['database', 'secrets', 'attachments', 'finalizing']);
  });

  test('مجلد الإخراج يُنشأ عند الحاجة، والأصول لم تُمسّ', async () => {
    addAttachment(100);
    const dbBefore = sha(fs.readFileSync(dbPath));
    const attBefore = [...blobs.keys()].map((n) => sha(fs.readFileSync(path.join(attDir, n))));
    await createBackupPackage(deps(), PASS);
    assert.equal(sha(fs.readFileSync(dbPath)), dbBefore);
    assert.deepEqual([...blobs.keys()].map((n) => sha(fs.readFileSync(path.join(attDir, n)))), attBefore);
    assert.deepEqual(fs.readdirSync(attDir).length, 1);
  });
});
