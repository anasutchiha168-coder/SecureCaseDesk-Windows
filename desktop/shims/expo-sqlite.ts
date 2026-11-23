// Shim لـ expo-sqlite عبر IPC إلى SQLCipher في العملية الرئيسية. التنفيذ: القسم 6.
import { notImplemented } from './errors';
const M = 'expo-sqlite';
const S = 6;

export class SQLiteDatabase {
  readonly databasePath: string = '';
  execAsync(_sql: string): Promise<void> { return notImplemented(M, 'execAsync', S); }
  runAsync(_sql: string, ..._params: unknown[]): Promise<{ changes: number; lastInsertRowId: number }> { return notImplemented(M, 'runAsync', S); }
  getAllAsync<T = unknown>(_sql: string, ..._params: unknown[]): Promise<T[]> { return notImplemented(M, 'getAllAsync', S); }
  getFirstAsync<T = unknown>(_sql: string, ..._params: unknown[]): Promise<T | null> { return notImplemented(M, 'getFirstAsync', S); }
  withTransactionAsync(_task: () => Promise<void>): Promise<void> { return notImplemented(M, 'withTransactionAsync', S); }
  closeAsync(): Promise<void> { return notImplemented(M, 'closeAsync', S); }
}

export const defaultDatabaseDirectory = '';
export function openDatabaseAsync(_name: string, _options?: Record<string, unknown>): Promise<SQLiteDatabase> {
  return notImplemented(M, 'openDatabaseAsync', S);
}
