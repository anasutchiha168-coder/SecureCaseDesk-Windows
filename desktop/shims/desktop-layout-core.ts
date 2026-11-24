// منطق تخطيط سطح المكتب (القسم 4) — دوال نقية بلا React ولا react-native ولا src.
// السبب: تُختبر دون شبكة (node --test) وتُستعمل من غلاف سطح المكتب (desktop-shell.tsx) ومن shim القوائم والنوافذ (react-native.tsx).
// المبدأ: لا تعديل على src؛ كل تحويل للتخطيط يحدث عند platform=web وSCD_TARGET=windows فقط.

export const LAYOUT = Object.freeze({
  /** أصغر نافذة يسمح بها Electron (window-state.cjs). */
  MIN_WINDOW: 1024,
  SIDEBAR_EXPANDED: 248,
  SIDEBAR_COMPACT: 76,
  DIVIDER: 1,
  /** تحت هذا العرض تُطوى القائمة تلقائياً إلى أيقونات (ما لم يختر المستخدم غير ذلك). */
  AUTO_COMPACT_BELOW: 1180,
  /** أقصى عرض لعمود المحتوى على الشاشات الكبيرة (يُوسَّط). */
  CONTENT_MAX: 1280,
  /** عرض عمود شاشتَي الدخول والإعداد الأول (بلا قائمة جانبية). */
  AUTH_MAX: 520,
  /** أقصى عرض للنوافذ السفلية (Sheet) على سطح المكتب. */
  SHEET_MAX: 680,
  /** عرض المحتوى الذي تتحول عنده القوائم الطويلة إلى عمودين. */
  GRID_MIN_CONTENT: 1000,
  /** تحت هذا العرض لا نغيّر شكل النوافذ السفلية. */
  SHEET_MIN_WINDOW: 760,
});

export type SidebarPref = 'auto' | 'expanded' | 'compact';
export type SidebarMode = 'expanded' | 'compact';
export type ShellMode = 'auth' | 'app';

const finite = (n: unknown, fallback: number): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback);

export function parseSidebarPref(raw: unknown): SidebarPref {
  return raw === 'expanded' || raw === 'compact' ? raw : 'auto';
}

export function sidebarModeFor(windowWidth: number, pref: SidebarPref = 'auto'): SidebarMode {
  if (pref === 'expanded' || pref === 'compact') return pref;
  return finite(windowWidth, LAYOUT.MIN_WINDOW) < LAYOUT.AUTO_COMPACT_BELOW ? 'compact' : 'expanded';
}

export function sidebarWidth(mode: SidebarMode): number {
  return mode === 'compact' ? LAYOUT.SIDEBAR_COMPACT : LAYOUT.SIDEBAR_EXPANDED;
}

/** عرض عمود المحتوى الفعلي: عرض النافذة − القائمة − الفاصل، مقيّداً بالحد الأقصى. */
export function contentWidthFor(windowWidth: number, shell: ShellMode, hasSidebar: boolean, mode: SidebarMode): number {
  const w = finite(windowWidth, LAYOUT.MIN_WINDOW);
  const used = hasSidebar ? sidebarWidth(mode) + LAYOUT.DIVIDER : 0;
  const cap = shell === 'auth' ? LAYOUT.AUTH_MAX : LAYOUT.CONTENT_MAX;
  return Math.max(0, Math.min(w - used, cap));
}

export function listColumnsFor(contentWidth: number): 1 | 2 {
  return finite(contentWidth, 0) >= LAYOUT.GRID_MIN_CONTENT ? 2 : 1;
}

// ── التنقل ──
export interface NavItem {
  name: string;
  title: string;
  route: string;
}

export function routeForTab(name: string): string {
  return name === 'index' ? '/(tabs)' : '/(tabs)/' + name;
}

/** يستخرج عناصر القائمة من أبناء <Tabs> (عناصر Tabs.Screen). href:null = مخفي (صلاحيات أو تبويب يُفتح من مكان آخر). */
export function deriveNavItems(screens: ReadonlyArray<{ name?: unknown; options?: unknown } | null | undefined>): NavItem[] {
  const out: NavItem[] = [];
  const seen = new Set<string>();
  for (const s of screens) {
    if (!s || typeof s.name !== 'string' || !s.name || seen.has(s.name)) continue;
    const o = (s.options && typeof s.options === 'object' ? s.options : {}) as { href?: unknown; title?: unknown };
    if (o.href === null) continue;
    seen.add(s.name);
    out.push({ name: s.name, title: typeof o.title === 'string' && o.title ? o.title : s.name, route: routeForTab(s.name) });
  }
  return out;
}

