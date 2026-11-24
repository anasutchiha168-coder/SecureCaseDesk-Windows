import * as React from 'react';
import { View } from './rn';
// موجّه مصغّر يحاكي واجهة expo-router المستعملة في src: useSegments/useRouter/Stack/Tabs(+Screen).
let segments: string[] = [];
const subs = new Set<() => void>();
const set = (s: string[]) => { segments = s; subs.forEach((f) => f()); };
export const parseRoute = (r: string) => r.split('/').filter(Boolean);
(window as any).__go = (r: string) => set(parseRoute(r));
export function useSegments() { return React.useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => segments); }
export function useRouter() { return React.useMemo(() => ({ navigate: (r: string) => set(parseRoute(r)), replace: (r: string) => set(parseRoute(r)), push: (r: string) => set(parseRoute(r)) }), []); }
const Screen = (_: any) => null;
// Stack الحقيقي يُبقي شاشة (tabs) مركّبة تحت الشاشات المدفوعة؛ نحاكي ذلك: تُركَّب عند أول زيارة وتُخفى بدل أن تُزال.
export function Stack({ children, screenOptions }: any) {
  const segs = useSegments();
  const visited = React.useRef(false);
  if (segs[0] === '(tabs)') visited.current = true;
  const onTabs = segs[0] === '(tabs)';
  return (
    <View style={{ flex: 1, backgroundColor: '#0B1120' }} data-name="stack">
      {(window as any).__app?.tabsLayout && visited.current ? <View style={{ flex: onTabs ? 1 : 0, display: onTabs ? 'flex' : 'none' } as any}>{(window as any).__app.tabsLayout()}</View> : null}
      {!onTabs ? <View style={{ flex: 1, padding: 12, backgroundColor: '#123' }} data-name="plain-screen">{'screen:' + (segs.join('/') || '/')}</View> : null}
    </View>
  );
}
Stack.Screen = Screen;
export function Tabs({ children, screenOptions, tabBar }: any) {
  const segs = useSegments();
  const active = segs[1] ?? 'index';
  const so = typeof screenOptions === 'function' ? screenOptions({}) : screenOptions;
  return (
    <View style={{ flex: 1, backgroundColor: '#145' }} data-name="tabs">
      <View style={{ height: 0 } as any} data-name="tabs-meta">{JSON.stringify({ tabBarDisplay: so?.tabBarStyle?.display, customTabBar: typeof tabBar === 'function' ? !!tabBar() === false : null, keepsOwn: so?.keepMe })}</View>
      <View style={{ flex: 1, padding: 12 }} data-name="tab-screen">{'tab:' + active}</View>
    </View>
  );
}
Tabs.Screen = Screen;
