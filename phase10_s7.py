#!/usr/bin/env python3
# SECURECASEDESK_PHASE10_S7 — مثبّت القسم 10.7 (التراجع الآمن + ترحيل القواعد القديمة)
# شغّله من جذر المشروع:  python3 phase10_s7.py
import os, sys, re, json, hashlib, shutil, time

if not (os.path.isfile('package.json') and os.path.isfile('src/modules/backup/backup-package.ts')
        and os.path.isfile('src/database/db.ts')):
    sys.exit('شغّل السكربت من جذر المشروع بعد اكتمال 10.1-10.3 (package.json و backup-package.ts و db.ts غير موجودة هنا).')
if not os.path.isfile('src/modules/backup/backup-verify.ts'):
    print('تنبيه: backup-verify.ts (10.4-B) غير موجود في هذا المجلد. المتابعة ممكنة لأن 10.7 لا يعتمد عليه.')

STAMP = time.strftime('%Y%m%d_%H%M%S')
FILES = {}
HASHES = {}
FILES['src/modules/backup/backup-rollback.ts'] = r'''// SECURECASEDESK_PHASE10_S7
// التراجع الآمن: حماية عملية تستبدل ملفات حيّة (قاعدة البيانات / المرفقات / الأسرار) بحيث يمكن
// دائماً الرجوع إلى الحالة السابقة بالضبط، حتى لو انقطع التطبيق في منتصف العملية.
// بالحقن الكامل (قابل للاختبار في Node). لا يعرف شيئاً عن صيغة النسخة ولا عن منطق الاستعادة (10.6):
// المستدعي يمرّر action (يكتب الحالة الجديدة) و verify (يتحقق منها).
//
// المبدأ: لا حذف أبداً قبل النجاح.
//  1) سجل رجوع (journal) يُكتب قبل أي تحريك.  2) الملفات الحيّة تُنقل (لا تُنسخ ولا تُحذف) إلى مجلد حماية.
//  3) الأسرار تُخزَّن في مخبأ SecureStore.  4) action ثم verify.  5) فشل أيهما = رجوع كامل مع مطابقة SHA-256.
//  6) النجاح = commit ثم تنظيف.  عند الإقلاع: recoverInterruptedOperation تُكمل الرجوع أو التثبيت.

export type RollbackErrorCode =
  | 'ROLLBACK_IN_PROGRESS' | 'JOURNAL_PENDING' | 'INVALID_PLAN' | 'GUARD_FAILED'
  | 'ACTION_FAILED_ROLLED_BACK' | 'VERIFY_FAILED_ROLLED_BACK' | 'ROLLBACK_FAILED';

export const ROLLBACK_ERROR_MESSAGES: Record<RollbackErrorCode, string> = {
  ROLLBACK_IN_PROGRESS: 'عملية محمية أخرى قيد التنفيذ.',
  JOURNAL_PENDING: 'توجد عملية سابقة غير مكتملة. يجب إكمال التعافي منها أولاً.',
  INVALID_PLAN: 'خطة الحماية غير صالحة.',
  GUARD_FAILED: 'تعذر حفظ نسخة الأمان قبل التنفيذ. أُعيدت الحالة السابقة ولم تُمسّ البيانات.',
  ACTION_FAILED_ROLLED_BACK: 'فشلت العملية وأُعيدت البيانات إلى حالتها السابقة بالكامل.',
  VERIFY_FAILED_ROLLED_BACK: 'فشل التحقق بعد التنفيذ وأُعيدت البيانات إلى حالتها السابقة بالكامل.',
  ROLLBACK_FAILED: 'تعذر إكمال الرجوع تلقائياً. نسخة الأمان محفوظة ولم تُحذف؛ لا تُشغّل أي عملية أخرى وراجع المسؤول.',
};

export class RollbackError extends Error {
  constructor(public readonly code: RollbackErrorCode, public readonly detail?: string) {
    super(ROLLBACK_ERROR_MESSAGES[code]);
    this.name = 'RollbackError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type RollbackPhase =
  | 'guarded' | 'acting' | 'verified' | 'committed' | 'rolling_back' | 'rolled_back';

export interface RollbackTarget { path: string; kind: 'file' | 'dir' }

export interface JournalTarget extends RollbackTarget {
  existed: boolean;
  guardPath: string;
  sha256: string | null;   // للملفات فقط
}

export interface RollbackJournal {
  version: 1;
  id: string;
  operation: string;
  phase: RollbackPhase;
  createdAt: number;
  updatedAt: number;
  targets: JournalTarget[];
  secretNames: string[];   // أسماء فقط، لا قيم
  note?: string;
}

export interface RollbackFs {
  ensureDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;                // ملف أو مجلد؛ لا خطأ إن غاب
  readText(path: string): Promise<string | null>;     // null إن غاب
  writeText(path: string, text: string): Promise<void>;
  sha256File(path: string): Promise<string>;
}

// مخبأ الأسرار: stash ينسخ القيم (أو غيابها) إلى مخزن آمن، restore يعيدها بالضبط، clear يمسح المخبأ.
export interface RollbackSecrets {
  stash(names: string[]): Promise<void>;
  restore(names: string[]): Promise<void>;
  clear(names: string[]): Promise<void>;
}

export interface RollbackDeps {
  fs: RollbackFs;
  secrets: RollbackSecrets;
  journalPath: string;
  guardRoot: string;            // مجلد حماية على نفس وحدة التخزين قدر الإمكان (document)
  newId(): string;
  now(): number;
  closeDatabase(): Promise<void>;
  reopenDatabase(): Promise<void>;
}

export interface RollbackPlan {
  operation: string;
  targets: RollbackTarget[];
  secretNames: string[];
}

const TERMINAL: RollbackPhase[] = ['committed', 'rolled_back'];
let inFlight = false;

const join = (a: string, b: string) => a.replace(/\/+$/, '') + '/' + b;

function validatePlan(deps: RollbackDeps, plan: RollbackPlan): void {
  if (!plan.operation || plan.targets.length === 0) throw new RollbackError('INVALID_PLAN');
  const seen = new Set<string>();
  for (const t of plan.targets) {
    if (!t.path || t.path.includes('..') || seen.has(t.path)) throw new RollbackError('INVALID_PLAN');
    if (t.kind !== 'file' && t.kind !== 'dir') throw new RollbackError('INVALID_PLAN');
    if (t.path.startsWith(deps.guardRoot)) throw new RollbackError('INVALID_PLAN');
    seen.add(t.path);
  }
  if (!deps.guardRoot || deps.guardRoot.includes('..')) throw new RollbackError('INVALID_PLAN');
}

// ===== السجل =====

async function writeJournal(deps: RollbackDeps, j: RollbackJournal, phase: RollbackPhase, note?: string): Promise<void> {
  j.phase = phase;
  j.updatedAt = deps.now();
  if (note !== undefined) j.note = note;
  const tmp = deps.journalPath + '.tmp';
  await deps.fs.writeText(tmp, JSON.stringify(j));
  await deps.fs.move(tmp, deps.journalPath);
}

function parseJournal(text: string | null): RollbackJournal | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as RollbackJournal;
    if (j && j.version === 1 && typeof j.id === 'string' && Array.isArray(j.targets) && typeof j.phase === 'string') return j;
  } catch { /* تالف */ }
  return null;
}

// يقرأ السجل الرئيسي، وإن غاب أو تلف يجرّب الملف المؤقت (انقطاع بين الكتابة والإعادة).
export async function readJournal(deps: RollbackDeps): Promise<RollbackJournal | null> {
  const main = parseJournal(await deps.fs.readText(deps.journalPath));
  if (main) return main;
  return parseJournal(await deps.fs.readText(deps.journalPath + '.tmp'));
}

// ===== الرجوع (متكرر الأمان: يمكن استدعاؤه مراراً بعد انقطاع) =====

async function performRollback(deps: RollbackDeps, j: RollbackJournal): Promise<void> {
  await writeJournal(deps, j, 'rolling_back');
  const problems: string[] = [];

  for (const t of j.targets) {
    try {
      if (!t.existed) {
        await deps.fs.remove(t.path);       // ما أنشأته العملية الفاشلة يُزال
        continue;
      }
      if (await deps.fs.exists(t.guardPath)) {
        await deps.fs.remove(t.path);       // الحالة الجديدة غير الموثوقة تُزال
        await deps.fs.move(t.guardPath, t.path);
      }
      // إن غابت نسخة الحماية فالأصل لم يُنقل بعد أو أُعيد سابقاً: لا نلمسه.
      if (t.kind === 'file' && t.sha256) {
        if (!(await deps.fs.exists(t.path))) problems.push(t.path + ':MISSING');
        else if ((await deps.fs.sha256File(t.path)) !== t.sha256) problems.push(t.path + ':HASH_MISMATCH');
      } else if (!(await deps.fs.exists(t.path))) {
        problems.push(t.path + ':MISSING');
      }
    } catch (e) {
      problems.push(t.path + ':' + (e instanceof Error ? e.message : 'ERROR'));
    }
  }

  try { await deps.secrets.restore(j.secretNames); } catch (e) {
    problems.push('SECRETS:' + (e instanceof Error ? e.message : 'ERROR'));
  }

  if (problems.length > 0) {
    // لا نحذف شيئاً ولا نغلق السجل: يبقى rolling_back كي يُعاد المحاولة ويُراجع.
    try { await writeJournal(deps, j, 'rolling_back', problems.join(' | ')); } catch { /* */ }
    throw new RollbackError('ROLLBACK_FAILED', problems.join(' | '));
  }

  await writeJournal(deps, j, 'rolled_back');
  await cleanup(deps, j);
}

async function cleanup(deps: RollbackDeps, j: RollbackJournal): Promise<void> {
  try { await deps.fs.remove(join(deps.guardRoot, j.id)); } catch { /* تنظيف فقط */ }
  try { await deps.secrets.clear(j.secretNames); } catch { /* تنظيف فقط */ }
}

// ===== التنفيذ المحمي =====

export interface ProtectedResult<T> { journalId: string; value: T }

export async function runWithRollback<T>(
  deps: RollbackDeps,
  plan: RollbackPlan,
  action: () => Promise<T>,
  verify: () => Promise<void>,
): Promise<ProtectedResult<T>> {
  if (inFlight) throw new RollbackError('ROLLBACK_IN_PROGRESS');
  inFlight = true;
  let journal: RollbackJournal | null = null;
  let dbClosed = false;
  try {
    validatePlan(deps, plan);
    const prior = await readJournal(deps);
    if (prior && !TERMINAL.includes(prior.phase)) throw new RollbackError('JOURNAL_PENDING');

    await deps.closeDatabase();
    dbClosed = true;

    // 1) تسجيل ما سيُحمى (قبل أي تحريك).
    const id = deps.newId();
    const guardDir = join(deps.guardRoot, id);
    await deps.fs.ensureDir(guardDir);
    const targets: JournalTarget[] = [];
    for (let i = 0; i < plan.targets.length; i++) {
      const t = plan.targets[i];
      const existed = await deps.fs.exists(t.path);
      targets.push({
        ...t, existed, guardPath: join(guardDir, i + '.pre'),
        sha256: existed && t.kind === 'file' ? await deps.fs.sha256File(t.path) : null,
      });
    }
    journal = {
      version: 1, id, operation: plan.operation, phase: 'guarded',
      createdAt: deps.now(), updatedAt: deps.now(), targets, secretNames: [...plan.secretNames],
    };
    await writeJournal(deps, journal, 'guarded');

    // 2) الأسرار ثم نقل الملفات الحيّة إلى الحماية.
    try {
      await deps.secrets.stash(plan.secretNames);
      for (const t of targets) {
        if (t.existed) await deps.fs.move(t.path, t.guardPath);
      }
      await writeJournal(deps, journal, 'acting');
    } catch {
      await performRollback(deps, journal);
      throw new RollbackError('GUARD_FAILED');
    }

    // 3) التنفيذ.
    let value: T;
    try {
      value = await action();
    } catch (e) {
      await performRollback(deps, journal);
      throw new RollbackError('ACTION_FAILED_ROLLED_BACK', e instanceof Error ? e.message : undefined);
    }

    // 4) التحقق من الحالة الجديدة (القاعدة تُفتح من جديد داخل verify عبر reopen).
    try {
      await deps.reopenDatabase();
      dbClosed = false;
      await verify();
    } catch (e) {
      await deps.closeDatabase().catch(() => {});
      dbClosed = true;
      await performRollback(deps, journal);
      throw new RollbackError('VERIFY_FAILED_ROLLED_BACK', e instanceof Error ? e.message : undefined);
    }

    // 5) التثبيت ثم التنظيف (التنظيف لا يفشل العملية).
    await writeJournal(deps, journal, 'verified');
    await writeJournal(deps, journal, 'committed');
    await cleanup(deps, journal);
    return { journalId: journal.id, value };
  } finally {
    if (dbClosed) { try { await deps.reopenDatabase(); } catch { /* يُعاد فتحها عند أول getDb */ } }
    inFlight = false;
  }
}

// ===== التعافي عند الإقلاع (يُستدعى قبل فتح القاعدة) =====

export type RecoveryStatus = 'none' | 'rolled_back' | 'committed' | 'cleaned';

export async function recoverInterruptedOperation(deps: RollbackDeps): Promise<{ status: RecoveryStatus; journalId?: string }> {
  const j = await readJournal(deps);
  if (!j) return { status: 'none' };

  switch (j.phase) {
    case 'guarded':
    case 'acting':
    case 'rolling_back':
      // الحالة الجديدة لم يُتحقق منها: الرجوع هو الخيار الآمن الوحيد.
      await performRollback(deps, j);
      return { status: 'rolled_back', journalId: j.id };
    case 'verified':
      // انقطاع بعد نجاح التحقق وقبل التثبيت: الحالة الجديدة موثّقة، نُكمل التثبيت.
      await writeJournal(deps, j, 'committed');
      await cleanup(deps, j);
      return { status: 'committed', journalId: j.id };
    case 'committed':
    case 'rolled_back':
      await cleanup(deps, j);
      return { status: 'cleaned', journalId: j.id };
  }
}
'''
HASHES['src/modules/backup/backup-rollback.ts'] = '1cc56fa67a68f6d7defc1e22be3c214528f3972810ba80664728753fd3333616'
FILES['src/modules/backup/backup-rollback-runtime.ts'] = r'''// SECURECASEDESK_PHASE10_S7
// محوّل Expo للتراجع الآمن. ⚠️ لم يُختبر على جهاز: أسماء واجهات expo-file-system (File/Directory/text/move)
// تحتاج فحص tsc وتجربة فعلية، كما في بقية أقسام المرحلة 10.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { closeDb, getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import {
  recoverInterruptedOperation, runWithRollback,
  type ProtectedResult, type RecoveryStatus, type RollbackDeps, type RollbackFs, type RollbackSecrets, type RollbackTarget,
} from './backup-rollback';
import {
  ATTACHMENTS_DIR_NAME, BACKUP_OUTPUT_DIR_NAME, BACKUP_PERMISSION, DATABASE_FILE_NAME, SECRET_NAMES, auditHmacKeyName,
} from './backup-types';

const CHUNK = 256 * 1024;
const STASH_PREFIX = 'scd_rb_stash_';
const stripScheme = (uri: string) => uri.replace(/^file:\/\//, '');

function removeIfExists(path: string) {
  const f = new File(path);
  if (f.exists) { f.delete(); return; }
  const d = new Directory(path);
  if (d.exists) d.delete();
}

const expoFs: RollbackFs = {
  async ensureDir(path) { new Directory(path).create({ intermediates: true, idempotent: true }); },
  async exists(path) { return new File(path).exists || new Directory(path).exists; },
  async move(from, to) {
    removeIfExists(to);
    const f = new File(from);
    if (f.exists) { f.move(new File(to)); return; }
    new Directory(from).move(new Directory(to));
  },
  async remove(path) { removeIfExists(path); },
  async readText(path) { const f = new File(path); return f.exists ? await f.text() : null; },
  async writeText(path, text) { const f = new File(path); if (!f.exists) f.create(); f.write(text); },
  async sha256File(path) {
    const f = new File(path);
    const total = f.size;
    const h = sha256.create();
    const handle = f.open(FileMode.ReadOnly);
    try {
      let read = 0;
      while (read < total) {
        const bytes = handle.readBytesSync(Math.min(CHUNK, total - read));
        if (bytes.length === 0) break;
        h.update(bytes);
        read += bytes.length;
      }
      if (read !== total) throw new Error('SHORT_READ');
    } finally { handle.close(); }
    return bytesToHex(h.digest());
  },
};

// المخبأ يحفظ القيمة أو غيابها، فيعيد restore الحالة بالضبط (بما فيها حذف سر لم يكن موجوداً).
const expoSecrets: RollbackSecrets = {
  async stash(names) {
    for (const n of names) {
      const v = await SecureStore.getItemAsync(n);
      await SecureStore.setItemAsync(STASH_PREFIX + n, JSON.stringify(v === null ? { p: false } : { p: true, v }));
    }
  },
  async restore(names) {
    for (const n of names) {
      const raw = await SecureStore.getItemAsync(STASH_PREFIX + n);
      if (raw === null) continue;                       // لم يصل التخزين لهذا السر: لم يُمسّ
      const s = JSON.parse(raw) as { p: boolean; v?: string };
      if (s.p && typeof s.v === 'string') await SecureStore.setItemAsync(n, s.v);
      else await SecureStore.deleteItemAsync(n);
    }
  },
  async clear(names) { for (const n of names) await SecureStore.deleteItemAsync(STASH_PREFIX + n); },
};

// أسماء الأسرار المحمية: الثابتة + مفاتيح HMAC لكل إصدار حتى الإصدار النشط الحالي.
export async function protectedSecretNames(): Promise<string[]> {
  const names: string[] = [
    SECRET_NAMES.dbKey, SECRET_NAMES.attachmentMasterKey, SECRET_NAMES.auditActiveVersion,
    SECRET_NAMES.auditCheckpointKey, SECRET_NAMES.auditCheckpointLast,
  ];
  const active = Number(await SecureStore.getItemAsync(SECRET_NAMES.auditActiveVersion));
  const top = Number.isInteger(active) && active > 0 ? Math.min(active, 100) : 1;
  for (let v = 1; v <= top; v++) names.push(auditHmacKeyName(v));
  return names;
}

function buildDeps(): RollbackDeps {
  const documentDir = stripScheme(Paths.document.uri);
  const backups = documentDir.replace(/\/+$/, '') + '/' + BACKUP_OUTPUT_DIR_NAME;
  return {
    fs: expoFs, secrets: expoSecrets,
    journalPath: backups + '/rollback-journal.json',
    guardRoot: backups + '/rollback-guard',
    newId: () => Crypto.randomUUID(), now: () => Date.now(),
    closeDatabase: () => closeDb(),
    reopenDatabase: async () => { await getDb(); },
  };
}

function databaseFilePath(): string {
  return stripScheme(String(SQLite.defaultDatabaseDirectory)).replace(/\/+$/, '') + '/' + DATABASE_FILE_NAME;
}

// يُستدعى عند إقلاع التطبيق قبل أول getDb()/initDatabase(): يكمل الرجوع أو التثبيت لعملية انقطعت.
// بدون جلسة عمداً (يعمل قبل تسجيل الدخول). يرمي RollbackError('ROLLBACK_FAILED') إن تعذر الرجوع.
export async function recoverInterruptedRestore(): Promise<{ status: RecoveryStatus; journalId?: string }> {
  const dir = new Directory(stripScheme(Paths.document.uri).replace(/\/+$/, '') + '/' + BACKUP_OUTPUT_DIR_NAME);
  if (!dir.exists) return { status: 'none' };
  return recoverInterruptedOperation(buildDeps());
}

// ينفّذ action (يكتب الحالة الجديدة في مسارات القاعدة والمرفقات) تحت حماية الرجوع الكامل.
// 10.6 يمرّر منطق الاستبدال هنا، و verify يفتح القاعدة الجديدة ويتحقق منها.
export async function runProtectedReplacement<T>(
  session: Session | null | undefined,
  action: () => Promise<T>,
  verify: () => Promise<void>,
): Promise<ProtectedResult<T>> {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);

  const dbPath = databaseFilePath();
  const targets: RollbackTarget[] = [
    { path: dbPath, kind: 'file' },
    { path: dbPath + '-wal', kind: 'file' },
    { path: dbPath + '-shm', kind: 'file' },
    { path: stripScheme(Paths.document.uri).replace(/\/+$/, '') + '/' + ATTACHMENTS_DIR_NAME, kind: 'dir' },
  ];
  return runWithRollback(buildDeps(), { operation: 'replace-data', targets, secretNames: await protectedSecretNames() }, action, verify);
}
'''
HASHES['src/modules/backup/backup-rollback-runtime.ts'] = 'd80e6cd2bf2d31f59213e79f12144349deb8539f8938fc18545a60528c2f630f'
FILES['src/modules/backup/legacy-migration.ts'] = r'''// SECURECASEDESK_PHASE10_S7
// ترحيل قاعدة بيانات قديمة (Legacy) إلى القاعدة الحالية. بالحقن الكامل (قابل للاختبار في Node).
//
// الضمانات:
//  - الملف الأصلي لا يُفتح ولا يُعدَّل: يُنسخ إلى مجلد مؤقت وتُقرأ النسخة؛ وبصمته تُقارن قبل وبعد.
//  - الفحص قبل أي كتابة: ترويسة الملف، integrity_check، foreign_key_check، تحديد الإصدار (profile) بلا غموض.
//  - الكتابة كلها في معاملة واحدة: فشل أي خطوة (حتى التحقق النهائي) = ROLLBACK كامل ولا صف جزئي.
//  - منع التكرار على مستويين: بصمة الملف كاملاً (legacy_migrations) + معرّف كل صف (legacy_id_map).
//  - جدولا السجل غير قابلين للتعديل والحذف (مشغلات) كباقي السجلات التاريخية.
//  - لا يوجد في هذا الملف أي افتراض عن مخطط القاعدة القديمة: المخطط يُعرَّف في ملفات profile
//    (legacy-profiles.ts) بعد فحص القاعدة القديمة الفعلية. بدون profile مطابق = UNSUPPORTED_LEGACY_VERSION.

export type LegacyErrorCode =
  | 'CONFIRMATION_REQUIRED' | 'LEGACY_FILE_MISSING' | 'LEGACY_NOT_SQLITE' | 'LEGACY_KEY_REQUIRED'
  | 'LEGACY_OPEN_FAILED' | 'LEGACY_INTEGRITY_FAILED' | 'UNSUPPORTED_LEGACY_VERSION'
  | 'AMBIGUOUS_LEGACY_VERSION' | 'ALREADY_MIGRATED' | 'SAFETY_COPY_FAILED' | 'SOURCE_CHANGED'
  | 'POST_CHECK_FAILED' | 'MIGRATION_FAILED' | 'MIGRATION_IN_PROGRESS';

export const LEGACY_ERROR_MESSAGES: Record<LegacyErrorCode, string> = {
  CONFIRMATION_REQUIRED: 'يجب تأكيد عملية الترحيل صراحةً.',
  LEGACY_FILE_MISSING: 'ملف قاعدة البيانات القديمة غير موجود أو فارغ.',
  LEGACY_NOT_SQLITE: 'الملف ليس قاعدة SQLite غير مشفرة. إن كان مشفراً فأدخل مفتاحه.',
  LEGACY_KEY_REQUIRED: 'قاعدة البيانات القديمة مشفرة ويلزم مفتاحها.',
  LEGACY_OPEN_FAILED: 'تعذر فتح قاعدة البيانات القديمة (مفتاح خاطئ أو ملف تالف).',
  LEGACY_INTEGRITY_FAILED: 'فحص سلامة قاعدة البيانات القديمة فشل. لم يُرحَّل شيء.',
  UNSUPPORTED_LEGACY_VERSION: 'إصدار قاعدة البيانات القديمة غير معروف. لم يُرحَّل شيء.',
  AMBIGUOUS_LEGACY_VERSION: 'أكثر من إصدار معروف يطابق القاعدة القديمة. لم يُرحَّل شيء.',
  ALREADY_MIGRATED: 'هذه القاعدة القديمة رُحِّلت سابقاً بالكامل. لا حاجة لترحيلها مرة أخرى.',
  SAFETY_COPY_FAILED: 'تعذر إنشاء نسخة أمان قبل الترحيل. لم يُرحَّل شيء.',
  SOURCE_CHANGED: 'تغيّر الملف الأصلي أثناء الترحيل. أُلغيت العملية بالكامل.',
  POST_CHECK_FAILED: 'فشل التحقق بعد الترحيل وأُلغيت العملية بالكامل.',
  MIGRATION_FAILED: 'فشل الترحيل وأُلغيت العملية بالكامل. القاعدة الحالية كما كانت.',
  MIGRATION_IN_PROGRESS: 'عملية ترحيل أخرى قيد التنفيذ.',
};

export class LegacyMigrationError extends Error {
  constructor(public readonly code: LegacyErrorCode, public readonly detail?: string) {
    super(LEGACY_ERROR_MESSAGES[code]);
    this.name = 'LegacyMigrationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ===== الواجهات المحقونة =====

export interface SqlReader {
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>;
}
export interface LegacyDb extends SqlReader { close(): Promise<void> }
export interface TargetTx extends SqlReader {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: unknown[]): Promise<unknown>;
}
export interface TargetDb extends TargetTx {
  // يلتزم (commit) إن اكتملت الدالة ويتراجع (rollback) إن رمت خطأ.
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface MigrationFs {
  exists(path: string): Promise<boolean>;
  size(path: string): Promise<number>;
  ensureDir(path: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  readHeader(path: string, bytes: number): Promise<Uint8Array>;
  sha256File(path: string): Promise<string>;
}

export interface LegacySchemaProbe {
  userVersion: number;
  tables: Record<string, string[]>;   // اسم الجدول → أسماء الأعمدة
}

export interface MigrationCounts { [legacyTable: string]: { inserted: number; skipped: number } }

export interface MigrationContext {
  legacy: SqlReader;
  tx: TargetTx;
  actorUserId: string;
  newId(): string;
  now(): number;
  // يدرج صفاً مرة واحدة فقط لكل (جدول قديم، معرّف قديم). يعيد skipped إن رُحِّل سابقاً.
  insertOnce(legacyTable: string, legacyId: string | number,
    build: (newId: string) => { sql: string; params: unknown[] }): Promise<'inserted' | 'skipped'>;
  // يترجم معرّفاً قديماً إلى المعرّف الجديد (للمفاتيح الأجنبية). null إن لم يُرحَّل.
  resolveId(legacyTable: string, legacyId: string | number): Promise<string | null>;
}

export interface LegacyProfile {
  id: string;                    // مثل 'legacy-v1' — يُحفظ في السجل، لا يتغير أبداً
  label: string;                 // عربي للعرض
  detect(probe: LegacySchemaProbe): boolean;
  migrate(ctx: MigrationContext): Promise<void>;   // يرمي عند أي شذوذ؛ لا يلتقط الأخطاء
}

export interface MigrationDeps {
  fs: MigrationFs;
  target: TargetDb;
  profiles: LegacyProfile[];
  stagingRoot: string;                                   // cache
  openLegacy(stagedPath: string, key?: string): Promise<LegacyDb>;
  createSafetyCopy(): Promise<{ path: string; sha256: string }>;   // لقطة 10.2 محفوظة خارج cache
  newId(): string;
  now(): number;
}

export interface LegacyInspection {
  sourceSha256: string;
  sourceSize: number;
  plaintext: boolean;
  userVersion: number;
  tables: Record<string, string[]>;
  matchedProfile: { id: string; label: string } | null;
  alreadyMigrated: boolean;
  foreignKeyViolations: number;
  warnings: string[];
}

export interface MigrationReport extends LegacyInspection {
  migrationId: string;
  counts: MigrationCounts;
  safetyCopyPath: string;
  targetForeignKeyViolationsBefore: number;
  targetForeignKeyViolationsAfter: number;
}

// ===== مخطط السجل في القاعدة الهدف =====

export const LEGACY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS legacy_migrations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  counts_json TEXT NOT NULL,
  safety_copy_path TEXT,
  actor_user_id TEXT NOT NULL,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_legacy_migrations_completed
  ON legacy_migrations(profile_id, source_sha256) WHERE status = 'completed';
CREATE TABLE IF NOT EXISTS legacy_id_map (
  profile_id TEXT NOT NULL,
  legacy_table TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  new_id TEXT NOT NULL,
  migration_id TEXT NOT NULL,
  PRIMARY KEY (profile_id, legacy_table, legacy_id)
);
CREATE TRIGGER IF NOT EXISTS trg_legacy_migrations_no_update BEFORE UPDATE ON legacy_migrations
BEGIN SELECT RAISE(ABORT, 'legacy_migrations: التعديل ممنوع'); END;
CREATE TRIGGER IF NOT EXISTS trg_legacy_migrations_no_delete BEFORE DELETE ON legacy_migrations
BEGIN SELECT RAISE(ABORT, 'legacy_migrations: الحذف ممنوع'); END;
CREATE TRIGGER IF NOT EXISTS trg_legacy_id_map_no_update BEFORE UPDATE ON legacy_id_map
BEGIN SELECT RAISE(ABORT, 'legacy_id_map: التعديل ممنوع'); END;
CREATE TRIGGER IF NOT EXISTS trg_legacy_id_map_no_delete BEFORE DELETE ON legacy_id_map
BEGIN SELECT RAISE(ABORT, 'legacy_id_map: الحذف ممنوع'); END;
`;

const SQLITE_MAGIC = 'SQLite format 3\u0000';
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const join = (a: string, b: string) => a.replace(/\/+$/, '') + '/' + b;

let inFlight = false;

function isPlaintextSqlite(header: Uint8Array): boolean {
  if (header.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) if (header[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  return true;
}

async function countFkViolations(db: SqlReader): Promise<number> {
  return (await db.getAllAsync<unknown>('PRAGMA foreign_key_check')).length;
}

async function probeSchema(legacy: SqlReader): Promise<LegacySchemaProbe> {
  const uv = await legacy.getFirstAsync<Record<string, unknown>>('PRAGMA user_version');
  const userVersion = Number(uv ? Object.values(uv)[0] : 0) || 0;
  const names = await legacy.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  const tables: Record<string, string[]> = {};
  for (const { name } of names) {
    if (!SAFE_IDENT.test(name)) continue;     // أسماء غريبة لا تُدمج في SQL ولا تُطابَق
    const cols = await legacy.getAllAsync<{ name: string }>('PRAGMA table_info(' + name + ')');
    tables[name] = cols.map((c) => c.name);
  }
  return { userVersion, tables };
}

function selectProfile(profiles: LegacyProfile[], probe: LegacySchemaProbe): LegacyProfile {
  const matched = profiles.filter((p) => { try { return p.detect(probe); } catch { return false; } });
  if (matched.length === 0) throw new LegacyMigrationError('UNSUPPORTED_LEGACY_VERSION');
  if (matched.length > 1) throw new LegacyMigrationError('AMBIGUOUS_LEGACY_VERSION', matched.map((p) => p.id).join(','));
  return matched[0];
}

// ===== مراحل مشتركة =====

interface Staged { dir: string; path: string; sha256: string; size: number; plaintext: boolean }

async function stageSource(deps: MigrationDeps, sourcePath: string, key: string | undefined): Promise<Staged> {
  if (!(await deps.fs.exists(sourcePath))) throw new LegacyMigrationError('LEGACY_FILE_MISSING');
  const size = await deps.fs.size(sourcePath);
  if (size <= 0) throw new LegacyMigrationError('LEGACY_FILE_MISSING');

  const plaintext = isPlaintextSqlite(await deps.fs.readHeader(sourcePath, 16));
  if (!plaintext && !key) throw new LegacyMigrationError('LEGACY_NOT_SQLITE');

  const sha256 = await deps.fs.sha256File(sourcePath);
  const dir = join(join(deps.stagingRoot, 'legacy-staging'), deps.newId());
  await deps.fs.ensureDir(dir);
  const path = join(dir, 'legacy.db');
  try {
    await deps.fs.copy(sourcePath, path);
    if ((await deps.fs.sha256File(path)) !== sha256) throw new Error('COPY_MISMATCH');
  } catch {
    await deps.fs.remove(dir).catch(() => {});
    throw new LegacyMigrationError('LEGACY_OPEN_FAILED', 'STAGING_COPY');
  }
  return { dir, path, sha256, size, plaintext };
}

async function openAndCheck(deps: MigrationDeps, staged: Staged, key: string | undefined): Promise<LegacyDb> {
  let legacy: LegacyDb;
  try { legacy = await deps.openLegacy(staged.path, key); }
  catch { throw new LegacyMigrationError('LEGACY_OPEN_FAILED'); }
  try {
    const rows = await legacy.getAllAsync<Record<string, unknown>>('PRAGMA integrity_check');
    const ok = rows.length === 1 && String(Object.values(rows[0])[0]).toLowerCase() === 'ok';
    if (!ok) throw new LegacyMigrationError('LEGACY_INTEGRITY_FAILED');
    return legacy;
  } catch (e) {
    await legacy.close().catch(() => {});
    if (e instanceof LegacyMigrationError) throw e;
    throw new LegacyMigrationError('LEGACY_OPEN_FAILED');   // مفتاح خاطئ يظهر هنا غالباً
  }
}

async function isAlreadyMigrated(target: SqlReader, profileId: string, sha: string): Promise<boolean> {
  const row = await target.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM legacy_migrations WHERE profile_id = ? AND source_sha256 = ? AND status = 'completed'`,
    [profileId, sha]);
  return !!row && Number(row.c) > 0;
}

// ===== الفحص فقط (لا كتابة في القاعدة الحالية، ويُستخدم للمعاينة) =====

export async function inspectLegacyDatabase(
  deps: MigrationDeps, sourcePath: string, key?: string,
): Promise<LegacyInspection> {
  await deps.target.execAsync(LEGACY_SCHEMA_SQL);   // جداول السجل فقط (IF NOT EXISTS) لازمة لفحص التكرار
  const staged = await stageSource(deps, sourcePath, key);
  let legacy: LegacyDb | null = null;
  try {
    legacy = await openAndCheck(deps, staged, key);
    const probe = await probeSchema(legacy);
    const warnings: string[] = [];
    const fk = await countFkViolations(legacy);
    if (fk > 0) warnings.push('القاعدة القديمة تحتوي ' + fk + ' مخالفة مفاتيح أجنبية؛ ستُعالَج حسب ملف الإصدار.');
    if (staged.plaintext) warnings.push('القاعدة القديمة غير مشفرة. يُنصح بحذفها بشكل آمن بعد نجاح الترحيل (لا يحذفها النظام).');

    let matched: LegacyProfile | null = null;
    try { matched = selectProfile(deps.profiles, probe); }
    catch (e) { if (!(e instanceof LegacyMigrationError) || e.code === 'AMBIGUOUS_LEGACY_VERSION') throw e; }

    return {
      sourceSha256: staged.sha256, sourceSize: staged.size, plaintext: staged.plaintext,
      userVersion: probe.userVersion, tables: probe.tables,
      matchedProfile: matched ? { id: matched.id, label: matched.label } : null,
      alreadyMigrated: matched ? await isAlreadyMigrated(deps.target, matched.id, staged.sha256) : false,
      foreignKeyViolations: fk, warnings,
    };
  } finally {
    if (legacy) await legacy.close().catch(() => {});
    await deps.fs.remove(staged.dir).catch(() => {});
  }
}

// ===== الترحيل =====

export async function migrateLegacyDatabase(
  deps: MigrationDeps,
  req: { sourcePath: string; key?: string; actorUserId: string; confirm: boolean },
): Promise<MigrationReport> {
  if (req.confirm !== true) throw new LegacyMigrationError('CONFIRMATION_REQUIRED');
  if (inFlight) throw new LegacyMigrationError('MIGRATION_IN_PROGRESS');
  inFlight = true;
  const startedAt = deps.now();
  let staged: Staged | null = null;
  let legacy: LegacyDb | null = null;
  let profile: LegacyProfile | null = null;
  try {
    await deps.target.execAsync(LEGACY_SCHEMA_SQL);
    staged = await stageSource(deps, req.sourcePath, req.key);
    legacy = await openAndCheck(deps, staged, req.key);

    const probe = await probeSchema(legacy);
    profile = selectProfile(deps.profiles, probe);
    if (await isAlreadyMigrated(deps.target, profile.id, staged.sha256)) throw new LegacyMigrationError('ALREADY_MIGRATED');

    const legacyFk = await countFkViolations(legacy);
    const warnings: string[] = [];
    if (legacyFk > 0) warnings.push('القاعدة القديمة تحتوي ' + legacyFk + ' مخالفة مفاتيح أجنبية.');
    if (staged.plaintext) warnings.push('القاعدة القديمة غير مشفرة؛ يُنصح بحذفها بشكل آمن بعد النجاح.');

    let safety: { path: string; sha256: string };
    try { safety = await deps.createSafetyCopy(); }
    catch { throw new LegacyMigrationError('SAFETY_COPY_FAILED'); }

    const migrationId = deps.newId();
    const counts: MigrationCounts = {};
    const sourceSha = staged.sha256;
    const stagedRef = staged;
    const profileRef = profile;
    const legacyRef = legacy;
    let fkBefore = 0;
    let fkAfter = 0;

    await deps.target.transaction(async () => {
      fkBefore = await countFkViolations(deps.target);

      const tally = (t: string, k: 'inserted' | 'skipped') => {
        counts[t] = counts[t] ?? { inserted: 0, skipped: 0 };
        counts[t][k] += 1;
      };
      const ctx: MigrationContext = {
        legacy: legacyRef, tx: deps.target, actorUserId: req.actorUserId,
        newId: () => deps.newId(), now: () => deps.now(),
        async resolveId(legacyTable, legacyId) {
          const r = await deps.target.getFirstAsync<{ new_id: string }>(
            'SELECT new_id FROM legacy_id_map WHERE profile_id = ? AND legacy_table = ? AND legacy_id = ?',
            [profileRef.id, legacyTable, String(legacyId)]);
          return r ? r.new_id : null;
        },
        async insertOnce(legacyTable, legacyId, build) {
          if (!SAFE_IDENT.test(legacyTable)) throw new Error('BAD_LEGACY_TABLE');
          const existing = await ctx.resolveId(legacyTable, legacyId);
          if (existing) { tally(legacyTable, 'skipped'); return 'skipped'; }
          const newId = deps.newId();
          const stmt = build(newId);
          await deps.target.runAsync(stmt.sql, stmt.params);
          await deps.target.runAsync(
            'INSERT INTO legacy_id_map (profile_id, legacy_table, legacy_id, new_id, migration_id) VALUES (?, ?, ?, ?, ?)',
            [profileRef.id, legacyTable, String(legacyId), newId, migrationId]);
          tally(legacyTable, 'inserted');
          return 'inserted';
        },
      };

      try { await profileRef.migrate(ctx); }
      catch (e) { throw new LegacyMigrationError('MIGRATION_FAILED', e instanceof Error ? e.message : undefined); }

      // تحقق قبل الالتزام: لا مخالفات مفاتيح أجنبية جديدة، والملف الأصلي لم يتغير.
      fkAfter = await countFkViolations(deps.target);
      if (fkAfter > fkBefore) throw new LegacyMigrationError('POST_CHECK_FAILED', 'FK_VIOLATIONS');
      if ((await deps.fs.sha256File(req.sourcePath)) !== sourceSha) throw new LegacyMigrationError('SOURCE_CHANGED');

      await deps.target.runAsync(
        `INSERT INTO legacy_migrations (id, profile_id, source_sha256, source_size, status, counts_json,
           safety_copy_path, actor_user_id, error_code, started_at, finished_at)
         VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, NULL, ?, ?)`,
        [migrationId, profileRef.id, sourceSha, stagedRef.size, JSON.stringify(counts),
          safety.path, req.actorUserId, startedAt, deps.now()]);
    });

    return {
      sourceSha256: staged.sha256, sourceSize: staged.size, plaintext: staged.plaintext,
      userVersion: probe.userVersion, tables: probe.tables,
      matchedProfile: { id: profile.id, label: profile.label },
      alreadyMigrated: false, foreignKeyViolations: legacyFk, warnings,
      migrationId, counts, safetyCopyPath: safety.path,
      targetForeignKeyViolationsBefore: fkBefore, targetForeignKeyViolationsAfter: fkAfter,
    };
  } catch (e) {
    const err = e instanceof LegacyMigrationError ? e : new LegacyMigrationError('MIGRATION_FAILED');
    await recordFailure(deps, profile, staged, req.actorUserId, err.code, startedAt);
    throw err;
  } finally {
    if (legacy) await legacy.close().catch(() => {});
    if (staged) await deps.fs.remove(staged.dir).catch(() => {});
    inFlight = false;
  }
}

// يسجل المحاولة الفاشلة (خارج المعاملة الملغاة) لتبقى في التاريخ. فشل التسجيل لا يخفي الخطأ الأصلي.
async function recordFailure(
  deps: MigrationDeps, profile: LegacyProfile | null, staged: Staged | null,
  actor: string, code: LegacyErrorCode, startedAt: number,
): Promise<void> {
  if (!profile || !staged) return;     // لا ملف/إصدار معروف: لا شيء يُنسب إليه
  try {
    await deps.target.runAsync(
      `INSERT INTO legacy_migrations (id, profile_id, source_sha256, source_size, status, counts_json,
         safety_copy_path, actor_user_id, error_code, started_at, finished_at)
       VALUES (?, ?, ?, ?, 'failed', '{}', NULL, ?, ?, ?, ?)`,
      [deps.newId(), profile.id, staged.sha256, staged.size, actor, code, startedAt, deps.now()]);
  } catch { /* تسجيل فقط */ }
}
'''
HASHES['src/modules/backup/legacy-migration.ts'] = '6f622ae21057ffef654f5cdc3f5d7c988270b654d9ad1e56ef7ff6f68f5b85aa'
FILES['src/modules/backup/legacy-migration-runtime.ts'] = r'''// SECURECASEDESK_PHASE10_S7
// محوّل Expo لترحيل قاعدة قديمة. ⚠️ لم يُختبر على جهاز: يحتاج فحص tsc وتجربة فعلية
// (فتح قاعدة بالاسم من مجلد expo-sqlite الافتراضي، withTransactionAsync مع SQLCipher، واجهات expo-file-system).
// المعاملة تستخدم الاتصال الرئيسي المفتوح بمفتاح SQLCipher عمداً (withExclusiveTransactionAsync يفتح اتصالاً جديداً بلا مفتاح).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import { createDatabaseBackupSnapshot, discardDatabaseBackupSnapshot } from './backup-snapshot-runtime';
import { BACKUP_OUTPUT_DIR_NAME, BACKUP_PERMISSION } from './backup-types';
import {
  LegacyMigrationError, inspectLegacyDatabase, migrateLegacyDatabase,
  type LegacyDb, type LegacyInspection, type MigrationDeps, type MigrationFs, type MigrationReport, type TargetDb,
} from './legacy-migration';
import { LEGACY_PROFILES } from './legacy-profiles';

const CHUNK = 256 * 1024;
const stripScheme = (uri: string) => uri.replace(/^file:\/\//, '');

function removeIfExists(path: string) {
  const f = new File(path);
  if (f.exists) { f.delete(); return; }
  const d = new Directory(path);
  if (d.exists) d.delete();
}

const expoMigrationFs: MigrationFs = {
  async exists(path) { return new File(path).exists; },
  async size(path) { const f = new File(path); return f.exists ? f.size : 0; },
  async ensureDir(path) { new Directory(path).create({ intermediates: true, idempotent: true }); },
  async copy(from, to) { removeIfExists(to); new File(from).copy(new File(to)); },
  async remove(path) { removeIfExists(path); },
  async readHeader(path, bytes) {
    const h = new File(path).open(FileMode.ReadOnly);
    try { return h.readBytesSync(bytes); } finally { h.close(); }
  },
  async sha256File(path) {
    const f = new File(path);
    const total = f.size;
    const h = sha256.create();
    const handle = f.open(FileMode.ReadOnly);
    try {
      let read = 0;
      while (read < total) {
        const bytes = handle.readBytesSync(Math.min(CHUNK, total - read));
        if (bytes.length === 0) break;
        h.update(bytes);
        read += bytes.length;
      }
      if (read !== total) throw new Error('SHORT_READ');
    } finally { handle.close(); }
    return bytesToHex(h.digest());
  },
};

// expo-sqlite يفتح القواعد بالاسم من مجلده الافتراضي: ننسخ النسخة المؤقتة إليه، ونحذفها عند الإغلاق.
async function openLegacyExpo(stagedPath: string, key?: string): Promise<LegacyDb> {
  const name = 'legacy-staging-' + Crypto.randomUUID() + '.db';
  const dir = stripScheme(String(SQLite.defaultDatabaseDirectory)).replace(/\/+$/, '');
  const copyPath = dir + '/' + name;
  new File(stagedPath).copy(new File(copyPath));
  const cleanup = () => { for (const suffix of ['', '-wal', '-shm', '-journal']) removeIfExists(copyPath + suffix); };
  try {
    const db = await SQLite.openDatabaseAsync(name);
    if (key) await db.execAsync("PRAGMA key = '" + key.replace(/'/g, "''") + "';");
    return {
      getAllAsync: (sql, params = []) => db.getAllAsync(sql, params as never[]),
      getFirstAsync: (sql, params = []) => db.getFirstAsync(sql, params as never[]),
      async close() { try { await db.closeAsync(); } finally { cleanup(); } },
    };
  } catch (e) { cleanup(); throw e; }
}

async function authorize(session: Session | null | undefined) {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);
  return { s, db };
}

function localPath(uri: string): string {
  if (!uri.startsWith('file://') && !uri.startsWith('/')) throw new LegacyMigrationError('LEGACY_FILE_MISSING', 'URI_NOT_LOCAL_FILE');
  return stripScheme(uri);
}

async function buildDeps(session: Session, db: Awaited<ReturnType<typeof getDb>>): Promise<MigrationDeps> {
  const target: TargetDb = {
    getAllAsync: (sql, params = []) => db.getAllAsync(sql, params as never[]),
    getFirstAsync: (sql, params = []) => db.getFirstAsync(sql, params as never[]),
    execAsync: (sql) => db.execAsync(sql),
    runAsync: (sql, params = []) => db.runAsync(sql, params as never[]),
    async transaction(fn) {
      let result: unknown;
      await db.withTransactionAsync(async () => { result = await fn(); });
      return result as never;
    },
  };
  return {
    fs: expoMigrationFs, target, profiles: LEGACY_PROFILES,
    stagingRoot: stripScheme(Paths.cache.uri),
    openLegacy: openLegacyExpo,
    // لقطة 10.2 تُنقل من cache (قد يمسحه النظام) إلى document لتبقى متاحة بعد الترحيل.
    async createSafetyCopy() {
      const snap = await createDatabaseBackupSnapshot(session);
      try {
        const dir = stripScheme(Paths.document.uri).replace(/\/+$/, '') + '/' + BACKUP_OUTPUT_DIR_NAME + '/pre-migration';
        new Directory(dir).create({ intermediates: true, idempotent: true });
        const dest = dir + '/' + snap.snapshotId + '.db';
        new File(snap.databasePath).copy(new File(dest));
        if ((await expoMigrationFs.sha256File(dest)) !== snap.manifest.sha256) throw new Error('SAFETY_COPY_MISMATCH');
        return { path: dest, sha256: snap.manifest.sha256 };
      } finally {
        await discardDatabaseBackupSnapshot(session, snap).catch(() => {});
      }
    },
    newId: () => Crypto.randomUUID(), now: () => Date.now(),
  };
}

// معاينة فقط: لا ترحيل. تعرض الإصدار المكتشف والجداول والتحذيرات.
export async function inspectLegacyDatabaseFile(
  session: Session | null | undefined, sourceUri: string, key?: string,
): Promise<LegacyInspection> {
  const { s, db } = await authorize(session);
  return inspectLegacyDatabase(await buildDeps(s, db), localPath(sourceUri), key);
}

export async function migrateLegacyDatabaseFile(
  session: Session | null | undefined, sourceUri: string, opts: { confirm: boolean; key?: string },
): Promise<MigrationReport> {
  const { s, db } = await authorize(session);
  return migrateLegacyDatabase(await buildDeps(s, db), {
    sourcePath: localPath(sourceUri), key: opts.key, actorUserId: s.userId, confirm: opts.confirm,
  });
}
'''
HASHES['src/modules/backup/legacy-migration-runtime.ts'] = '09483f291ff2c036ed86de5c025e4684f9546a7980103f48fd05b2a60229e51f'
FILES['src/modules/backup/legacy-profiles.ts'] = r'''// SECURECASEDESK_PHASE10_S7
// سجل إصدارات قواعد البيانات القديمة المدعومة.
//
// ⚠️ فارغ عمداً: لا يوجد هنا أي افتراض عن مخطط القاعدة القديمة. المتطلب الخارجي المفقود هو
// ملف القاعدة القديمة الفعلي. بعد الحصول عليه:
//   1) شغّل inspectLegacyDatabase عليه لاستخراج الجداول والأعمدة وuser_version.
//   2) أضف هنا LegacyProfile واحداً لكل إصدار: detect (بالأعمدة لا بالأسماء فقط) و migrate
//      (يستخدم ctx.insertOnce لكل صف و ctx.resolveId لترجمة المفاتيح الأجنبية، بترتيب الجداول الأم أولاً).
//   3) اختبره على نسخة من القاعدة الفعلية قبل أي استعمال.
import type { LegacyProfile } from './legacy-migration';

export const LEGACY_PROFILES: LegacyProfile[] = [];
'''
HASHES['src/modules/backup/legacy-profiles.ts'] = '0a9d5b0a761b20010568c19bff9c496f6e5bdf15434ebb7820959b5fb9c80a45'
FILES['tests/backup-rollback.test.ts'] = r'''// SECURECASEDESK_PHASE10_S7
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
'''
HASHES['tests/backup-rollback.test.ts'] = 'd13e3cf27ad1382938ba8dd691eed42fb6d6502332b466a0a3f3a7a21e2d2764'
FILES['tests/legacy-migration.test.ts'] = r'''// SECURECASEDESK_PHASE10_S7
// اختبارات محرك ترحيل القواعد القديمة (10.7). تشغَّل بـ: npm run test:legacy-migration
// تستخدم SQLite حقيقية عبر node:sqlite (غير مشفرة) وملفات وبصمات حقيقية. المخطط القديم هنا مخطط اختبار
// مصطنع لاختبار المحرك فقط، وليس مخطط قاعدتك القديمة الفعلية.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LegacyMigrationError, inspectLegacyDatabase, migrateLegacyDatabase,
  type LegacyDb, type LegacyProfile, type MigrationDeps, type MigrationFs, type TargetDb,
} from '../src/modules/backup/legacy-migration';

const nodeFs: MigrationFs = {
  async exists(p) { return fs.existsSync(p); },
  async size(p) { return fs.existsSync(p) ? fs.statSync(p).size : 0; },
  async ensureDir(p) { fs.mkdirSync(p, { recursive: true }); },
  async copy(a, b) { fs.copyFileSync(a, b); },
  async remove(p) { fs.rmSync(p, { recursive: true, force: true }); },
  async readHeader(p, n) { const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, 0); fs.closeSync(fd); return new Uint8Array(b); },
  async sha256File(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); },
};

function wrap(db: DatabaseSync) {
  return {
    async getAllAsync<T>(sql: string, params: unknown[] = []) { return db.prepare(sql).all(...(params as never[])) as T[]; },
    async getFirstAsync<T>(sql: string, params: unknown[] = []) { return (db.prepare(sql).get(...(params as never[])) ?? null) as T | null; },
    async execAsync(sql: string) { db.exec(sql); },
    async runAsync(sql: string, params: unknown[] = []) { return db.prepare(sql).run(...(params as never[])); },
  };
}

// ملف قاعدة قديمة مصطنع: جدولان (أب/ابن) بمفتاح أجنبي
function makeLegacy(file: string, opts: { userVersion?: number; rows?: number; orphanChild?: boolean } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${opts.userVersion ?? 7};
    CREATE TABLE old_cases (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE old_notes (id INTEGER PRIMARY KEY, case_id INTEGER, body TEXT);`);
  const n = opts.rows ?? 3;
  for (let i = 1; i <= n; i++) {
    db.prepare('INSERT INTO old_cases (id, title) VALUES (?, ?)').run(i, 'قضية ' + i);
    db.prepare('INSERT INTO old_notes (id, case_id, body) VALUES (?, ?, ?)').run(i, i, 'ملاحظة ' + i);
  }
  if (opts.orphanChild) db.prepare('INSERT INTO old_notes (id, case_id, body) VALUES (99, 12345, ?)').run('يتيمة');
  db.close();
}

const testProfile: LegacyProfile = {
  id: 'test-legacy-v7', label: 'إصدار اختبار',
  detect: (p) => p.userVersion === 7 && !!p.tables.old_cases && p.tables.old_notes?.includes('case_id') === true,
  async migrate(ctx) {
    for (const c of await ctx.legacy.getAllAsync<{ id: number; title: string }>('SELECT id, title FROM old_cases ORDER BY id')) {
      await ctx.insertOnce('old_cases', c.id, (nid) => ({
        sql: 'INSERT INTO new_cases (id, title, created_by) VALUES (?, ?, ?)', params: [nid, c.title, ctx.actorUserId] }));
    }
    for (const n of await ctx.legacy.getAllAsync<{ id: number; case_id: number; body: string }>('SELECT id, case_id, body FROM old_notes ORDER BY id')) {
      const parent = await ctx.resolveId('old_cases', n.case_id);
      if (!parent) throw new Error('ORPHAN_NOTE:' + n.id);
      await ctx.insertOnce('old_notes', n.id, (nid) => ({
        sql: 'INSERT INTO new_notes (id, case_id, body) VALUES (?, ?, ?)', params: [nid, parent, n.body] }));
    }
  },
};

let root: string;
let src: string;
let targetDb: DatabaseSync;
let deps: MigrationDeps;
let safetyCalls = 0;

const count = (t: string) => (targetDb.prepare('SELECT COUNT(*) AS c FROM ' + t).get() as { c: number }).c;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scd-lm-'));
  src = path.join(root, 'old.db');
  makeLegacy(src);
  targetDb = new DatabaseSync(path.join(root, 'target.db'));
  targetDb.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE new_cases (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_by TEXT NOT NULL);
    CREATE TABLE new_notes (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES new_cases(id), body TEXT);`);
  const w = wrap(targetDb);
  const target: TargetDb = {
    ...w,
    async transaction(fn) {
      targetDb.exec('BEGIN');
      try { const r = await fn(); targetDb.exec('COMMIT'); return r; }
      catch (e) { targetDb.exec('ROLLBACK'); throw e; }
    },
  };
  safetyCalls = 0;
  deps = {
    fs: nodeFs, target, profiles: [testProfile],
    stagingRoot: path.join(root, 'cache'),
    async openLegacy(p) {
      const d = new DatabaseSync(p, { readOnly: true });
      const ww = wrap(d);
      const l: LegacyDb = { getAllAsync: ww.getAllAsync, getFirstAsync: ww.getFirstAsync, async close() { d.close(); } };
      return l;
    },
    async createSafetyCopy() { safetyCalls++; return { path: path.join(root, 'safety.db'), sha256: 'x' }; },
    newId: () => randomUUID(), now: () => Date.now(),
  };
});
afterEach(() => { try { targetDb.close(); } catch { /* */ } fs.rmSync(root, { recursive: true, force: true }); });

const ok = { actorUserId: 'admin-1', confirm: true };
const codeIs = (c: string) => (e: unknown) => e instanceof LegacyMigrationError && e.code === c;

describe('10.7 ترحيل القواعد القديمة', () => {
  test('معاينة: تكتشف الإصدار والجداول ولا تكتب بيانات ولا تغيّر الأصل', async () => {
    const before = fs.readFileSync(src);
    const r = await inspectLegacyDatabase(deps, src);
    assert.equal(r.matchedProfile?.id, 'test-legacy-v7');
    assert.equal(r.userVersion, 7);
    assert.deepEqual(r.tables.old_cases, ['id', 'title']);
    assert.equal(r.alreadyMigrated, false);
    assert.equal(r.plaintext, true);
    assert.equal(count('new_cases'), 0);
    assert.ok(before.equals(fs.readFileSync(src)));
    assert.equal(fs.existsSync(path.join(root, 'cache', 'legacy-staging', fs.readdirSync(path.join(root, 'cache', 'legacy-staging'))[0] ?? 'x')), false);
  });

  test('ترحيل كامل: الصفوف والمفاتيح الأجنبية والسجل والعدّادات', async () => {
    const r = await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    assert.equal(count('new_cases'), 3);
    assert.equal(count('new_notes'), 3);
    assert.deepEqual(r.counts.old_cases, { inserted: 3, skipped: 0 });
    assert.equal(count('legacy_id_map'), 6);
    const log = targetDb.prepare('SELECT * FROM legacy_migrations').all() as Array<Record<string, unknown>>;
    assert.equal(log.length, 1);
    assert.equal(log[0].status, 'completed');
    assert.equal(log[0].source_sha256, r.sourceSha256);
    assert.equal(r.targetForeignKeyViolationsAfter, 0);
    assert.equal(safetyCalls, 1);
  });

  test('الملف الأصلي لا يتغير بايتاً بايت', async () => {
    const before = createHash('sha256').update(fs.readFileSync(src)).digest('hex');
    await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    assert.equal(createHash('sha256').update(fs.readFileSync(src)).digest('hex'), before);
  });

  test('منع التكرار: نفس الملف مرة ثانية = ALREADY_MIGRATED بلا صفوف إضافية', async () => {
    await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: src, ...ok }), codeIs('ALREADY_MIGRATED'));
    assert.equal(count('new_cases'), 3);
    assert.equal((await inspectLegacyDatabase(deps, src)).alreadyMigrated, true);
  });

  test('منع تكرار الصفوف: نسخة أحدث من نفس القاعدة تضيف الجديد فقط', async () => {
    await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    const src2 = path.join(root, 'old2.db');
    makeLegacy(src2, { rows: 5 });
    const r = await migrateLegacyDatabase(deps, { sourcePath: src2, ...ok });
    assert.equal(count('new_cases'), 5);
    assert.deepEqual(r.counts.old_cases, { inserted: 2, skipped: 3 });
  });

  test('فشل في منتصف الترحيل: ROLLBACK كامل ولا صف جزئي، وتُسجَّل محاولة فاشلة', async () => {
    const bad: LegacyProfile = { ...testProfile, async migrate(ctx) {
      await testProfile.migrate(ctx);
      throw new Error('late-failure');
    } };
    await assert.rejects(migrateLegacyDatabase({ ...deps, profiles: [bad] }, { sourcePath: src, ...ok }), codeIs('MIGRATION_FAILED'));
    assert.equal(count('new_cases'), 0);
    assert.equal(count('new_notes'), 0);
    assert.equal(count('legacy_id_map'), 0);
    const log = targetDb.prepare('SELECT status, error_code FROM legacy_migrations').all() as Array<{ status: string; error_code: string }>;
    assert.deepEqual(log.map((x) => ({ ...x })), [{ status: 'failed', error_code: 'MIGRATION_FAILED' }]);
    // بعد فشل يمكن إعادة المحاولة بنجاح (الفاشلة لا تمنع)
    await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    assert.equal(count('new_cases'), 3);
  });

  test('صف يتيم في القديمة يُوقف الترحيل كاملاً ولا يُرحَّل نصفه', async () => {
    const src3 = path.join(root, 'orphan.db');
    makeLegacy(src3, { orphanChild: true });
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: src3, ...ok }), codeIs('MIGRATION_FAILED'));
    assert.equal(count('new_cases'), 0);
  });

  test('مخالفات مفاتيح أجنبية جديدة في الهدف تُلغي الترحيل (POST_CHECK_FAILED)', async () => {
    targetDb.exec('PRAGMA foreign_keys = OFF');   // يحاكي هدفاً لا يفرض المفاتيح؛ التحقق بعد الترحيل شبكة أمان
    const sneaky: LegacyProfile = { ...testProfile, async migrate(ctx) {
      await ctx.insertOnce('old_notes', 1, (nid) => ({ sql: 'INSERT INTO new_notes (id, case_id, body) VALUES (?, ?, ?)', params: [nid, 'no-such-parent', 'x'] }));
    } };
    await assert.rejects(migrateLegacyDatabase({ ...deps, profiles: [sneaky] }, { sourcePath: src, ...ok }), codeIs('POST_CHECK_FAILED'));
    assert.equal(count('new_notes'), 0);
    assert.equal(count('legacy_id_map'), 0);
  });

  test('إصدار غير معروف / بلا profile: UNSUPPORTED ولا كتابة', async () => {
    await assert.rejects(migrateLegacyDatabase({ ...deps, profiles: [] }, { sourcePath: src, ...ok }), codeIs('UNSUPPORTED_LEGACY_VERSION'));
    const src4 = path.join(root, 'v9.db'); makeLegacy(src4, { userVersion: 9 });
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: src4, ...ok }), codeIs('UNSUPPORTED_LEGACY_VERSION'));
    assert.equal(count('new_cases'), 0);
    assert.equal(safetyCalls, 0);
    const insp = await inspectLegacyDatabase({ ...deps, profiles: [] }, src);
    assert.equal(insp.matchedProfile, null);          // المعاينة تعرض البنية لكتابة profile
    assert.ok(insp.tables.old_cases);
  });

  test('إصداران يطابقان معاً = AMBIGUOUS', async () => {
    await assert.rejects(
      migrateLegacyDatabase({ ...deps, profiles: [testProfile, { ...testProfile, id: 'other' }] }, { sourcePath: src, ...ok }),
      codeIs('AMBIGUOUS_LEGACY_VERSION'));
  });

  test('بلا تأكيد صريح لا يحدث شيء', async () => {
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: src, actorUserId: 'a', confirm: false as unknown as true }), codeIs('CONFIRMATION_REQUIRED'));
    assert.equal(safetyCalls, 0);
  });

  test('ملف مفقود / فارغ / ليس SQLite', async () => {
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: path.join(root, 'nope.db'), ...ok }), codeIs('LEGACY_FILE_MISSING'));
    const empty = path.join(root, 'empty.db'); fs.writeFileSync(empty, '');
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: empty, ...ok }), codeIs('LEGACY_FILE_MISSING'));
    const junk = path.join(root, 'junk.db'); fs.writeFileSync(junk, Buffer.alloc(4096, 7));
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: junk, ...ok }), codeIs('LEGACY_NOT_SQLITE'));
  });

  test('ملف مشفر بمفتاح خاطئ: LEGACY_OPEN_FAILED وتنظيف المجلد المؤقت', async () => {
    const junk = path.join(root, 'enc.db'); fs.writeFileSync(junk, Buffer.alloc(4096, 9));
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: junk, key: 'wrong', ...ok }), codeIs('LEGACY_OPEN_FAILED'));
    const stage = path.join(root, 'cache', 'legacy-staging');
    assert.deepEqual(fs.existsSync(stage) ? fs.readdirSync(stage) : [], []);
  });

  test('فشل نسخة الأمان يمنع الترحيل قبل أي كتابة', async () => {
    await assert.rejects(
      migrateLegacyDatabase({ ...deps, async createSafetyCopy() { throw new Error('disk'); } }, { sourcePath: src, ...ok }),
      codeIs('SAFETY_COPY_FAILED'));
    assert.equal(count('new_cases'), 0);
  });

  test('تغيّر الملف الأصلي أثناء الترحيل يُلغي العملية (SOURCE_CHANGED)', async () => {
    const mutating: LegacyProfile = { ...testProfile, async migrate(ctx) {
      await testProfile.migrate(ctx);
      fs.appendFileSync(src, 'tamper');
    } };
    await assert.rejects(migrateLegacyDatabase({ ...deps, profiles: [mutating] }, { sourcePath: src, ...ok }), codeIs('SOURCE_CHANGED'));
    assert.equal(count('new_cases'), 0);
  });

  test('سجل الترحيل وخريطة المعرّفات لا يقبلان التعديل ولا الحذف', async () => {
    await migrateLegacyDatabase(deps, { sourcePath: src, ...ok });
    for (const sql of [
      `UPDATE legacy_migrations SET status = 'failed'`, 'DELETE FROM legacy_migrations',
      `UPDATE legacy_id_map SET new_id = 'x'`, 'DELETE FROM legacy_id_map',
    ]) assert.throws(() => targetDb.exec(sql), /ممنوع/);
  });

  test('عمليتان متزامنتان: الثانية MIGRATION_IN_PROGRESS', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow: LegacyProfile = { ...testProfile, async migrate(ctx) { await gate; await testProfile.migrate(ctx); } };
    const p1 = migrateLegacyDatabase({ ...deps, profiles: [slow] }, { sourcePath: src, ...ok });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(migrateLegacyDatabase(deps, { sourcePath: src, ...ok }), codeIs('MIGRATION_IN_PROGRESS'));
    release(); await p1;
  });
});
'''
HASHES['tests/legacy-migration.test.ts'] = '2d4bc2d9ecd2ac35ffc16283a6db7fb5902f3e19252e29ce79d3165070b924d8'
FILES['docs/phase10/10.7-rollback-and-legacy-migration.md'] = r'''<!-- SECURECASEDESK_PHASE10_S7 -->
# المرحلة 10 / القسم 10.7 — التراجع الآمن وترحيل قواعد البيانات القديمة

> نطاق هذا القسم: (أ) آلية رجوع كاملة لأي عملية تستبدل بيانات حيّة، (ب) محرك ترحيل من قاعدة قديمة.
> لا يعيد كتابة منطق الاستعادة (10.6) ولا يختبره كاملاً (10.8).

## أ) التراجع الآمن (`backup-rollback.ts`)
المبدأ: **لا حذف قبل النجاح**.
1. فحص الخطة، إغلاق القاعدة، تسجيل ما سيُحمى في سجل رجوع `rollback-journal.json` (كتابة ذرية) قبل أي تحريك.
2. حفظ الأسرار في مخبأ SecureStore (القيمة أو غيابها)، ثم **نقل** (لا نسخ ولا حذف) الملفات الحيّة إلى `backups/rollback-guard/<id>/`.
3. `action()` تكتب الحالة الجديدة، ثم تُعاد فتح القاعدة و`verify()` تتحقق منها.
4. فشل `action` أو `verify` أو الحماية = رجوع كامل: إزالة الجديد، إعادة الأصل، مطابقة SHA-256 للملفات، إعادة الأسرار.
5. النجاح = commit ثم تنظيف. فشل الرجوع نفسه = `ROLLBACK_FAILED` والسجل ونسخة الأمان **يبقيان** ولا يُحذف شيء.
6. **التعافي عند الإقلاع** `recoverInterruptedRestore()`: انقطاع قبل التحقق → رجوع؛ بعد التحقق وقبل التثبيت → تثبيت؛ بعد الانتهاء → تنظيف فقط.

السجل يحتوي **أسماء** الأسرار فقط، لا قيمها.

## ب) ترحيل قاعدة قديمة (`legacy-migration.ts`)
- الملف الأصلي **لا يُفتح ولا يُعدَّل**: تُقرأ نسخة مؤقتة، وبصمة الأصل تُقارن قبل الالتزام (`SOURCE_CHANGED`).
- فحص قبل أي كتابة: ترويسة SQLite، `integrity_check` (مانع)، `foreign_key_check` (تحذير)، اكتشاف الإصدار بلا غموض.
- نسخة أمان (لقطة 10.2) قبل الكتابة؛ فشلها يمنع الترحيل.
- كل الكتابة في **معاملة واحدة**: أي فشل (وبعد التحقق من عدم ظهور مخالفات مفاتيح أجنبية جديدة) = ROLLBACK كامل.
- منع التكرار: بصمة الملف كاملاً (`legacy_migrations`، فهرس فريد للمكتمل) + معرّف كل صف (`legacy_id_map`).
  نسخة أحدث من القاعدة نفسها تضيف الجديد فقط. المحاولات الفاشلة تُسجَّل ولا تمنع إعادة المحاولة.
- جدولا السجل محميان بمشغلات ضد التعديل والحذف.
- يستلزم تأكيداً صريحاً `confirm: true` وصلاحية `backup.manage`.

## ⚠️ المتطلب الخارجي المفقود
**ملف القاعدة القديمة الفعلي غير متوفر**، ولا يوجد في هذا الكود أي افتراض عن مخططها. `legacy-profiles.ts` فارغ عمداً.
بدون profile مطابق تنتهي المحاولة بـ `UNSUPPORTED_LEGACY_VERSION` ولا يُرحَّل شيء. الخطوات عند توفرها:
1. `inspectLegacyDatabaseFile` لاستخراج الجداول والأعمدة و`user_version`.
2. كتابة `LegacyProfile` (detect + migrate بـ `ctx.insertOnce` و`ctx.resolveId`).
3. اختباره على نسخة من الملف الفعلي.

## الملفات
| الملف | الغرض |
|---|---|
| `backup-rollback.ts` | الرجوع والتعافي (صرف، بالحقن) |
| `backup-rollback-runtime.ts` | محوّل Expo: `runProtectedReplacement`, `recoverInterruptedRestore` |
| `legacy-migration.ts` | الفحص والترحيل (صرف، بالحقن) |
| `legacy-migration-runtime.ts` | محوّل Expo: `inspectLegacyDatabaseFile`, `migrateLegacyDatabaseFile` |
| `legacy-profiles.ts` | سجل الإصدارات المدعومة (فارغ) |
| `src/database/db.ts` | + `closeDb()` |
| `tests/backup-rollback.test.ts` | 14 اختباراً |
| `tests/legacy-migration.test.ts` | 17 اختباراً (SQLite حقيقية عبر `node:sqlite`، يتطلب Node ≥ 22.5) |

## لم يُنفَّذ / لم يُختبر (معلّق)
- **لم يُربط بعد بـ 10.6**: `runProtectedReplacement` جاهزة لكن استدعاؤها من منطق الاستعادة (وكذا استدعاء `recoverInterruptedRestore` قبل `initDatabase` عند الإقلاع) يُنجز في 10.8 بعد مراجعة ملفات 10.4-A..10.6.
- المحوّلات (`*-runtime.ts`) لم تُفحص بـ tsc ولم تُجرَّب على Android: واجهات `expo-file-system` و`expo-sqlite` تحتاج تحقق.
- الاختبارات تستعمل SQLite عادية لا SQLCipher، ولا تغطي قاعدة قديمة مشفرة فعلية.
- لا واجهة مستخدم لهذا القسم.
- بعد الالتزام لا رجوع آلي للترحيل؛ نسخة الأمان محفوظة في `backups/pre-migration/` وتُستعاد عبر مسار الاستعادة.
- `closeDb()` يبطل أي مرجع قاعدة محفوظ خارج `getDb()`؛ تأكد أن الخدمات لا تحتفظ باتصال قديم.
- تدقيق الترحيل يعتمد على مشغلات التدقيق التلقائية للجداول المتتبَّعة؛ لم يُتحقق من تغطيتها لجداول الترحيل.
'''
HASHES['docs/phase10/10.7-rollback-and-legacy-migration.md'] = '82124b10375ab3c73305f96dc482602658f9b18ce0a8b8e63cfe636c1a71462b'

