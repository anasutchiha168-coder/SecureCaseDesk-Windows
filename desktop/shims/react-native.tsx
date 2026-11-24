// Shim لوحدة 'react-native' على Windows (القسم 3).
// يُستخدم فقط عند platform=web وSCD_TARGET=windows (انظر metro-alias.cjs). كل ما في react-native-web يمرّ كما هو،
// ونستبدل فقط ما لا يعمل على سطح المكتب:
//   Alert        ← حوار داخلي (react-native-web يجعل Alert.alert دالة فارغة؛ src تستدعيها ~100 مرة)
//   Share        ← نسخ/مشاركة نصية (غير موجود أصلاً في react-native-web)
//   I18nManager  ← isRTL=true ثابتاً (التطبيق عربي دائماً)
//   DevSettings  ← reload فقط
//   StatusBar    ← مكوّن فارغ آمن
// ثم نضبط اتجاه المستند RTL ونلفّ الجذر بـ <View dir="rtl"> كي يقلب react-native-web الاتجاه في الشجرة كلها.
// القسم 4 (تخطيط سطح المكتب) يضيف: ScrollView/FlatList (أشرطة تمرير ظاهرة + عمودان في القوائم العريضة)،
// Modal (النوافذ السفلية تصير عموداً مركزياً)، RefreshControl (زر تحديث عائم بدل السحب)،
// Text/TextInput (تكافؤ textAlign إن قلبه react-native-web — يُقاس فعلياً عند الإقلاع).
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import * as RNW from 'react-native-web';
import { showAlert } from './web-alert';
import { createShare, browserShareEnv } from './web-share';
import { I18nManagerWeb, DevSettingsWeb, StatusBarWeb } from './web-i18n';
import { LAYOUT, pickOverlayColor } from './desktop-layout-core';
import { useDesktopLayout } from './desktop-layout-context';
import { compensateStyle, interpretProbe, swapAlign } from './text-align-fix';
import { createScdImage } from './file-image';

export * from 'react-native-web';

export const Alert = { alert: showAlert };
export const Share = Object.assign(createShare(browserShareEnv((t, m) => showAlert(t, m))), {
  sharedAction: 'sharedAction' as const,
  dismissedAction: 'dismissedAction' as const,
});
export const I18nManager = I18nManagerWeb;
export const DevSettings = DevSettingsWeb;
// إن وفّرت النسخة المثبّتة من react-native-web مكوّن StatusBar نستعمله، وإلا البديل الفارغ.
export const StatusBar = (RNW as { StatusBar?: unknown }).StatusBar ?? StatusBarWeb;

// ── اتجاه المستند ──
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('dir', 'rtl');
  document.documentElement.setAttribute('lang', 'ar');
}

// ── لفّ الجذر ──
// registerComponent هو ما يستدعيه expo (registerRootComponent) على الويب؛ نلفّ المكوّن مرة واحدة فقط.
const PATCHED = '__scdRtlRootPatched';
const registry = (RNW as { AppRegistry?: Record<string, any> }).AppRegistry;
if (registry && !registry[PATCHED]) {
  const original = registry.registerComponent;
  registry.registerComponent = function (appKey: string, provider: () => React.ComponentType<any>, section?: boolean) {
    let wrapped: React.ComponentType<any> | null = null;
    return original.call(registry, appKey, () => {
      if (wrapped) return wrapped;
      const Inner = provider();
      wrapped = function ScdRtlRoot(props: any) {
        return React.createElement(
          (RNW as any).View,
          { dir: 'rtl', lang: 'ar', style: { flex: 1 } },
          React.createElement(Inner, props),
        );
      };
      return wrapped;
    }, section);
  };
  registry[PATCHED] = true;
}


// ───────────────────────── القسم 4: تخطيط سطح المكتب ─────────────────────────
const R = RNW as any;

// ── Image: عناوين file:// (الصور المفكوكة في cache) تُعرض عبر blob: لأن Chromium يمنع file:// من app:// (القسم 5) ──
export const Image = createScdImage(R);

// ── تكافؤ textAlign ──
// نقيس مرة واحدة عند الإقلاع: نرسم Text تجريبياً (textAlign:'right') داخل <View dir="rtl"> ونقرأ textAlign المحسوب.
// 'left' ⇒ react-native-web قلبه ⇒ نعوّض في Text/TextInput. غير ذلك ⇒ لا تعويض ولا كلفة (نصدّر المكوّن الأصلي نفسه).
function probeTextAlignFlip(): boolean | null {
  const g = globalThis as any;
  if (g.__SCD_TEXTALIGN_FLIP__ !== undefined) return g.__SCD_TEXTALIGN_FLIP__;
  let result: boolean | null = null;
  try {
    if (typeof document !== 'undefined' && document.body) {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none';
      document.body.appendChild(host);
      const root = createRoot(host);
      flushSync(() => {
        root.render(React.createElement(R.View, { dir: 'rtl' }, React.createElement(R.Text, { style: { textAlign: 'right' } }, 'x')));
      });
      const nodes = host.querySelectorAll('div');
      const el = nodes.length ? nodes[nodes.length - 1] : null;
      result = interpretProbe(el ? getComputedStyle(el).textAlign : null);
      flushSync(() => { root.unmount(); });
      host.remove();
    }
  } catch { result = null; }
  g.__SCD_TEXTALIGN_FLIP__ = result;
  if (g.__SCD_RN_DIAG) g.__SCD_RN_DIAG.textAlignFlip = result;
  return result;
}
const TEXT_ALIGN_FLIPPED = probeTextAlignFlip() === true;

