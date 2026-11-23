// Shim لـ expo-print (printToFileAsync/printAsync) عبر webContents.printToPDF. التنفيذ: القسم 5.
import { notImplemented } from './errors';
const M = 'expo-print';
const S = 5;
export function printToFileAsync(_options?: Record<string, unknown>): Promise<{ uri: string; numberOfPages?: number }> { return notImplemented(M, 'printToFileAsync', S); }
export function printAsync(_options?: Record<string, unknown>): Promise<void> { return notImplemented(M, 'printAsync', S); }
