// SECURECASEDESK_PHASE9_S3 + SECURECASEDESK_UI_V3 — الإعدادات مقسّمة إلى أقسام ببطاقات.
// كل الإجراءات والصلاحيات كما كانت (الذكاء الاصطناعي، فحص الأمان، التقارير، أدوات الفحص، تسجيل الخروج).
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Alert, Pressable, ActivityIndicator, Linking, Switch } from 'react-native';
import { runProtectionTest } from '@/security/protection-test';
import { runAuditProtectionTest } from '@/security/audit-protection-test';
import {
  LogOut, FileText, Sparkles, Search, ListChecks, ShieldCheck, ChevronLeft, UserRound, Building2, Lock, Database, KeyRound,
  ScrollText, Palette as PaletteIcon, Languages, WifiOff, Info, FlaskConical, BarChart3, Eye, HardDriveDownload,
  Mail, Copyright, Fingerprint,
} from 'lucide-react-native'; // SECURECASEDESK_PHASE11_S1
import { router } from 'expo-router'; // SECURECASEDESK_PHASE9_S3
import { useAuth } from '@/context/AuthContext';
import { inspectDatabaseEncryption } from '@/database/db';
import { Colors, Palette as Pal, Type, tint } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { roleLabel, can, canAccessTab } from '@/security/permissions';
import { Screen, PageHeader, Card, Pill, SectionTitle } from '@/components/ui/Kit';
import { GradientFill } from '@/components/ui/Gradient';
import { FadeIn, PressableScale } from '@/components/ui/Motion';

/* ───────────── مكونات الأقسام ───────────── */
interface RowProps {
  icon: React.ElementType; title: string; subtitle?: string; color?: string;
  onPress?: () => void; busy?: boolean; trailing?: React.ReactNode; last?: boolean;
}
function SettingRow({ icon: Icon, title, subtitle, color = Pal.cyan, onPress, busy, trailing, last }: RowProps) {
  const body = (
    <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: 'rgba(148,163,255,0.08)' }}>
      <View style={{ width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(color, 0.14), borderWidth: 1, borderColor: tint(color, 0.38) }}>
        <Icon color={color} size={19} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={2}>{title}</Text>
        {subtitle ? <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {busy ? <ActivityIndicator color={color} /> : trailing ?? (onPress ? <ChevronLeft color={Colors.textMuted} size={18} /> : null)}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} disabled={busy} accessibilityRole="button" accessibilityLabel={title}
      style={({ pressed }) => [pressed && { opacity: 0.7 }, busy && { opacity: 0.8 }]}>{body}</Pressable>
  );
}

// آخر صف مرئي في كل مجموعة بلا خط فاصل (يُحسب تلقائياً حتى لو أُخفيت صفوف بالصلاحيات).
function Group({ title, hint, children, delay = 0 }: { title: string; hint?: string; children: React.ReactNode; delay?: number }) {
  const kids = React.Children.toArray(children);
  const lastRow = kids.map((k) => React.isValidElement(k) && k.type === SettingRow).lastIndexOf(true);
  return (
    <FadeIn delay={delay}>
      <SectionTitle title={title} hint={hint} top={20} />
      <Card style={{ paddingVertical: 4, paddingHorizontal: 14 }}>
        {kids.map((k, i) => (React.isValidElement(k) && k.type === SettingRow ? React.cloneElement(k as React.ReactElement<RowProps>, { last: i === lastRow }) : k))}
      </Card>
    </FadeIn>
  );
}

// بيانات المطوّر والحقوق (SECURECASEDESK_DEV_CREDITS)
const DEV = {
  version: 'v2.2',
  developer: 'Anas obali',
  email: 'obalians83@gmail.com',
  rights: 'جميع الحقوق محفوظة © 2026 Anas obali',
} as const;

const TAB_NAMES: Record<string, string> = {
  index: 'الرئيسية', cases: 'القضايا', detainees: 'المحتجزون', memos: 'المذكرات', users: 'المستخدمون', audit: 'سجل التدقيق', settings: 'الإعدادات',
};

