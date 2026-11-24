// غلاف سطح المكتب (القسم 4): قائمة جانبية على اليمين (RTL) بدل شريط التبويبات السفلي، وعمود محتوى مُوسَّط بعرض محدود.
// يُرسم فوق Stack الجذري من shims/expo-router.tsx، ولا يستورد expo-router (كي لا تنشأ حلقة مع الـ shim)؛
// يستلم segments ودالة التنقل كمعاملات. لا يستورد من src (الرموز في desktop-theme.ts).
import * as React from 'react';
import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import * as Lucide from 'lucide-react-native';
import { ShieldCheck } from 'lucide-react-native';
import {
  LAYOUT, activeTabFromSegments, contentWidthFor, installDesktopCss, listColumnsFor, parseSidebarPref,
  scdDiag, shellModeForSegments, shortcutTarget, sidebarModeFor, sidebarWidth, type SidebarPref,
} from './desktop-layout-core';
import { getNavStore, type NavEntry } from './desktop-nav-store';
import { DesktopLayoutContext, type DesktopLayoutValue } from './desktop-layout-context';
import { DT, DT_IDENTITY, tintColor } from './desktop-theme';

const PREF_KEY = 'scd.sidebar';
const SHELL_DOM_ID = 'scd-shell-root';
const readPref = (): SidebarPref => {
  try { return parseSidebarPref(window.localStorage.getItem(PREF_KEY)); } catch { return 'auto'; }
};
const writePref = (p: SidebarPref): void => {
  try { window.localStorage.setItem(PREF_KEY, p); } catch { /* التخزين غير متاح: نكتفي بالحالة في الذاكرة */ }
};

// الأيقونات المأخوذة بالاسم تُحمى من غياب الاسم في نسخة lucide المثبّتة.
const pickIcon = (name: string): React.ComponentType<any> | null => ((Lucide as any)[name] as React.ComponentType<any> | undefined) ?? null;

/** يلتقط أي خطأ في الغلاف نفسه فيعرض المحتوى بلا غلاف بدل شاشة بيضاء. */
class ShellBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { scdDiag('boundaryError', String((e as { message?: unknown } | null)?.message ?? e).slice(0, 160)); console.error('[desktop-shell] تعذّر رسم الغلاف، يُعرض المحتوى بلا قائمة جانبية:', e); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function NavRow({ item, active, compact, onPress }: { item: NavEntry; active: boolean; compact: boolean; onPress: () => void }) {
  const color = active ? DT.cyan : DT.textMuted;
  let icon: React.ReactNode = null;
  try { icon = item.icon ? (item.icon({ color, focused: active, size: 21 }) as React.ReactNode) : null; } catch { icon = null; }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={item.title}
      accessibilityState={{ selected: active }}
      style={(st: any) => [s.row, compact && s.rowCompact, active ? s.rowActive : st && st.hovered ? s.rowHover : null]}
    >
      <View style={s.iconSlot}>{icon}</View>
      {compact ? null : (
        <Text numberOfLines={1} style={[s.rowLabel, { color: active ? DT.textPrimary : DT.textSecondary, fontFamily: active ? DT.fontBold : DT.fontMedium }]}>
          {item.title}
        </Text>
      )}
      {active && !compact ? <View style={s.activeDot} /> : null}
    </Pressable>
  );
}

