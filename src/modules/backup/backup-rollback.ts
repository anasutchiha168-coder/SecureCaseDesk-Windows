// SECURECASEDESK_PHASE10_S7
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
