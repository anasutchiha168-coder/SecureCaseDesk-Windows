// Shim لـ expo-local-authentication. التنفيذ: القسم 7 (Windows فقط، دون المساس بسلوك Android).
import { notImplementedAsync } from './errors';
const M = 'expo-local-authentication';
const S = 7;
export function hasHardwareAsync(): Promise<boolean> { return notImplementedAsync(M, 'hasHardwareAsync', S); }
export function isEnrolledAsync(): Promise<boolean> { return notImplementedAsync(M, 'isEnrolledAsync', S); }
export function authenticateAsync(_options?: Record<string, unknown>): Promise<{ success: boolean; error?: string }> { return notImplementedAsync(M, 'authenticateAsync', S); }
