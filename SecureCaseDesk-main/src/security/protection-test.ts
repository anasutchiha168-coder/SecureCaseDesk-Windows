import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb } from '@/database/db';
import { assertUserCan } from '@/security/permissions';

const NOT_BLOCKED = '__NOT_BLOCKED__';
const OTHER_ERRORS = ['no such', 'syntax error', 'FOREIGN KEY', 'NOT NULL', 'locked'];

type TableName = 'detainee_movements' | 'correction_history';

interface Check {
  title: string;
  trigger: string;
  table: TableName;
  kind: 'update' | 'delete';
  known: string | null;
}

const CHECKS: Check[] = [
  { title: 'تعديل سجل الحركات', trigger: 'trg_movements_no_update', table: 'detainee_movements', kind: 'update', known: null },
  { title: 'حذف من سجل الحركات', trigger: 'trg_movements_no_delete', table: 'detainee_movements', kind: 'delete', known: null },
  { title: 'تعديل سجل التصحيحات', trigger: 'trg_corrections_no_update', table: 'correction_history', kind: 'update', known: 'غير قابل' },
  { title: 'حذف من سجل التصحيحات', trigger: 'trg_corrections_no_delete', table: 'correction_history', kind: 'delete', known: 'غير قابل' },
];

interface RowInfo {
  id: string;
  reason: string | null;
}

function excerpt(msg: string): string {
  const flat = msg.split('\n').join(' ').trim();
  return flat.length > 110 ? flat.slice(flat.length - 110) : flat;
}

async function countRows(db: SQLiteDatabase, table: TableName): Promise<number> {
  const r = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM ' + table);
  return r?.c ?? 0;
}

async function firstRow(db: SQLiteDatabase, table: TableName): Promise<RowInfo | null> {
  return db.getFirstAsync<RowInfo>('SELECT id, reason FROM ' + table + ' ORDER BY rowid LIMIT 1');
}

// ينفّذ العبارة داخل transaction يتراجع عنها دائماً، فلا يتغير شيء حتى لو لم تُرفض.
async function attempt(
  db: SQLiteDatabase,
  sql: string,
  params: string[]
): Promise<{ blocked: boolean; message: string }> {
  try {
    await db.withTransactionAsync(async () => {
      await db.runAsync(sql, params);
      throw new Error(NOT_BLOCKED);
    });
    return { blocked: false, message: '' };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes(NOT_BLOCKED)) return { blocked: false, message: '' };
    return { blocked: true, message: msg };
  }
}

export async function runProtectionTest(userId: string): Promise<string> {
  const db = await getDb();
  await assertUserCan(db, userId, 'users.manage');

  const lines: string[] = [];
  const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version;');
  lines.push('التشفير: ' + (cipher?.cipher_version ? 'SQLCipher ' + cipher.cipher_version : 'غير مؤكد'));

  const found = await db.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'trigger'`
  );
  const names = found.map((t) => t.name);

  const before = {
    detainee_movements: await countRows(db, 'detainee_movements'),
    correction_history: await countRows(db, 'correction_history'),
  };
  const rows = {
    detainee_movements: await firstRow(db, 'detainee_movements'),
    correction_history: await firstRow(db, 'correction_history'),
  };

  for (const c of CHECKS) {
    const row = rows[c.table];
    if (!names.includes(c.trigger)) {
      lines.push('فشل: ' + c.title + ' - الحماية (' + c.trigger + ') غير موجودة');
      continue;
    }
    if (!row) {
      lines.push('تنبيه: ' + c.title + ' - لا توجد سجلات للاختبار');
      continue;
    }
    const sql =
      c.kind === 'update'
        ? 'UPDATE ' + c.table + ' SET reason = ? WHERE id = ?'
        : 'DELETE FROM ' + c.table + ' WHERE id = ?';
    const params = c.kind === 'update' ? ['__test__', row.id] : [row.id];
    const r = await attempt(db, sql, params);

    if (!r.blocked) {
      lines.push('فشل: ' + c.title + ' - لم يُرفض! (تم التراجع عن العملية)');
    } else if (OTHER_ERRORS.some((p) => r.message.includes(p))) {
      lines.push('تنبيه: ' + c.title + ' - رُفض لسبب آخر: ' + excerpt(r.message));
    } else if (c.known && !r.message.includes(c.known)) {
      lines.push('تنبيه: ' + c.title + ' - رسالة غير متوقعة: ' + excerpt(r.message));
    } else {
      lines.push('نجح: ' + c.title + ' - مرفوض من القاعدة: ' + excerpt(r.message));
    }
  }

  const after = {
    detainee_movements: await countRows(db, 'detainee_movements'),
    correction_history: await countRows(db, 'correction_history'),
  };
  const sameCounts =
    after.detainee_movements === before.detainee_movements &&
    after.correction_history === before.correction_history;
  lines.push(
    (sameCounts ? 'نجح' : 'فشل') +
      ': عدد السجلات بعد الفحص - حركات ' + after.detainee_movements +
      ' / تصحيحات ' + after.correction_history + (sameCounts ? ' (لم يتغير)' : ' (تغيّر!)')
  );

  const rowsAfter = {
    detainee_movements: await firstRow(db, 'detainee_movements'),
    correction_history: await firstRow(db, 'correction_history'),
  };
  const tables: TableName[] = ['detainee_movements', 'correction_history'];
  const sameData = tables.every((t) => {
    const b = rows[t];
    const a = rowsAfter[t];
    return !b || (!!a && a.reason === b.reason);
  });
  lines.push((sameData ? 'نجح' : 'فشل') + ': محتوى السجلات المختبَرة لم يتغير');

  const report = lines.join('\n');
  console.log('[ProtectionTest]\n' + report);
  return report;
}
