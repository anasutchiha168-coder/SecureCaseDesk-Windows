// SECURECASEDESK_UI_V2 — لوحة التحكم الجديدة. المنطق والصلاحيات كما كانت؛ التغيير في العرض فقط.
import React, { useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  FolderOpen, Users, FileText, AlertTriangle, LogOut, UserPlus, UserMinus, FolderPlus, UserRoundPlus,
  FilePlus2, Search, BarChart3, ShieldCheck, WifiOff,
} from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { Colors, Palette, Type, tint, Glow } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { can, roleLabel } from '@/security/permissions';
import { ForbiddenError, type Session } from '@/security/guard';
import { getDashboardStats, getDashboardTrends, weekOverWeek, type DashboardStats, type DashboardTrends } from '@/services/stats.service';
import { getAuditLogs, type AuditLogRow } from '@/services/audit.service';
import { listAvailableReports } from '@/services/reports.service';
import { StatCard } from '@/components/ui/StatCard';
import { FadeIn, PressableScale } from '@/components/ui/Motion';
import { SkeletonStatCard, Skeleton } from '@/components/ui/Skeleton';
import { ErrorState, EmptyState } from '@/components/ui/States';
import { GradientFill } from '@/components/ui/Gradient';
import { SectionTitle } from '@/components/ui/Kit';
import { HeroCard } from '@/components/dashboard/HeroCard';
import { ActivityFeed } from '@/components/dashboard/ActivityFeed';

interface Tile { key: string; label: string; value: number; icon: React.ElementType; color: string; series: number[] | null; pct: number | null; zeroHint: string; route?: string }
interface Action { key: string; label: string; icon: React.ElementType; color: string; route: string }


