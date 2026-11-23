// SECURECASEDESK_PHASE10_S7
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
