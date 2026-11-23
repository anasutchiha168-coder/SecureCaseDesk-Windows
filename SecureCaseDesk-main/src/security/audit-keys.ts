// SECURECASEDESK_PHASE8_S2
// إدارة مفاتيح HMAC وإصداراتها. المفاتيح في SecureStore فقط، والبصمات في قاعدة البيانات.
// لا يستورد هذا الملف audit.service (لتجنب الدورات).

import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getDb } from '@/database/db';
import {
  KEY_ROTATION_ENTITY, KEY_ROTATION_OPERATION,
  parseVersion, sha256Hex, versionLabel,
} from './audit-crypto';
import type { AuditLogRow } from './audit-crypto';

const ACTIVE_VERSION_ITEM = 'securecase_audit_active_version';
const CHECKPOINT_KEY_ITEM = 'securecase_audit_checkpoint_key_v1';

// v1 يطابق اسم المفتاح في القسم الأول تماماً.
export function hmacKeyItemName(version: number): string {
  return 'securecase_audit_hmac_key_v' + version;
}

export async function loadKey(version: number): Promise<Uint8Array | null> {
  const saved = await SecureStore.getItemAsync(hmacKeyItemName(version));
  if (!saved) return null;
  try {
    const bytes = hexToBytes(saved);
    if (bytes.length !== 32) throw new Error('len');
    return bytes;
  } catch {
    throw new Error('AUDIT_KEY_INVALID');
  }
}

export async function loadKeysFor(versions: number[]): Promise<Map<number, Uint8Array>> {
  const map = new Map<number, Uint8Array>();
  for (const v of versions) {
    const k = await loadKey(v);
    if (k) map.set(v, k);
  }
  return map;
}

export async function loadFingerprints(): Promise<Map<number, string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ version: number; fingerprint: string }>(
    'SELECT version, fingerprint FROM audit_key_registry'
  );
  return new Map(rows.map((r) => [r.version, r.fingerprint]));
}

export async function registerKey(
  version: number,
  key: Uint8Array,
  activatedAfterSeq: number | null
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR IGNORE INTO audit_key_registry
       (version, fingerprint, created_at, activated_after_seq)
     VALUES (?, ?, ?, ?)`,
    [version, sha256Hex(key), Date.now(), activatedAfterSeq]
  );
}

export async function getActiveVersion(): Promise<number> {
  const raw = await SecureStore.getItemAsync(ACTIVE_VERSION_ITEM);
  const stored = raw && /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : null;

  const db = await getDb();
  const last = await db.getFirstAsync<{ hmac_version: string }>(
    'SELECT hmac_version FROM audit_logs ORDER BY sequence_no DESC LIMIT 1'
  );
  const chainVersion = last ? parseVersion(last.hmac_version) : null;

  if (last && chainVersion === null) throw new Error('AUDIT_CHAIN_TAMPERED');

  if (stored !== null && chainVersion !== null && stored < chainVersion) {
    throw new Error('AUDIT_KEY_VERSION_REGRESSION');
  }

  const active = Math.max(stored ?? 0, chainVersion ?? 0) || 1;
  if (stored !== active) {
    await SecureStore.setItemAsync(ACTIVE_VERSION_ITEM, String(active));
  }
  return active;
}

export async function setActiveVersion(next: number): Promise<void> {
  const current = await getActiveVersion();
  if (current >= next) return; // سبق التفعيل (idempotent)
  if (next !== current + 1) throw new Error('AUDIT_KEY_VERSION_INVALID');
  await SecureStore.setItemAsync(ACTIVE_VERSION_ITEM, String(next));
}

// مفتاح التوقيع الحالي. لا يُنشأ مفتاح بديل لسلسلة موجودة أبداً.
// إن كان آخر سجل هو "سجل تدوير" فالسجل التالي يُوقَّع بالإصدار الجديد دائماً،
// حتى لا يُدرج أي سجل بالمفتاح القديم بعد سجل التدوير.
export async function getSigningKey(latest: AuditLogRow | null): Promise<{
  version: number; label: string; key: Uint8Array;
}> {
  let version = await getActiveVersion();

  if (latest &&
      latest.operation_type === KEY_ROTATION_OPERATION &&
      latest.entity_type === KEY_ROTATION_ENTITY) {
    try {
      const to = JSON.parse(latest.new_values ?? 'null')?.to;
      const from = parseVersion(latest.hmac_version);
      if (Number.isInteger(to) && from !== null && to === from + 1) {
        version = Math.max(version, to);
      }
    } catch { /* يُتجاهل: سيكتشف المحقق أي خلل */ }
  }

  let key = await loadKey(version);

  if (!key) {
    const db = await getDb();
    const existing = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM audit_logs'
    );
    if (version !== 1) throw new Error('AUDIT_KEY_MISSING');
    if ((existing?.count ?? 0) > 0) throw new Error('AUDIT_KEY_MISSING');

    key = await Crypto.getRandomBytesAsync(32);
    await SecureStore.setItemAsync(hmacKeyItemName(1), bytesToHex(key));
  }

  // تسجيل البصمة عند أول استخدام (للتركيب القديم: ثقة عند أول استخدام).
  await registerKey(version, key, version === 1 ? 0 : null);

  return { version, label: versionLabel(version), key };
}

export async function createRotationKey(next: number): Promise<Uint8Array> {
  const db = await getDb();
  const registered = await db.getFirstAsync<{ version: number }>(
    'SELECT version FROM audit_key_registry WHERE version = ?',
    [next]
  );
  if (registered) throw new Error('AUDIT_KEY_VERSION_INVALID');

  // قد يوجد مفتاح يتيم من محاولة تدوير فاشلة؛ يُستبدل لأنه لم يُستخدم قط.
  const key = await Crypto.getRandomBytesAsync(32);
  await SecureStore.setItemAsync(hmacKeyItemName(next), bytesToHex(key));
  return key;
}

// مفتاح Checkpoints مستقل تماماً عن مفاتيح السلسلة.
export async function getCheckpointKey(
  createWhenEmpty: boolean
): Promise<Uint8Array | null> {
  const saved = await SecureStore.getItemAsync(CHECKPOINT_KEY_ITEM);
  if (saved) {
    const bytes = hexToBytes(saved);
    if (bytes.length !== 32) throw new Error('CHECKPOINT_KEY_INVALID');
    return bytes;
  }

  const db = await getDb();
  const existing = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM audit_checkpoints'
  );
  if ((existing?.count ?? 0) > 0) throw new Error('CHECKPOINT_KEY_MISSING');
  if (!createWhenEmpty) return null;

  const key = await Crypto.getRandomBytesAsync(32);
  await SecureStore.setItemAsync(CHECKPOINT_KEY_ITEM, bytesToHex(key));
  return key;
}
