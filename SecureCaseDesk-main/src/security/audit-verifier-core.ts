// SECURECASEDESK_PHASE8_S2
// محرك التحقق الصرف: لا يعتمد على قاعدة البيانات ولا SecureStore.
// يستقبل الصفوف على دفعات (feed) فيدعم سجلات كبيرة بدون تحميلها كلها في الذاكرة.

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  GENESIS_HASH, KEY_ROTATION_ENTITY, KEY_ROTATION_OPERATION,
  buildCheckpoint, calculateRowHmac, constantTimeEqual, parseVersion,
  sha256Hex, verifyCheckpointSignature, versionLabel,
} from './audit-crypto';
import type { AuditLogRow, CheckpointRecord } from './audit-crypto';

export type Severity = 'critical' | 'warning' | 'unverifiable';

export type FindingCode =
  | 'SEQUENCE_GAP' | 'OUT_OF_ORDER' | 'BROKEN_LINK' | 'INVALID_HMAC'
  | 'UNKNOWN_VERSION' | 'KEY_VERSION_REGRESSION' | 'UNAUTHORIZED_KEY_SWITCH'
  | 'KEY_UNAVAILABLE' | 'KEY_FINGERPRINT_MISMATCH' | 'TIME_REGRESSION'
  | 'TAIL_TRUNCATED' | 'CHECKPOINT_MISMATCH' | 'CHECKPOINT_SIGNATURE_INVALID'
  | 'CHECKPOINT_KEY_UNAVAILABLE' | 'CHECKPOINT_MISSING' | 'CHECKPOINT_CORRUPT'
  | 'QUEUE_EVENT_MISSING_FROM_CHAIN';

export interface Finding {
  code: FindingCode;
  severity: Severity;
  sequence?: number;
  detail: string;
}

export interface CheckpointInput {
  source: 'external' | 'database';
  record: CheckpointRecord;
}

export interface ChainVerifierOptions {
  resolveKey: (version: number) => Uint8Array | null;
  fingerprints?: Map<number, string> | null;
  checkpoints?: CheckpointInput[];
  checkpointKey?: Uint8Array | null;
  externalState?: 'present' | 'missing' | 'corrupt' | 'ignored';
  maxFindings?: number;
}

export type VerificationStatus = 'VALID' | 'INCONCLUSIVE' | 'COMPROMISED';

export interface VerificationReport {
  ok: boolean;
  status: VerificationStatus;
  count: number;
  lastSequence: number;
  lastHash: string;
  keyVersionsUsed: number[];
  findings: Finding[];
  findingsTruncated: boolean;
  firstFailure: Finding | null;
  checkpoint: 'NONE' | 'MATCH' | 'FAILED' | 'UNCHECKED';
}

export class ChainVerifier {
  private opts: ChainVerifierOptions;
  private expectedSeq = 1;
  private previousHash = GENESIS_HASH;
  private lastVersion = 0;
  private prevRow: AuditLogRow | null = null;
  private lastCreatedAt = 0;
  private count = 0;
  private lastSequence = 0;
  private lastHash = GENESIS_HASH;
  private findings: Finding[] = [];
  private truncated = false;
  private versions = new Set<number>();
  private missingKeyVersions = new Set<number>();
  private fingerprintChecked = new Set<number>();
  private anchors = new Map<number, string>();
  private anchorSeqs = new Set<number>();
  private maxFindings: number;

  constructor(opts: ChainVerifierOptions) {
    this.opts = opts;
    this.maxFindings = opts.maxFindings ?? 50;
    for (const c of opts.checkpoints ?? []) {
      this.anchorSeqs.add(c.record.sequence_no);
    }
  }

  private add(f: Finding) {
    if (this.findings.length >= this.maxFindings) {
      this.truncated = true;
      return;
    }
    this.findings.push(f);
  }

  private rotationAllows(prev: AuditLogRow | null, version: number): boolean {
    if (!prev) return version === 1;
    if (prev.operation_type !== KEY_ROTATION_OPERATION) return false;
    if (prev.entity_type !== KEY_ROTATION_ENTITY) return false;
    try {
      const v = JSON.parse(prev.new_values ?? 'null');
      return !!v && v.to === version && v.from === version - 1;
    } catch {
      return false;
    }
  }

