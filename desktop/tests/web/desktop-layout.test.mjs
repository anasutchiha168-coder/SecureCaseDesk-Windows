import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shim = (f) => path.join(desktop, 'shims', f);

// الملفات النقية تُحمَّل من نسخة مؤقتة (strip-types) بنفس أسلوب rtl-root.test.mjs.
const tmp = mkdtempSync(path.join(tmpdir(), 'scd-layout-'));
// strip-types يتطلب امتداداً في الاستيراد النسبي، بينما Metro لا يريده: نضيفه في النسخة المؤقتة فقط.
for (const f of ['desktop-layout-core.ts', 'desktop-nav-store.ts', 'text-align-fix.ts']) writeFileSync(path.join(tmp, f), readFileSync(shim(f), 'utf8').replace(/from '(\.\/[\w-]+)'/g, "from '$1.ts'"));
const core = await import(pathToFileURL(path.join(tmp, 'desktop-layout-core.ts')).href);
const storeMod = await import(pathToFileURL(path.join(tmp, 'desktop-nav-store.ts')).href);
const fix = await import(pathToFileURL(path.join(tmp, 'text-align-fix.ts')).href);
const { LAYOUT } = core;

test('القائمة الجانبية: تُطوى تلقائياً تحت 1180 ويحترم اختيار المستخدم', () => {
  assert.equal(core.sidebarModeFor(1024), 'compact');
  assert.equal(core.sidebarModeFor(1179), 'compact');
  assert.equal(core.sidebarModeFor(1180), 'expanded');
  assert.equal(core.sidebarModeFor(1920), 'expanded');
  assert.equal(core.sidebarModeFor(1920, 'compact'), 'compact');
  assert.equal(core.sidebarModeFor(1024, 'expanded'), 'expanded');
  assert.equal(core.sidebarModeFor(Number.NaN), 'compact', 'قيمة غير صالحة تُعامل كأصغر نافذة');
  assert.equal(core.parseSidebarPref('x'), 'auto');
  assert.equal(core.parseSidebarPref('compact'), 'compact');
});

test('عرض المحتوى: نافذة Electron الافتراضية 1360 وأصغرها 1024 وشاشة كبيرة 2560', () => {
  const cw = (w, shell, side, mode) => core.contentWidthFor(w, shell, side, mode);
  assert.equal(cw(1360, 'app', true, 'expanded'), 1360 - 248 - 1);
  assert.equal(cw(1024, 'app', true, 'compact'), 1024 - 76 - 1);
  assert.equal(cw(2560, 'app', true, 'expanded'), LAYOUT.CONTENT_MAX, 'يُقيَّد بالحد الأقصى');
  assert.equal(cw(2560, 'auth', false, 'expanded'), LAYOUT.AUTH_MAX, 'الدخول عمود ضيق');
  assert.equal(cw(300, 'app', true, 'expanded'), 51);
  assert.equal(cw(100, 'app', true, 'expanded'), 0, 'لا قيم سالبة');
});

test('أعمدة القوائم: عمود واحد في النافذة الصغيرة، عمودان في الافتراضية والكبيرة', () => {
  const cols = (w) => {
    const mode = core.sidebarModeFor(w);
    return core.listColumnsFor(core.contentWidthFor(w, 'app', true, mode));
  };
  assert.equal(cols(1024), 1);
  assert.equal(cols(1180), 1, '1180 موسَّعة ⇒ محتوى 931');
  assert.equal(cols(1360), 2);
  assert.equal(cols(1920), 2);
  assert.equal(core.listColumnsFor(0), 1);
  assert.equal(core.listColumnsFor(undefined), 1);
});

test('عناصر القائمة: تتبع href:null وتأخذ العنوان وتتجاهل المكرر والأسماء الفارغة', () => {
  const items = core.deriveNavItems([
    { name: 'index', options: { title: 'الرئيسية', href: undefined } },
    { name: 'cases', options: { title: 'القضايا' } },
    { name: 'users', options: { title: 'المستخدمون', href: null } },   // صلاحيات
    { name: 'audit', options: { title: 'سجل التدقيق', href: null } },   // يُفتح من الإعدادات
    { name: 'settings', options: {} },                                 // بلا عنوان ⇒ الاسم
    { name: 'cases', options: { title: 'مكرر' } },
    { name: '', options: {} }, { name: 5 }, null, undefined,
  ]);
  assert.deepEqual(items.map((i) => i.name), ['index', 'cases', 'settings']);
  assert.equal(items[2].title, 'settings');
  assert.equal(items[0].route, '/(tabs)');
  assert.equal(items[1].route, '/(tabs)/cases');
});

