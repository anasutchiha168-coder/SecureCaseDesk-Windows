// مكوّنات تخطيط سطح المكتب (القسم 4) التي تُحقَن داخل حزمة react-native-web نفسها (إصلاح القسم 4).
// السبب: Expo يحوّل 'react-native' إلى 'react-native-web' قبل محلّل Metro، فـ shims/react-native.tsx لا يدخل الحزمة أبداً
// (انظر rnw-extras.ts و docs/section-3-fix.md). لذلك لم تكن هذه المكوّنات ولا قياس textAlign تصل للحزمة المبنية.
// يعدّل scripts/lib/patch-rnw.mjs ملف dist/index.js في react-native-web ليستدعي createSection4 بالمكوّنات الأصلية كمعاملات،
// فلا يستورد هذا الملف react-native-web أبداً (لا حلقة استيراد). يشمل: Text/TextInput (تكافؤ textAlign)،
// ScrollView، FlatList (عمودان)، Modal (عمود مركزي)، RefreshControl (زر تحديث عائم).
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LAYOUT, pickOverlayColor } from './desktop-layout-core';
import { useDesktopLayout } from './desktop-layout-context';
import { compensateStyle, interpretProbe, swapAlign } from './text-align-fix';

export const SECTION4_NAMES = ['Text', 'TextInput', 'ScrollView', 'FlatList', 'Modal', 'RefreshControl'] as const;

const FAB = {
  position: 'absolute', bottom: 18, width: 44, height: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
  backgroundColor: 'rgba(17, 26, 46, 0.94)', borderWidth: 1, borderColor: 'rgba(34, 211, 238, 0.4)',
} as const;

// R = المكوّنات الأصلية من react-native-web: View, Text, TextInput, ScrollView, FlatList, Modal, Pressable,
// ActivityIndicator, StyleSheet, useWindowDimensions.
export function createSection4(R: any) {
  // ── تكافؤ textAlign ──
  // نقيس مرة واحدة عند الإقلاع: Text تجريبي (textAlign:'right') داخل <View dir="rtl"> ثم نقرأ textAlign المحسوب.
  // 'left' ⇒ react-native-web قلبه ⇒ نعوّض في Text/TextInput. غير ذلك ⇒ لا تعويض (نصدّر المكوّن الأصلي نفسه).
  const probeTextAlignFlip = (): boolean | null => {
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
  };
  const flipped = probeTextAlignFlip() === true;

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
  const Text = flipped ? ScdText : R.Text;
  const TextInput = flipped ? ScdTextInput : R.TextInput;

  // ── التمرير: على سطح المكتب لا لمس، فنُظهر أشرطة التمرير ──
  const ScrollView = React.forwardRef(function ScdScrollView(props: any, ref: any) {
    return React.createElement(R.ScrollView, { ...props, ref, showsVerticalScrollIndicator: true, showsHorizontalScrollIndicator: props.horizontal ? true : props.showsHorizontalScrollIndicator });
  });

  // ── القوائم: عمودان حين يتّسع عمود المحتوى ──
  const FlatList = React.forwardRef(function ScdFlatList(props: any, ref: any) {
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

  // ── النوافذ السفلية: عمود مركزي بدل عرض النافذة كاملة؛ نوافذ fade وغيرها تمرّ كما هي ──
  const Modal = function ScdModal(props: any) {
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

  // ── التحديث: زر عائم يستدعي onRefresh نفسه (react-native-web لا يرسم السحب للتحديث) ──
  const RefreshControl = function ScdRefreshControl(props: any) {
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

  return { Text, TextInput, ScrollView, FlatList, Modal, RefreshControl };
}