  feed(rows: AuditLogRow[]): void {
    for (const row of rows) {
      this.count += 1;
      const seq = row.sequence_no;
      let gapFlagged = false;

      if (seq !== this.expectedSeq) {
        gapFlagged = true;
        if (seq < this.expectedSeq) {
          this.add({
            code: 'OUT_OF_ORDER', severity: 'critical', sequence: seq,
            detail: `expected ${this.expectedSeq}, found ${seq}`,
          });
        } else {
          this.add({
            code: 'SEQUENCE_GAP', severity: 'critical', sequence: seq,
            detail: `expected ${this.expectedSeq}, found ${seq} (records missing)`,
          });
        }
      }

      const version = parseVersion(row.hmac_version);
      let key: Uint8Array | null = null;

      if (version === null) {
        this.add({
          code: 'UNKNOWN_VERSION', severity: 'critical', sequence: seq,
          detail: `unknown signature version "${row.hmac_version}"`,
        });
      } else {
        this.versions.add(version);

        if (version < this.lastVersion) {
          this.add({
            code: 'KEY_VERSION_REGRESSION', severity: 'critical', sequence: seq,
            detail: `version ${version} after ${this.lastVersion}`,
          });
        } else if (version > this.lastVersion) {
          const ok = version === this.lastVersion + 1 &&
            this.rotationAllows(this.prevRow, version);
          if (!ok) {
            this.add({
              code: 'UNAUTHORIZED_KEY_SWITCH', severity: 'critical', sequence: seq,
              detail: `switch to v${version} without a valid rotation record`,
            });
          }
          this.lastVersion = version;
        }

        key = this.opts.resolveKey(version);

        if (!key) {
          if (!this.missingKeyVersions.has(version)) {
            this.missingKeyVersions.add(version);
            this.add({
              code: 'KEY_UNAVAILABLE', severity: 'unverifiable', sequence: seq,
              detail: `key v${version} not available on this device`,
            });
          }
        } else if (!this.fingerprintChecked.has(version)) {
          this.fingerprintChecked.add(version);
          const expected = this.opts.fingerprints?.get(version);
          if (expected && !constantTimeEqual(expected, sha256Hex(key))) {
            this.add({
              code: 'KEY_FINGERPRINT_MISMATCH', severity: 'critical', sequence: seq,
              detail: `key v${version} does not match the registered fingerprint`,
            });
          }
        }
      }

      if (!gapFlagged && !constantTimeEqual(row.previous_hash, this.previousHash)) {
        this.add({
          code: 'BROKEN_LINK', severity: 'critical', sequence: seq,
          detail: 'previous_hash does not match the preceding record',
        });
      }

      if (key) {
        const { record_hash, ...base } = row;
        const expected = calculateRowHmac(key, base);
        if (!constantTimeEqual(expected, record_hash)) {
          this.add({
            code: 'INVALID_HMAC', severity: 'critical', sequence: seq,
            detail: 'record content does not match its signature',
          });
        }
      }

      if (row.created_at < this.lastCreatedAt) {
        this.add({
          code: 'TIME_REGRESSION', severity: 'warning', sequence: seq,
          detail: 'timestamp earlier than the previous record (clock change?)',
        });
      }
      this.lastCreatedAt = Math.max(this.lastCreatedAt, row.created_at);

      if (this.anchorSeqs.has(seq)) this.anchors.set(seq, row.record_hash);

      // إعادة مزامنة الحالة حتى لا يحجب خطأ واحد بقية الأخطاء.
      this.previousHash = row.record_hash;
      this.prevRow = row;
      this.expectedSeq = seq + 1;
      this.lastSequence = seq;
      this.lastHash = row.record_hash;
    }
  }

  finish(extra: { queueGapCount?: number } = {}): VerificationReport {
    let checkpoint: VerificationReport['checkpoint'] = 'NONE';
    const list = this.opts.checkpoints ?? [];

    if ((extra.queueGapCount ?? 0) > 0) {
      this.add({
        code: 'QUEUE_EVENT_MISSING_FROM_CHAIN', severity: 'critical',
        detail: `${extra.queueGapCount} queued event(s) have no chain record`,
      });
    }

    const ext = this.opts.externalState ?? 'ignored';
    if (ext === 'corrupt') {
      this.add({
        code: 'CHECKPOINT_CORRUPT', severity: 'critical',
        detail: 'external checkpoint is unreadable',
      });
      checkpoint = 'FAILED';
    } else if (ext === 'missing' && this.count > 0) {
      this.add({
        code: 'CHECKPOINT_MISSING', severity: 'warning',
        detail: 'no external checkpoint; tail truncation cannot be detected',
      });
      checkpoint = 'UNCHECKED';
    }

    if (list.length > 0) {
      const key = this.opts.checkpointKey ?? null;
      if (!key) {
        this.add({
          code: 'CHECKPOINT_KEY_UNAVAILABLE', severity: 'unverifiable',
          detail: 'checkpoint key not available on this device',
        });
        checkpoint = 'UNCHECKED';
      } else {
        let failed = false;
        for (const c of list) {
          const cp = c.record;
          if (!verifyCheckpointSignature(key, cp)) {
            failed = true;
            this.add({
              code: 'CHECKPOINT_SIGNATURE_INVALID', severity: 'critical',
              sequence: cp.sequence_no,
              detail: `${c.source} checkpoint signature is invalid`,
            });
          } else if (cp.sequence_no > this.lastSequence) {
            failed = true;
            this.add({
              code: 'TAIL_TRUNCATED', severity: 'critical',
              sequence: cp.sequence_no,
              detail: `${c.source} checkpoint at ${cp.sequence_no}, chain ends at ${this.lastSequence}`,
            });
          } else {
            const hash = this.anchors.get(cp.sequence_no);
            if (!hash || !constantTimeEqual(hash, cp.record_hash)) {
              failed = true;
              this.add({
                code: 'CHECKPOINT_MISMATCH', severity: 'critical',
                sequence: cp.sequence_no,
                detail: `${c.source} checkpoint does not match the record at ${cp.sequence_no}`,
              });
            }
          }
        }
        checkpoint = failed ? 'FAILED' : 'MATCH';
      }
    }

    const critical = this.findings.filter((f) => f.severity === 'critical');
    const unverifiable = this.findings.filter((f) => f.severity === 'unverifiable');
    const status: VerificationStatus =
      critical.length > 0 ? 'COMPROMISED'
        : unverifiable.length > 0 ? 'INCONCLUSIVE' : 'VALID';

    return {
      ok: status === 'VALID',
      status,
      count: this.count,
      lastSequence: this.lastSequence,
      lastHash: this.lastHash,
      keyVersionsUsed: Array.from(this.versions).sort((a, b) => a - b),
      findings: this.findings,
      findingsTruncated: this.truncated,
      firstFailure: critical[0] ?? null,
      checkpoint,
    };
  }
}

