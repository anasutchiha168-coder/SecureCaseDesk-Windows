// SECURECASEDESK_FILE_URI_FIX
// expo-file-system (File/Directory) على أندرويد يحوّل النص إلى java.net.URI ثم يستدعي java.io.File(URI)،
// وهذا يرمي "URI is not absolute" إذا لم يبدأ النص بـ file://. مسارات SQLite (db.databasePath)
// والمسارات التي أزيل منها file:// تكون مساراً عادياً، فنضيف المخطط هنا في مكان واحد.
import { Directory, File } from 'expo-file-system';

type FsPart = string | File | Directory;

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function toFileUri(path: string): string {
  if (HAS_SCHEME.test(path)) return path; // file:// أو content:// ... تُترك كما هي
  if (!path.startsWith('/')) return path; // مسار نسبي: لا نخمّنه
  const encoded = path.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return 'file://' + encoded;
}

function normalize(parts: FsPart[]): FsPart[] {
  // مسار نصي واحد فقط يُحوَّل؛ الصيغة (Directory, 'name') تبقى كما هي.
  if (parts.length === 1 && typeof parts[0] === 'string') return [toFileUri(parts[0])];
  return parts;
}

export function fsFile(...parts: FsPart[]): File {
  return new File(...normalize(parts));
}

export function fsDir(...parts: FsPart[]): Directory {
  return new Directory(...normalize(parts));
}
