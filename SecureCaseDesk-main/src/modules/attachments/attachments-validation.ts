// SECURECASEDESK_PHASE9_S1
// التحقق من الملفات: الاسم، الامتداد، الحجم، التوقيع الداخلي (magic bytes)، ونوع MIME المعلن.

import {
  AttachmentError, MAX_ATTACHMENT_BYTES, MAX_FILENAME_LENGTH,
  type AttachmentKind,
} from './attachments-types';

interface KindInfo { kind: AttachmentKind; mime: string; extensions: readonly string[] }

const KINDS: readonly KindInfo[] = [
  { kind: 'pdf', mime: 'application/pdf', extensions: ['pdf'] },
  { kind: 'jpeg', mime: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  { kind: 'png', mime: 'image/png', extensions: ['png'] },
];

// أحرف التحكم والاتجاه الثنائي (RLO وأخواتها) المستخدمة لتزوير الامتداد، والفواصل ورموز المسار.
const FORBIDDEN_NAME_CHARS =
  /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\\/:*?"<>|]/g;

export function sanitizeFileName(raw: string): string {
  const cleaned = String(raw ?? '')
    .normalize('NFC')
    .replace(FORBIDDEN_NAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!cleaned) throw new AttachmentError('INVALID_NAME');

  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function detectKind(bytes: Uint8Array): AttachmentKind | null {
  if (bytes.length >= 5 &&
      bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return 'pdf'; // %PDF-
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'png';
  return null;
}

export interface ValidatedFile {
  name: string;
  extension: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
}

export function validateAttachment(
  input: { name: string; bytes: Uint8Array; declaredMime?: string | null }
): ValidatedFile {
  const name = sanitizeFileName(input.name);
  const extension = extensionOf(name);
  const byExtension = KINDS.find((k) => k.extensions.includes(extension));
  if (!byExtension) throw new AttachmentError('UNSUPPORTED_TYPE');

  const size = input.bytes.length;
  if (size === 0) throw new AttachmentError('EMPTY_FILE');
  if (size > MAX_ATTACHMENT_BYTES) throw new AttachmentError('FILE_TOO_LARGE');

  const detected = detectKind(input.bytes);
  if (detected !== byExtension.kind) throw new AttachmentError('CONTENT_MISMATCH');

  const declared = String(input.declaredMime ?? '').trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') {
    const normalized = declared === 'image/jpg' ? 'image/jpeg' : declared;
    if (normalized !== byExtension.mime) throw new AttachmentError('MIME_MISMATCH');
  }

  return { name, extension, kind: byExtension.kind, mime: byExtension.mime, size };
}
