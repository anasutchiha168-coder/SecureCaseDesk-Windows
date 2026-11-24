// Shim لوحدة 'expo-router' على Windows (القسم 4). يُستخدم فقط عند platform=web وSCD_TARGET=windows (metro-alias.cjs).
// كل شيء يمرّ من expo-router الحقيقي كما هو؛ نستبدل فقط:
//   Stack ← يُلفّ بغلاف سطح المكتب (قائمة جانبية يمين + عمود محتوى مُوسَّط) بدل تصميم الهاتف.
//   Tabs  ← يخفي شريط التبويبات السفلي وينشر عناصره (العنوان/الأيقونة/الصلاحية) إلى القائمة الجانبية.
// لا نعدّل src: التبويبات والصلاحيات (href: null) تبقى كما قرّرها src/app/(tabs)/_layout.tsx،
// والقائمة الجانبية تقرأ نتيجتها فقط. يستورد الحزمة الحقيقية لأن metro-alias يستثني ملف الـ shim نفسه.
import * as React from 'react';
import * as Real from 'expo-router';
import { DesktopShell } from './desktop-shell';
import { deriveNavItems } from './desktop-layout-core';
import { getNavStore, type NavEntry } from './desktop-nav-store';

export * from 'expo-router';

const R = Real as any;
const RealStack: any = R.Stack;
const RealTabs: any = R.Tabs;

// علامة يقرؤها فحص البناء الثابت وفحص Electron الدخاني.
(globalThis as any).__SCD_DESKTOP__ = (globalThis as any).__SCD_DESKTOP__ ?? { shell: 1, section: 4, state: null };

// يمنع لفّ الغلاف مرتين إن وُجد Stack متداخل.
const ShellFlag = React.createContext(false);

function ShellHost({ children }: { children?: React.ReactNode }) {
  const segments = R.useSegments() as string[];
  const router = R.useRouter();
  const go = React.useCallback((route: string) => {
    try { router.navigate(route); } catch (e) { console.error('[desktop-shell] تعذّر الانتقال إلى ' + route, e); }
  }, [router]);
  return <DesktopShell segments={segments} onNavigate={go}>{children}</DesktopShell>;
}

function ScdStackImpl(props: any) {
  const inShell = React.useContext(ShellFlag);
  const el = <RealStack {...props} />;
  if (inShell) return el;
  return (
    <ShellFlag.Provider value={true}>
      <ShellHost>{el}</ShellHost>
    </ShellFlag.Provider>
  );
}
export const Stack = Object.assign(ScdStackImpl, { Screen: RealStack.Screen });

/** يجمع عناصر القائمة من أبناء <Tabs>: عناصر Tabs.Screen (name + options.title/href/tabBarIcon). */
function collectEntries(children: React.ReactNode): NavEntry[] {
  const screens = React.Children.toArray(children).map((c: any) =>
    c && c.props ? { name: c.props.name, options: c.props.options } : null);
  return deriveNavItems(screens).map((item) => {
    const o = (screens.find((s) => s && s.name === item.name)?.options ?? {}) as { tabBarIcon?: unknown };
    return { ...item, icon: typeof o.tabBarIcon === 'function' ? (o.tabBarIcon as NavEntry['icon']) : undefined };
  });
}

const HIDE_TAB_BAR = Object.freeze({ tabBarStyle: { display: 'none' } });
const NO_TAB_BAR = () => null;

function ScdTabsImpl({ screenOptions, children, tabBar, ...rest }: any) {
  const entries = collectEntries(children);
  const store = getNavStore();
  // كل رسم: نفس الأسماء/العناوين ⇒ تحديث صامت للأيقونات؛ تغيّر الصلاحيات ⇒ إشعار القائمة.
  React.useEffect(() => { store.set(entries); });
  React.useEffect(() => () => store.clear(), [store]);
  const merged = typeof screenOptions === 'function'
    ? (p: unknown) => ({ ...screenOptions(p), ...HIDE_TAB_BAR })
    : { ...(screenOptions ?? {}), ...HIDE_TAB_BAR };
  return <RealTabs {...rest} tabBar={NO_TAB_BAR} screenOptions={merged}>{children}</RealTabs>;
}
export const Tabs = Object.assign(ScdTabsImpl, { Screen: RealTabs.Screen });
