// Shim لـ expo-local-authentication. التنفيذ: القسم 7 (Windows فقط، دون المساس بسلوك Android).
import { notImplemented } from './errors';
const M = 'expo-local-authentication';
const S = 7;
export function hasHardwareAsync(): Promise<boolean> { return notImplemented(M, 'hasHardwareAsync', S); }
export function isEnrolledAsync(): Promise<boolean> { return notImplemented(M, 'isEnrolledAsync', S); }
export function authenticateAsync(_options?: Record<string, unknown>): Promise<{ success: boolean; error?: string }> { return notImplemented(M, 'authenticateAsync', S); }
