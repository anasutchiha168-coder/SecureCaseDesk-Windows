// SECURECASEDESK_PHASE10_S1
// محوّل Expo لجرد مصادر النسخ الاحتياطي. للقراءة فقط:
//  - لا يستدعي expoBlobStorage.list() لأنه يحذف بقايا .tmp عند الاستعراض.
//  - لا ينشئ مجلد المرفقات إن لم يكن موجوداً.
// ⚠️ أسماء File/Directory/Paths تحتاج تحقق tsc على الجهاز الفعلي (كما في attachments-storage.ts).

import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';
import { getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import { collectBackupInventory } from './backup-inventory';
import { ATTACHMENTS_DIR_NAME, BackupError, BACKUP_PERMISSION, type BackupInventory } from './backup-types';
import { fsFile, fsDir } from '@/modules/backup/fs-uri'; // SECURECASEDESK_FILE_URI_FIX

function listAttachmentFilesReadOnly(): string[] {
  const dir = fsDir(Paths.document, ATTACHMENTS_DIR_NAME);
  if (!dir.exists) return [];
  const names: string[] = [];
  for (const item of dir.list()) {
    if (item instanceof File) names.push(item.name);
  }
  return names;
}

function fileSize(path: string): number {
  const f = fsFile(path);
  return f.exists ? f.size : 0;
}

// فحص مزدوج: الجلسة (قبل أي لمس للبيانات) ثم الدور الحالي من جدول المستخدمين (حساب معطّل = رفض).
export async function inspectBackupReadiness(session: Session | null | undefined): Promise<BackupInventory> {
  const s = requirePerm(session, BACKUP_PERMISSION);
  const db = await getDb();
  await assertUserCan(db, s.userId, BACKUP_PERMISSION);

  try {
    return await collectBackupInventory({
      db,
      listAttachmentFiles: async () => listAttachmentFilesReadOnly(),
      getDatabaseFile: async () => {
        const main = fsFile(db.databasePath);
        return {
          exists: main.exists,
          sizeBytes: main.exists ? main.size : 0,
          walBytes: fileSize(db.databasePath + '-wal'),
        };
      },
      // SecureStore لا يوفر فحص الوجود دون قراءة؛ القيمة تُقارن ولا تُحفظ ولا تُسجَّل.
      hasSecret: async (name) => {
        const v = await SecureStore.getItemAsync(name);
        return typeof v === 'string' && v.length > 0;
      },
      now: () => Date.now(),
    });
  } catch {
    throw new BackupError('INVENTORY_FAILED');
  }
}
