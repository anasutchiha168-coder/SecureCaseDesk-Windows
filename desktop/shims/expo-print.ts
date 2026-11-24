// Shim لـ expo-print عبر webContents.printToPDF / print في Electron (القسم 5).
import { SCD_CHANNELS } from './bridge-contract';
import { callAsync, DesktopFsError } from './fs-bridge';

export const Orientation = { portrait: 'portrait', landscape: 'landscape' } as const;
export interface PrintOptions { html?: string; width?: number; height?: number; base64?: boolean; orientation?: string; [k: string]: unknown }

function needHtml(o: PrintOptions): string {
  if (!o || typeof o.html !== 'string' || o.html.length === 0) throw new DesktopFsError('INVALID_PAYLOAD', 'يلزم تمرير html (الطباعة من uri غير مدعومة على Windows)');
  return o.html;
}
export async function printToFileAsync(options: PrintOptions = {}): Promise<{ uri: string; numberOfPages?: number; base64?: string }> {
  const html = needHtml(options);
  return callAsync(SCD_CHANNELS.print.toPdf, {
    html, width: options.width, height: options.height, base64: !!options.base64, landscape: options.orientation === 'landscape',
  });
}
export async function printAsync(options: PrintOptions = {}): Promise<void> {
  await callAsync(SCD_CHANNELS.print.print, { html: needHtml(options) });
}
export async function selectPrinterAsync(): Promise<never> {
  throw new DesktopFsError('NOT_SUPPORTED', 'اختيار الطابعة يتم من حوار الطباعة في Windows');
}
