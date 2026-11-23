// Shim لـ expo-secure-store عبر safeStorage/DPAPI في Electron. التنفيذ: القسم 7.
import { notImplemented } from './errors';
const M = 'expo-secure-store';
const S = 7;
export function getItemAsync(_key: string, _options?: Record<string, unknown>): Promise<string | null> { return notImplemented(M, 'getItemAsync', S); }
export function setItemAsync(_key: string, _value: string, _options?: Record<string, unknown>): Promise<void> { return notImplemented(M, 'setItemAsync', S); }
export function deleteItemAsync(_key: string, _options?: Record<string, unknown>): Promise<void> { return notImplemented(M, 'deleteItemAsync', S); }