def put(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        old = open(path, encoding='utf-8').read()
        if old == text:
            print('=  (بلا تغيير)', path); return
        shutil.copy2(path, path + '.bak_' + STAMP)
        print('   نسخة احتياطية:', path + '.bak_' + STAMP)
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    back = open(path, encoding='utf-8').read()
    if hashlib.sha256(back.encode()).hexdigest() != HASHES[path]:
        sys.exit('فشل التحقق من الملف بعد الكتابة: ' + path)
    print('OK', path)

for p, t in FILES.items():
    put(p, t)

# ---- db.ts: إضافة closeDb() مرة واحدة ----
DB = 'src/database/db.ts'
src = open(DB, encoding='utf-8').read()
if 'SECURECASEDESK_PHASE10_S7' in src:
    print('=  (بلا تغيير)', DB)
else:
    if 'let db: SQLite.SQLiteDatabase | null = null;' not in src:
        sys.exit('db.ts لا يطابق البنية المتوقعة (let db ...). لم يُعدَّل شيء في db.ts؛ أضف closeDb() يدوياً.')
    shutil.copy2(DB, DB + '.bak_' + STAMP)
    src = src.rstrip('\n') + """

// SECURECASEDESK_PHASE10_S7
// يغلق الاتصال الحالي ويُفرغ المرجع؛ أول getDb() بعده يعيد الفتح بالمفتاح. يستعمله التراجع الآمن قبل استبدال الملفات.
export async function closeDb(): Promise<void> {
  if (!db) return;
  const current = db;
  db = null;
  await current.closeAsync();
}
"""
    with open(DB, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(src)
    print('OK', DB, '(+ closeDb، نسخة احتياطية: ' + DB + '.bak_' + STAMP + ')')

# ---- package.json: سكربتا الاختبار ----
data = json.loads(open('package.json', encoding='utf-8').read())
scripts = data.get('scripts', {})
add = {
    'test:backup-rollback': 'tsx --tsconfig tests/tsconfig.json --test tests/backup-rollback.test.ts',
    'test:legacy-migration': 'tsx --tsconfig tests/tsconfig.json --test tests/legacy-migration.test.ts',
}
missing = {k: v for k, v in add.items() if k not in scripts}
if not missing:
    print('=  (بلا تغيير) package.json')
else:
    shutil.copy2('package.json', 'package.json.bak_' + STAMP)
    scripts.update(missing)
    data['scripts'] = scripts
    with open('package.json', 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write('\n')
    print('OK package.json (+', ', '.join(missing), ')')

print('')
print('تم تثبيت 10.7. للتحقق:')
print('  npm run test:backup-rollback')
print('  npm run test:legacy-migration     (يتطلب Node 22.5 أو أحدث)')
print('  npx tsc --noEmit')
