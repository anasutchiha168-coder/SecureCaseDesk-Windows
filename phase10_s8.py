#!/usr/bin/env python3
# SECURECASEDESK_PHASE10_S8 — مثبّت القسم 10.8 (التكامل والاختبارات النهائية)
# شغّله من جذر المشروع:  python3 phase10_s8.py
import os, sys, re, json, hashlib, shutil, time

if not (os.path.isfile('package.json') and os.path.isfile('src/modules/backup/legacy-migration.ts')
        and os.path.isfile('src/database/db.ts')):
    sys.exit('شغّل السكربت من جذر المشروع بعد 10.7 (ملفات المشروع غير موجودة هنا).')

STAMP = time.strftime('%Y%m%d_%H%M%S')
FILES = {}
HASHES = {}
FILES['src/modules/backup/startup-recovery.ts'] = r'''// SECURECASEDESK_PHASE10_S8
// استيراد هذا الملف (أثر جانبي) يسجّل خطاف التعافي: أول getDb() في العملية ينتظر إكمال/رجوع أي عملية
// استبدال انقطعت، قبل فتح القاعدة. فشل التعافي (ROLLBACK_FAILED) يمنع فتح القاعدة عمداً.
import { setPreOpenHook } from '@/database/db';
import { recoverInterruptedRestore } from './backup-rollback-runtime';

setPreOpenHook(async () => { await recoverInterruptedRestore(); });
'''
HASHES['src/modules/backup/startup-recovery.ts'] = '0a6e25556aa394f99477ac9af93eb05fd229dbb220c6f3c77156f2816581be59'
FILES['tests/backup-integration.test.ts'] = r'''// SECURECASEDESK_PHASE10_S8
// اختبار تكاملي (10.8): ترحيل قاعدة قديمة ثم التراجع عنه عبر الحماية، بقواعد SQLite وملفات حقيقية.
// تشغَّل بـ: npm run test:backup-integration  (يتطلب Node >= 22.5). SQLite عادية لا SQLCipher.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RollbackError, runWithRollback, type RollbackDeps, type RollbackFs } from '../src/modules/backup/backup-rollback';
import {
  migrateLegacyDatabase, type LegacyProfile, type MigrationDeps, type MigrationFs, type TargetDb,
} from '../src/modules/backup/legacy-migration';

const sha = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rbFs: RollbackFs & MigrationFs = {
  async ensureDir(p) { fs.mkdirSync(p, { recursive: true }); },
  async exists(p) { return fs.existsSync(p); },
  async size(p) { return fs.existsSync(p) ? fs.statSync(p).size : 0; },
  async copy(a, b) { fs.copyFileSync(a, b); },
  async move(a, b) { fs.rmSync(b, { recursive: true, force: true }); fs.renameSync(a, b); },
  async remove(p) { fs.rmSync(p, { recursive: true, force: true }); },
  async readText(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; },
  async writeText(p, t) { fs.writeFileSync(p, t, 'utf8'); },
  async readHeader(p, n) { const b = Buffer.alloc(n); const fd = fs.openSync(p, 'r'); fs.readSync(fd, b, 0, n, 0); fs.closeSync(fd); return new Uint8Array(b); },
  async sha256File(p) { return sha(p); },
};

let root: string, live: string, legacySrc: string, safety: string;
let liveDb: DatabaseSync | null = null;
const rows = (p: string) => { const d = new DatabaseSync(p); try { return (d.prepare('SELECT COUNT(*) AS c FROM new_cases').get() as { c: number }).c; } finally { d.close(); } };

const profile: LegacyProfile = {
  id: 'it-v1', label: 'اختبار',
  detect: (p) => !!p.tables.old_cases,
  async migrate(ctx) {
    for (const c of await ctx.legacy.getAllAsync<{ id: number; title: string }>('SELECT id, title FROM old_cases')) {
      await ctx.insertOnce('old_cases', c.id, (nid) => ({ sql: 'INSERT INTO new_cases (id, title) VALUES (?, ?)', params: [nid, c.title] }));
    }
  },
};

function openLive() { liveDb = new DatabaseSync(live); }
function closeLive() { liveDb?.close(); liveDb = null; }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-it-'));
  live = path.join(root, 'securecase.db'); legacySrc = path.join(root, 'old.db'); safety = path.join(root, 'pre.db');
  const l = new DatabaseSync(legacySrc);
  l.exec('CREATE TABLE old_cases (id INTEGER PRIMARY KEY, title TEXT)');
  for (let i = 1; i <= 4; i++) l.prepare('INSERT INTO old_cases VALUES (?, ?)').run(i, 'ق' + i);
  l.close();
  openLive();
  liveDb!.exec('CREATE TABLE new_cases (id TEXT PRIMARY KEY, title TEXT)');
  liveDb!.prepare('INSERT INTO new_cases VALUES (?, ?)').run('existing', 'قائمة');
  fs.mkdirSync(path.join(root, 'attachments')); fs.writeFileSync(path.join(root, 'attachments', 'a.enc'), 'ATT');
});
afterEach(() => { closeLive(); fs.rmSync(root, { recursive: true, force: true }); });

function migrationDeps(): MigrationDeps {
  const d = liveDb!;
  const target: TargetDb = {
    async getAllAsync<T>(s: string, p: unknown[] = []) { return d.prepare(s).all(...(p as never[])) as T[]; },
    async getFirstAsync<T>(s: string, p: unknown[] = []) { return (d.prepare(s).get(...(p as never[])) ?? null) as T | null; },
    async execAsync(s) { d.exec(s); },
    async runAsync(s, p = []) { return d.prepare(s).run(...(p as never[])); },
    async transaction(fn) { d.exec('BEGIN'); try { const r = await fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; } },
  };
  return {
    fs: rbFs, target, profiles: [profile], stagingRoot: path.join(root, 'cache'),
    async openLegacy(p) {
      const o = new DatabaseSync(p, { readOnly: true });
      return {
        async getAllAsync<T>(s: string, q: unknown[] = []) { return o.prepare(s).all(...(q as never[])) as T[]; },
        async getFirstAsync<T>(s: string, q: unknown[] = []) { return (o.prepare(s).get(...(q as never[])) ?? null) as T | null; },
        async close() { o.close(); },
      };
    },
    async createSafetyCopy() { fs.copyFileSync(live, safety); return { path: safety, sha256: sha(safety) }; },
    newId: () => randomUUID(), now: () => Date.now(),
  };
}

function rollbackDeps(): RollbackDeps {
  const stash = new Map<string, string | null>();
  return {
    fs: rbFs,
    secrets: { async stash(n) { n.forEach((x) => stash.set(x, 'v')); }, async restore() {}, async clear() { stash.clear(); } },
    journalPath: path.join(root, 'journal.json'), guardRoot: path.join(root, 'guard'),
    newId: () => randomUUID(), now: () => Date.now(),
    async closeDatabase() { closeLive(); }, async reopenDatabase() { openLive(); },
  };
}
const plan = () => ({ operation: 'restore', secretNames: ['db_encryption_key'], targets: [
  { path: live, kind: 'file' as const }, { path: live + '-wal', kind: 'file' as const },
  { path: path.join(root, 'attachments'), kind: 'dir' as const }] });

test('ترحيل ثم التراجع عنه باستعادة نسخة الأمان: القاعدة تعود بايتاً بايت', async () => {
  const report = await migrateLegacyDatabase(migrationDeps(), { sourcePath: legacySrc, actorUserId: 'a', confirm: true });
  assert.equal(report.safetyCopyPath, safety);
  closeLive(); assert.equal(rows(live), 5); openLive();
  const preSha = sha(safety);

  await runWithRollback(rollbackDeps(), plan(), async () => {
    fs.copyFileSync(safety, live); fs.mkdirSync(path.join(root, 'attachments')); fs.writeFileSync(path.join(root, 'attachments', 'a.enc'), 'ATT');
  }, async () => { assert.equal(liveDb!.prepare('SELECT COUNT(*) AS c FROM new_cases').get()!.c, 1); });

  closeLive();
  assert.equal(sha(live), preSha);
  assert.equal(rows(live), 1);
  assert.equal(fs.readFileSync(path.join(root, 'attachments', 'a.enc'), 'utf8'), 'ATT');
});

test('استبدال فاشل التحقق بعد الترحيل: تبقى القاعدة المُرحَّلة كما هي (5 صفوف) والمرفقات سليمة', async () => {
  await migrateLegacyDatabase(migrationDeps(), { sourcePath: legacySrc, actorUserId: 'a', confirm: true });
  closeLive(); const postSha = sha(live); openLive();

  await assert.rejects(runWithRollback(rollbackDeps(), plan(), async () => {
    fs.writeFileSync(live, 'GARBAGE-NOT-A-DB'); fs.mkdirSync(path.join(root, 'attachments'));
  }, async () => { liveDb!.prepare('SELECT COUNT(*) FROM new_cases').get(); }),
  (e) => e instanceof RollbackError && e.code === 'VERIFY_FAILED_ROLLED_BACK');

  closeLive();
  assert.equal(sha(live), postSha);
  assert.equal(rows(live), 5);
  assert.equal(fs.readFileSync(path.join(root, 'attachments', 'a.enc'), 'utf8'), 'ATT');
  assert.deepEqual(fs.readdirSync(path.join(root, 'guard')), []);   // نسخة الأمان نُظّفت بعد الرجوع
});

test('ترحيل فاشل لا يترك أثراً، ثم ترحيل ناجح يعمل على نفس القاعدة', async () => {
  const bad: LegacyProfile = { ...profile, async migrate(ctx) { await profile.migrate(ctx); throw new Error('late'); } };
  await assert.rejects(migrateLegacyDatabase({ ...migrationDeps(), profiles: [bad] }, { sourcePath: legacySrc, actorUserId: 'a', confirm: true }));
  closeLive(); assert.equal(rows(live), 1); openLive();
  await migrateLegacyDatabase(migrationDeps(), { sourcePath: legacySrc, actorUserId: 'a', confirm: true });
  closeLive(); assert.equal(rows(live), 5);
});
'''
HASHES['tests/backup-integration.test.ts'] = '5c265f6361abf06768da861548d9e9be715b434d64ff5b459f98e38b98c3eeef'
FILES['docs/phase10/10.8-final-integration.md'] = r'''<!-- SECURECASEDESK_PHASE10_S8 -->
# المرحلة 10 / القسم 10.8 — الاختبارات النهائية والتكامل

> قاعدة التوثيق: لا يُعلَّم أي بند «نجح» إلا إذا نُفِّذ فعلاً. الحالات أدناه: **نُفِّذ** / **معلّق** / **غير مغطى**.

## ما أُضيف
- `startup-recovery.ts` + خطاف `setPreOpenHook` في `db.ts` + استيراده في `_layout.tsx`: أول `getDb()` ينتظر تعافي أي عملية استبدال منقطعة. فشل التعافي يمنع فتح القاعدة عمداً.
- `tests/backup-integration.test.ts` (3 اختبارات): ترحيل ثم تراجع باستعادة نسخة الأمان (مطابقة بايتات)، استبدال فاشل التحقق بعد ترحيل، وترحيل فاشل ثم ناجح.
- أمرا `npm run test:backup-integration` و`npm run test:backup-all` (يشغّل كل اختبارات النسخ الاحتياطي: foundation, snapshot, package, rollback, legacy-migration, integration).

## حالة المتطلبات (المرحلة 10)
| البند | الحالة | ملاحظة |
|---|---|---|
| نسخة مشفرة (قاعدة + مرفقات + أسرار) | نُفِّذ في Node (10.3) | لم يُجرَّب على Android |
| scrypt logN=15 على جهاز حقيقي | معلّق | قد يلزم تخفيضه إلى 14 |
| التحقق من النسخة (10.4) | حسب ما نفّذته أنت | لم أر ملفاته في المشروع المرفوع |
| الاستعادة وإنشاء نسخة الأمان (10.5/10.6) | حسب ما نفّذته أنت | لم أر ملفاتها؛ **الربط بـ `runProtectedReplacement` غير مؤكد** |
| تراجع آمن وتعافي بعد انقطاع | نُفِّذ في Node (14 + 3 اختبارات) | لم يُجرَّب على Android |
| ترحيل قاعدة قديمة (المحرك) | نُفِّذ في Node بـ SQLite عادية | لا SQLCipher |
| ترحيل القاعدة القديمة **الفعلية** | **معلّق: الملف غير متوفر** | `legacy-profiles.ts` فارغ |
| تسجيل تدقيق للنسخ/الاستعادة/الترحيل | معلّق | يعتمد على مشغلات الجداول التلقائية؛ لم يُتحقق |
| واجهة مستخدم للنسخ/الاستعادة/الترحيل | غير مغطى | |
| اختبار على جهاز Android حقيقي | **معلّق** | يشمل `expo-file-system` و`expo-sqlite` و`SecureStore` |
| `npx tsc --noEmit` للمشروع كاملاً | معلّق عندك | لم أستطع تشغيله (لا node_modules) |

## قائمة تحقق يدوية على الجهاز (تُنفَّذ ويُسجَّل نتيجتها الفعلية)
1. إنشاء نسخة، ثم تعديل بيانات، ثم استعادتها: تعود البيانات والمرفقات.
2. إيقاف التطبيق قسراً أثناء الاستعادة، ثم فتحه: يجب أن يكتمل الرجوع أو التثبيت قبل ظهور شاشة الدخول.
3. استعادة نسخة بكلمة مرور خاطئة: لا تتغير البيانات.
4. استعادة نسخة تالفة: لا تتغير البيانات.
5. بعد الاستعادة: فتح مرفق مشفر والتحقق من SHA-256، والتحقق من سلسلة HMAC للتدقيق.
6. زمن إنشاء النسخة (scrypt) على جهاز متوسط.
7. ترحيل القاعدة القديمة الفعلية (عند توفرها) على نسخة منها.

## حدود معروفة
- `closeDb()` يبطل أي مرجع قاعدة محفوظ خارج `getDb()`.
- لا رجوع آلي للترحيل بعد الالتزام؛ نسخة الأمان في `backups/pre-migration/`.
'''
HASHES['docs/phase10/10.8-final-integration.md'] = '8211ae8af817877de099bcb1bfa13126b181cf0e1c04785d555dcb49dec41499'

