import { getDb } from '@/database/db';
import { can } from '@/security/permissions';
import { requirePerm, type Session } from '@/security/guard';
import { resolveCaseScope, caseScopeSql, memoScopeSql } from '@/security/case-scope'; // SECURECASEDESK_FIX_L1_G1_G2

export interface DashboardStats {
  cases: { open: number; underInvestigation: number } | null;
  memos: { active: number } | null;
  detainees: { current: number; admissionsToday: number; releasesToday: number } | null;
}

// كل قسم يُحسب فقط إن كان الدور يملك صلاحية عرضه؛ غير ذلك يرجع null ولا يُنفَّذ أي استعلام عليه.
export async function getDashboardStats(
  session: Session | null | undefined
): Promise<DashboardStats> {
  const s = requirePerm(session, 'dashboard.view');
  const db = await getDb();
  const result: DashboardStats = { cases: null, memos: null, detainees: null };

  const scope = await resolveCaseScope(db, s); // L1: أعداد القضايا والمذكرات ضمن نطاق القسم
  if (can(s.role, 'cases.view')) {
    const cf = caseScopeSql(scope, 'department_id');
    const open = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM cases WHERE ' + cf.sql + ' AND status NOT IN (?, ?)',
      [...cf.args, 'مغلقة', 'مؤرشفة']
    );
    const inv = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM cases WHERE ' + cf.sql + ' AND status = ?',
      [...cf.args, 'قيد التحقيق']
    );
    result.cases = { open: open?.count ?? 0, underInvestigation: inv?.count ?? 0 };
  }

  if (can(s.role, 'memos.view')) {
    const mf = memoScopeSql(scope, 'linked_case_id');
    const memos = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM memos WHERE ' + mf.sql + ' AND status != ?',
      [...mf.args, 'مؤرشفة']
    );
    result.memos = { active: memos?.count ?? 0 };
  }

  if (can(s.role, 'detainees.view')) {
    const detained = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM detainees WHERE status = ?',
      ['محتجز']
    );
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
    const adm = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM detainee_movements WHERE movement_type = ? AND movement_date >= ? AND movement_date <= ?',
      ['إيداع', start, end]
    );
    const rel = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM detainee_movements WHERE movement_type = ? AND movement_date >= ? AND movement_date <= ?',
      ['إفراج', start, end]
    );
    result.detainees = {
      current: detained?.count ?? 0,
      admissionsToday: adm?.count ?? 0,
      releasesToday: rel?.count ?? 0,
    };
  }

  return result;
}

// ===== SECURECASEDESK_UI_V2: اتجاهات آخر 14 يوماً للرسوم المصغّرة (بيانات حقيقية، ضمن نفس الصلاحيات والنطاق) =====
export interface DashboardTrends {
  casesCreated: number[] | null;   // 14 قيمة: أقدم يوم أولاً
  memosCreated: number[] | null;
  admissions: number[] | null;
  releases: number[] | null;
}
export const TREND_DAYS = 14;

function dayStart(ts: number): number { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function bucket(times: number[], first: number): number[] {
  const out = new Array<number>(TREND_DAYS).fill(0);
  for (const t of times) {
    const i = Math.floor((dayStart(t) - first) / 86400000);
    if (i >= 0 && i < TREND_DAYS) out[i] += 1;
  }
  return out;
}

export async function getDashboardTrends(session: Session | null | undefined): Promise<DashboardTrends> {
  const s = requirePerm(session, 'dashboard.view');
  const db = await getDb();
  const res: DashboardTrends = { casesCreated: null, memosCreated: null, admissions: null, releases: null };
  const todayStart = dayStart(Date.now());
  const first = todayStart - (TREND_DAYS - 1) * 86400000;
  const scope = await resolveCaseScope(db, s);

  if (can(s.role, 'cases.view')) {
    const cf = caseScopeSql(scope, 'department_id');
    const r = await db.getAllAsync<{ created_at: number }>('SELECT created_at FROM cases WHERE ' + cf.sql + ' AND created_at >= ?', [...cf.args, first]);
    res.casesCreated = bucket(r.map((x) => x.created_at), first);
  }
  if (can(s.role, 'memos.view')) {
    const mf = memoScopeSql(scope, 'linked_case_id');
    const r = await db.getAllAsync<{ created_at: number }>('SELECT created_at FROM memos WHERE ' + mf.sql + ' AND created_at >= ?', [...mf.args, first]);
    res.memosCreated = bucket(r.map((x) => x.created_at), first);
  }
  if (can(s.role, 'detainees.view')) {
    const r = await db.getAllAsync<{ movement_type: string; movement_date: number }>(
      'SELECT movement_type, movement_date FROM detainee_movements WHERE movement_type IN (?, ?) AND movement_date >= ?', ['إيداع', 'إفراج', first]);
    res.admissions = bucket(r.filter((x) => x.movement_type === 'إيداع').map((x) => x.movement_date), first);
    res.releases = bucket(r.filter((x) => x.movement_type === 'إفراج').map((x) => x.movement_date), first);
  }
  return res;
}

// نسبة التغير: آخر 7 أيام مقابل الـ 7 السابقة. null إن لم توجد قاعدة مقارنة (لا نختلق نسبة).
export function weekOverWeek(series: number[] | null | undefined): number | null {
  if (!series || series.length < TREND_DAYS) return null;
  const prev = series.slice(0, 7).reduce((a, b) => a + b, 0);
  const cur = series.slice(7).reduce((a, b) => a + b, 0);
  if (prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}