const ScdText = React.forwardRef(function ScdText(props: any, ref: any) {
  return React.createElement(R.Text, { ...props, ref, style: compensateStyle(R.StyleSheet.flatten(props.style), true) });
});
const ScdTextInput = React.forwardRef(function ScdTextInput(props: any, ref: any) {
  const { textAlign, style, ...rest } = props;
  return React.createElement(R.TextInput, {
    ...rest, ref,
    textAlign: typeof textAlign === 'string' ? swapAlign(textAlign) : textAlign,
    style: compensateStyle(R.StyleSheet.flatten(style), true),
  });
});
export const Text = TEXT_ALIGN_FLIPPED ? ScdText : R.Text;
export const TextInput = TEXT_ALIGN_FLIPPED ? ScdTextInput : R.TextInput;

// ── التمرير: على سطح المكتب لا لمس، فنُظهر أشرطة التمرير (src تخفيها لتناسب الهاتف) ──
export const ScrollView = React.forwardRef(function ScdScrollView(props: any, ref: any) {
  return React.createElement(R.ScrollView, { ...props, ref, showsVerticalScrollIndicator: true, showsHorizontalScrollIndicator: props.horizontal ? true : props.showsHorizontalScrollIndicator });
});

// ── القوائم: عمودان حين يتّسع عمود المحتوى (>= LAYOUT.GRID_MIN_CONTENT) ──
// يُحاط كل عنصر بـ <View width=50%>؛ العنوان (ListHeaderComponent) يبقى بعرض كامل. تغيّر عدد الأعمدة يُعيد تركيب القائمة (key).
export const FlatList = React.forwardRef(function ScdFlatList(props: any, ref: any) {
  const { width } = R.useWindowDimensions();
  const layout = useDesktopLayout(width);
  const base = props.renderItem;
  const eligible = !props.horizontal && !props.numColumns && !props.ListItemComponent && typeof base === 'function';
  const cols = eligible ? layout.columns : 1;
  const wrapped = React.useMemo(() => {
    if (cols <= 1) return base;
    const w = (100 / cols) + '%';
    return (info: any) => {
      const el = base(info);
      return el == null ? el : React.createElement(R.View, { style: { width: w } }, el);
    };
  }, [base, cols]);
  const common = { ...props, ref, showsVerticalScrollIndicator: props.horizontal ? props.showsVerticalScrollIndicator : true };
  if (cols <= 1) return React.createElement(R.FlatList, common);
  return React.createElement(R.FlatList, { ...common, key: 'scd-cols-' + cols, numColumns: cols, renderItem: wrapped });
});

// ── النوافذ السفلية (Sheet في src/components/ui/Kit.tsx): عمود مركزي بدل عرض النافذة كاملة ──
// نلتزم بلون تعتيم الخلفية الأصلي (من أول ابن) على الجانبين كي لا يظهر شريط أغمق؛ النقر على الجانبين يغلق النافذة.
// النوافذ الأخرى (animationType='fade': معاينة الصور وحوار الحذف) تمرّ كما هي.
export const Modal = function ScdModal(props: any) {
  const { width } = R.useWindowDimensions();
  const layout = useDesktopLayout(width);
  if (props.animationType !== 'slide' || !props.transparent || layout.windowWidth < LAYOUT.SHEET_MIN_WINDOW) {
    return React.createElement(R.Modal, props);
  }
  const first = React.Children.toArray(props.children)[0] as any;
  const dim = pickOverlayColor(first && first.props ? R.StyleSheet.flatten(first.props.style) : null);
  const side = { flex: 1, backgroundColor: dim };
  const close = props.onRequestClose;
  return React.createElement(
    R.Modal, { ...props, animationType: 'fade' },
    React.createElement(
      R.View, { style: { flex: 1, flexDirection: 'row' } },
      React.createElement(R.Pressable, { style: side, onPress: close, accessibilityLabel: 'إغلاق' }),
      React.createElement(R.View, { style: { width: '100%', maxWidth: LAYOUT.SHEET_MAX, alignSelf: 'stretch' } }, props.children),
      React.createElement(R.Pressable, { style: side, onPress: close, accessibilityLabel: 'إغلاق' }),
    ),
  );
};

// ── التحديث: react-native-web لا يرسم السحب للتحديث؛ نعوّضه بزر عائم يستدعي onRefresh نفسه ──
// ScrollView في react-native-web يلفّ نفسه بالعنصر المُمرَّر في refreshControl (cloneElement) فيصل المحتوى كأبناء.
const FAB = {
  position: 'absolute', bottom: 18, width: 44, height: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
  backgroundColor: 'rgba(17, 26, 46, 0.94)', borderWidth: 1, borderColor: 'rgba(34, 211, 238, 0.4)',
} as const;
export const RefreshControl = function ScdRefreshControl(props: any) {
  const { onRefresh, refreshing, children } = props;
  return React.createElement(
    R.View, { style: { flex: 1, minHeight: 0 } },
    children,
    typeof onRefresh === 'function'
      ? React.createElement(
          R.Pressable,
          {
            onPress: onRefresh, disabled: !!refreshing, accessibilityRole: 'button', accessibilityLabel: 'تحديث',
            style: (st: any) => [FAB, st && st.hovered ? { backgroundColor: 'rgba(34, 211, 238, 0.18)' } : null, refreshing ? { opacity: 0.6 } : null],
          },
          refreshing
            ? React.createElement(R.ActivityIndicator, { size: 'small', color: '#22D3EE' })
            : React.createElement(R.Text, { style: { color: '#22D3EE', fontSize: 22, lineHeight: 26 } }, '↻'),
        )
      : null,
  );
};

// علامة يقرؤها فحص Electron الدخاني للتأكد أن الـ shim هو المُحمَّل فعلاً.
(globalThis as any).__SCD_RN_WEB__ = Object.freeze({ shim: 1, rtl: true, diag: (globalThis as any).__SCD_RN_DIAG });
