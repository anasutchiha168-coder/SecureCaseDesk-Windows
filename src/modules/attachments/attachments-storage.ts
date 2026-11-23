// SECURECASEDESK_PHASE9_S1 + ATTACH_FIX
// تخزين الملفات المشفرة على الجهاز عبر expo-file-system (واجهة File/Directory الحديثة).
// المسار: <document>/attachments/<uuid>.enc  — أسماء عشوائية لا تكشف اسم الملف الأصلي.
//
// إصلاح "تعذر حفظ الملف": النسخة السابقة كانت تكتب ملفاً مؤقتاً ثم تتحقق من tmp.size ثم تنقله بـ move،
// وأي خطوة منها قد تفشل على أندرويد (حجم غير مُحدَّث بعد الكتابة، أو تعذر النقل) فيُبتلع الخطأ.
// الآن: كتابة مباشرة إلى الملف النهائي، ثم قراءة الملف والتحقق من الطول الفعلي، مع مسار بديل
// عبر مقبض الملف (FileMode) إن فشلت الكتابة المباشرة. الملف الناقص لا يبقى: يُحذف عند أي فشل،
// والمستودع يحذف اليتيم، وفحص الصيانة ينظف أي بقايا.

import { Directory, File, FileMode, Paths } from 'expo-file-system';
import type { BlobStorage } from './attachments-repo';

const SAFE_NAME = /^[0-9a-f-]{36}\.enc$/;

function dir(): Directory {
  const d = new Directory(Paths.document, 'attachments');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

function assertSafe(name: string): void {
  if (!SAFE_NAME.test(name)) throw new Error('INVALID_STORAGE_NAME');
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function removeQuietly(f: File): void {
  try { if (f.exists) f.delete(); } catch { /* لا شيء */ }
}

// كتابة مباشرة: create ثم write.
function writeDirect(f: File, bytes: Uint8Array): void {
  f.create();
  f.writeSync(bytes); // SDK 58: write() غير متزامنة؛ writeSync هي المتزامنة
}

// مسار بديل: مقبض كتابة صريح.
function writeViaHandle(f: File, bytes: Uint8Array): void {
  f.create();
  const h = f.open(FileMode.WriteOnly);
  try { h.writeBytesSync(bytes); } finally { h.close(); } // SDK 58: writeBytes غير متزامنة
}

export const expoBlobStorage: BlobStorage = {
  async write(name, bytes) {
    assertSafe(name);
    const f = new File(dir(), name);
    removeQuietly(f);

    const errors: string[] = [];
    const strategies: [string, (f: File, b: Uint8Array) => void][] = [
      ['direct', writeDirect], ['handle', writeViaHandle],
    ];
    for (const [label, strategy] of strategies) {
      try {
        strategy(f, bytes);
        const back = await f.bytes(); // التحقق بالطول الفعلي المقروء لا بخاصية size
        if (back.length === bytes.length) return;
        errors.push(label + ': SHORT_WRITE ' + back.length + '/' + bytes.length);
      } catch (e) {
        errors.push(label + ': ' + msg(e));
      }
      removeQuietly(f); // لا يبقى ملف ناقص قبل المحاولة التالية
    }
    throw new Error(errors.join(' | '));
  },
  async read(name) {
    assertSafe(name);
    const f = new File(dir(), name);
    if (!f.exists) throw new Error('FILE_MISSING');
    return await f.bytes();
  },
  async delete(name) {
    assertSafe(name);
    const f = new File(dir(), name);
    if (f.exists) f.delete();
  },
  async exists(name) {
    assertSafe(name);
    return new File(dir(), name).exists;
  },
  async list() {
    const names: string[] = [];
    for (const item of dir().list()) {
      if (item instanceof File) {
        if (item.name.endsWith('.tmp')) { item.delete(); continue; } // بقايا النسخة القديمة
        names.push(item.name);
      }
    }
    return names;
  },
};
