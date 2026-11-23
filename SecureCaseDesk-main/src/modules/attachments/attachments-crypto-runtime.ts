// SECURECASEDESK_PHASE9_S1
// مزوّد التشفير الفعلي داخل التطبيق: مكتبات @noble (JavaScript صرف) + أرقام عشوائية من expo-crypto.
// المفتاح الرئيسي (32 بايت) يُنشأ مرة واحدة ويُخزَّن في SecureStore ولا يظهر في الشيفرة أو السجلات.
//
// ⚠️ يتطلب تثبيت:  npx expo install @noble/ciphers   (انظر ملاحظات التسليم)

import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { AttachmentCryptoProvider } from './attachments-crypto';

const MASTER_KEY_ITEM = 'attachment_master_key_v1';

export const runtimeCryptoProvider: AttachmentCryptoProvider = {
  randomBytes: (n) => Crypto.getRandomBytes(n),
  sha256Hex: (data) => bytesToHex(sha256(data)),
  hkdfSha256: (master, salt, info, length) => hkdf(sha256, master, salt, info, length),
  aeadEncrypt: (key, nonce, aad, plaintext) => chacha20poly1305(key, nonce, aad).encrypt(plaintext),
  aeadDecrypt: (key, nonce, aad, ciphertext) => chacha20poly1305(key, nonce, aad).decrypt(ciphertext),
};

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

let cachedMaster: Uint8Array | null = null;

// يفشل مغلقاً: إن تعذرت قراءة المفتاح لا يُنشأ مفتاح جديد بصمت إن كانت هناك مرفقات مشفرة سابقة
// (يتحقق منها المستدعي عبر hasEncryptedAttachments)؛ هنا يُنشأ المفتاح فقط إذا كان العنصر غائباً فعلاً.
export async function getAttachmentMasterKey(allowCreate: boolean): Promise<Uint8Array> {
  if (cachedMaster) return cachedMaster;
  const stored = await SecureStore.getItemAsync(MASTER_KEY_ITEM);
  if (stored && /^[0-9a-f]{64}$/.test(stored)) {
    cachedMaster = hexToBytes(stored);
    return cachedMaster;
  }
  if (!allowCreate) throw new Error('ATTACHMENT_KEY_MISSING');
  const fresh = Crypto.getRandomBytes(32);
  await SecureStore.setItemAsync(MASTER_KEY_ITEM, bytesToHex(fresh));
  cachedMaster = fresh;
  return fresh;
}

export function clearCachedAttachmentKey(): void {
  cachedMaster?.fill(0);
  cachedMaster = null;
}