def put(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        if open(path, encoding='utf-8').read() == text:
            print('=  (بلا تغيير)', path); return
        shutil.copy2(path, path + '.bak_' + STAMP)
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    if hashlib.sha256(open(path, encoding='utf-8').read().encode()).hexdigest() != HASHES[path]:
        sys.exit('فشل التحقق من الملف بعد الكتابة: ' + path)
    print('OK', path)

for p, t in FILES.items():
    put(p, t)

# ---- db.ts: خطاف ما قبل الفتح ----
DB = 'src/database/db.ts'
src = open(DB, encoding='utf-8').read()
if 'SECURECASEDESK_PHASE10_S8' in src:
    print('=  (بلا تغيير)', DB)
else:
    anchor = 'export async function getDb() {\n  if (db) return db;\n'
    if anchor not in src:
        sys.exit('db.ts: لم أجد بداية getDb() بالشكل المتوقع. لم يُعدَّل شيء.')
    shutil.copy2(DB, DB + '.bak_' + STAMP)
    src = src.replace(anchor, anchor + '  if (preOpenHook) {\n    preOpenState ??= preOpenHook().catch((e) => { preOpenState = null; throw e; });\n    await preOpenState; // SECURECASEDESK_PHASE10_S8\n    if (db) return db;\n  }\n', 1)
    src = src.rstrip('\n') + """

// SECURECASEDESK_PHASE10_S8
// خطاف يُنفَّذ مرة واحدة قبل أول فتح للقاعدة (تعافي الاستبدال المنقطع). فشله يمنع الفتح ويُعاد تجريبه لاحقاً.
let preOpenHook: (() => Promise<void>) | null = null;
let preOpenState: Promise<void> | null = null;
export function setPreOpenHook(hook: () => Promise<void>): void {
  preOpenHook = hook;
  preOpenState = null;
}
"""
    with open(DB, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(src)
    print('OK', DB, '(+ preOpenHook)')

# ---- _layout.tsx ----
LAY = 'src/app/_layout.tsx'
lay = open(LAY, encoding='utf-8').read()
imp = "import '@/modules/backup/startup-recovery'; // SECURECASEDESK_PHASE10_S8\n"
if 'startup-recovery' in lay:
    print('=  (بلا تغيير)', LAY)
else:
    marker = "import { AuthProvider } from '@/context/AuthContext';\n"
    if marker not in lay:
        sys.exit('_layout.tsx: لم أجد سطر استيراد AuthProvider. أضف هذا السطر يدوياً في أعلى الملف:\n' + imp)
    shutil.copy2(LAY, LAY + '.bak_' + STAMP)
    with open(LAY, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(lay.replace(marker, imp + marker, 1))
    print('OK', LAY)

# ---- package.json ----
data = json.loads(open('package.json', encoding='utf-8').read())
scripts = data.get('scripts', {})
names = ['backup-foundation', 'backup-snapshot', 'backup-package', 'backup-rollback', 'legacy-migration', 'backup-integration']
if os.path.isfile('tests/backup-verify.test.ts'):
    names.insert(3, 'backup-verify')
add = {'test:backup-integration': 'tsx --tsconfig tests/tsconfig.json --test tests/backup-integration.test.ts',
       'test:backup-all': 'tsx --tsconfig tests/tsconfig.json --test ' + ' '.join('tests/%s.test.ts' % n for n in names)}
missing = {k: v for k, v in add.items() if scripts.get(k) != v}
if not missing:
    print('=  (بلا تغيير) package.json')
else:
    shutil.copy2('package.json', 'package.json.bak_' + STAMP)
    scripts.update(missing); data['scripts'] = scripts
    with open('package.json', 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2); fh.write('\n')
    print('OK package.json (+', ', '.join(missing), ')')

print('')
print('تم تثبيت 10.8. للتحقق:')
print('  npm run test:backup-all')
print('  npx tsc --noEmit')
print('  ثم نفّذ قائمة التحقق اليدوية في docs/phase10/10.8-final-integration.md على جهاز Android')
