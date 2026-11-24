import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Stack, Tabs } from '../../shims/expo-router';
import { Home, FolderOpen, Users, FileText, Settings, UserPlus } from 'lucide-react-native';

// يحاكي src/app/(tabs)/_layout.tsx: role يحدد href (undefined = ظاهر، null = مخفي).
const role = new URLSearchParams(location.search).get('role') ?? 'admin';
const show = (tab: string) => (role === 'viewer' && (tab === 'users' || tab === 'memos') ? null : undefined);
const Icon = (C: any) => ({ color, focused }: any) => <div data-focused={String(focused)} style={{ width: 46, height: 28 }}><C color={color} size={21} /></div>;
function TabLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false, keepMe: 1, tabBarStyle: { height: 74 } }}>
      <Tabs.Screen name="index" options={{ title: 'الرئيسية', href: show('index'), tabBarIcon: Icon(Home) }} />
      <Tabs.Screen name="cases" options={{ title: 'القضايا', href: show('cases'), tabBarIcon: Icon(FolderOpen) }} />
      <Tabs.Screen name="detainees" options={{ title: 'المحتجزون', href: show('detainees'), tabBarIcon: Icon(Users) }} />
      <Tabs.Screen name="memos" options={{ title: 'المذكرات', href: show('memos'), tabBarIcon: Icon(FileText) }} />
      <Tabs.Screen name="users" options={{ title: 'المستخدمون', href: show('users'), tabBarIcon: Icon(UserPlus) }} />
      <Tabs.Screen name="audit" options={{ title: 'سجل التدقيق', href: null, tabBarIcon: Icon(Settings) }} />
      <Tabs.Screen name="settings" options={{ title: 'الإعدادات', href: show('settings'), tabBarIcon: Icon(Settings) }} />
    </Tabs>
  );
}
(window as any).__app = { tabsLayout: () => <TabLayout /> };
function Root() { return <div dir="rtl" style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}><div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}><Stack /></div></div>; }
createRoot(document.getElementById('root')!).render(<Root />);
