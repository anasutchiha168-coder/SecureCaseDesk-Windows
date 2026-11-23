// SECURECASEDESK_PHASE8_S2
// دوال التشفير الصرفة المشتركة (بدون أي اعتماد على Expo) كي يمكن اختبارها في Node.

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const GENESIS_HASH = 'GENESIS';
export const HMAC_VERSION_PREFIX = 'HMAC-SHA256-v';
export const KEY_ROTATION_OPERATION = 'audit_key_rotation';
export const KEY_ROTATION_ENTITY = 'audit_keys';

export interface AuditLogRow {
  sequence_no: number;
  operation_id: string;
  source_event_id: string;
  user_id: string | null;
  username: string | null;
  operation_type: string;
  entity_type: string;
  entity_id: string | null;
  previous_values: string | null;
  new_values: string | null;
  correction_reason: string | null;
  created_at: number;
  previous_hash: string;
  record_hash: string;
  hmac_version: string;
}

export type AuditRowBase = Omit<AuditLogRow, 'record_hash'>;

export interface CheckpointRecord {
  sequence_no: number;
  record_hash: string;
  entry_count: number;
  created_at: number;
  key_version: number;
  signature: string;
}

export function versionLabel(version: number): string {
  return HMAC_VERSION_PREFIX + version;
}

export function parseVersion(label: string | null | undefined): number | null {
  const m = /^HMAC-SHA256-v([1-9][0-9]{0,5})$/.exec(String(label ?? ''));
  return m ? Number(m[1]) : null;
}

export function canonicalRow(row: AuditRowBase): string {
  // نفس ترتيب الحقول في القسم الأول تماماً (لا تغيّره أبداً).
  return JSON.stringify([
    row.sequence_no, row.operation_id, row.source_event_id,
    row.user_id, row.username, row.operation_type,
    row.entity_type, row.entity_id, row.previous_values,
    row.new_values, row.correction_reason, row.created_at,
    row.previous_hash, row.hmac_version,
  ]);
}

export function calculateRowHmac(key: Uint8Array, row: AuditRowBase): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(canonicalRow(row))));
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

// ---------- Checkpoints (توقيع مستقل بمفتاح مختلف عن مفاتيح السلسلة) ----------

function canonicalCheckpoint(cp: Omit<CheckpointRecord, 'signature'>): string {
  return JSON.stringify([
    'CHECKPOINT-v1', cp.sequence_no, cp.record_hash,
    cp.entry_count, cp.created_at, cp.key_version,
  ]);
}

export function calculateCheckpointSignature(
  key: Uint8Array,
  cp: Omit<CheckpointRecord, 'signature'>
): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(canonicalCheckpoint(cp))));
}

export function buildCheckpoint(
  key: Uint8Array,
  last: { sequence_no: number; record_hash: string; key_version: number },
  now: number
): CheckpointRecord {
  const base = {
    sequence_no: last.sequence_no,
    record_hash: last.record_hash,
    entry_count: last.sequence_no,
    created_at: now,
    key_version: last.key_version,
  };
  return { ...base, signature: calculateCheckpointSignature(key, base) };
}

export function isCheckpointShape(x: unknown): x is CheckpointRecord {
  const c = x as CheckpointRecord;
  return !!c &&
    Number.isInteger(c.sequence_no) && c.sequence_no >= 1 &&
    typeof c.record_hash === 'string' &&
    Number.isInteger(c.entry_count) &&
    Number.isInteger(c.created_at) &&
    Number.isInteger(c.key_version) &&
    typeof c.signature === 'string';
}

export function verifyCheckpointSignature(
  key: Uint8Array,
  cp: CheckpointRecord
): boolean {
  const { signature, ...base } = cp;
  return constantTimeEqual(calculateCheckpointSignature(key, base), signature);
}
