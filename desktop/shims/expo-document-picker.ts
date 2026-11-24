// Shim لـ expo-document-picker عبر حوار الفتح الأصلي في Windows (القسم 5).
// copyToCacheDirectory=true (الافتراضي كما في expo): نسخة في cache/picked تُرجع بدل الأصل.
import { SCD_CHANNELS } from './bridge-contract';
import { callAsync } from './fs-bridge';

export type DocumentPickerAsset = { uri: string; name: string; size?: number; mimeType?: string; lastModified?: number };
export type DocumentPickerResult =
  | { canceled: true; assets: null }
  | { canceled: false; assets: DocumentPickerAsset[] };
export interface DocumentPickerOptions { type?: string | string[]; copyToCacheDirectory?: boolean; multiple?: boolean }

const EXT: Record<string, string[]> = {
  'application/pdf': ['pdf'], 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'],
  'image/*': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'], 'text/csv': ['csv'], 'text/plain': ['txt'],
  'application/json': ['json'], 'application/zip': ['zip'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
};
const LABEL: Record<string, string> = { pdf: 'PDF', jpg: 'صور', jpeg: 'صور', png: 'صور', csv: 'CSV', txt: 'نص', json: 'JSON', zip: 'ZIP', xlsx: 'Excel', docx: 'Word' };

export function filtersFor(type?: string | string[]): Array<{ name: string; extensions: string[] }> {
  const types = type === undefined ? ['*/*'] : Array.isArray(type) ? type : [type];
  const exts = new Set<string>();
  for (const t of types) {
    if (!EXT[t]) return [{ name: 'كل الملفات', extensions: ['*'] }];
    for (const e of EXT[t]) exts.add(e);
  }
  const list = [...exts];
  return [{ name: [...new Set(list.map((e) => LABEL[e] ?? e))].join(' / '), extensions: list }];
}

export async function getDocumentAsync(options: DocumentPickerOptions = {}): Promise<DocumentPickerResult> {
  const r = await callAsync<{ canceled: boolean; files?: DocumentPickerAsset[] }>(SCD_CHANNELS.fs.openDialog, {
    multiple: !!options.multiple, copyToCache: options.copyToCacheDirectory !== false,
    title: 'اختيار ملف', filters: filtersFor(options.type),
  });
  if (r.canceled || !r.files || r.files.length === 0) return { canceled: true, assets: null };
  return { canceled: false, assets: r.files };
}
