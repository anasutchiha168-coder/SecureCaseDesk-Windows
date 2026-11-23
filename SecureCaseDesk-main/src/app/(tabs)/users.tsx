// SECURECASEDESK_UI_V3 — إدارة المستخدمين كواجهة إدارية مؤسسية.
// المنطق حرفياً كما كان: الصلاحيات، إنشاء الحساب، تعديل الدور والقسم، التعطيل والتفعيل، حماية آخر مدير. التغيير في العرض فقط.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, FlatList, Alert, Pressable, ActivityIndicator } from 'react-native';
import {
  Users, UserPlus, ShieldCheck, ShieldAlert, Eye, Lock, Search, Ban, Pencil, Check, KeyRound,
  Building2, Clock, CalendarDays, UserRound,
} from 'lucide-react-native';
import * as Crypto from 'expo-crypto';
import { getDb } from '@/database/db';
import { useAuth } from '@/context/AuthContext';
import { can, assertUserCan, ROLES, roleLabel, normalizeRole } from '@/security/permissions';
import type { Role, Permission } from '@/security/permissions';
import { Colors, Palette, Type, tint, Glow } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import {
  Screen, PageHeader, IconBtn, Card, Pill, MetaItem, StatStrip, SearchField, FilterChips, Btn, Field,
  Sheet, ListSkeleton, SectionTitle, type MiniStat, type ChipOpt,
} from '@/components/ui/Kit';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { FadeIn, PressableScale } from '@/components/ui/Motion';

interface UserRow {
  id: string;
  username: string;
  role: string;
  created_at: number | string;
  department_id: string | null;
  department_name: string | null;
  is_active: number;
  last_login: number | null;
}
interface DepartmentRow { id: string; name: string; }

/* ───────────── مظهر الأدوار الأربعة (العرض فقط؛ نظام الصلاحيات لم يُمسّ) ───────────── */
interface RoleLook { color: string; icon: React.ElementType }
const ROLE_LOOK: Record<Role, RoleLook> = {
  admin: { color: Palette.blue, icon: ShieldCheck },
  investigator: { color: Palette.green, icon: Search },
  viewer: { color: Palette.cyan, icon: Eye },
  detention_viewer: { color: Palette.gold, icon: Lock },
};
const UNKNOWN_LOOK: RoleLook = { color: Colors.textMuted, icon: ShieldAlert };
function roleLook(role: string | null | undefined): RoleLook {
  const r = normalizeRole(role);
  return r ? ROLE_LOOK[r] : UNKNOWN_LOOK;
}

// تسميات عرض فقط. القيمة الفعلية تأتي من can() أي من نظام الصلاحيات نفسه.
const PERM_LABELS: { perm: Permission; label: string }[] = [
  { perm: 'dashboard.view', label: 'لوحة التحكم' },
  { perm: 'cases.view', label: 'عرض القضايا' },
  { perm: 'cases.manage', label: 'إدارة القضايا' },
  { perm: 'memos.view', label: 'عرض المذكرات' },
  { perm: 'memos.manage', label: 'إدارة المذكرات' },
  { perm: 'detainees.view', label: 'عرض المحتجزين' },
  { perm: 'detainees.manage', label: 'إدارة المحتجزين' },
  { perm: 'detainees.correct', label: 'تصحيح بيانات المحتجزين' },
  { perm: 'users.manage', label: 'إدارة المستخدمين' },
  { perm: 'attachments.admin', label: 'إدارة المرفقات' },
  { perm: 'audit.view', label: 'عرض سجل التدقيق' },
  { perm: 'audit.verify', label: 'التحقق من سجل التدقيق' },
  { perm: 'audit.sync', label: 'مزامنة سجل التدقيق' },
  { perm: 'backup.manage', label: 'النسخ الاحتياطي' },
  { perm: 'ai.use', label: 'استخدام المساعد الذكي' },
  { perm: 'ai.manage', label: 'إعدادات المساعد الذكي' },
];

