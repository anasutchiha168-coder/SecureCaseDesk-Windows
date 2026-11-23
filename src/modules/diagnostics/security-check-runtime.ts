// SECURECASEDESK_PHASE12_S2
// جمع حقائق تشفير القاعدة على الجهاز الفعلي (للقراءة فقط؛ لا يكتب سجلات ولا يعرض المفتاح).
import * as SQLite from 'expo-sqlite';
import { closeDb, getDb, inspectDatabaseEncryption } from '@/database/db';
import { runAuditIntegritySelfTest } from '@/security/audit-verifier-core';
import type { EncryptionFacts } from './security-check';

const DB_NAME = 'securecase.db';

// يفتح اتصالاً جديداً بمفتاح خاطئ عمداً؛ النجاح في القراءة = فشل أمني.
export async function probeWrongKeyRejected(): Promise<boolean> {
  let probe: SQLite.SQLiteDatabase | null = null;
  try {
    probe = await SQLite.openDatabaseAsync(DB_NAME, { useNewConnection: true });
    await probe.execAsync("PRAGMA key = 'scd-diagnostic-wrong-key-0000';");
    await probe.getFirstAsync('SELECT COUNT(*) AS c FROM sqlite_master;');
    return false; // قُرئت بمفتاح خاطئ
  } catch {
    return true; // رُفضت كما يجب
  } finally {
    if (probe) { try { await probe.closeAsync(); } catch { /* تجاهل */ } }
  }
}

// يغلق الاتصال الرئيسي ويعيد فتحه بالمفتاح المخزَّن ثم يقرأ جدولاً. لا يُستدعى تلقائياً (بزر صريح).
export async function probeReopen(): Promise<boolean> {
  try {
    await closeDb();
    const db = await getDb();
    const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM users;');
    return row !== null;
  } catch {
    return false;
  }
}

export async function collectEncryptionFacts(opts: { withReopen: boolean }): Promise<EncryptionFacts> {
  let base: Awaited<ReturnType<typeof inspectDatabaseEncryption>> | null = null;
  try { base = await inspectDatabaseEncryption(); } catch { base = null; }
  const wrongKeyRejected = base ? await probeWrongKeyRejected() : null;
  const reopenOk = opts.withReopen ? await probeReopen() : null;
  return {
    cipherVersion: base?.cipherVersion ?? null,
    headerReadable: base?.headerReadable ?? false,
    sqliteHeaderDetected: base?.sqliteHeaderDetected ?? false,
    fileSize: base?.fileSize ?? 0,
    schemaAccessible: base?.schemaAccessible ?? false,
    wrongKeyRejected,
    reopenOk,
  };
}

export function runAuditSelfTestSafe(): { ok: boolean; detail: string } {
  try {
    const r = runAuditIntegritySelfTest();
    return { ok: r.ok, detail: r.ok ? 'اكتشف التعديل والحذف وإعادة الترتيب وبتر الذيل' : JSON.stringify(r) };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}
