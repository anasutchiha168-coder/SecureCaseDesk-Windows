// SECURECASEDESK_PHASE12_S2
// اختبارات السلامة: (1) حماية سجلات الحركات والتصحيحات بالمشغّلات الفعلية المقتطعة من src/database/db.ts،
// (2) سلسلة HMAC للتدقيق: كشف التعديل والحذف وإعادة الترتيب والرابط المكسور وبتر الذيل وتبديل المفتاح.
// ملاحظة صادقة: تعمل على node:sqlite (ليس SQLCipher). تشفير القاعدة نفسه لا يُثبت إلا على الجهاز (شاشة فحص الأمان).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChainVerifier, runAuditIntegritySelfTest, type CheckpointInput } from '../src/security/audit-verifier-core';
import { GENESIS_HASH, buildCheckpoint, calculateRowHmac, versionLabel, type AuditLogRow } from '../src/security/audit-crypto';

// ───────── (1) مشغّلات الحماية الفعلية ─────────
const dbSource = readFileSync(join(process.cwd(), 'src', 'database', 'db.ts'), 'utf8');
function grab(re: RegExp, label: string): string {
  const m = re.exec(dbSource);
  assert.ok(m, `لم يُعثر على ${label} في db.ts (تغيّر شكل الكود؟)`);
  return m![0];
}
const MOVEMENTS_TABLE = grab(/CREATE TABLE IF NOT EXISTS detainee_movements \([\s\S]*?\n\s*\);/, 'جدول الحركات');
const CORRECTIONS_TABLE = grab(/CREATE TABLE IF NOT EXISTS correction_history \([\s\S]*?\n\s*\);/, 'جدول التصحيحات');
const TRIGGERS = ['trg_movements_no_update', 'trg_movements_no_delete', 'trg_corrections_no_update', 'trg_corrections_no_delete']
  .map((n) => grab(new RegExp(`CREATE TRIGGER IF NOT EXISTS ${n}[\\s\\S]*?END;`), 'مشغّل ' + n));

function freshHistoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(MOVEMENTS_TABLE);
  db.exec(CORRECTIONS_TABLE);
  for (const t of TRIGGERS) db.exec(t);
  db.prepare(`INSERT INTO detainee_movements (id, movement_number, detainee_id, movement_type, movement_date, executed_by, created_at)
              VALUES ('m1','MV-1','d1','إيداع',1000,'u1',1000)`).run();
  db.prepare(`INSERT INTO correction_history (id, detainee_id, field_name, previous_value, new_value, reason, executed_by, created_at)
              VALUES ('c1','d1','name','قديم','جديد','خطأ إملائي','u1',1000)`).run();
  return db;
}

test('الحركات: التعديل مرفوض والقيم السابقة محفوظة', () => {
  const db = freshHistoryDb();
  assert.throws(() => db.exec(`UPDATE detainee_movements SET reason = 'x' WHERE id = 'm1'`), /لا يقبل التعديل/);
  assert.throws(() => db.exec(`UPDATE detainee_movements SET movement_type = 'إفراج'`), /لا يقبل التعديل/);
  const row = db.prepare(`SELECT movement_type, reason FROM detainee_movements WHERE id='m1'`).get() as { movement_type: string; reason: string | null };
  assert.equal(row.movement_type, 'إيداع');
  assert.equal(row.reason, null);
});

test('الحركات: الحذف مرفوض (مفرداً وجماعياً)', () => {
  const db = freshHistoryDb();
  assert.throws(() => db.exec(`DELETE FROM detainee_movements WHERE id = 'm1'`), /لا يقبل الحذف/);
  assert.throws(() => db.exec(`DELETE FROM detainee_movements`), /لا يقبل الحذف/);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM detainee_movements').get() as { c: number }).c, 1);
});

test('الحركات: الإضافة مسموحة (سجل إلحاقي فقط) ونوع الحركة مقيّد', () => {
  const db = freshHistoryDb();
  db.prepare(`INSERT INTO detainee_movements (id, movement_number, detainee_id, movement_type, movement_date, executed_by, created_at)
              VALUES ('m2','MV-2','d1','إفراج',2000,'u1',2000)`).run();
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM detainee_movements').get() as { c: number }).c, 2);
  assert.throws(() => db.prepare(`INSERT INTO detainee_movements (id, movement_number, detainee_id, movement_type, movement_date, executed_by, created_at)
              VALUES ('m3','MV-3','d1','نوع_مخترع',3000,'u1',3000)`).run());
});

