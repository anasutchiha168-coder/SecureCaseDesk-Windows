import type { SQLiteDatabase } from 'expo-sqlite';

export type Role = 'admin' | 'investigator' | 'viewer' | 'detention_viewer';

export type Permission =
  | 'dashboard.view'
  | 'cases.view'
  | 'cases.manage'
  | 'memos.view'
  | 'memos.manage'
  | 'detainees.view'
  | 'detainees.manage'
  | 'detainees.correct'
  | 'users.manage'
  | 'attachments.admin'
  | 'audit.view'
  | 'audit.verify'
  | 'audit.sync'
  | 'backup.manage'
  | 'ai.use'
  | 'ai.manage';

export type TabName = 'index' | 'cases' | 'detainees' | 'memos' | 'settings' | 'users' | 'audit';

export const ROLES: { key: Role; label: string; description: string }[] = [
  { key: 'admin', label: 'مدير النظام', description: 'صلاحيات كاملة على الوحدات المصرح بها' },
  { key: 'investigator', label: 'محقق', description: 'تسجيل القضايا ومتابعتها' },
  { key: 'viewer', label: 'مستخدم اطلاع', description: 'الاطلاع والبحث فقط دون تعديل' },
  {
    key: 'detention_viewer',
    label: 'مشاهد المحتجزين',
    description: 'عرض المحتجزين وإحصاءاتهم فقط، دون وصول للقضايا والمذكرات',
  },
];

// ملاحظة: صلاحيات المحقق والمشاهد مؤقتة وتحاكي ما يعمل الآن، وستُراجع في المرحلة 7.
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: [
    'dashboard.view', 'cases.view', 'cases.manage', 'memos.view', 'memos.manage',
    'detainees.view', 'detainees.manage', 'detainees.correct', 'users.manage', 'attachments.admin',
    'audit.view', 'audit.verify', 'audit.sync', 'backup.manage', 'ai.use', 'ai.manage',
  ],
  investigator: [
    'dashboard.view', 'cases.view', 'cases.manage', 'memos.view', 'memos.manage', 'detainees.view', 'ai.use',
  ],
  viewer: ['dashboard.view', 'cases.view', 'memos.view', 'detainees.view', 'ai.use'],
  detention_viewer: ['dashboard.view', 'detainees.view'],
};

// صلاحية كل تبويب. القيمة null تعني متاح للجميع (شاشة الإعدادات فيها تسجيل الخروج).
const TAB_PERMISSION: Record<TabName, Permission | null> = {
  index: 'dashboard.view',
  cases: 'cases.view',
  detainees: 'detainees.view',
  memos: 'memos.view',
  settings: null,
  users: 'users.manage',
  audit: 'audit.view',
};

export function normalizeRole(role: string | null | undefined): Role | null {
  const r = String(role ?? '').trim().toLowerCase().split(' ').join('_').split('-').join('_');
  if (r === 'admin' || r === 'investigator' || r === 'viewer' || r === 'detention_viewer') {
    return r;
  }
  return null;
}

// الرفض هو الأصل: دور غير معروف لا يملك أي صلاحية.
export function can(role: string | null | undefined, permission: Permission): boolean {
  const r = normalizeRole(role);
  if (!r) return false;
  return ROLE_PERMISSIONS[r].includes(permission);
}

export function roleLabel(role: string | null | undefined): string {
  const r = normalizeRole(role);
  const found = ROLES.find((x) => x.key === r);
  return found ? found.label : 'غير معروف';
}

export function canAccessTab(role: string | null | undefined, tab: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(TAB_PERMISSION, tab)) return true;
  const perm = TAB_PERMISSION[tab as TabName];
  if (perm === null) return true;
  return can(role, perm);
}

export function firstAllowedTab(role: string | null | undefined): TabName {
  const order: TabName[] = ['index', 'detainees', 'cases', 'memos', 'users', 'audit', 'settings'];
  return order.find((t) => canAccessTab(role, t)) ?? 'settings';
}

// فحص على مستوى البيانات: يقرأ الدور من جدول المستخدمين نفسه، لا من حالة الواجهة.
export async function assertUserCan(
  db: SQLiteDatabase,
  userId: string,
  permission: Permission
): Promise<void> {
  const row = await db.getFirstAsync<{ role: string; is_active: number }>(
    'SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?', [userId]
  );

  if (!row || Number(row.is_active) !== 1 || !can(row.role, permission)) {
    throw new Error('FORBIDDEN');
  }
}
