// Shim لـ expo-document-picker عبر حوار الفتح الأصلي في Electron. التنفيذ: القسم 5.
import { notImplementedAsync } from './errors';
const M = 'expo-document-picker';
const S = 5;
export type DocumentPickerResult =
  | { canceled: true; assets: null }
  | { canceled: false; assets: Array<{ uri: string; name: string; size?: number; mimeType?: string }> };
export function getDocumentAsync(_options?: Record<string, unknown>): Promise<DocumentPickerResult> { return notImplementedAsync(M, 'getDocumentAsync', S); }
