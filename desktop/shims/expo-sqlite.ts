// Shim لـ expo-sqlite عبر IPC إلى SQLCipher في العملية الرئيسية. التنفيذ: القسم 6.
import { notImplemented, notImplementedAsync } from './errors';
const M = 'expo-sqlite';
const S = 6;

export class SQLiteDatabase {
  readonly databasePath: string = '';
  execAsync(_sql: string): Promise<void> { return notImplementedAsync(M, 'execAsync', S); }
  runAsync(_sql: string, ..._params: unknown[]): Promise<{ changes: number; lastInsertRowId: number }> { return notImplementedAsync(M, 'runAsync', S); }
  getAllAsync<T = unknown>(_sql: string, ..._params: unknown[]): Promise<T[]> { return notImplementedAsync(M, 'getAllAsync', S); }
  getFirstAsync<T = unknown>(_sql: string, ..._params: unknown[]): Promise<T | null> { return notImplementedAsync(M, 'getFirstAsync', S); }
  withTransactionAsync(_task: () => Promise<void>): Promise<void> { return notImplementedAsync(M, 'withTransactionAsync', S); }
  closeAsync(): Promise<void> { return notImplementedAsync(M, 'closeAsync', S); }
}

export const defaultDatabaseDirectory = '';
export function openDatabaseAsync(_name: string, _options?: Record<string, unknown>): Promise<SQLiteDatabase> {
  return notImplemented(M, 'openDatabaseAsync', S);
}
