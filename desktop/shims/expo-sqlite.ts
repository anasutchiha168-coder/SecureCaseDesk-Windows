// Shim لـ expo-sqlite عبر IPC إلى SQLCipher في العملية الرئيسية (القسم 6).
// الواجهة المستعملة في src فقط: openDatabaseAsync / defaultDatabaseDirectory / getFirstAsync / getAllAsync / runAsync / execAsync /
// withTransactionAsync / closeAsync / databasePath. المسارات نصوص عادية بشرطات مائلة أمامية (C:/Users/...) كما تتوقع src.
import { getBridge, parseScdError, SCD_CHANNELS } from './bridge-contract';

const CH = SCD_CHANNELS.db;

export class DesktopDbError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'DesktopDbError'; this.code = code; }
}

async function call<T = unknown>(channel: string, payload: unknown): Promise<T> {
  const b = getBridge();
  if (!b) throw new DesktopDbError('NO_BRIDGE', 'جسر سطح المكتب غير متاح');
  try { return await b.invoke<T>(channel, payload); } catch (e) {
    const p = parseScdError(e);
    throw new DesktopDbError(p.code, p.message); // الرسالة كما هي (قيود UNIQUE وRAISE العربية تعتمد عليها src)
  }
}

type Params = unknown[] | Record<string, unknown>;
// expo يقبل (sql, [a,b]) أو (sql, a, b) أو (sql, {$name: v}).
function normParams(p: unknown[]): Params {
  if (p.length === 1 && p[0] !== null && typeof p[0] === 'object' && !ArrayBuffer.isView(p[0]) && !(p[0] instanceof ArrayBuffer)) return p[0] as Params;
  return p;
}

export class SQLiteDatabase {
  readonly databasePath: string;
  private readonly handle: number;
  private closed = false;
  constructor(handle: number, path: string) { this.handle = handle; this.databasePath = path; }
  private live(): number {
    if (this.closed) throw new DesktopDbError('DB_NOT_OPEN', 'اتصال قاعدة البيانات مغلق');
    return this.handle;
  }
  async execAsync(sql: string): Promise<void> { await call(CH.exec, { handle: this.live(), sql }); }
  async runAsync(sql: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowId: number }> {
    return call(CH.run, { handle: this.live(), sql, params: normParams(params) });
  }
  async getAllAsync<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]> {
    return call<T[]>(CH.all, { handle: this.live(), sql, params: normParams(params) });
  }
  async getFirstAsync<T = unknown>(sql: string, ...params: unknown[]): Promise<T | null> {
    return call<T | null>(CH.first, { handle: this.live(), sql, params: normParams(params) });
  }
  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    const handle = this.live();
    await call(CH.tx, { handle, action: 'begin' });
    try { await task(); } catch (e) {
      try { await call(CH.tx, { handle, action: 'rollback' }); } catch { /* الخطأ الأصلي أهم */ }
      throw e;
    }
    try { await call(CH.tx, { handle, action: 'commit' }); } catch (e) {
      try { await call(CH.tx, { handle, action: 'rollback' }); } catch { /* */ }
      throw e;
    }
  }
  async closeAsync(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await call(CH.close, { handle: this.handle });
  }
}

// file:///C:/Users/x%20y/... → C:/Users/x y/...   (و /home/x على غير Windows)
function uriToPath(uri: string): string {
  const u = new URL(uri);
  let p = decodeURIComponent(u.pathname);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p.replace(/\/+$/, '');
}

function computeDefaultDir(): string {
  try {
    const b = getBridge();
    if (!b || typeof b.invokeSync !== 'function') return '';
    const r = b.invokeSync<{ document: string }>(SCD_CHANNELS.fs.roots);
    return uriToPath(r.document) + '/SQLite';
  } catch { return ''; }
}
export const defaultDatabaseDirectory: string = computeDefaultDir();

export async function openDatabaseAsync(name: string, _options?: Record<string, unknown>, directory?: string): Promise<SQLiteDatabase> {
  // useNewConnection يُتجاهل: كل فتح = اتصال جديد (SQLite يدعم عدة اتصالات على الملف نفسه).
  const r = await call<{ handle: number; path: string }>(CH.open, { name, directory: directory || undefined });
  return new SQLiteDatabase(r.handle, r.path);
}
