// SECURECASEDESK_PHASE10_S3
// صيغة ملف النسخة الاحتياطية المشفّر (.scdbak) — صرفة وبالحقن الكامل (تعمل في Node وفي التطبيق بالشيفرة نفسها).
//
// البنية:
//   [ترويسة غير مشفّرة]  "SCDBAK" (6) | إصدار (1) | طول JSON (u32) | JSON {alg,logN,r,p,salt,chunk,id,at,aead}
//   [إطارات مشفّرة]      تكرار:  طول (u32) | نص مشفّر (ChaCha20-Poly1305) = بيانات ≤ chunk + وسم 16
//
// - المفتاح: scrypt(كلمة المرور المطبَّعة NFKC، ملح عشوائي 16 بايت) ثم HKDF-SHA256 مرتبطاً ببصمة الترويسة.
// - كل إطار: nonce = [علم الإطار الأخير (1) | 0 0 0 | عدّاد 64 بت]، و AAD = SHA-256(الترويسة).
//   الترويسة لا يمكن تعديلها (مصادقة)، ولا يمكن إعادة ترتيب الإطارات أو حذف الأخير أو إضافة بعده.
// - داخل التيار المشفّر سجلات:  نوع (1) | طول البيان الوصفي (u32) | JSON وصفي {name,size,..} | البيانات | SHA-256 للبيانات (32).
// الترويسة لا تحمل أعداداً ولا أسماء ولا أي محتوى؛ كل ما عداها مشفّر.

import { BackupError, BACKUP_FILE_MAGIC, BACKUP_FORMAT_VERSION, MIN_BACKUP_PASSPHRASE_LENGTH } from './backup-types';

export interface KdfParams { logN: number; r: number; p: number }

// 2^15 · r=8 ≈ 32 ميغابايت ذاكرة. ⚠️ يُقاس زمنه على الجهاز الفعلي (JavaScript صرف).
export const BACKUP_KDF_DEFAULT: KdfParams = { logN: 15, r: 8, p: 1 };
export const KDF_LOGN_MIN = 10;
export const KDF_LOGN_MAX = 17;                 // سقف يمنع ترويسة خبيثة من استنزاف الذاكرة
export const BACKUP_CHUNK_SIZE = 256 * 1024;
export const CHUNK_SIZE_MIN = 4096;
export const CHUNK_SIZE_MAX = 4 * 1024 * 1024;
export const AEAD_TAG_LENGTH = 16;
export const STREAM_INFO = 'securecasedesk/backup/v1/stream';
export const AEAD_NAME = 'chacha20poly1305-stream';
export const SALT_LENGTH = 16;
export const MAX_META_LENGTH = 64 * 1024;
export const MAX_RECORD_SIZE = 2 ** 40;
export const MIN_DISTINCT_PASSPHRASE_CHARS = 4;

export const RECORD_KIND = { secrets: 1, database: 2, attachment: 3, manifest: 9 } as const;
export type RecordKind = (typeof RECORD_KIND)[keyof typeof RECORD_KIND];

export interface HashStream { update(data: Uint8Array): void; digest(): Uint8Array }