function toTs(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n)) return n;
  const p = Date.parse(String(v));
  return Number.isNaN(p) ? null : p;
}
function fmtDate(v: number | string | null | undefined): string {
  const t = toTs(v);
  return t ? new Date(t).toLocaleDateString('ar-YE', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}
function fmtDateTime(v: number | string | null | undefined): string {
  const t = toTs(v);
  if (!t) return 'لم يسجل الدخول بعد';
  return new Date(t).toLocaleDateString('ar-YE', { year: 'numeric', month: 'short', day: 'numeric' }) + ' • ' +
    new Date(t).toLocaleTimeString('ar-YE', { hour: '2-digit', minute: '2-digit' });
}
const initialOf = (name: string) => (name.trim().charAt(0) || '؟').toUpperCase();

/* ───────────── مكونات العرض ───────────── */
function Avatar({ name, color, active, size = 52 }: { name: string; color: string; active: boolean; size?: number }) {
  return (
    <View style={{ width: size, height: size }}>
      <View style={[{ width: size, height: size, borderRadius: size * 0.34, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(color, 0.18), borderWidth: 1, borderColor: tint(color, 0.55) }, Glow(color)]}>
        <Text style={[Type.h1, { color, fontSize: Math.round(size * 0.42), lineHeight: Math.round(size * 0.62) }]}>{initialOf(name)}</Text>
      </View>
      <View style={{ position: 'absolute', bottom: -2, end: -2, width: 15, height: 15, borderRadius: 8, backgroundColor: active ? Palette.green : Palette.red, borderWidth: 2.5, borderColor: Palette.surface }} />
    </View>
  );
}

function ActionBtn({ label, icon: Icon, color, onPress, busy, disabled }: {
  label: string; icon: React.ElementType; color: string; onPress: () => void; busy?: boolean; disabled?: boolean;
}) {
  const off = !!(busy || disabled);
  return (
    <View style={{ flex: 1 }}>
      <PressableScale onPress={onPress} disabled={off} accessibilityRole="button" accessibilityLabel={label}
        style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'center', gap: 6, height: 42, borderRadius: 14, backgroundColor: tint(color, 0.12), borderWidth: 1, borderColor: tint(color, 0.45), opacity: disabled ? 0.5 : 1 }}>
        {busy ? <ActivityIndicator size="small" color={color} /> : (
          <>
            <Icon color={color} size={16} />
            <Text style={[Type.body, { color, fontFamily: 'Cairo_700Bold' }]}>{label}</Text>
          </>
        )}
      </PressableScale>
    </View>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8, marginTop: 6, padding: 12, borderRadius: 14, backgroundColor: tint(Palette.red, 0.1), borderWidth: 1, borderColor: tint(Palette.red, 0.45) }}>
      <ShieldAlert color={Palette.red} size={18} />
      <Text style={[Type.body, { color: Palette.red, flex: 1, textAlign: 'right' }]}>{message}</Text>
    </View>
  );
}

function FieldLabel({ text }: { text: string }) {
  return <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right', marginBottom: 8, marginTop: 4 }]}>{text}</Text>;
}

// اختيار الدور ببطاقات: الأدوار الأربعة بألوانها وأيقوناتها ووصفها.
function RoleOptions({ value, onChange, lockAllButAdmin }: { value: Role | null; onChange: (r: Role) => void; lockAllButAdmin?: boolean }) {
  return (
    <View style={{ gap: 10, marginBottom: 14 }}>
      {ROLES.map((r) => {
        const look = ROLE_LOOK[r.key];
        const on = value === r.key;
        const locked = !!lockAllButAdmin && r.key !== 'admin';
        const Icon = look.icon;
        return (
          <View key={r.key} style={{ opacity: locked ? 0.4 : 1 }}>
            <PressableScale onPress={() => onChange(r.key)} disabled={locked} accessibilityRole="button" accessibilityLabel={r.label} accessibilityState={{ selected: on, disabled: locked }}
              style={{ flexDirection: ROW, alignItems: 'center', gap: 12, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: on ? tint(look.color, 0.75) : Palette.glassBorder, backgroundColor: on ? tint(look.color, 0.14) : Palette.bg1 }}>
              <View style={{ width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(look.color, 0.16), borderWidth: 1, borderColor: tint(look.color, 0.45) }}>
                <Icon color={look.color} size={19} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[Type.h3, { color: on ? look.color : Colors.textPrimary, textAlign: 'right' }]}>{r.label}</Text>
                <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>{r.description}</Text>
              </View>
              <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: on ? look.color : Colors.borderLight, backgroundColor: on ? look.color : 'transparent' }}>
                {on ? <Check color="#fff" size={13} /> : null}
              </View>
            </PressableScale>
          </View>
        );
      })}
    </View>
  );
}