test('التصحيحات: التعديل والحذف مرفوضان والقيمتان القديمة والجديدة محفوظتان', () => {
  const db = freshHistoryDb();
  assert.throws(() => db.exec(`UPDATE correction_history SET new_value = 'تلاعب' WHERE id = 'c1'`), /غير قابل للتعديل/);
  assert.throws(() => db.exec(`DELETE FROM correction_history WHERE id = 'c1'`), /غير قابل للحذف/);
  const row = db.prepare(`SELECT previous_value, new_value FROM correction_history WHERE id='c1'`).get() as { previous_value: string; new_value: string };
  assert.deepEqual({ ...row }, { previous_value: 'قديم', new_value: 'جديد' });
});

test('التصحيحات: سبب التصحيح إلزامي', () => {
  const db = freshHistoryDb();
  assert.throws(() => db.prepare(`INSERT INTO correction_history (id, detainee_id, field_name, previous_value, new_value, reason, executed_by, created_at)
              VALUES ('c2','d1','name','a','b',NULL,'u1',1)`).run());
});

// ───────── (2) سلسلة HMAC ─────────
const K = new Uint8Array(32).fill(0x41);
const CK = new Uint8Array(32).fill(0x42);

function mk(seq: number, prev: string, over: Partial<AuditLogRow> = {}): AuditLogRow {
  const base = {
    sequence_no: seq, operation_id: 'OP' + seq, source_event_id: 'EV' + seq,
    user_id: 'U1', username: 'admin', operation_type: 'create', entity_type: 'case', entity_id: 'C' + seq,
    previous_values: null, new_values: '{"n":' + seq + '}', correction_reason: null,
    created_at: 5000 + seq, previous_hash: prev, hmac_version: versionLabel(1), ...over,
  };
  return { ...base, record_hash: calculateRowHmac(K, base) };
}
function chain(n: number): AuditLogRow[] {
  const rows: AuditLogRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) { const r = mk(i, prev); rows.push(r); prev = r.record_hash; }
  return rows;
}
function verify(rows: AuditLogRow[], opts: { cps?: CheckpointInput[]; key?: Uint8Array } = {}) {
  const v = new ChainVerifier({ resolveKey: () => opts.key ?? K, checkpoints: opts.cps ?? [], checkpointKey: CK, externalState: 'ignored' });
  v.feed(rows);
  return v.finish();
}
const codes = (r: ReturnType<typeof verify>) => r.findings.map((f) => f.code);

test('الاختبار الذاتي المدمج للتدقيق ينجح بكل مكوّناته', () => {
  const r = runAuditIntegritySelfTest();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('سلسلة سليمة من 10 سجلات ← VALID', () => {
  const r = verify(chain(10));
  assert.equal(r.ok, true);
  assert.equal(r.status, 'VALID');
  assert.equal(r.count, 10);
  assert.equal(r.findings.length, 0);
});

test('تعديل حقل في سجل ← INVALID_HMAC', () => {
  const rows = chain(5);
  rows[2] = { ...rows[2], new_values: '{"n":999}' };
  const r = verify(rows);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'COMPROMISED');
  assert.ok(codes(r).includes('INVALID_HMAC'), codes(r).join());
});

test('حذف سجل من الوسط ← يُكتشف', () => {
  const rows = chain(5);
  const r = verify([rows[0], rows[1], rows[3], rows[4]]);
  assert.equal(r.ok, false);
  assert.ok(codes(r).some((c) => c === 'SEQUENCE_GAP' || c === 'BROKEN_LINK'), codes(r).join());
});

test('إعادة ترتيب سجلين ← يُكتشف', () => {
  const rows = chain(5);
  const r = verify([rows[0], rows[2], rows[1], rows[3], rows[4]]);
  assert.equal(r.ok, false);
  assert.ok(codes(r).some((c) => c === 'OUT_OF_ORDER' || c === 'SEQUENCE_GAP' || c === 'BROKEN_LINK'), codes(r).join());
});

test('رابط سابق مكسور (previous_hash مزوَّر مع HMAC صحيح للسجل نفسه) ← BROKEN_LINK', () => {
  const rows = chain(4);
  rows[2] = mk(3, 'f'.repeat(64)); // HMAC صحيح لكن لا يرتبط بالسجل السابق
  rows[3] = mk(4, rows[2].record_hash);
  const r = verify(rows);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('BROKEN_LINK'), codes(r).join());
});

test('التحقق بمفتاح خاطئ ← الفشل (لا يمر التزوير)', () => {
  const r = verify(chain(3), { key: new Uint8Array(32).fill(0x99) });
  assert.equal(r.ok, false);
});

test('بتر ذيل السلسلة يُكتشف عبر نقطة التحقق الموقّعة', () => {
  const rows = chain(6);
  const cp: CheckpointInput = {
    source: 'external',
    record: buildCheckpoint(CK, { sequence_no: 6, record_hash: rows[5].record_hash, key_version: 1 }, 1),
  };
  assert.equal(verify(rows, { cps: [cp] }).ok, true);
  const truncated = verify(rows.slice(0, 4), { cps: [cp] });
  assert.equal(truncated.ok, false);
});
