// SECURECASEDESK_PHASE9_S1
// واجهة خدمة المرفقات للتطبيق: توصل منطق attachments-repo بقاعدة البيانات المشفرة
// (SQLCipher) والتخزين والتشفير وسجل التدقيق. كل دالة تتطلب جلسة وتتحقق من الصلاحيات أولاً.

import * as Crypto from 'expo-crypto';
import { File, Directory, Paths } from 'expo-file-system';
import { getDb } from '@/database/db';
import type { Session } from '@/security/guard';
import { recordSystemEvent } from '@/modules/audit/audit-integration';
import {
  addAttachment, listAttachments, countAttachments, readAttachment, deleteAttachment,
  verifyAttachment, runAttachmentMaintenance,
  type AttachmentDeps, type DbLike,
} from '@/modules/attachments/attachments-repo';
import { expoBlobStorage } from '@/modules/attachments/attachments-storage';
import {
  getAttachmentMasterKey, runtimeCryptoProvider, clearCachedAttachmentKey,
} from '@/modules/attachments/attachments-crypto-runtime';
import {
  AttachmentError, type AttachmentEntityType, type AttachmentInfo,
} from '@/modules/attachments/attachments-types';

export { AttachmentError } from '@/modules/attachments/attachments-types';
export type { AttachmentInfo, AttachmentEntityType } from '@/modules/attachments/attachments-types';
export type { MaintenanceReport, VerifyResult } from '@/modules/attachments/attachments-repo';

async function deps(): Promise<AttachmentDeps> {
  const db = (await getDb()) as unknown as DbLike;
  return {
    db,
    storage: expoBlobStorage,
    crypto: runtimeCryptoProvider,
    getMasterKey: getAttachmentMasterKey,
    uuid: () => Crypto.randomUUID(),
    now: () => Date.now(),
    // إضافة وحذف المرفقات يلتقطهما مشغل جدول attachments تلقائياً؛ هنا فقط الفتح وفشل السلامة.
    audit: async (session, event) => {
      await recordSystemEvent(session, 'dashboard.view', event);
    },
  };
}

// يقرأ الملف من مسار على الجهاز (مثلاً ناتج منتقي المستندات مع النسخ إلى الكاش).
async function readSource(uri: string): Promise<Uint8Array> {
  const file = new File(uri);
  if (!file.exists) throw new AttachmentError('FILE_MISSING');
  return file.bytes();
}

export async function addAttachmentFromUri(
  session: Session | null | undefined,
  entityType: AttachmentEntityType,
  entityId: string,
  source: { uri: string; name: string; mimeType?: string | null }
): Promise<AttachmentInfo> {
  const d = await deps();
  const bytes = await readSource(source.uri);
  return addAttachment(d, session, entityType, entityId,
    { name: source.name, bytes, declaredMime: source.mimeType ?? null });
}

export async function getAttachments(
  session: Session | null | undefined, entityType: AttachmentEntityType, entityId: string
): Promise<AttachmentInfo[]> {
  return listAttachments(await deps(), session, entityType, entityId);
}

export async function getAttachmentCount(
  session: Session | null | undefined, entityType: AttachmentEntityType, entityId: string
): Promise<number> {
  return countAttachments(await deps(), session, entityType, entityId);
}

export async function removeAttachment(
  session: Session | null | undefined, id: string, reason: string
): Promise<void> {
  await deleteAttachment(await deps(), session, id, reason);
}

export async function checkAttachment(session: Session | null | undefined, id: string) {
  return verifyAttachment(await deps(), session, id);
}

export async function maintainAttachments(session: Session | null | undefined) {
  return runAttachmentMaintenance(await deps(), session);
}

// نسخة مفكوكة مؤقتة في الكاش لمعاينة المرفق (القسم الثاني). تُحذف عبر purgeDecryptedCache.
const CACHE_DIR = 'attachment-preview';

export async function openAttachmentToCache(
  session: Session | null | undefined, id: string
): Promise<{ uri: string; mimeType: string; name: string }> {
  const { info, bytes } = await readAttachment(await deps(), session, id);
  const dir = new Directory(Paths.cache, CACHE_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const out = new File(dir, Crypto.randomUUID() + '.' + info.extension);
  out.create();
  out.writeSync(bytes); // SDK 58: write() غير متزامنة؛ كان bytes.fill(0) يصفّر البيانات قبل اكتمال الكتابة
  bytes.fill(0);
  return { uri: out.uri, mimeType: info.mime_type, name: info.original_name };
}

// يجب استدعاؤها عند تسجيل الخروج والقفل التلقائي والإغلاق.
export function purgeDecryptedCache(): void {
  try {
    const dir = new Directory(Paths.cache, CACHE_DIR);
    if (dir.exists) dir.delete();
  } catch (e) {
    console.error('[Attachments] تعذر تنظيف الكاش المؤقت');
  }
  clearCachedAttachmentKey();
}
