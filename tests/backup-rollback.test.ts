// SECURECASEDESK_PHASE10_S7
// اختبارات التراجع الآمن (10.7). تشغَّل بـ: npm run test:backup-rollback
// ملفات حقيقية وبصمات SHA-256 حقيقية؛ مخزن الأسرار مزيّف في الذاكرة.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RollbackError, readJournal, recoverInterruptedOperation, runWithRollback,
  type RollbackDeps, type RollbackFs, type RollbackPlan, type RollbackSecrets,
} from '../src/modules/backup/backup-rollback';

const nodeFs: RollbackFs = {
  async ensureDir(p) { fs.mkdirSync(p, { recursive: true }); },
  async exists(p) { return fs.existsSync(p); },
  async move(a, b) { fs.rmSync(b, { recursive: true, force: true }); fs.renameSync(a, b); },
  async remove(p) { fs.rmSync(p, { recursive: true, force: true }); },
  async readText(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; },
  async writeText(p, t) { fs.writeFileSync(p, t, 'utf8'); },
  async sha256File(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); },
};

class FakeSecrets implements RollbackSecrets {
  store = new Map<string, string>();
  stashed = new Map<string, string | null>();
  failStash = false;
  async stash(names: string[]) {
    if (this.failStash) throw new Error('STASH_FAIL');
    for (const n of names) this.stashed.set(n, this.store.get(n) ?? null);
  }
  async restore(names: string[]) {
    for (const n of names) {
      if (!this.stashed.has(n)) continue;
      const v = this.stashed.get(n)!;
      if (v === null) this.store.delete(n); else this.store.set(n, v);
    }
  }
  async clear(names: string[]) { for (const n of names) this.stashed.delete(n); }
}

let root: string;
let secrets: FakeSecrets;
let events: string[];
let deps: RollbackDeps;
let plan: RollbackPlan;
const dbPath = () => path.join(root, 'securecase.db');
const walPath = () => path.join(root, 'securecase.db-wal');
const attDir = () => path.join(root, 'attachments');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-rb-'));
  fs.writeFileSync(dbPath(), 'OLD-DB-BYTES');
  fs.mkdirSync(attDir());
  fs.writeFileSync(path.join(attDir(), 'a.enc'), 'OLD-ATT');
  secrets = new FakeSecrets();
  secrets.store.set('db_encryption_key', 'old-key');
  events = [];
  deps = {
    fs: nodeFs, secrets,
    journalPath: path.join(root, 'rollback-journal.json'),
    guardRoot: path.join(root, 'rollback-guard'),
    newId: () => randomUUID(), now: () => Date.now(),
    closeDatabase: async () => { events.push('close'); },
    reopenDatabase: async () => { events.push('reopen'); },
  };
  plan = {
    operation: 'restore',
    targets: [
      { path: dbPath(), kind: 'file' },
      { path: walPath(), kind: 'file' },
      { path: attDir(), kind: 'dir' },
    ],
    secretNames: ['db_encryption_key', 'attachment_master_key_v1'],
  };
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function writeNewState() {
  fs.writeFileSync(dbPath(), 'NEW-DB-BYTES');
  fs.mkdirSync(attDir());
  fs.writeFileSync(path.join(attDir(), 'b.enc'), 'NEW-ATT');
  secrets.store.set('db_encryption_key', 'new-key');
  secrets.store.set('attachment_master_key_v1', 'new-att-key');
}
function assertOldState() {
  assert.equal(fs.readFileSync(dbPath(), 'utf8'), 'OLD-DB-BYTES');
  assert.equal(fs.readFileSync(path.join(attDir(), 'a.enc'), 'utf8'), 'OLD-ATT');
  assert.equal(fs.existsSync(path.join(attDir(), 'b.enc')), false);
  assert.equal(secrets.store.get('db_encryption_key'), 'old-key');
  assert.equal(secrets.store.has('attachment_master_key_v1'), false);
}