function Sidebar({ items, activeTab, compact, onNavigate, onToggle }: {
  items: ReadonlyArray<NavEntry>; activeTab: string | null; compact: boolean; onNavigate: (route: string) => void; onToggle: () => void;
}) {
  const Collapse = pickIcon(compact ? 'ChevronsLeft' : 'ChevronsRight');
  return (
    <View style={[s.sidebar, { width: sidebarWidth(compact ? 'compact' : 'expanded') }]} accessibilityRole={'navigation' as any}>
      <View style={[s.brand, compact && s.brandCompact]}>
        <View style={s.brandIcon}><ShieldCheck color={DT.cyan} size={22} strokeWidth={1.9} /></View>
        {compact ? null : (
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={s.brandName}>{DT_IDENTITY.appName}</Text>
            <Text numberOfLines={1} style={s.brandSub}>{DT_IDENTITY.tagline}</Text>
          </View>
        )}
      </View>
      <View style={s.navList}>
        {items.map((it, i) => (
          <NavRow key={it.name} item={it} compact={compact} active={activeTab === it.name} onPress={() => onNavigate(it.route)} />
        ))}
      </View>
      <View style={[s.footer, compact && { alignItems: 'center' }]}>
        {compact ? null : (
          <View style={s.hint}>
            <Text style={s.hintText}>التنقل السريع: Ctrl + 1 … {Math.min(items.length, 9)}</Text>
          </View>
        )}
        {compact ? null : <Text style={s.version}>{DT_IDENTITY.department} • {DT_IDENTITY.appVersion}</Text>}
        <Pressable onPress={onToggle} accessibilityRole="button" accessibilityLabel={compact ? 'توسيع القائمة' : 'طيّ القائمة'}
          style={(st: any) => [s.toggle, st && st.hovered ? s.rowHover : null]}>
          {Collapse ? <Collapse color={DT.textMuted} size={18} /> : <Text style={{ color: DT.textMuted }}>{compact ? '«' : '»'}</Text>}
          {compact ? null : <Text style={s.toggleText}>طيّ القائمة</Text>}
        </Pressable>
      </View>
    </View>
  );
}

export interface DesktopShellProps {
  segments: ReadonlyArray<string>;
  onNavigate: (route: string) => void;
  children?: React.ReactNode;
}

