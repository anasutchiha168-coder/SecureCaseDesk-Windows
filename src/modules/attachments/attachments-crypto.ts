// SECURECASEDESK_PHASE9_S1
// تشفير المرفقات: ChaCha20-Poly1305 (AEAD) بمفتاح مستقل لكل ملف مشتق بـ HKDF-SHA256
// من المفتاح الرئيسي المخزَّن في SecureStore. الدوال هنا صرفة وتعتمد مزوّد تشفير
// يُحقن من الخارج (مزوّد التطبيق: attachments-crypto-runtime.ts، ومزوّد الاختبار: node:crypto).
//
// صيغة الملف المشفر:  "SCDA" (4) | الإصدار (1) | nonce (12) | النص المشفر + وسم Poly1305 (16)
// البيانات المصادَق عليها (AAD) = "SCDA|v1|" + معرّف المرفق، فلا يمكن نقل ملف مشفر إلى سجل آخر.

import { AttachmentError } from './attachments-types';

export const ENC_VERSION = 1;
export const MAGIC = [0x53, 0x43, 0x44, 0x41]; // SCDA
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;
export const HEADER_LENGTH = MAGIC.length + 1 + NONCE_LENGTH;
export const HKDF_INFO = 'securecasedesk/attachment/v1';

export interface AttachmentCryptoProvider {
  randomBytes(length: number): Uint8Array;
  sha256Hex(data: Uint8Array): string;
  hkdfSha256(master: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array;
  // يعيد النص المشفر مع وسم المصادقة في آخره.
  aeadEncrypt(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  // يرمي خطأ إن فشلت المصادقة.
  aeadDecrypt(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
}

const enc = new TextEncoder();

function aadFor(attachmentId: string): Uint8Array {
  return enc.encode('SCDA|v' + ENC_VERSION + '|' + attachmentId);
}

function fileKey(p: AttachmentCryptoProvider, master: Uint8Array, attachmentId: string): Uint8Array {
  return p.hkdfSha256(master, enc.encode(attachmentId), enc.encode(HKDF_INFO), 32);
}

export interface EncryptedBlob {
  blob: Uint8Array;
  sha256Cipher: string;
}

export function encryptAttachment(
  p: AttachmentCryptoProvider, master: Uint8Array, attachmentId: string, plaintext: Uint8Array
): EncryptedBlob {
  const key = fileKey(p, master, attachmentId);
  const nonce = p.randomBytes(NONCE_LENGTH);
  const sealed = p.aeadEncrypt(key, nonce, aadFor(attachmentId), plaintext);
  const blob = new Uint8Array(HEADER_LENGTH + sealed.length);
  blob.set(MAGIC, 0);
  blob[MAGIC.length] = ENC_VERSION;
  blob.set(nonce, MAGIC.length + 1);
  blob.set(sealed, HEADER_LENGTH);
  key.fill(0);
  return { blob, sha256Cipher: p.sha256Hex(blob) };
}

export function decryptAttachment(
  p: AttachmentCryptoProvider, master: Uint8Array, attachmentId: string, blob: Uint8Array
): Uint8Array {
  const headerOk = blob.length >= HEADER_LENGTH + TAG_LENGTH &&
    MAGIC.every((b, i) => blob[i] === b) && blob[MAGIC.length] === ENC_VERSION;
  if (!headerOk) throw new AttachmentError('DECRYPT_FAILED');

  const nonce = blob.slice(MAGIC.length + 1, HEADER_LENGTH);
  const sealed = blob.slice(HEADER_LENGTH);
  const key = fileKey(p, master, attachmentId);
  try {
    return p.aeadDecrypt(key, nonce, aadFor(attachmentId), sealed);
  } catch {
    throw new AttachmentError('DECRYPT_FAILED');
  } finally {
    key.fill(0);
  }
}