describe('10.7 التراجع الآمن', () => {
  test('نجاح: الحالة الجديدة تثبت وتُنظَّف نسخة الأمان', async () => {
    const r = await runWithRollback(deps, plan, async () => { writeNewState(); return 'ok'; }, async () => {});
    assert.equal(r.value, 'ok');
    assert.equal(fs.readFileSync(dbPath(), 'utf8'), 'NEW-DB-BYTES');
    assert.equal(fs.existsSync(path.join(deps.guardRoot, r.journalId)), false);
    assert.equal((await readJournal(deps))?.phase, 'committed');
    assert.equal(secrets.stashed.size, 0);
    assert.deepEqual(events, ['close', 'reopen']);
  });

  test('فشل التنفيذ: رجوع كامل (قاعدة + مرفقات + أسرار) وبايتات مطابقة', async () => {
    await assert.rejects(
      runWithRollback(deps, plan, async () => { writeNewState(); throw new Error('boom'); }, async () => {}),
      (e) => e instanceof RollbackError && e.code === 'ACTION_FAILED_ROLLED_BACK');
    assertOldState();
    assert.equal((await readJournal(deps))?.phase, 'rolled_back');
    assert.equal(events[events.length - 1], 'reopen');
  });

  test('فشل التحقق: رجوع كامل وإغلاق القاعدة قبل الرجوع', async () => {
    await assert.rejects(
      runWithRollback(deps, plan, async () => { writeNewState(); }, async () => { throw new Error('bad-db'); }),
      (e) => e instanceof RollbackError && e.code === 'VERIFY_FAILED_ROLLED_BACK');
    assertOldState();
    assert.deepEqual(events, ['close', 'reopen', 'close', 'reopen']);
  });

  test('ملف لم يكن موجوداً (wal) وأنشأته العملية الفاشلة يُزال عند الرجوع', async () => {
    await assert.rejects(runWithRollback(deps, plan, async () => {
      writeNewState(); fs.writeFileSync(walPath(), 'NEW-WAL'); throw new Error('x');
    }, async () => {}));
    assert.equal(fs.existsSync(walPath()), false);
    assertOldState();
  });

  test('فشل حفظ الأسرار قبل أي تحريك: لا تُمسّ الملفات', async () => {
    secrets.failStash = true;
    await assert.rejects(
      runWithRollback(deps, plan, async () => { throw new Error('must-not-run'); }, async () => {}),
      (e) => e instanceof RollbackError && e.code === 'GUARD_FAILED');
    assertOldState();
  });

  test('الأصل يُنقل لا يُحذف: أثناء action تكون نسخة الأمان موجودة بالبايتات الأصلية', async () => {
    let seenGuard = '';
    await runWithRollback(deps, plan, async () => {
      const j = await readJournal(deps);
      const t = j!.targets.find((x) => x.path === dbPath())!;
      seenGuard = fs.readFileSync(t.guardPath, 'utf8');
      assert.equal(fs.existsSync(dbPath()), false);
      writeNewState();
    }, async () => {});
    assert.equal(seenGuard, 'OLD-DB-BYTES');
  });

  test('انقطاع أثناء التنفيذ ثم إقلاع: التعافي يعيد الحالة السابقة', async () => {
    const crash = new Error('CRASH');
    // نحاكي الانقطاع: action يكتب الجديد ثم نكسر performRollback بجعل الحذف يفشل مرة واحدة.
    const realRemove = nodeFs.remove;
    let first = true;
    const flaky: RollbackFs = { ...nodeFs, async remove(p) {
      if (first && p === dbPath()) { first = false; throw crash; }
      return realRemove(p);
    } };
    await assert.rejects(
      runWithRollback({ ...deps, fs: flaky }, plan, async () => { writeNewState(); throw new Error('x'); }, async () => {}),
      (e) => e instanceof RollbackError && e.code === 'ROLLBACK_FAILED');
    assert.equal((await readJournal(deps))?.phase, 'rolling_back');
    // إقلاع جديد: التعافي بملفات سليمة
    const r = await recoverInterruptedOperation(deps);
    assert.equal(r.status, 'rolled_back');
    assertOldState();
    assert.equal((await recoverInterruptedOperation(deps)).status, 'cleaned');
  });

  test('عدم مطابقة البصمة بعد الرجوع لا يُعلَن نجاحاً (ROLLBACK_FAILED ويبقى السجل)', async () => {
    const tamper: RollbackFs = { ...nodeFs, async move(a, b) {
      await nodeFs.move(a, b);
      if (b === dbPath()) fs.writeFileSync(b, 'TAMPERED');
    } };
    await assert.rejects(
      runWithRollback({ ...deps, fs: tamper }, plan, async () => { throw new Error('x'); }, async () => {}),
      (e) => e instanceof RollbackError && e.code === 'ROLLBACK_FAILED');
    assert.equal((await readJournal(deps))?.phase, 'rolling_back');
  });

  test('تعافي: انقطاع بعد التحقق وقبل التثبيت (verified) يُثبَّت ولا يُرجَع', async () => {
    await runWithRollback(deps, plan, async () => { writeNewState(); }, async () => {});
    const j = (await readJournal(deps))!;
    j.phase = 'verified';
    fs.writeFileSync(deps.journalPath, JSON.stringify(j));
    const r = await recoverInterruptedOperation(deps);
    assert.equal(r.status, 'committed');
    assert.equal(fs.readFileSync(dbPath(), 'utf8'), 'NEW-DB-BYTES');
  });

  test('تعافي: لا سجل = none، وسجل تالف يُتجاهَل', async () => {
    assert.equal((await recoverInterruptedOperation(deps)).status, 'none');
    fs.writeFileSync(deps.journalPath, '{not json');
    assert.equal((await recoverInterruptedOperation(deps)).status, 'none');
  });

  test('سجل عملية غير منتهية يمنع بدء عملية جديدة', async () => {
    await assert.rejects(runWithRollback(deps, plan, async () => { throw new Error('x'); }, async () => {}));
    const j = (await readJournal(deps))!;
    j.phase = 'acting';
    fs.writeFileSync(deps.journalPath, JSON.stringify(j));
    await assert.rejects(
      runWithRollback(deps, plan, async () => {}, async () => {}),
      (e) => e instanceof RollbackError && e.code === 'JOURNAL_PENDING');
  });

  test('عمليتان متزامنتان: الثانية ترفض', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    const p1 = runWithRollback(deps, plan, async () => { await gate; writeNewState(); }, async () => {});
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(
      runWithRollback(deps, plan, async () => {}, async () => {}),
      (e) => e instanceof RollbackError && e.code === 'ROLLBACK_IN_PROGRESS');
    release(); await p1;
  });

  test('خطة غير صالحة: مسار مكرر / .. / داخل مجلد الحماية / بلا أهداف', async () => {
    for (const bad of [
      { ...plan, targets: [] },
      { ...plan, targets: [plan.targets[0], plan.targets[0]] },
      { ...plan, targets: [{ path: root + '/../x', kind: 'file' as const }] },
      { ...plan, targets: [{ path: deps.guardRoot + '/x', kind: 'file' as const }] },
    ]) {
      await assert.rejects(runWithRollback(deps, bad, async () => {}, async () => {}),
        (e) => e instanceof RollbackError && e.code === 'INVALID_PLAN');
    }
    assertOldState();
  });

  test('السجل لا يحتوي قيم أسرار', async () => {
    await runWithRollback(deps, plan, async () => { writeNewState(); }, async () => {});
    const raw = fs.readFileSync(deps.journalPath, 'utf8');
    assert.equal(raw.includes('old-key'), false);
    assert.equal(raw.includes('new-key'), false);
    assert.equal(raw.includes('db_encryption_key'), true);
  });
});
