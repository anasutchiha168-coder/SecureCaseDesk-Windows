// Shim لـ expo-sharing (إظهار الملف في المستكشف/حفظ باسم). التنفيذ: القسم 5.
import { notImplemented } from './errors';
const M = 'expo-sharing';
const S = 5;
export function isAvailableAsync(): Promise<boolean> { return notImplemented(M, 'isAvailableAsync', S); }
export function shareAsync(_url: string, _options?: Record<string, unknown>): Promise<void> { return notImplemented(M, 'shareAsync', S); }
