// بيئة اختبار Node: قاعدة SQLite حقيقية (node:sqlite) بنفس واجهة expo-sqlite المستخدمة في المشروع،
// ومزوّد تشفير يستخدم node:crypto بنفس خوارزمية التطبيق (ChaCha20-Poly1305 + HKDF-SHA256 + SHA-256).
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import type { AttachmentCryptoProvider } from '../../src/modules/attachments/attachments-crypto';
import type { BlobStorage, DbLike } from '../../src/modules/attachments/attachments-repo';

export class NodeDb implements DbLike {
  raw = new DatabaseSync(':memory:');
  async execAsync(sql: string) { this.raw.exec(sql); }
  async runAsync(sql: string, params: unknown[] = []) { return this.raw.prepare(sql).run(...(params as never[])); }
  async getFirstAsync<T>(sql: string, params: unknown[] = []) {
    return (this.raw.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
  }
  async getAllAsync<T>(sql: string, params: unknown[] = []) {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }
  async withTransactionAsync(task: () => Promise<void>) {
    this.raw.exec('BEGIN');
    try { await task(); this.raw.exec('COMMIT'); } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
  }
}

export const nodeCrypto: AttachmentCryptoProvider = {
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
  sha256Hex: (d) => createHash('sha256').update(d).digest('hex'),
  hkdfSha256: (m, s, i, l) => new Uint8Array(hkdfSync('sha256', m, s, i, l)),
  aeadEncrypt(key, nonce, aad, plain) {
    const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return new Uint8Array(Buffer.concat([ct, c.getAuthTag()]));
  },
  aeadDecrypt(key, nonce, aad, sealed) {
    const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    d.setAAD(aad);
    d.setAuthTag(sealed.slice(sealed.length - 16));
    return new Uint8Array(Buffer.concat([d.update(sealed.slice(0, sealed.length - 16)), d.final()]));
  },
};

export class MemoryStorage implements BlobStorage {
  files = new Map<string, Uint8Array>();
  failWrites = false;
  async write(name: string, bytes: Uint8Array) {
    if (this.failWrites) throw new Error('disk full');
    this.files.set(name, bytes.slice());
  }
  async read(name: string) {
    const f = this.files.get(name);
    if (!f) throw new Error('missing');
    return f.slice();
  }
  async delete(name: string) { this.files.delete(name); }
  async exists(name: string) { return this.files.has(name); }
  async list() { return [...this.files.keys()]; }
}

export const uuid = () => randomUUID();

export const PDF = (extra = 'hello') => new TextEncoder().encode('%PDF-1.4\n' + extra + '\n%%EOF');
export const PNG = (extra = 'x') => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(extra)]);
export const JPG = (extra = 'x') => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(extra)]);