export function navSignature(items: ReadonlyArray<NavItem>): string {
  return items.map((i) => i.name + '|' + i.title).join('¦');
}

/** التبويب الحالي من segments (نفس منطق src/app/(tabs)/_layout.tsx): الجذر داخل (tabs) = index. */
export function activeTabFromSegments(segments: ReadonlyArray<string>): string | null {
  return segments[0] === '(tabs)' ? (segments[1] ?? 'index') : null;
}

/** شاشتا الدخول والإعداد الأول بلا قائمة جانبية وبعمود ضيق. */
export function shellModeForSegments(segments: ReadonlyArray<string>): ShellMode {
  if (segments.length === 0) return 'auth';
  if (segments[0] === 'setup') return 'auth';
  return 'app';
}

export interface KeyLike {
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** Ctrl+1…9 ينقل إلى العنصر المقابل في القائمة. */
export function shortcutTarget(ev: KeyLike, items: ReadonlyArray<NavItem>): NavItem | null {
  if (!ev || !(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return null;
  if (typeof ev.key !== 'string' || !/^[1-9]$/.test(ev.key)) return null;
  return items[Number(ev.key) - 1] ?? null;
}

// ── النوافذ السفلية ──
export const DEFAULT_OVERLAY = 'rgba(3, 6, 14, 0.72)';

/** لون تعتيم الخلفية يؤخذ من أول ابن للنافذة كي يتطابق الجانبان مع العمود المركزي. */
export function pickOverlayColor(flatStyle: unknown): string {
  const c = flatStyle && typeof flatStyle === 'object' ? (flatStyle as { backgroundColor?: unknown }).backgroundColor : undefined;
  return typeof c === 'string' && c.length > 0 ? c : DEFAULT_OVERLAY;
}

// ── CSS عام لسطح المكتب ──
export const DESKTOP_CSS_ID = 'scd-desktop-css';

export function desktopCss(): string {
  return [
    ':root{color-scheme:dark}',
    'html,body{background:#0B1120;overscroll-behavior:none}',
    '*{scrollbar-width:thin;scrollbar-color:rgba(148,163,255,.28) transparent}',
    '::-webkit-scrollbar{width:12px;height:12px}',
    '::-webkit-scrollbar-track{background:transparent}',
    '::-webkit-scrollbar-thumb{background:rgba(148,163,255,.26);border:3px solid transparent;border-radius:10px;background-clip:content-box}',
    '::-webkit-scrollbar-thumb:hover{background:rgba(148,163,255,.46);border:3px solid transparent;background-clip:content-box}',
    '::selection{background:rgba(34,211,238,.3)}',
    'input,textarea{caret-color:#22D3EE}',
    '[role="button"]:focus-visible,[role="tab"]:focus-visible,a:focus-visible,[tabindex="0"]:focus-visible{outline:2px solid #22D3EE;outline-offset:2px;border-radius:8px}',
    '[role="button"],[role="tab"]{user-select:none;-webkit-user-select:none}',
  ].join('\n');
}

export interface StyleDocLike {
  getElementById: (id: string) => unknown;
  createElement: (tag: string) => { id: string; setAttribute: (k: string, v: string) => void; textContent: string | null };
  head?: { appendChild: (n: unknown) => unknown } | null;
}

/** يحقن أنماط سطح المكتب مرة واحدة (CSP تسمح بـ style-src 'unsafe-inline'). يعيد true إن حُقنت الآن. */
export function installDesktopCss(doc: StyleDocLike | null | undefined): boolean {
  if (!doc || !doc.head || doc.getElementById(DESKTOP_CSS_ID)) return false;
  const el = doc.createElement('style');
  el.id = DESKTOP_CSS_ID;
  el.setAttribute('data-scd', 'desktop');
  el.textContent = desktopCss();
  doc.head.appendChild(el);
  return true;
}

// تشخيص غلاف سطح المكتب: عدّادات على globalThis.__SCD_DESKTOP__.diag يقرؤها الفحص الدخاني عند الفشل. لا تأثير على السلوك.
export function scdDiag(key: string, value?: unknown, g: any = globalThis): void {
  try {
    const d = g.__SCD_DESKTOP__ ?? (g.__SCD_DESKTOP__ = { shell: 1, section: 4, state: null });
    const diag = d.diag ?? (d.diag = {});
    diag[key] = value === undefined ? (Number(diag[key]) || 0) + 1 : value;
  } catch { /* تشخيص فقط */ }
}