test('التبويب النشط والوضع من segments (نفس منطق _layout الأصلي)', () => {
  assert.equal(core.activeTabFromSegments(['(tabs)']), 'index');
  assert.equal(core.activeTabFromSegments(['(tabs)', 'cases']), 'cases');
  assert.equal(core.activeTabFromSegments(['reports']), null);
  assert.equal(core.activeTabFromSegments([]), null);
  assert.equal(core.shellModeForSegments([]), 'auth');
  assert.equal(core.shellModeForSegments(['setup']), 'auth');
  assert.equal(core.shellModeForSegments(['(tabs)', 'cases']), 'app');
  assert.equal(core.shellModeForSegments(['reports']), 'app');
  assert.equal(core.shellModeForSegments(['ai-search']), 'app');
});

test('اختصارات Ctrl+1…9', () => {
  const items = core.deriveNavItems([{ name: 'index', options: { title: 'أ' } }, { name: 'cases', options: { title: 'ب' } }]);
  assert.equal(core.shortcutTarget({ ctrlKey: true, key: '2' }, items)?.name, 'cases');
  assert.equal(core.shortcutTarget({ metaKey: true, key: '1' }, items)?.name, 'index');
  assert.equal(core.shortcutTarget({ ctrlKey: true, key: '3' }, items), null, 'بلا عنصر ثالث');
  assert.equal(core.shortcutTarget({ ctrlKey: true, key: '0' }, items), null);
  assert.equal(core.shortcutTarget({ key: '1' }, items), null, 'بلا Ctrl لا يُلتقط (لا نعترض الكتابة)');
  assert.equal(core.shortcutTarget({ ctrlKey: true, altKey: true, key: '1' }, items), null);
  assert.equal(core.shortcutTarget({ ctrlKey: true, shiftKey: true, key: '1' }, items), null);
  assert.equal(core.shortcutTarget({ ctrlKey: true, key: '10' }, items), null);
});

test('مخزن القائمة: يُشعر عند تغيّر الأسماء/العناوين فقط، ويحدّث الأيقونات بصمت، وclear', () => {
  const st = storeMod.createNavStore();
  let calls = 0;
  const off = st.subscribe(() => { calls++; });
  const a = [{ name: 'index', title: 'الرئيسية', route: '/(tabs)' }];
  st.set(a); assert.equal(calls, 1); assert.equal(st.get().length, 1);
  const icon = () => null;
  st.set([{ ...a[0], icon }]); assert.equal(calls, 1, 'نفس التوقيع ⇒ لا إشعار');
  assert.equal(st.get()[0].icon, icon, 'لكن الأيقونة الأحدث محفوظة');
  st.set([...a, { name: 'cases', title: 'القضايا', route: '/(tabs)/cases' }]); assert.equal(calls, 2);
  st.clear(); assert.equal(calls, 3); assert.equal(st.get().length, 0);
  st.clear(); assert.equal(calls, 3, 'clear على فارغ لا يُشعر');
  off(); st.set(a); assert.equal(calls, 3, 'بعد إلغاء الاشتراك');
  st.subscribe(() => { throw new Error('x'); }); st.clear(); st.set(a); // مشترك معطوب لا يكسر المخزن
  assert.equal(st.get().length, 1);
});

test('المخزن العام: نسخة واحدة على globalThis', () => {
  const g = {};
  assert.equal(storeMod.getNavStore(g), storeMod.getNavStore(g));
  assert.notEqual(storeMod.getNavStore({}), storeMod.getNavStore(g));
});

test('لون تعتيم النافذة يؤخذ من الأصل، وإلا الافتراضي', () => {
  assert.equal(core.pickOverlayColor({ backgroundColor: 'rgba(0,0,0,.9)' }), 'rgba(0,0,0,.9)');
  assert.equal(core.pickOverlayColor(null), core.DEFAULT_OVERLAY);
  assert.equal(core.pickOverlayColor({}), core.DEFAULT_OVERLAY);
  assert.equal(core.pickOverlayColor({ backgroundColor: '' }), core.DEFAULT_OVERLAY);
  const src = readFileSync(path.join(desktop, '..', 'src', 'components', 'ui', 'Kit.tsx'), 'utf8');
  assert.ok(src.includes(core.DEFAULT_OVERLAY), 'الافتراضي يطابق backdrop الحقيقي في Kit.tsx');
});

