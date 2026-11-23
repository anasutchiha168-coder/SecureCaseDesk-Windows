import { getDb } from '../database/db';
import { requirePerm } from '../security/guard';
import type { Session } from '../security/guard';

export interface DetaineeRow {
  id: string;
  reference_number: string;
  full_name: string;
  admission_date: number;
  release_date: number | null;
  status: string;
  category_name: string | null;
}

export interface CategoryRow {
  id: string;
  name: string;
}

const SQL_BASE = `
  SELECT d.id, d.reference_number, d.full_name, d.admission_date,
         d.release_date, d.status, c.name AS category_name
  FROM detainees d
  LEFT JOIN detainee_categories c ON c.id = d.category_id
`;
const SQL_ORDER = ' ORDER BY d.admission_date DESC, d.created_at DESC';

export async function listDetainees(
  session: Session | null | undefined,
  query: string
): Promise<DetaineeRow[]> {
  requirePerm(session, 'detainees.view');
  const db = await getDb();
  const term = query.trim();

  if (term) {
    return db.getAllAsync<DetaineeRow>(
      SQL_BASE + ' WHERE d.full_name LIKE ? OR d.reference_number LIKE ?' + SQL_ORDER,
      ['%' + term + '%', '%' + term + '%']
    );
  }
  return db.getAllAsync<DetaineeRow>(SQL_BASE + SQL_ORDER);
}

export async function listDetaineeCategories(
  session: Session | null | undefined
): Promise<CategoryRow[]> {
  requirePerm(session, 'detainees.view');
  const db = await getDb();
  return db.getAllAsync<CategoryRow>(
    'SELECT id, name FROM detainee_categories WHERE is_active = 1 ORDER BY name ASC'
  );
}

// ⚠️ insertDetaineeWithMovement غير مكتوبة بعد عمداً.
// بانتظار استعلامات INSERT الفعلية من handleSave (السطور ~341-350 من detainees.tsx)
// قبل كتابة هذه الدالة - لا نخمّن بنية إدراج محتجز أو حركة حجز.