// ---------- اكتشاف فجوات الطابور (حذف نهاية السلسلة مع بقاء الطابور) ----------

export function detectQueueGaps(
  pendingQueueSeqs: number[],
  maxFlushedQueueSeq: number | null
): number[] {
  if (maxFlushedQueueSeq === null) return [];
  return pendingQueueSeqs.filter((s) => s < maxFlushedQueueSeq);
}

// ---------- منع تكرار الأحداث (للتزامن والاستيراد) ----------

export function dedupeEvents<T extends { event_key: string }>(
  incoming: T[],
  known: Set<string>
): { fresh: T[]; duplicates: T[] } {
  const seen = new Set(known);
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const e of incoming) {
    if (seen.has(e.event_key)) duplicates.push(e);
    else { seen.add(e.event_key); fresh.push(e); }
  }
  return { fresh, duplicates };
}

// ---------- اختبار داخلي سريع (متزامن) ----------

function calculateVector(key: Uint8Array): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes('Hi There')));
}

export function runAuditIntegritySelfTest(): {
  ok: boolean; hmacVector: boolean; validChain: boolean;
  modifiedDetected: boolean; missingDetected: boolean; reorderedDetected: boolean;
  checkpointTailDetected: boolean;
} {
  const vectorKey = new Uint8Array(20).fill(0x0b);
  const hmacVector =
    calculateVector(vectorKey) ===
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';

  const k = new Uint8Array(32).fill(0x41);
  const ck = new Uint8Array(32).fill(0x42);
  const mk = (seq: number, prev: string): AuditLogRow => {
    const base = {
      sequence_no: seq, operation_id: 'T' + seq, source_event_id: 'S' + seq,
      user_id: 'U', username: 'اختبار', operation_type: 'test',
      entity_type: 'test', entity_id: String(seq), previous_values: null,
      new_values: '{"v":' + seq + '}', correction_reason: null,
      created_at: 1000 + seq, previous_hash: prev, hmac_version: versionLabel(1),
    };
    return { ...base, record_hash: calculateRowHmac(k, base) };
  };
  const a = mk(1, GENESIS_HASH), b = mk(2, a.record_hash), c = mk(3, b.record_hash);
  const run = (rows: AuditLogRow[], cps: CheckpointInput[] = []) => {
    const v = new ChainVerifier({
      resolveKey: () => k, checkpoints: cps, checkpointKey: ck, externalState: 'ignored',
    });
    v.feed(rows);
    return v.finish();
  };

  const validChain = run([a, b, c]).ok;
  const modifiedDetected = !run([{ ...a, username: 'x' }, b, c]).ok;
  const missingDetected = !run([a, c]).ok;
  const reorderedDetected = !run([a, c, b]).ok;
  const cp: CheckpointInput = {
    source: 'external',
    record: buildCheckpoint(ck, { sequence_no: 3, record_hash: c.record_hash, key_version: 1 }, 1),
  };
  const checkpointTailDetected = !run([a, b], [cp]).ok;

  return {
    ok: hmacVector && validChain && modifiedDetected && missingDetected &&
        reorderedDetected && checkpointTailDetected,
    hmacVector, validChain, modifiedDetected, missingDetected,
    reorderedDetected, checkpointTailDetected,
  };
}
