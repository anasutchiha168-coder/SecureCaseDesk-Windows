// مخزن صغير لعناصر القائمة الجانبية (القسم 4). بلا React.
// <Tabs> (داخل (tabs)/_layout.tsx) ينشر عناصره هنا، والغلاف الجذري (فوق Stack) يقرؤها،
// فتبقى القائمة ظاهرة حتى في شاشات Stack الأخرى (التقارير، البحث الذكي، تقرير التدقيق...).
import { navSignature, type NavItem } from './desktop-layout-core';

export interface NavEntry extends NavItem {
  /** دالة رسم الأيقونة الأصلية من options.tabBarIcon (قد تكون غائبة). */
  icon?: (args: { color: string; focused: boolean; size: number }) => unknown;
}

export interface NavStore {
  get: () => ReadonlyArray<NavEntry>;
  set: (items: ReadonlyArray<NavEntry>) => void;
  clear: () => void;
  subscribe: (fn: () => void) => () => void;
}

export function createNavStore(): NavStore {
  let snapshot: ReadonlyArray<NavEntry> = Object.freeze([]) as ReadonlyArray<NavEntry>;
  const subs = new Set<() => void>();
  const notify = () => { for (const fn of [...subs]) { try { fn(); } catch { /* مشترك واحد لا يوقف البقية */ } } };
  return {
    get: () => snapshot,
    set(items) {
      // نفس الأسماء والعناوين: نحدّث دوال الأيقونات بصمت ولا نُشعر (يمنع حلقات إعادة الرسم).
      if (navSignature(items) === navSignature(snapshot)) { snapshot = items.length ? items.slice() : snapshot; return; }
      snapshot = Object.freeze(items.slice()) as ReadonlyArray<NavEntry>;
      notify();
    },
    clear() {
      if (snapshot.length === 0) return;
      snapshot = Object.freeze([]) as ReadonlyArray<NavEntry>;
      notify();
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

/** نسخة وحيدة على globalThis: ESM/CJS أو أكثر من استيراد لا يُنتج مخزنين. */
const KEY = '__scdNavStore';
export function getNavStore(g: any = globalThis): NavStore {
  return g[KEY] ?? (g[KEY] = createNavStore());
}