function DeptChips({ departments, value, onChange }: { departments: DepartmentRow[]; value: string | null; onChange: (id: string | null) => void }) {
  const all: { id: string | null; name: string }[] = [{ id: null, name: 'بلا قسم' }, ...departments.map((d) => ({ id: d.id as string | null, name: d.name }))];
  return (
    <View style={{ flexDirection: ROW, flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
      {all.map((d) => {
        const on = value === d.id;
        return (
          <Pressable key={d.id ?? 'none'} onPress={() => onChange(d.id)} accessibilityRole="button" accessibilityState={{ selected: on }}
            style={{ flexDirection: ROW, alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 38, borderRadius: 999, borderWidth: 1, borderColor: on ? tint(Palette.cyan, 0.6) : Palette.glassBorder, backgroundColor: on ? tint(Palette.cyan, 0.18) : Palette.bg1 }}>
            <Building2 color={on ? Palette.cyan : Colors.textMuted} size={14} />
            <Text style={[Type.body, { color: on ? Palette.cyan : Colors.textSecondary, fontFamily: on ? 'Cairo_700Bold' : 'Cairo_500Medium' }]}>{d.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ───────────── بطاقة المستخدم ───────────── */
const UserCard = React.memo(function UserCard({ item, index, isSelf, busy, onOpen, onEdit, onToggle }: {
  item: UserRow; index: number; isSelf: boolean; busy: boolean;
  onOpen: (u: UserRow) => void; onEdit: (u: UserRow) => void; onToggle: (u: UserRow) => void;
}) {
  const look = roleLook(item.role);
  const active = Number(item.is_active) === 1;
  return (
    <FadeIn delay={Math.min(index, 8) * 40}>
      <Card accent={active ? look.color : Palette.red} onPress={() => onOpen(item)} label={'عرض ملف المستخدم ' + item.username}>
        <View style={{ flexDirection: ROW, alignItems: 'center' }}>
          <Avatar name={item.username} color={look.color} active={active} />
          <View style={{ flex: 1, paddingHorizontal: 12 }}>
            <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8 }}>
              <Text style={[Type.h2, { color: Colors.textPrimary, flexShrink: 1, textAlign: 'right' }]} numberOfLines={1}>{item.username}</Text>
              {isSelf ? <Pill label="أنت" color={Palette.cyan} /> : null}
            </View>
            <View style={{ flexDirection: ROW, alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <Pill label={roleLabel(item.role)} color={look.color} icon={look.icon} />
              <Pill label={active ? 'نشط' : 'معطّل'} color={active ? Palette.green : Palette.red} />
            </View>
          </View>
        </View>
        <View style={{ flexDirection: ROW, flexWrap: 'wrap', rowGap: 8, columnGap: 12, marginTop: 12 }}>
          <MetaItem icon={Building2} label="القسم" value={item.department_name || 'غير محدد'} />
          <MetaItem icon={Clock} label="آخر دخول" value={fmtDateTime(item.last_login)} />
        </View>
        <View style={{ flexDirection: ROW, gap: 10, marginTop: 14 }}>
          <ActionBtn label="تعديل" icon={Pencil} color={Palette.cyan} onPress={() => onEdit(item)} />
          <ActionBtn label={active ? 'تعطيل الحساب' : 'تفعيل الحساب'} icon={active ? Ban : ShieldCheck} color={active ? Palette.red : Palette.green} busy={busy} onPress={() => onToggle(item)} />
        </View>
      </Card>
    </FadeIn>
  );
});

/* ───────────── ملف المستخدم ───────────── */
function ProfileSheet({ item, isSelf, busy, onClose, onEdit, onToggle }: {
  item: UserRow | null; isSelf: boolean; busy: boolean; onClose: () => void; onEdit: (u: UserRow) => void; onToggle: (u: UserRow) => void;
}) {
  const look = roleLook(item?.role);
  const active = item ? Number(item.is_active) === 1 : false;
  const rk = normalizeRole(item?.role);
  const desc = ROLES.find((r) => r.key === rk)?.description ?? '';
  const perms = item ? PERM_LABELS.map((p) => ({ ...p, ok: can(item.role, p.perm) })) : [];
  const granted = perms.filter((p) => p.ok).length;
  return (
    <Sheet visible={!!item} onClose={onClose} title={item?.username ?? ''} subtitle="ملف المستخدم">
      {item ? (
        <>
          <View style={{ alignItems: 'center', marginBottom: 16 }}>
            <Avatar name={item.username} color={look.color} active={active} size={76} />
            <View style={{ flexDirection: ROW, alignItems: 'center', gap: 6, marginTop: 12 }}>
              <Pill label={roleLabel(item.role)} color={look.color} icon={look.icon} />
              <Pill label={active ? 'نشط' : 'معطّل'} color={active ? Palette.green : Palette.red} />
              {isSelf ? <Pill label="أنت" color={Palette.cyan} /> : null}
            </View>
            {desc ? <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'center', marginTop: 8 }]}>{desc}</Text> : null}
          </View>

          <Card>
            <View style={{ flexDirection: ROW, flexWrap: 'wrap', rowGap: 12, columnGap: 12 }}>
              <MetaItem icon={UserRound} label="اسم المستخدم" value={item.username} />
              <MetaItem icon={Building2} label="القسم" value={item.department_name || 'غير محدد'} />
              <MetaItem icon={Clock} label="آخر دخول" value={fmtDateTime(item.last_login)} />
              <MetaItem icon={CalendarDays} label="تاريخ إنشاء الحساب" value={fmtDate(item.created_at)} />
            </View>
          </Card>

          <SectionTitle title="الصلاحيات الفعلية" hint={granted + ' من ' + perms.length + ' صلاحية لهذا الدور'} top={18} />
          <Card>
            <View style={{ flexDirection: ROW, flexWrap: 'wrap', rowGap: 10, columnGap: 8 }}>
              {perms.map((p) => (
                <View key={p.perm} style={{ flexBasis: '48%', flexGrow: 1, flexDirection: ROW, alignItems: 'center', gap: 8 }}>
                  <View style={{ width: 20, height: 20, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: p.ok ? tint(Palette.green, 0.18) : tint('#94A3B8', 0.12) }}>
                    {p.ok ? <Check color={Palette.green} size={12} /> : <Ban color={Colors.textMuted} size={11} />}
                  </View>
                  <Text style={[Type.caption, { color: p.ok ? Colors.textPrimary : Colors.textMuted, flex: 1, textAlign: 'right' }]} numberOfLines={1}>{p.label}</Text>
                </View>
              ))}
            </View>
          </Card>

          <View style={{ flexDirection: ROW, gap: 10, marginTop: 16 }}>
            <ActionBtn label="تعديل الدور والقسم" icon={Pencil} color={Palette.cyan} onPress={() => onEdit(item)} />
            <ActionBtn label={active ? 'تعطيل الحساب' : 'تفعيل الحساب'} icon={active ? Ban : ShieldCheck} color={active ? Palette.red : Palette.green} busy={busy} onPress={() => onToggle(item)} />
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

/* ───────────── الشاشة ───────────── */
export default function UsersScreen() {
  const { user } = useAuth();
  const isAdmin = can(user?.role, 'users.manage');

  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [role, setRole] = useState<Role | null>(null);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [editRole, setEditRole] = useState<Role | null>(null);
  const [editDepartmentId, setEditDepartmentId] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');

  const loadUsers = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    try {
      const db = await getDb();
      const [rows, departmentRows] = await Promise.all([
        db.getAllAsync<UserRow>(
          `SELECT u.id, u.username, u.role, u.created_at, u.department_id,
                  d.name AS department_name,
                  COALESCE(u.is_active, 1) AS is_active,
                  u.last_login
           FROM users u
           LEFT JOIN departments d ON d.id = u.department_id
           ORDER BY u.created_at ASC, u.rowid ASC`
        ),
        db.getAllAsync<DepartmentRow>(
          'SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name ASC'
        ),
      ]);

      setUsers(rows);
      setDepartments(departmentRows);
      setFailed(false);
    } catch (e) {
      console.error('[Users] load error:', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const openAdd = () => {
    setUsername('');
    setPassword('');
    setConfirm('');
    setRole(null);
    setDepartmentId(null);
    setError('');
    setShowAdd(true);
  };

  const closeAdd = () => {
    if (saving) return;
    setShowAdd(false);
  };

  const persist = async (name: string, pass: string, newRole: Role, newDepartmentId: string | null) => {
    if (!user) return;
    const actorId = user.id;
    setSaving(true);
    setError('');
    try {
      const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, pass);
      const db = await getDb();
      await db.withTransactionAsync(async () => {
        await assertUserCan(db, actorId, 'users.manage');
        const dup = await db.getFirstAsync<{ id: string }>(
          'SELECT id FROM users WHERE LOWER(username) = LOWER(?)',
          [name]
        );
        if (dup) throw new Error('DUPLICATE');

        if (newDepartmentId) {
          const dept = await db.getFirstAsync<{ id: string }>(
            'SELECT id FROM departments WHERE id = ? AND is_active = 1',
            [newDepartmentId]
          );
          if (!dept) throw new Error('INVALID_DEPARTMENT');
        }

        await db.runAsync(
          `INSERT INTO users
           (id, username, password_hash, role, created_at, department_id, is_active)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          [Crypto.randomUUID(), name, hash, newRole, Date.now(), newDepartmentId]
        );
      });
      setShowAdd(false);
      await loadUsers();
      Alert.alert('تم الحفظ', 'تم إنشاء الحساب بنجاح');
    } catch (e) {
      console.error('[Users] create error:', e);
      const msg = String((e as Error)?.message ?? '');
      if (msg.includes('FORBIDDEN')) {
        setError('إنشاء المستخدمين من صلاحيات المدير فقط');
      } else if (msg.includes('DUPLICATE') || msg.includes('UNIQUE')) {
        setError('اسم المستخدم مستخدم مسبقاً');
      } else if (msg.includes('INVALID_DEPARTMENT')) {
        setError('القسم المحدد غير موجود أو غير نشط');
      } else {
        setError('تعذر الحفظ ولم يتم إنشاء أي حساب، حاول مرة أخرى');
      }
    } finally {
      setSaving(false);
    }
  };

  const openEdit = useCallback((item: UserRow) => {
    setEditingUser(item);
    setEditRole(normalizeRole(item.role));
    setEditDepartmentId(item.department_id);
    setShowEdit(true);
  }, []);

  // من ملف المستخدم: أغلق الملف أولاً ثم افتح التعديل (نافذتان فوق بعضهما غير مستقرتين على أندرويد).
  const openEditFromProfile = useCallback((item: UserRow) => {
    setProfileId(null);
    setTimeout(() => openEdit(item), 250);
  }, [openEdit]);

  const saveEdit = async () => {
    if (!user || !editingUser || !editRole || savingEdit) return;
    setSavingEdit(true);

    try {
      const db = await getDb();

      await db.withTransactionAsync(async () => {
        await assertUserCan(db, user.id, 'users.manage');

        const target = await db.getFirstAsync<{ role: string; is_active: number }>(
          'SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?',
          [editingUser.id]
        );

        if (!target) throw new Error('USER_NOT_FOUND');
        if (editingUser.id === user.id && editRole !== 'admin') {
          throw new Error('SELF_ROLE_CHANGE');
        }

        if (editDepartmentId) {
          const dept = await db.getFirstAsync<{ id: string }>(
            'SELECT id FROM departments WHERE id = ? AND is_active = 1',
            [editDepartmentId]
          );
          if (!dept) throw new Error('INVALID_DEPARTMENT');
        }

        if (
          normalizeRole(target.role) === 'admin' &&
          Number(target.is_active) === 1 &&
          editRole !== 'admin'
        ) {
          const count = await db.getFirstAsync<{ count: number }>(
            `SELECT COUNT(*) AS count FROM users
             WHERE LOWER(role) = 'admin' AND COALESCE(is_active, 1) = 1`
          );
          if ((count?.count ?? 0) <= 1) throw new Error('LAST_ADMIN');
        }

        await db.runAsync(
          'UPDATE users SET role = ?, department_id = ? WHERE id = ?',
          [editRole, editDepartmentId, editingUser.id]
        );
      });

      setShowEdit(false);
      setEditingUser(null);
      await loadUsers();
      Alert.alert('تم التحديث', 'تم حفظ تعديلات حساب المستخدم');

    } catch (e) {
      const msg = String((e as Error)?.message ?? '');

      if (msg.includes('FORBIDDEN')) {
        Alert.alert('رفض العملية', 'إدارة الحسابات من صلاحيات المدير النشط فقط');
      } else if (msg.includes('LAST_ADMIN')) {
        Alert.alert('تعذر التعديل', 'لا يمكن تغيير دور آخر مدير نشط');
      } else if (msg.includes('SELF_ROLE_CHANGE')) {
        Alert.alert('تعذر التعديل', 'لا يمكنك تغيير دور حسابك الحالي');
      } else if (msg.includes('INVALID_DEPARTMENT')) {
        Alert.alert('خطأ', 'القسم المحدد غير موجود أو غير نشط');
      } else {
        Alert.alert('خطأ', 'تعذر تعديل الحساب');
      }
    } finally {
      setSavingEdit(false);
    }
  };

  const persistUserStatus = useCallback(async (item: UserRow, next: number) => {
    if (!user) return;

    setBusyUserId(item.id);

    try {
      const db = await getDb();

      await db.withTransactionAsync(async () => {
        await assertUserCan(db, user.id, 'users.manage');

        const target = await db.getFirstAsync<{ role: string; is_active: number }>(
          'SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?',
          [item.id]
        );

        if (!target) throw new Error('USER_NOT_FOUND');

        if (
          next === 0 &&
          normalizeRole(target.role) === 'admin' &&
          Number(target.is_active) === 1
        ) {
          const count = await db.getFirstAsync<{ count: number }>(
            `SELECT COUNT(*) AS count FROM users
             WHERE LOWER(role) = 'admin' AND COALESCE(is_active, 1) = 1`
          );

          if ((count?.count ?? 0) <= 1) throw new Error('LAST_ADMIN');
        }

        await db.runAsync(
          'UPDATE users SET is_active = ? WHERE id = ?',
          [next, item.id]
        );
      });

      await loadUsers();
      Alert.alert('تم التحديث', next ? 'تم تفعيل الحساب' : 'تم تعطيل الحساب');

    } catch (e) {
      const msg = String((e as Error)?.message ?? '');

      if (msg.includes('FORBIDDEN')) {
        Alert.alert('رفض العملية', 'يجب أن يكون حساب المدير نشطاً');
      } else if (msg.includes('LAST_ADMIN')) {
        Alert.alert('تعذر التعطيل', 'لا يمكن تعطيل آخر مدير نشط');
      } else {
        Alert.alert('خطأ', 'تعذر تغيير حالة الحساب');
      }
    } finally {
      setBusyUserId(null);
    }
  }, [user, loadUsers]);

  const toggleUserStatus = useCallback((item: UserRow) => {
    const next = Number(item.is_active) === 1 ? 0 : 1;

    if (item.id === user?.id && next === 0) {
      Alert.alert('تعذر التعطيل', 'لا يمكنك تعطيل الحساب المستخدم حالياً');
      return;
    }

    Alert.alert(
      next ? 'تأكيد التفعيل' : 'تأكيد التعطيل',
      next
        ? 'هل تريد تفعيل حساب «' + item.username + '»؟'
        : 'سيُمنع الحساب من تسجيل الدخول. هل تريد المتابعة؟',
      [
        { text: 'إلغاء', style: 'cancel' },
        {
          text: 'تأكيد',
          style: next ? 'default' : 'destructive',
          onPress: () => { void persistUserStatus(item, next); }
        }
      ]
    );
  }, [user?.id, persistUserStatus]);

  const submit = () => {
    if (saving) return;
    if (!user || !can(user.role, 'users.manage')) {
      setError('إنشاء المستخدمين من صلاحيات المدير فقط');
      return;
    }
    const name = username.trim();
    if (name.length < 3) {
      setError('اسم المستخدم يجب ألا يقل عن 3 أحرف');
      return;
    }
    if (name.includes(' ')) {
      setError('اسم المستخدم لا يجوز أن يحتوي مسافات');
      return;
    }
    if (password.length < 8) {
      setError('كلمة المرور يجب ألا تقل عن 8 أحرف');
      return;
    }
    if (password !== confirm) {
      setError('كلمتا المرور غير متطابقتين');
      return;
    }
    if (!role) {
      setError('اختر دور المستخدم');
      return;
    }
    setError('');
    const chosen = role;
    const pass = password;
    Alert.alert(
      'تأكيد إنشاء الحساب',
      'سيتم إنشاء الحساب «' + name + '» بدور «' + roleLabel(chosen) + '». هل تريد المتابعة؟',
      [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'تأكيد', onPress: () => persist(name, pass, chosen, departmentId) },
      ]
    );
  };

  /* ───── بيانات العرض ───── */
  const profile = useMemo(() => users.find((u) => u.id === profileId) ?? null, [users, profileId]);

  const stats = useMemo(() => {
    const active = users.filter((u) => Number(u.is_active) === 1);
    return {
      total: users.length,
      active: active.length,
      disabled: users.length - active.length,
      admins: active.filter((u) => normalizeRole(u.role) === 'admin').length,
    };
  }, [users]);

  const tiles: MiniStat[] = [
    { key: 't', label: 'إجمالي الحسابات', value: stats.total, color: Palette.blue, icon: Users },
    { key: 'a', label: 'حسابات نشطة', value: stats.active, color: Palette.green, icon: ShieldCheck },
    { key: 'd', label: 'حسابات معطّلة', value: stats.disabled, color: Palette.red, icon: Ban },
    { key: 'm', label: 'مدراء النظام النشطون', value: stats.admins, color: Palette.cyan, icon: KeyRound },
  ];

  const chips: ChipOpt<string>[] = useMemo(() => {
    const counts: Record<string, number> = {};
    users.forEach((u) => { const r = normalizeRole(u.role); if (r) counts[r] = (counts[r] ?? 0) + 1; });
    return [
      { key: 'all', label: 'الكل', count: users.length },
      ...ROLES.map((r) => ({ key: r.key as string, label: r.label, count: counts[r.key] ?? 0, color: ROLE_LOOK[r.key].color })),
    ];
  }, [users]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== 'all' && normalizeRole(u.role) !== roleFilter) return false;
      if (!q) return true;
      return u.username.toLowerCase().includes(q) ||
        (u.department_name ?? '').toLowerCase().includes(q) ||
        roleLabel(u.role).includes(q);
    });
  }, [users, query, roleFilter]);

  const openProfile = useCallback((u: UserRow) => setProfileId(u.id), []);
  const renderItem = useCallback(({ item, index }: { item: UserRow; index: number }) => (
    <View style={{ paddingHorizontal: 18, marginBottom: 12 }}>
      <UserCard item={item} index={index} isSelf={item.id === user?.id} busy={busyUserId === item.id}
        onOpen={openProfile} onEdit={openEdit} onToggle={toggleUserStatus} />
    </View>
  ), [user?.id, busyUserId, openProfile, openEdit, toggleUserStatus]);

  if (!isAdmin) {
    return (
      <Screen>
        <PageHeader title="إدارة المستخدمين" subtitle="الحسابات والأدوار والصلاحيات" icon={Users} color={Palette.purple} />
        <EmptyState icon={Lock} title="هذه الشاشة للمدير فقط" hint="لا تملك صلاحية إدارة الحسابات." color={Palette.red} />
      </Screen>
    );
  }

  const hasQuery = query.length > 0 || roleFilter !== 'all';
  const header = (
    <View>
      <StatStrip items={tiles} />
      <View style={{ paddingHorizontal: 18, marginTop: 12 }}>
        <View style={{ flexDirection: ROW, alignItems: 'center', gap: 10, padding: 12, borderRadius: 16, backgroundColor: tint(Palette.cyan, 0.07), borderWidth: 1, borderColor: tint(Palette.cyan, 0.3) }}>
          <ShieldCheck color={Palette.cyan} size={18} />
          <Text style={[Type.caption, { color: Colors.textSecondary, flex: 1, textAlign: 'right' }]}>
            قواعد الحماية: لا يُعطَّل آخر مدير نشط، ولا يغيّر المدير دور حسابه الحالي أو يعطّله.
          </Text>
        </View>
      </View>
      <SectionTitle title="الحسابات" hint={visible.length + ' من ' + users.length + ' حساباً'} top={20} />
    </View>
  );

  return (
    <Screen>
      <PageHeader title="إدارة المستخدمين" subtitle="الحسابات والأدوار والصلاحيات" icon={Users} color={Palette.purple}
        actions={<IconBtn icon={UserPlus} label="إضافة مستخدم" solid color={Palette.purple} onPress={openAdd} />} />
      <SearchField value={query} onChangeText={setQuery} placeholder="ابحث باسم المستخدم أو القسم أو الدور..." />
      <View style={{ height: 10 }} />
      <FilterChips options={chips} value={roleFilter} onChange={setRoleFilter} />
      <View style={{ height: 14 }} />

      {loading ? <ListSkeleton /> : failed ? (
        <View style={{ paddingHorizontal: 18 }}>
          <ErrorState message="تعذر تحميل قائمة المستخدمين." onRetry={() => { setLoading(true); void loadUsers(); }} />
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(u) => u.id}
          renderItem={renderItem}
          extraData={busyUserId}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 40, flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={6}
          windowSize={7}
          removeClippedSubviews
          ListEmptyComponent={
            <EmptyState
              icon={Users}
              color={Palette.purple}
              title={hasQuery ? 'لا توجد نتائج مطابقة' : 'لا يوجد مستخدمون'}
              hint={hasQuery ? 'جرّب تغيير كلمات البحث أو فلتر الدور.' : 'لا توجد بيانات متاحة حالياً.'}
              actionLabel={!hasQuery ? 'إضافة مستخدم' : undefined}
              onAction={!hasQuery ? openAdd : undefined}
            />
          }
        />
      )}

      <ProfileSheet
        item={profile}
        isSelf={!!profile && profile.id === user?.id}
        busy={!!profile && busyUserId === profile.id}
        onClose={() => setProfileId(null)}
        onEdit={openEditFromProfile}
        onToggle={toggleUserStatus}
      />

      {/* نافذة إضافة مستخدم */}
      <Sheet visible={showAdd} onClose={closeAdd} title="إضافة مستخدم" subtitle="الحقول المعلّمة بنجمة إلزامية"
        footer={<>
          <View style={{ flex: 1 }}><Btn label="إنشاء الحساب" icon={Check} onPress={submit} loading={saving} /></View>
          <Btn label="إلغاء" variant="ghost" onPress={closeAdd} disabled={saving} />
        </>}>
        <Field label="اسم المستخدم *" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false}
          placeholder="3 أحرف على الأقل" editable={!saving} />
        <Field label="كلمة المرور *" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false}
          placeholder="8 أحرف على الأقل" editable={!saving} />
        <Field label="تأكيد كلمة المرور *" value={confirm} onChangeText={setConfirm} secureTextEntry autoCapitalize="none" autoCorrect={false}
          placeholder="أعد كتابة كلمة المرور" editable={!saving} />
        <FieldLabel text="الدور *" />
        <RoleOptions value={role} onChange={setRole} />
        <FieldLabel text="القسم" />
        <DeptChips departments={departments} value={departmentId} onChange={setDepartmentId} />
        {error !== '' ? <ErrorBanner message={error} /> : null}
      </Sheet>

      {/* نافذة تعديل مستخدم */}
      <Sheet visible={showEdit} onClose={() => { if (!savingEdit) setShowEdit(false); }} title="تعديل الحساب" subtitle={editingUser?.username ?? ''}
        footer={<>
          <View style={{ flex: 1 }}><Btn label="حفظ التعديلات" icon={Check} onPress={saveEdit} loading={savingEdit} /></View>
          <Btn label="إلغاء" variant="ghost" onPress={() => setShowEdit(false)} disabled={savingEdit} />
        </>}>
        <FieldLabel text="الدور" />
        <RoleOptions value={editRole} onChange={setEditRole} lockAllButAdmin={editingUser?.id === user?.id} />
        <FieldLabel text="القسم" />
        <DeptChips departments={departments} value={editDepartmentId} onChange={setEditDepartmentId} />
      </Sheet>
    </Screen>
  );
}
