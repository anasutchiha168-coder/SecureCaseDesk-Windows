// SECURECASEDESK_DETAINEES_V22_S5
// جدول التصنيفات القانونية للجرائم (بيانات مرجعية) + تعبئته أول مرة من ملف Excel.
// المعرّفات ثابتة (cls-001 ... cls-178 بترقيم Excel) حتى تتطابق على كل الأجهزة والنسخ الاحتياطية.
// لا تُعاد التعبئة إن كان الجدول غير فارغ، فلا يُستبدل أي تعديل أو تعطيل يدوي لاحقاً.
import { CLASSIFICATION_GROUPS, SEVERITY_GRAVE, SEVERITY_LIGHT } from '../modules/detainees/classifications-seed';

export interface ClassificationsDb {
  execAsync(sql: string): Promise<void>;
  getFirstAsync<T>(sql: string, params?: unknown): Promise<T | null>;
}

const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";

export function classificationSeedRows() {
  const rows: { id: string; name: string; severity: string; sub: string; main: string; basis: string; sort: number }[] = [];
  for (const g of CLASSIFICATION_GROUPS) {
    for (const [name, grave] of g.items) {
      const n = rows.length + 1;
      rows.push({
        id: 'cls-' + String(n).padStart(3, '0'), name, severity: grave ? SEVERITY_GRAVE : SEVERITY_LIGHT,
        sub: g.sub, main: g.main, basis: g.basis, sort: n,
      });
    }
  }
  return rows;
}

export async function initClassificationsSchema(db: ClassificationsDb): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS crime_classifications (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      severity TEXT NOT NULL CHECK (severity IN ('جسيمة', 'غير جسيم')),
      sub_category TEXT NOT NULL,
      main_category TEXT NOT NULL,
      legal_basis TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crime_cls_groups ON crime_classifications(main_category, sub_category);
  `);
  const have = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM crime_classifications');
  if ((have?.count ?? 0) > 0) return;

  const now = Date.now();
  const rows = classificationSeedRows();
  try {
    await db.execAsync('BEGIN IMMEDIATE;');
    for (let i = 0; i < rows.length; i += 40) {
      const values = rows.slice(i, i + 40).map((r) =>
        '(' + [q(r.id), q(r.name), q(r.severity), q(r.sub), q(r.main), q(r.basis), 1, r.sort, now].join(', ') + ')');
      await db.execAsync(
        'INSERT INTO crime_classifications (id, name, severity, sub_category, main_category, legal_basis, is_active, sort_order, created_at) VALUES ' +
        values.join(', ') + ';');
    }
    await db.execAsync('COMMIT;');
  } catch (e) {
    try { await db.execAsync('ROLLBACK;'); } catch { /* لا معاملة مفتوحة */ }
    throw e;
  }
}