export default function SettingsScreen() {
  const { user, logout, getBiometricState, enableBiometric, disableBiometric } = useAuth();
  const role = user?.role;
  const [testing, setTesting] = useState(false);
  const [encryptionTesting, setEncryptionTesting] = useState(false);
  const [auditTesting, setAuditTesting] = useState(false);

  // SECURECASEDESK_BIOMETRIC
  const [bio, setBio] = useState<{ available: boolean; reason: string | null; enrolledUserId: string | null }>({ available: false, reason: null, enrolledUserId: null });
  const [bioBusy, setBioBusy] = useState(false);
  const refreshBio = useCallback(async () => { try { setBio(await getBiometricState()); } catch { /* يبقى غير متاح */ } }, [getBiometricState]);
  useEffect(() => { refreshBio(); }, [refreshBio]);
  const bioOnForMe = !!user && bio.enrolledUserId === user.id;
  const bioOnForOther = !!bio.enrolledUserId && !bioOnForMe;

  const toggleBio = async (next: boolean) => {
    if (bioBusy) return;
    setBioBusy(true);
    try {
      if (next) {
        const r = await enableBiometric();
        if (!r.success && r.error) Alert.alert('الدخول بالبصمة', r.error);
      } else {
        await disableBiometric();
      }
    } finally {
      await refreshBio();
      setBioBusy(false);
    }
  };

  const runTest = async () => {
    if (testing || !user) return;
    setTesting(true);
    try {
      const report = await runProtectionTest(user.id);
      Alert.alert('نتيجة فحص الحماية', report);
    } catch (e) {
      console.error('[ProtectionTest] error:', e);
      Alert.alert('خطأ', 'تعذر تنفيذ الفحص');
    } finally {
      setTesting(false);
    }
  };

  const runEncryptionTest = async () => {
    if (encryptionTesting) return;
    setEncryptionTesting(true);
    try {
      const result = await inspectDatabaseEncryption();
      const lines = [
        'إصدار SQLCipher: ' + result.cipherVersion,
        'حجم ملف القاعدة: ' + result.fileSize + ' بايت',
        'قراءة بنية القاعدة بالمفتاح الحالي: ناجحة',
      ];
      if (!result.headerReadable) {
        lines.push('تعذر قراءة التوقيع كاملاً. لا يمكن إصدار نتيجة عن رأس الملف.');
      } else if (result.sqliteHeaderDetected) {
        lines.push('تحذير: ظهر توقيع SQLite العادي. الملف الذي فُحص لا يظهر كرأس قاعدة SQLCipher مشفرة.');
      } else {
        lines.push('لم يظهر توقيع SQLite العادي. النتيجة متوافقة مع وجود التشفير، لكنها مؤشر أولي وليست إثباتاً نهائياً مستقلاً.');
      }
      Alert.alert('نتيجة فحص تشفير قاعدة البيانات', lines.join('\n'));
    } catch (e) {
      Alert.alert('تعذر فحص التشفير', 'لم يكتمل الفحص. تحقق من توفر SQLCipher وإمكانية قراءة ملف قاعدة البيانات.');
    } finally {
      setEncryptionTesting(false);
    }
  };

  const runAuditTest = async () => {
    if (auditTesting || !user) return;
    setAuditTesting(true);
    try {
      const report = await runAuditProtectionTest(user.id);
      Alert.alert('نتيجة فحص سجل التدقيق', report);
    } catch (e) {
      console.error('[AuditProtectionTest] error:', e);
      Alert.alert('خطأ', 'تعذر تنفيذ فحص سجل التدقيق');
    } finally {
      setAuditTesting(false);
    }
  };

  const confirmLogout = () => {
    Alert.alert('تسجيل الخروج', 'هل تريد تسجيل الخروج من الحساب؟', [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'تسجيل الخروج', style: 'destructive', onPress: async () => { await logout(); } },
    ]);
  };

  const go = (r: string) => router.push(r as never);
  const initial = (user?.username ?? '؟').trim().charAt(0);
  const tabs = Object.keys(TAB_NAMES).filter((t) => canAccessTab(role, t));
  const aiUse = can(role, 'ai.use');
  const aiManage = can(role, 'ai.manage');
  const showAi = aiUse || aiManage;
  const showSecurity = can(role, 'audit.view') || can(role, 'audit.verify');

  return (
    <Screen>
      <PageHeader title="الإعدادات" subtitle="الحساب والأمان وأدوات النظام" icon={PaletteIcon} color={Pal.purple} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

        {/* الحساب */}
        <FadeIn>
          <View style={{ borderRadius: 26, padding: 18, overflow: 'hidden', borderWidth: 1, borderColor: Pal.glassBorder }}>
            <GradientFill colors={['#13224A', '#0D1633', '#0A1128']} glow={{ color: Pal.blue, opacity: 0.35, cx: '90%', cy: '10%', r: '70%' }} />
            <View style={{ flexDirection: ROW, alignItems: 'center', gap: 14 }}>
              <View style={{ width: 62, height: 62, borderRadius: 21, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                <GradientFill colors={[Pal.blue, Pal.purple]} />
                <Text style={[Type.h1, { color: '#fff' }]}>{initial}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[Type.h1, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={1}>{user?.username ?? '—'}</Text>
                <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8, marginTop: 2 }}>
                  <Pill label={roleLabel(role)} color={Pal.blue} icon={KeyRound} />
                  <Pill label="جلسة مؤمّنة" color={Pal.green} />
                </View>
              </View>
            </View>
            <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8, marginTop: 14 }}>
              <Building2 color={Colors.textMuted} size={14} />
              <Text style={[Type.caption, { color: Colors.textSecondary, flex: 1, textAlign: 'right' }]}>وزارة الداخلية - إدارة المباحث الجنائية - م/ حجة</Text>
            </View>
          </View>
        </FadeIn>

        {/* الصلاحيات */}
        <Group title="الصلاحيات" hint="الوحدات المتاحة لدورك الوظيفي" delay={60}>
          <View style={{ flexDirection: ROW, flexWrap: 'wrap', gap: 8, paddingVertical: 12 }}>
            {tabs.map((t) => <Pill key={t} label={TAB_NAMES[t]} color={Pal.cyan} />)}
          </View>
        </Group>

        {/* الأمان */}
        <Group title="الأمان" hint="حماية البيانات وسلامة السجلات" delay={90}>
          <SettingRow icon={Lock} title="قاعدة بيانات مشفّرة" subtitle="التخزين المحلي محمي بتشفير SQLCipher" color={Pal.green}
            trailing={<Pill label="مفعّل" color={Pal.green} />} last={!showSecurity} />
          <SettingRow icon={Fingerprint} title="الدخول بالبصمة"
            subtitle={!bio.available ? (bio.reason ?? 'غير متاح على هذا الجهاز')
              : bioOnForOther ? 'مفعّلة حالياً لحساب آخر على هذا الجهاز. تفعيلها هنا سيستبدلها'
              : 'استخدم بصمتك بدل كتابة كلمة المرور'}
            color={Pal.purple} busy={bioBusy}
            trailing={<Switch value={bioOnForMe} onValueChange={toggleBio} disabled={!bio.available || bioBusy} />} />
          {can(role, 'audit.view') ? (
            <SettingRow icon={ScrollText} title="سجل التدقيق" subtitle="مراقبة العمليات وسلامة السلسلة" color={Pal.cyan} onPress={() => go('/(tabs)/audit')} last={!can(role, 'audit.verify')} />
          ) : null}
          {can(role, 'audit.verify') ? (
            <SettingRow icon={ShieldCheck} title="فحص الأمان على الجهاز" subtitle="تشخيص حماية الجهاز والمفاتيح" color={Pal.cyan} onPress={() => go('/security-check')} last /> // SECURECASEDESK_PHASE12_S2
          ) : null}
        </Group>

        {/* الذكاء الاصطناعي */}
        {showAi ? (
          <Group title="الذكاء الاصطناعي" hint="اختياري ويخضع للصلاحيات والخصوصية" delay={120}>
            {aiUse ? <SettingRow icon={Search} title="البحث الذكي" color={Pal.cyan} onPress={() => go('/ai-search')} /> : null /* SECURECASEDESK_PHASE11_S2 */}
            {aiUse ? <SettingRow icon={ListChecks} title="التلخيص الذكي" color={Pal.cyan} onPress={() => go('/ai-summary')} /> : null /* SECURECASEDESK_PHASE11_S3 */}
            {aiUse && can(role, 'memos.view') ? <SettingRow icon={FileText} title="المساعد في صياغة المستندات" color={Pal.gold} onPress={() => go('/ai-drafting')} /> : null /* SECURECASEDESK_PHASE11_S4 */}
            {aiManage ? <SettingRow icon={Sparkles} title="إعدادات الذكاء الاصطناعي" color={Pal.purple} onPress={() => go('/ai-settings')} /> : null}
            {aiManage ? <SettingRow icon={Eye} title="فحص خصوصية الذكاء الاصطناعي" color={Pal.purple} onPress={() => go('/ai-privacy')} last /> : null /* SECURECASEDESK_PHASE11_S5 */}
          </Group>
        ) : null}

        {/* التقارير */}
        {can(role, 'dashboard.view') ? (
          <Group title="التقارير" hint="تقارير ومستندات عربية للطباعة والمشاركة" delay={150}>
            <SettingRow icon={BarChart3} title="التقارير والمستندات" subtitle="PDF و DOCX وطباعة" color={Pal.red} onPress={() => go('/reports')} last />
          </Group>
        ) : null}

        {/* قاعدة البيانات والنظام والمظهر */}
        <Group title="النظام" hint="معلومات التشغيل والمظهر" delay={180}>
          <SettingRow icon={Database} title="التخزين" subtitle="محلي على الجهاز دون خادم" color={Pal.blue} />
          <SettingRow icon={WifiOff} title="وضع التشغيل" subtitle="يعمل دون اتصال • المزامنة غير مفعّلة" color={Pal.gold} />
          <SettingRow icon={Languages} title="اللغة والاتجاه" subtitle="العربية • من اليمين إلى اليسار" color={Pal.cyan} />
          <SettingRow icon={PaletteIcon} title="المظهر" subtitle="داكن مؤسسي" color={Pal.purple} last />
        </Group>

        {/* أدوات الفحص */}
        {can(role, 'users.manage') ? (
          <Group title="أدوات الفحص" hint="للمدير فقط • مؤقتة" delay={210}>
            <SettingRow icon={HardDriveDownload} title={encryptionTesting ? 'جارٍ فحص تشفير القاعدة...' : 'فحص تشفير قاعدة البيانات'} color={Pal.gold} onPress={runEncryptionTest} busy={encryptionTesting} />
            <SettingRow icon={FlaskConical} title={testing ? 'جارٍ الفحص...' : 'فحص حماية السجلات'} color={Pal.gold} onPress={runTest} busy={testing} />
            <SettingRow icon={ShieldCheck} title={auditTesting ? 'جارٍ فحص سجل التدقيق...' : 'فحص إنشاء وحماية سجل التدقيق'} color={Pal.gold} onPress={runAuditTest} busy={auditTesting} last />
          </Group>
        ) : null}

        {/* حول التطبيق */}
        <Group title="حول التطبيق" delay={240}>
<SettingRow icon={Info} title="الإصدار" subtitle={DEV.version} color={Pal.blue} />
<SettingRow icon={UserRound} title="المطوّر" subtitle={DEV.developer} color={Pal.cyan} />
<SettingRow icon={Copyright} title="الحقوق" subtitle={DEV.rights} color={Pal.gold} />
<SettingRow icon={Mail} title="البريد الإلكتروني" subtitle={DEV.email} color={Pal.green}
  onPress={() => { Linking.openURL('mailto:' + DEV.email).catch(() => Alert.alert('تعذر فتح البريد', DEV.email)); }} last />
        </Group>

        <FadeIn delay={270}>
          <PressableScale onPress={confirmLogout} accessibilityRole="button" accessibilityLabel="تسجيل الخروج"
            style={{ marginTop: 24, flexDirection: ROW, alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 16, backgroundColor: tint(Pal.red, 0.1), borderWidth: 1, borderColor: tint(Pal.red, 0.45) }}>
            <LogOut color={Pal.red} size={20} />
            <Text style={[Type.h3, { color: Pal.red }]}>تسجيل الخروج</Text>
          </PressableScale>
        </FadeIn>
      </ScrollView>
    </Screen>
  );
}
