// Shim لوحدة 'react-native' على Windows (القسم 3).
// يُستخدم فقط عند platform=web وSCD_TARGET=windows (انظر metro-alias.cjs). كل ما في react-native-web يمرّ كما هو،
// ونستبدل فقط ما لا يعمل على سطح المكتب:
//   Alert        ← حوار داخلي (react-native-web يجعل Alert.alert دالة فارغة؛ src تستدعيها ~100 مرة)
//   Share        ← نسخ/مشاركة نصية (غير موجود أصلاً في react-native-web)
//   I18nManager  ← isRTL=true ثابتاً (التطبيق عربي دائماً)
//   DevSettings  ← reload فقط
//   StatusBar    ← مكوّن فارغ آمن
// ثم نضبط اتجاه المستند RTL ونلفّ الجذر بـ <View dir="rtl"> كي يقلب react-native-web الاتجاه في الشجرة كلها.
import * as React from 'react';
import * as RNW from 'react-native-web';
import { showAlert } from './web-alert';
import { createShare, browserShareEnv } from './web-share';
import { I18nManagerWeb, DevSettingsWeb, StatusBarWeb } from './web-i18n';

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

// علامة يقرؤها فحص Electron الدخاني للتأكد أن الـ shim هو المُحمَّل فعلاً.
(globalThis as any).__SCD_RN_WEB__ = Object.freeze({ shim: 1, rtl: true, diag: (globalThis as any).__SCD_RN_DIAG });
