import React, { useEffect, useRef } from 'react';
import { Tabs, Redirect, useSegments, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Home, FolderOpen, Users, FileText, Settings, UserPlus, ShieldCheck } from 'lucide-react-native';
import { View, Animated, Easing } from 'react-native';
import { Colors, Palette, tint } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { canAccessTab, firstAllowedTab } from '@/security/permissions';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration'; // SECTION3

// SECURECASEDESK_SMOOTH_UI: تبويب نشط بانتقال ناعم (تلاشٍ + تكبير خفيف) بدل التبديل الفوري.
const SMOOTH_TABS = { animation: 'fade', tabBarHideOnKeyboard: true };

function TabIcon({ focused, children }: { focused: boolean; children: React.ReactNode }) {
  const v = useRef(new Animated.Value(focused ? 1 : 0)).current;
  useEffect(() => {
    const a = Animated.timing(v, { toValue: focused ? 1 : 0, duration: 260, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [focused, v]);
  return (
    <View style={{ width: 46, height: 28, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View pointerEvents="none" style={{
        position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 14,
        backgroundColor: tint(Palette.cyan, 0.14), borderWidth: 1, borderColor: tint(Palette.cyan, 0.4),
        shadowColor: Palette.cyan, shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 0 },
        opacity: v, transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }],
      }} />
      <Animated.View style={{ transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) }] }}>{children}</Animated.View>
    </View>
  );
}

export default function TabLayout() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const segments = useSegments() as unknown as string[];
  const role = user?.role;
  const insets = useSafeAreaInsets();

  // بعد تسجيل الخروج: الانتقال إلى شاشة الدخول يتم من هنا، بعد أن تصل حالة الخروج إلى الواجهة.
  useEffect(() => {
    if (!isLoading && !user) router.replace('/');
  }, [user, isLoading]);
  const currentTab = segments[0] === '(tabs)' ? (segments[1] ?? 'index') : null;

  // SECTION3: كل محاولة فتح تبويب غير مسموح تُسجَّل في سجل التدقيق قبل التحويل.
  useEffect(() => {
    if (user && currentTab && !canAccessTab(role, currentTab)) {
      void recordUnauthorizedAccess({
        userId: user.id,
        username: user.username,
        role: user.role,
        resource: 'tab:' + currentTab,
        detail: 'محاولة فتح شاشة غير مسموحة',
      });
    }
  }, [user?.id, currentTab, role]);

  // حماية الدخول المباشر: أي تبويب غير مصرح به يُحوَّل إلى أول تبويب مسموح.
  if (user && currentTab && !canAccessTab(role, currentTab)) {
    const target = firstAllowedTab(role);
    return <Redirect href={(target === 'index' ? '/' : '/' + target) as never} />;
  }

  const show = (tab: string) => (canAccessTab(role, tab) ? undefined : null);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        ...(SMOOTH_TABS as object),
        tabBarActiveTintColor: Palette.cyan,
        tabBarInactiveTintColor: Colors.textMuted,
        tabBarStyle: {
          backgroundColor: Palette.bg0,
          borderTopColor: Palette.glassBorder,
          borderTopWidth: 1,
          height: 74 + insets.bottom,
          paddingBottom: 10 + insets.bottom,
          paddingTop: 8,
          elevation: 12,
        },
        tabBarLabelStyle: {
          fontFamily: 'Cairo_500Medium',
          fontSize: 10.5,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'الرئيسية',
          href: show('index'),
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused}><Home color={color} size={21} /></TabIcon>,
        }}
      />
      <Tabs.Screen
        name="cases"
        options={{
          title: 'القضايا',
          href: show('cases'),
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused}><FolderOpen color={color} size={21} /></TabIcon>,
        }}
      />
      <Tabs.Screen
        name="detainees"
        options={{
          title: 'المحتجزون',
          href: show('detainees'),
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused}><Users color={color} size={21} /></TabIcon>,
        }}
      />
      <Tabs.Screen
        name="memos"
        options={{
          title: 'المذكرات',
          href: show('memos'),
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused}><FileText color={color} size={21} /></TabIcon>,
        }}
      />
      <Tabs.Screen
        name="users"
        options={{
          title: 'المستخدمون',
          href: show('users'),
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused}><UserPlus color={color} size={21} /></TabIcon>,
        }}
      />
      <Tabs.Screen
        name="audit"
        options={{
          title: 'سجل التدقيق',
          href: null, // UI_V3: يُفتح من الإعدادات (الأمان) ومن «عرض الكل» في اللوحة؛ الصلاحية تُفرض في الحارس أعلاه
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused}><ShieldCheck color={color} size={21} /></TabIcon>,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'الإعدادات',
          href: show('settings'),
          tabBarIcon: ({ color, focused }) => <TabIcon focused={focused}><Settings color={color} size={21} /></TabIcon>,
        }}
      />
    </Tabs>
  );
}