export default function DashboardScreen() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const session = useMemo<Session | null>(() => (user ? { userId: user.id, role: user.role } : null), [user?.id, user?.role]);
  const role = user?.role;
  const canCases = can(role, 'cases.view');
  const canMemos = can(role, 'memos.view');
  const canDet = can(role, 'detainees.view');
  const canAudit = can(role, 'audit.view');

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [trends, setTrends] = useState<DashboardTrends | null>(null);
  const [activity, setActivity] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const [s, t] = await Promise.all([getDashboardStats(session), getDashboardTrends(session)]);
      if (!alive.current) return;
      setStats(s); setTrends(t); setFailed(false);
    } catch (e) {
      if (!alive.current) return;
      setStats(null); setTrends(null); // لا نُبقي أرقام جلسة سابقة
      if (!(e instanceof ForbiddenError)) { console.error('[dashboard] load error:', e); setFailed(true); }
    }
    if (canAudit && user) {
      try { const rows = await getAuditLogs(user.id, { limit: 6 }); if (alive.current) setActivity(rows); }
      catch { if (alive.current) setActivity([]); }
    } else setActivity([]);
  }, [session, canAudit, user?.id]);

  useFocusEffect(useCallback(() => {
    alive.current = true;
    setLoading(true);
    load().finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
  }, [load]));

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const tiles: Tile[] = [];
  if (canCases) tiles.push({ key: 'open', label: 'قضايا مفتوحة', value: stats?.cases?.open ?? 0, icon: FolderOpen, color: Palette.blue, series: trends?.casesCreated ?? null, pct: weekOverWeek(trends?.casesCreated), zeroHint: 'لا توجد قضايا مفتوحة', route: '/(tabs)/cases' });
  if (canDet) tiles.push({ key: 'det', label: 'محتجزون حالياً', value: stats?.detainees?.current ?? 0, icon: Users, color: Palette.green, series: trends?.admissions ?? null, pct: weekOverWeek(trends?.admissions), zeroHint: 'لا يوجد محتجزون حالياً', route: '/(tabs)/detainees' });
  if (canMemos) tiles.push({ key: 'memo', label: 'مذكرات نشطة', value: stats?.memos?.active ?? 0, icon: FileText, color: Palette.gold, series: trends?.memosCreated ?? null, pct: weekOverWeek(trends?.memosCreated), zeroHint: 'لا توجد مذكرات نشطة', route: '/(tabs)/memos' });
  if (canCases) tiles.push({ key: 'inv', label: 'قضايا قيد التحقيق', value: stats?.cases?.underInvestigation ?? 0, icon: AlertTriangle, color: Palette.red, series: null, pct: null, zeroHint: 'لا توجد قضايا قيد التحقيق', route: '/(tabs)/cases' });
  if (canDet) tiles.push({ key: 'adm', label: 'إيداعات اليوم', value: stats?.detainees?.admissionsToday ?? 0, icon: UserPlus, color: Palette.cyan, series: trends?.admissions ?? null, pct: null, zeroHint: 'لا إيداعات اليوم', route: '/(tabs)/detainees' });
  if (canDet) tiles.push({ key: 'rel', label: 'إفراجات اليوم', value: stats?.detainees?.releasesToday ?? 0, icon: UserMinus, color: Palette.purple, series: trends?.releases ?? null, pct: null, zeroHint: 'لا إفراجات اليوم', route: '/(tabs)/detainees' });

  // الإجراءات السريعة تفتح الوحدة المعنيّة (نماذج الإنشاء داخل الشاشات نفسها)، وتُعرض فقط لمن يملك الصلاحية.
  const hasReports = useMemo(() => { try { return listAvailableReports(session).length > 0; } catch { return false; } }, [session]);
  const actions: Action[] = [];
  if (can(role, 'cases.manage')) actions.push({ key: 'c', label: 'إضافة قضية', icon: FolderPlus, color: Palette.blue, route: '/(tabs)/cases' });
  if (can(role, 'detainees.manage')) actions.push({ key: 'd', label: 'تسجيل محتجز', icon: UserRoundPlus, color: Palette.green, route: '/(tabs)/detainees' });
  if (can(role, 'memos.manage')) actions.push({ key: 'm', label: 'إنشاء مذكرة', icon: FilePlus2, color: Palette.gold, route: '/(tabs)/memos' });
  if (can(role, 'ai.use')) actions.push({ key: 's', label: 'البحث الذكي', icon: Search, color: Palette.cyan, route: '/ai-search' });
  if (can(role, 'users.manage')) actions.push({ key: 'u', label: 'إضافة مستخدم', icon: UserPlus, color: Palette.purple, route: '/(tabs)/users' });
  if (hasReports) actions.push({ key: 'r', label: 'إنشاء تقرير', icon: BarChart3, color: Palette.red, route: '/reports' });

  const today = new Date().toLocaleDateString('ar-YE', { weekday: 'long', day: 'numeric', month: 'long' });
  const initial = (user?.username ?? '؟').trim().charAt(0);
  const go = (r: string) => router.push(r as never);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <GradientFill colors={[Palette.bg0, Palette.bg1, Palette.bg2]} glow={{ color: Palette.blue, opacity: 0.12, cx: '100%', cy: '0%', r: '80%' }} />
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Palette.cyan} colors={[Palette.cyan]} progressBackgroundColor={Palette.surface} />}>

        <FadeIn>
          <View style={s.header}>
            <View style={[s.avatar, Glow(Palette.blue)]}>
              <GradientFill colors={[Palette.blue, Palette.purple]} />
              <Text style={[Type.h2, { color: '#fff' }]}>{initial}</Text>
            </View>
            <View style={{ flex: 1, paddingHorizontal: 12 }}>
              <Text style={[Type.caption, { color: Palette.cyan, textAlign: 'right' }]}>SecureCaseDesk • نظام إدارة القضايا والاحتجاز</Text>
              <Text style={[Type.h2, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={1}>{user?.username ?? '—'}</Text>
              <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8, marginTop: 2 }}>
                <View style={s.rolePill}><Text style={[Type.caption, { color: Palette.blue, fontFamily: 'Cairo_700Bold' }]}>{roleLabel(role)}</Text></View>
                <View style={{ flexDirection: ROW, alignItems: 'center', gap: 4 }}>
                  <View style={s.liveDot} /><Text style={[Type.caption, { color: Colors.textMuted }]}>جلسة مؤمّنة</Text>
                </View>
              </View>
            </View>
            <PressableScale onPress={() => { void logout(); }} accessibilityRole="button" accessibilityLabel="تسجيل الخروج" style={s.logout}>
              <LogOut color={Palette.red} size={19} />
            </PressableScale>
          </View>
          <View style={{ flexDirection: ROW, justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
            <Text style={[Type.caption, { color: Colors.textMuted }]}>{today}</Text>
            <View style={s.modePill}>
              <WifiOff color={Palette.gold} size={12} />
              <Text style={[Type.caption, { color: Palette.gold }]}>وضع التشغيل المحلي • لا مزامنة</Text>
            </View>
          </View>
        </FadeIn>

        <FadeIn delay={80} style={{ marginTop: 16 }}><HeroCard name={'أهلاً ' + (user?.username ?? '')} /></FadeIn>

        <SectionTitle title="نظرة عامة" hint="آخر 7 أيام مقابل الأسبوع السابق عند توفر بيانات للمقارنة" />
        {failed ? <ErrorState onRetry={() => { setLoading(true); load().finally(() => setLoading(false)); }} /> : loading && !stats ? (
          <View style={s.grid}>{[0, 1, 2, 3].map((i) => <SkeletonStatCard key={i} />)}</View>
        ) : tiles.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="لا توجد إحصائيات متاحة لدورك" hint="الإحصائيات تُعرض وفق صلاحياتك." />
        ) : (
          <View style={s.grid}>
            {tiles.map((t, i) => (
              <FadeIn key={t.key} delay={120 + i * 60} style={s.cell}>
                <StatCard label={t.label} value={t.value} icon={t.icon} color={t.color} series={t.series} changePct={t.pct} zeroHint={t.zeroHint} onPress={t.route ? () => go(t.route as string) : undefined} />
              </FadeIn>
            ))}
          </View>
        )}

        {actions.length > 0 ? (
          <>
            <SectionTitle title="الإجراءات السريعة" />
            <View style={s.grid}>
              {actions.map((a) => (
                <View key={a.key} style={s.cell}>
                  <PressableScale onPress={() => go(a.route)} accessibilityRole="button" accessibilityLabel={a.label} style={s.action}>
                    <View style={[s.actIcon, { backgroundColor: tint(a.color, 0.15), borderColor: tint(a.color, 0.4) }]}><a.icon color={a.color} size={22} /></View>
                    <Text style={[Type.h3, { color: Colors.textPrimary, flex: 1, textAlign: 'right' }]} numberOfLines={1}>{a.label}</Text>
                  </PressableScale>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {canAudit ? (
          <>
            <SectionTitle title="آخر الأنشطة" hint="من سجل التدقيق المحمي"
              action={<PressableScale onPress={() => go('/(tabs)/audit')} accessibilityRole="button" accessibilityLabel="عرض كل الأنشطة"><Text style={[Type.h3, { color: Palette.cyan }]}>عرض الكل</Text></PressableScale>} />
            {loading && activity.length === 0 ? (
              <View style={{ gap: 10 }}><Skeleton height={54} radius={16} /><Skeleton height={54} radius={16} /><Skeleton height={54} radius={16} /></View>
            ) : <FadeIn delay={200}><ActivityFeed rows={activity} /></FadeIn>}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Palette.bg1 },
  scroll: { paddingHorizontal: 18, paddingBottom: 36, paddingTop: 10 },
  header: { flexDirection: ROW, alignItems: 'center' },
  avatar: { width: 52, height: 52, borderRadius: 18, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  rolePill: { paddingHorizontal: 9, paddingVertical: 1, borderRadius: 999, backgroundColor: tint(Palette.blue, 0.14), borderWidth: 1, borderColor: tint(Palette.blue, 0.4) },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Palette.green },
  logout: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(Palette.red, 0.1), borderWidth: 1, borderColor: tint(Palette.red, 0.35) },
  modePill: { flexDirection: ROW, alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 2, borderRadius: 999, backgroundColor: tint(Palette.gold, 0.1), borderWidth: 1, borderColor: tint(Palette.gold, 0.3) },
  grid: { flexDirection: ROW, flexWrap: 'wrap', justifyContent: 'space-between' },
  cell: { width: '48.5%', marginBottom: 12 },
  action: { flexDirection: ROW, alignItems: 'center', gap: 10, padding: 12, borderRadius: 18, backgroundColor: Palette.surface, borderWidth: 1, borderColor: Palette.glassBorder },
  actIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
});