test('CSS سطح المكتب: يُحقن مرة واحدة ولا يحوي HTML/استيراد خارجي', () => {
  const css = core.desktopCss();
  assert.match(css, /scrollbar/); assert.match(css, /focus-visible/); assert.match(css, /color-scheme:dark/);
  assert.ok(!/@import|url\(|<|expression/i.test(css));
  const added = [];
  const doc = {
    head: { appendChild: (n) => added.push(n) },
    getElementById: (id) => added.find((n) => n.id === id) ?? null,
    createElement: () => ({ id: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, textContent: null }),
  };
  assert.equal(core.installDesktopCss(doc), true);
  assert.equal(core.installDesktopCss(doc), false, 'idempotent');
  assert.equal(added.length, 1);
  assert.equal(added[0].id, core.DESKTOP_CSS_ID);
  assert.equal(core.installDesktopCss(null), false);
  assert.equal(core.installDesktopCss({ ...doc, head: null }), false);
});

test('تكافؤ textAlign: القياس والتعويض', () => {
  assert.equal(fix.interpretProbe('left'), true, "كُتب right وظهر left ⇒ انقلب");
  assert.equal(fix.interpretProbe('right'), false);
  assert.equal(fix.interpretProbe('start'), null);
  assert.equal(fix.interpretProbe(undefined), null);
  assert.deepEqual(fix.compensateStyle({ textAlign: 'right', color: 'red' }, true), { textAlign: 'left', color: 'red' });
  assert.deepEqual(fix.compensateStyle({ textAlign: 'left' }, true), { textAlign: 'right' });
  const c = { textAlign: 'center' };
  assert.equal(fix.compensateStyle(c, true), c, 'center لا يتغير ولا تخصيص جديد');
  const r = { textAlign: 'right' };
  assert.equal(fix.compensateStyle(r, false), r, 'بلا قلب لا تعويض');
  assert.equal(fix.compensateStyle(undefined, true), undefined);
  assert.equal(fix.swapAlign('auto'), 'auto');
});

test('رموز التصميم تطابق src/constants/theme.ts و identity.ts (لا انحراف)', () => {
  const theme = readFileSync(path.join(desktop, '..', 'src', 'constants', 'theme.ts'), 'utf8');
  const ident = readFileSync(path.join(desktop, '..', 'src', 'constants', 'identity.ts'), 'utf8');
  const dt = readFileSync(shim('desktop-theme.ts'), 'utf8');
  const val = (k) => new RegExp(`\\b${k}:\\s*'([^']+)'`).exec(dt)?.[1];
  for (const [mine, theirs] of [['bg0', 'bg0'], ['bg1', 'bg1'], ['surface', 'surface'], ['glassBorder', 'glassBorder'], ['cyan', 'cyan'], ['blue', 'blue'], ['gold', 'gold']]) {
    assert.ok(theme.includes(`${theirs}: '${val(mine)}'`), `Palette.${theirs} انحرف: ${val(mine)}`);
  }
  assert.ok(theme.includes(`textPrimary: '${val('textPrimary')}'`));
  assert.ok(theme.includes(`textSecondary: '${val('textSecondary')}'`));
  assert.ok(theme.includes(`textMuted: '${val('textMuted')}'`));
  for (const f of ['fontRegular', 'fontMedium', 'fontSemiBold', 'fontBold', 'fontExtraBold']) assert.ok(theme.includes(`'${val(f)}'`), f);
  assert.ok(ident.includes(`appName: '${val('appName')}'`) && ident.includes(`appVersion: '${val('appVersion')}'`) && ident.includes(`department: '${val('department')}'`));
});

test('ملفات القسم 4: لا استيراد من src ولا Node ولا حقن HTML، وكل ملف موجود', () => {
  for (const f of ['desktop-layout-core.ts', 'desktop-nav-store.ts', 'desktop-layout-context.ts', 'desktop-theme.ts', 'text-align-fix.ts', 'desktop-shell.tsx', 'expo-router.tsx']) {
    assert.ok(existsSync(shim(f)), f);
    const s = readFileSync(shim(f), 'utf8');
    assert.ok(!/from\s+['"][./]*\/?src\//.test(s) && !s.includes("'@/"), f + ' يستورد من src');
    assert.ok(!/require\(|node:|process\./.test(s), f + ' يستعمل Node');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(s), f + ' يحقن HTML/eval');
  }
});

test('تجنّب حلقات الاستيراد: الغلاف والسياق والمخزن لا يستوردون expo-router؛ react-native.tsx لا يستورد lucide', () => {
  for (const f of ['desktop-shell.tsx', 'desktop-layout-context.ts', 'desktop-nav-store.ts', 'desktop-layout-core.ts']) {
    assert.ok(!/from\s+['"]expo-router['"]/.test(readFileSync(shim(f), 'utf8')), f + ' يستورد expo-router (يسبّب حلقة عبر الـ shim)');
  }
  assert.ok(!/from\s+['"]lucide-react-native['"]/.test(readFileSync(shim('react-native.tsx'), 'utf8')), 'react-native-svg يستورد react-native ⇒ حلقة');
  assert.ok(!/from\s+['"]react-native['"]/.test(readFileSync(shim('react-native.tsx'), 'utf8')), 'react-native.tsx لا يستورد نفسه');
});

test('registry: expo-router صار shim (القسم 4) وملفه موجود ويُحوَّل على web+windows فقط', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { createShimResolver, buildTable } = require('../../shims/metro-alias.cjs');
  const registry = require('../../shims/registry.json');
  const e = registry.modules['expo-router'];
  assert.equal(e.action, 'shim'); assert.equal(e.file, 'expo-router.tsx'); assert.equal(e.section, 4);
  assert.ok(existsSync(shim(e.file)));
  assert.ok(buildTable(registry, desktop).has('expo-router'));
  const base = (ctx, name) => ({ type: 'base', name });
  const r = createShimResolver(base, { enabled: () => true, registry, dir: path.join(desktop, 'shims') });
  const shimFile = shim('expo-router.tsx');
  assert.equal(r({ originModulePath: '/p/src/app/_layout.tsx' }, 'expo-router', 'web').type, 'sourceFile');
  assert.equal(r({ originModulePath: shimFile }, 'expo-router', 'web').type, 'base', 'الـ shim نفسه يصل إلى الحزمة الحقيقية');
  assert.equal(r({ originModulePath: '/p/src/app/_layout.tsx' }, 'expo-router', 'android').type, 'base', 'الأندرويد لا يتأثر');
  assert.equal(r({ originModulePath: '/p/src/app/_layout.tsx' }, 'expo-router/entry', 'web').type, 'base', 'المسارات الفرعية لا تُعترض');
  const off = createShimResolver(base, { enabled: () => false, registry, dir: path.join(desktop, 'shims') });
  assert.equal(off({ originModulePath: '/p/x.tsx' }, 'expo-router', 'web').type, 'base', 'بلا SCD_TARGET=windows لا يتأثر');
});

test('expo-router.tsx: يعيد تصدير الحزمة ويستبدل Stack وTabs مع Screen، ويخفي شريط التبويبات', () => {
  const s = readFileSync(shim('expo-router.tsx'), 'utf8');
  assert.match(s, /export \* from 'expo-router'/);
  assert.match(s, /export const Stack = Object\.assign\(ScdStackImpl, \{ Screen: RealStack\.Screen \}\)/);
  assert.match(s, /export const Tabs = Object\.assign\(ScdTabsImpl, \{ Screen: RealTabs\.Screen \}\)/);
  assert.match(s, /display: 'none'/);
  assert.match(s, /__SCD_DESKTOP__/);
  assert.match(s, /store\.clear\(\)/, 'تنظيف القائمة عند إزالة Tabs (تسجيل الخروج)');
});

test('react-native.tsx القسم 4: يصدّر المكوّنات الجديدة ويقيس textAlign فعلياً', () => {
  const s = readFileSync(shim('react-native.tsx'), 'utf8');
  for (const n of ['ScrollView', 'FlatList', 'Modal', 'RefreshControl', 'Text', 'TextInput']) assert.match(s, new RegExp(`export const ${n}\\b`), n);
  assert.match(s, /probeTextAlignFlip/);
  assert.match(s, /dir: 'rtl'/);
  assert.match(s, /animationType !== 'slide'/, 'نوافذ fade لا تُمسّ');
  assert.match(s, /numColumns/);
});