export interface BackupCryptoProvider {
  randomBytes(length: number): Uint8Array;
  sha256(): HashStream;
  scrypt(passphrase: Uint8Array, salt: Uint8Array, params: { N: number; r: number; p: number }, length: number): Promise<Uint8Array>;
  hkdfSha256(master: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array;
  aeadEncrypt(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array; // + وسم
  aeadDecrypt(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array; // يرمي عند الفشل
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new BackupError('PACKAGE_FORMAT_INVALID');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function sha256Of(p: BackupCryptoProvider, data: Uint8Array): Uint8Array {
  const h = p.sha256();
  h.update(data);
  return h.digest();
}

// ===== كلمة المرور =====

export function normalizePassphrase(raw: string): string {
  return raw.normalize('NFKC');
}

// سياسة الكتابة فقط (القراءة لا تفرضها كي لا تُحجب نسخة قديمة بسبب سياسة أحدث).
export function assertPassphraseAcceptable(raw: unknown, confirmation?: unknown): string {
  if (typeof raw !== 'string') throw new BackupError('INVALID_PASSPHRASE');
  const n = normalizePassphrase(raw);
  const chars = Array.from(n);
  if (chars.length < MIN_BACKUP_PASSPHRASE_LENGTH) throw new BackupError('INVALID_PASSPHRASE');
  if (new Set(chars).size < MIN_DISTINCT_PASSPHRASE_CHARS) throw new BackupError('INVALID_PASSPHRASE');
  if (n.trim().length === 0) throw new BackupError('INVALID_PASSPHRASE');
  if (confirmation !== undefined && (typeof confirmation !== 'string' || normalizePassphrase(confirmation) !== n)) {
    throw new BackupError('INVALID_PASSPHRASE');
  }
  return n;
}

// ===== الترويسة =====

export interface BackupHeader {
  backupId: string;
  createdAt: number;
  kdf: KdfParams;
  salt: Uint8Array;
  chunkSize: number;
}

const PREAMBLE_LENGTH = BACKUP_FILE_MAGIC.length + 1 + 4;

export function encodeHeader(h: BackupHeader): Uint8Array {
  const json = enc.encode(JSON.stringify({
    alg: 'scrypt', logN: h.kdf.logN, r: h.kdf.r, p: h.kdf.p, salt: toHex(h.salt),
    chunk: h.chunkSize, id: h.backupId, at: h.createdAt, aead: AEAD_NAME,
  }));
  const out = new Uint8Array(PREAMBLE_LENGTH + json.length);
  out.set(enc.encode(BACKUP_FILE_MAGIC), 0);
  out[BACKUP_FILE_MAGIC.length] = BACKUP_FORMAT_VERSION;
  new DataView(out.buffer).setUint32(BACKUP_FILE_MAGIC.length + 1, json.length);
  out.set(json, PREAMBLE_LENGTH);
  return out;
}

export function assertWritableKdf(k: KdfParams, chunkSize: number): void {
  if (!Number.isInteger(k.logN) || k.logN < KDF_LOGN_MIN || k.logN > KDF_LOGN_MAX || k.r !== 8 || k.p !== 1) {
    throw new BackupError('PACKAGE_FAILED');
  }
  if (!Number.isInteger(chunkSize) || chunkSize < CHUNK_SIZE_MIN || chunkSize > CHUNK_SIZE_MAX) {
    throw new BackupError('PACKAGE_FAILED');
  }
}

// ===== قراءة بايتات مع نظرة مسبقة =====

export interface ByteSource { read(max: number): Promise<Uint8Array> } // مصفوفة فارغة = نهاية الملف

export class ByteReader {
  private pending: Uint8Array | null = null;
  constructor(private readonly src: ByteSource) {}

  // يعيد n بايت، أو أقل فقط عند نهاية الملف.
  async readExact(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let got = 0;
    if (this.pending) {
      const k = Math.min(n, this.pending.length);
      out.set(this.pending.subarray(0, k), 0);
      got = k;
      this.pending = k < this.pending.length ? this.pending.subarray(k) : null;
    }
    while (got < n) {
      const part = await this.src.read(n - got);
      if (part.length === 0) break;
      const k = Math.min(part.length, n - got);
      out.set(part.subarray(0, k), got);
      got += k;
    }
    return got === n ? out : out.subarray(0, got);
  }

  async atEof(): Promise<boolean> {
    if (this.pending && this.pending.length > 0) return false;
    const part = await this.src.read(1);
    if (part.length === 0) return true;
    this.pending = part;
    return false;
  }
}

// ===== المفتاح والنونس =====

export async function deriveStreamKey(
  p: BackupCryptoProvider, passphrase: string, header: BackupHeader, headerHash: Uint8Array
): Promise<Uint8Array> {
  const pw = enc.encode(normalizePassphrase(passphrase));
  let kek: Uint8Array | null = null;
  try {
    kek = await p.scrypt(pw, header.salt, { N: 2 ** header.kdf.logN, r: header.kdf.r, p: header.kdf.p }, 32);
    return p.hkdfSha256(kek, headerHash, enc.encode(STREAM_INFO), 32);
  } finally {
    pw.fill(0);
    kek?.fill(0);
  }
}

function nonceFor(counter: number, final: boolean): Uint8Array {
  const n = new Uint8Array(12);
  n[0] = final ? 1 : 0;
  const dv = new DataView(n.buffer);
  dv.setUint32(4, Math.floor(counter / 2 ** 32));
  dv.setUint32(8, counter >>> 0);
  return n;
}

// ===== الكاتب =====

export type ByteSink = (bytes: Uint8Array) => Promise<void>;

export class SealedWriter {
  private readonly buf: Uint8Array;
  private fill = 0;
  private counter = 0;
  private written = 0;
  private finished = false;
  private readonly fileHash: HashStream;

  private constructor(
    private readonly p: BackupCryptoProvider,
    private key: Uint8Array,
    private readonly aad: Uint8Array,
    private readonly chunkSize: number,
    private readonly sink: ByteSink
  ) {
    this.buf = new Uint8Array(chunkSize);
    this.fileHash = p.sha256();
  }

  // يكتب الترويسة (غير مشفّرة) ثم يجهّز التيار. المفتاح يُشتق من ترويسة مطابقة تماماً للمكتوبة.
  static async create(
    p: BackupCryptoProvider, passphrase: string, header: BackupHeader, sink: ByteSink
  ): Promise<SealedWriter> {
    assertWritableKdf(header.kdf, header.chunkSize);
    const headerBytes = encodeHeader(header);
    const headerHash = sha256Of(p, headerBytes);
    const key = await deriveStreamKey(p, passphrase, header, headerHash);
    const w = new SealedWriter(p, key, headerHash, header.chunkSize, sink);
    await w.emitRaw(headerBytes);
    return w;
  }

  private async emitRaw(bytes: Uint8Array): Promise<void> {
    this.fileHash.update(bytes);
    this.written += bytes.length;
    await this.sink(bytes);
  }

  private async seal(final: boolean): Promise<void> {
    const plain = this.buf.subarray(0, this.fill);
    const sealed = this.p.aeadEncrypt(this.key, nonceFor(this.counter, final), this.aad, plain);
    const frame = new Uint8Array(4 + sealed.length);
    new DataView(frame.buffer).setUint32(0, sealed.length);
    frame.set(sealed, 4);
    this.counter++;
    this.fill = 0;
    await this.emitRaw(frame);
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.finished) throw new BackupError('PACKAGE_FAILED');
    let off = 0;
    while (off < data.length) {
      if (this.fill === this.chunkSize) await this.seal(false); // لا يُختم الإطار إلا إذا وصل بيان بعده
      const n = Math.min(this.chunkSize - this.fill, data.length - off);
      this.buf.set(data.subarray(off, off + n), this.fill);
      this.fill += n;
      off += n;
    }
  }

  async finish(): Promise<{ bytesWritten: number; sha256: string }> {
    if (this.finished) throw new BackupError('PACKAGE_FAILED');
    await this.seal(true); // الإطار الأخير دائماً (قد يكون فارغاً)
    this.finished = true;
    this.key.fill(0);
    this.buf.fill(0);
    return { bytesWritten: this.written, sha256: toHex(this.fileHash.digest()) };
  }

  abort(): void {
    this.finished = true;
    this.key.fill(0);
    this.buf.fill(0);
  }
}

// ===== القارئ المرجعي (يستعمله الاختبار؛ 10.4 يبني عليه التحقق) =====

export interface RecordMeta { name: string; size: number; [k: string]: unknown }
export interface RecordHead { kind: number; meta: RecordMeta }

export class PackageReader {
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;
  private counter = 0;
  private done = false;
  private current: RecordHead | null = null;

  private constructor(
    private readonly p: BackupCryptoProvider,
    private readonly key: Uint8Array,
    private readonly aad: Uint8Array,
    private readonly reader: ByteReader,
    readonly header: BackupHeader
  ) {}

  static async open(p: BackupCryptoProvider, passphrase: string, source: ByteSource): Promise<PackageReader> {
    const reader = new ByteReader(source);
    const fixed = await reader.readExact(PREAMBLE_LENGTH);
    if (fixed.length !== PREAMBLE_LENGTH) throw new BackupError('PACKAGE_FORMAT_INVALID');
    const magic = dec.decode(fixed.subarray(0, BACKUP_FILE_MAGIC.length));
    if (magic !== BACKUP_FILE_MAGIC || fixed[BACKUP_FILE_MAGIC.length] !== BACKUP_FORMAT_VERSION) {
      throw new BackupError('PACKAGE_FORMAT_INVALID');
    }
    const jsonLen = new DataView(fixed.buffer, fixed.byteOffset).getUint32(BACKUP_FILE_MAGIC.length + 1);
    if (jsonLen < 2 || jsonLen > 2048) throw new BackupError('PACKAGE_FORMAT_INVALID');
    const json = await reader.readExact(jsonLen);
    if (json.length !== jsonLen) throw new BackupError('PACKAGE_FORMAT_INVALID');

    let o: Record<string, unknown>;
    try { o = JSON.parse(dec.decode(json)); } catch { throw new BackupError('PACKAGE_FORMAT_INVALID'); }
    const logN = o.logN, r = o.r, pp = o.p, chunk = o.chunk;
    if (o.alg !== 'scrypt' || o.aead !== AEAD_NAME ||
        !Number.isInteger(logN) || (logN as number) < KDF_LOGN_MIN || (logN as number) > KDF_LOGN_MAX ||
        r !== 8 || pp !== 1 ||
        !Number.isInteger(chunk) || (chunk as number) < CHUNK_SIZE_MIN || (chunk as number) > CHUNK_SIZE_MAX ||
        typeof o.salt !== 'string' || o.salt.length !== SALT_LENGTH * 2 ||
        typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 64 ||
        typeof o.at !== 'number' || !Number.isFinite(o.at)) {
      throw new BackupError('PACKAGE_FORMAT_INVALID');
    }
    const header: BackupHeader = {
      backupId: o.id, createdAt: o.at, salt: fromHex(o.salt), chunkSize: chunk as number,
      kdf: { logN: logN as number, r: 8, p: 1 },
    };
    const headerBytes = new Uint8Array(PREAMBLE_LENGTH + jsonLen);
    headerBytes.set(fixed, 0);
    headerBytes.set(json, PREAMBLE_LENGTH);
    const headerHash = sha256Of(p, headerBytes);
    const key = await deriveStreamKey(p, passphrase, header, headerHash);
    return new PackageReader(p, key, headerHash, reader, header);
  }

  close(): void { this.key.fill(0); }

  private async nextFrame(): Promise<boolean> {
    if (this.done) return false;
    const lenBytes = await this.reader.readExact(4);
    if (lenBytes.length !== 4) throw new BackupError('PACKAGE_FORMAT_INVALID');
    const len = new DataView(lenBytes.buffer, lenBytes.byteOffset).getUint32(0);
    if (len < AEAD_TAG_LENGTH || len > this.header.chunkSize + AEAD_TAG_LENGTH) {
      throw new BackupError('PACKAGE_FORMAT_INVALID');
    }
    const ct = await this.reader.readExact(len);
    if (ct.length !== len) throw new BackupError('PACKAGE_FORMAT_INVALID');
    const final = await this.reader.atEof();
    let plain: Uint8Array;
    try {
      plain = this.p.aeadDecrypt(this.key, nonceFor(this.counter, final), this.aad, ct);
    } catch {
      throw new BackupError('PACKAGE_AUTH_FAILED');
    }
    if (!final && plain.length !== this.header.chunkSize) throw new BackupError('PACKAGE_FORMAT_INVALID');
    this.counter++;
    if (final) this.done = true;
    this.buf = plain;
    this.pos = 0;
    return true;
  }

  private async readPlain(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      if (this.pos >= this.buf.length && !(await this.nextFrame())) {
        throw new BackupError('PACKAGE_FORMAT_INVALID');
      }
      const k = Math.min(n - got, this.buf.length - this.pos);
      out.set(this.buf.subarray(this.pos, this.pos + k), got);
      this.pos += k;
      got += k;
    }
    return out;
  }

  private async atPlainEnd(): Promise<boolean> {
    while (this.pos >= this.buf.length) {
      if (!(await this.nextFrame())) return true;
    }
    return false;
  }

  // null = لا سجلات أخرى (والتيار انتهى بإطار أخير صحيح).
  async nextRecord(): Promise<RecordHead | null> {
    if (this.current) throw new BackupError('PACKAGE_FAILED'); // بيانات السجل السابق لم تُستهلك
    if (await this.atPlainEnd()) return null;
    const fixed = await this.readPlain(5);
    const metaLen = new DataView(fixed.buffer, fixed.byteOffset).getUint32(1);
    if (metaLen === 0 || metaLen > MAX_META_LENGTH) throw new BackupError('PACKAGE_FORMAT_INVALID');
    let meta: RecordMeta;
    try { meta = JSON.parse(dec.decode(await this.readPlain(metaLen))); } catch { throw new BackupError('PACKAGE_FORMAT_INVALID'); }
    if (!meta || typeof meta.name !== 'string' || !Number.isInteger(meta.size) || meta.size < 0 || meta.size > MAX_RECORD_SIZE) {
      throw new BackupError('PACKAGE_FORMAT_INVALID');
    }
    this.current = { kind: fixed[0], meta };
    return this.current;
  }

  // يبث بيانات السجل الحالي ويتحقق من بصمته المدمجة. يعيد SHA-256 (hex).
  async readData(onChunk: (bytes: Uint8Array) => Promise<void> | void): Promise<string> {
    const head = this.current;
    if (!head) throw new BackupError('PACKAGE_FAILED');
    const h = this.p.sha256();
    let remaining = head.meta.size;
    while (remaining > 0) {
      const part = await this.readPlain(Math.min(remaining, 64 * 1024));
      h.update(part);
      await onChunk(part);
      remaining -= part.length;
    }
    const actual = toHex(h.digest());
    const stored = toHex(await this.readPlain(32));
    this.current = null;
    if (actual !== stored) throw new BackupError('PACKAGE_FORMAT_INVALID');
    return actual;
  }
}