function ShellInner({ segments, onNavigate, children }: DesktopShellProps) {
  const { width } = useWindowDimensions();
  const store = getNavStore();
  const items = React.useSyncExternalStore(store.subscribe, store.get, store.get);
  const [pref, setPref] = React.useState<SidebarPref>(readPref);
  const rootRef = React.useRef<any>(null);
  scdDiag('innerRender');

  const shell = shellModeForSegments(segments);
  const hasSidebar = shell === 'app' && items.length > 0;
  const sidebarMode = sidebarModeFor(width, pref);
  const contentWidth = contentWidthFor(width, shell, hasSidebar, sidebarMode);
  const activeTab = activeTabFromSegments(segments);

  React.useEffect(() => { installDesktopCss(typeof document !== 'undefined' ? (document as any) : null); }, []);

  // اختصارات لوحة المفاتيح: Ctrl+1…9
  React.useEffect(() => {
    if (!hasSidebar || typeof window === 'undefined') return undefined;
    const onKey = (e: KeyboardEvent) => {
      const target = shortcutTarget(e, items);
      if (!target) return;
      e.preventDefault();
      onNavigate(target.route);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasSidebar, items, onNavigate]);

  // علامات DOM يقرؤها الفحص الدخاني في Electron (لا تأثير على التصميم).
  React.useEffect(() => {
    let el: any = rootRef.current;
    scdDiag('refKind', el ? (typeof el.setAttribute === 'function' ? 'dom' : 'non-dom') : 'null');
    if (!el || typeof el.setAttribute !== 'function') el = typeof document !== 'undefined' ? document.getElementById(SHELL_DOM_ID) : null;
    if (!el || typeof el.setAttribute !== 'function') scdDiag('markMissed');
    if (el && typeof el.setAttribute === 'function') {
      scdDiag('marked');
      el.setAttribute('data-scd-shell', shell);
      el.setAttribute('data-scd-sidebar', hasSidebar ? sidebarMode : 'none');
      el.setAttribute('data-scd-content-width', String(Math.round(contentWidth)));
    }
    const g = globalThis as any;
    if (g.__SCD_DESKTOP__) g.__SCD_DESKTOP__.state = { shell, sidebar: hasSidebar ? sidebarMode : 'none', contentWidth, windowWidth: width, items: items.length };
  });

  const ctx = React.useMemo<DesktopLayoutValue>(() => ({
    windowWidth: width, contentWidth, sidebarMode, shell, columns: listColumnsFor(contentWidth),
  }), [width, contentWidth, sidebarMode, shell]);

  const toggle = () => {
    const next: SidebarPref = sidebarMode === 'expanded' ? 'compact' : 'expanded';
    setPref(next);
    writePref(next);
  };

  return (
    <DesktopLayoutContext.Provider value={ctx}>
      <View ref={rootRef} id={SHELL_DOM_ID} style={s.root}>
        {hasSidebar ? (
          <>
            <Sidebar items={items} activeTab={activeTab} compact={sidebarMode === 'compact'} onNavigate={onNavigate} onToggle={toggle} />
            <View style={s.divider} />
          </>
        ) : null}
        <View style={s.stage}>
          <View style={[s.column, { maxWidth: shell === 'auth' ? LAYOUT.AUTH_MAX : LAYOUT.CONTENT_MAX }]}>{children}</View>
        </View>
      </View>
    </DesktopLayoutContext.Provider>
  );
}

export function DesktopShell(props: DesktopShellProps) {
  return (
    <ShellBoundary fallback={props.children}>
      <ShellInner {...props} />
    </ShellBoundary>
  );
}

const s = StyleSheet.create({
  // flexDirection:'row' مع dir=rtl على الجذر: أول ابن (القائمة) يقع على اليمين.
  root: { flex: 1, flexDirection: 'row', backgroundColor: DT.bg1 },
  stage: { flex: 1, minWidth: 0, alignItems: 'center', backgroundColor: DT.bg1 },
  column: { flex: 1, width: '100%', minWidth: 0 },
  divider: { width: LAYOUT.DIVIDER, backgroundColor: DT.glassBorder },
  sidebar: { backgroundColor: DT.bg0, paddingTop: 18, paddingBottom: 14, paddingHorizontal: 12 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6, paddingBottom: 18 },
  brandCompact: { justifyContent: 'center', paddingHorizontal: 0 },
  brandIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: tintColor(DT.cyan, 0.12), borderWidth: 1, borderColor: tintColor(DT.cyan, 0.4) },
  brandName: { fontFamily: DT.fontExtraBold, fontSize: 16, color: DT.textPrimary, textAlign: 'right' },
  brandSub: { fontFamily: DT.fontRegular, fontSize: 11, color: DT.textMuted, textAlign: 'right' },
  navList: { flex: 1, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 14, borderWidth: 1, borderColor: 'transparent', minHeight: 46 },
  rowCompact: { justifyContent: 'center', paddingHorizontal: 0 },
  rowActive: { backgroundColor: tintColor(DT.cyan, 0.1), borderColor: tintColor(DT.cyan, 0.32) },
  rowHover: { backgroundColor: 'rgba(148, 163, 255, 0.08)' },
  iconSlot: { width: 46, height: 30, alignItems: 'center', justifyContent: 'center' },
  rowLabel: { flex: 1, fontSize: 14, textAlign: 'right' },
  activeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: DT.cyan },
  footer: { gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: DT.glassBorder },
  hint: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, backgroundColor: tintColor(DT.gold, 0.08), borderWidth: 1, borderColor: tintColor(DT.gold, 0.22) },
  hintText: { fontFamily: DT.fontRegular, fontSize: 11, color: DT.gold, textAlign: 'center' },
  version: { fontFamily: DT.fontRegular, fontSize: 11, color: DT.textMuted, textAlign: 'center' },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 40, paddingHorizontal: 10, borderRadius: 12 },
  toggleText: { fontFamily: DT.fontMedium, fontSize: 12, color: DT.textMuted },
});
