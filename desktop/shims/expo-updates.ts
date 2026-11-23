// Shim لـ expo-updates: على Windows يُعاد تشغيل التطبيق عبر Electron. التنفيذ: القسم 2.
import { notImplemented } from './errors';
export function reloadAsync(): Promise<void> { return notImplemented('expo-updates', 'reloadAsync', 2); }
