// بدائل Windows التي تُحقَن داخل حزمة react-native-web نفسها (القسم 3 — إصلاح).
// السبب: Expo يحوّل 'react-native' إلى 'react-native-web' قبل وصوله لمحلّل Metro المخصّص،
// فلم يكن shims/react-native.tsx يدخل الحزمة. الحل: build-web.mjs يعدّل dist/index.js داخل
// desktop/.stage/app/node_modules/react-native-web بحيث يصدّر Alert/Share/I18nManager/DevSettings من هنا.
// لا يستورد هذا الملف react-native-web أبداً (يستلم View وAppRegistry وcreateElement كمعاملات) فلا توجد حلقة استيراد.
import { showAlert } from './web-alert';
import { createShare, browserShareEnv } from './web-share';
import { I18nManagerWeb, DevSettingsWeb, StatusBarWeb } from './web-i18n';

export interface RnwCore {
  View: any;
  AppRegistry?: Record<string, any>;
  StatusBar?: unknown;
  createElement: (...args: any[]) => any;
}

const PATCHED = '__scdRtlRootPatched';

export function createScdExtras(core: RnwCore) {
  // عدّادات تشخيصية يقرؤها فحص Electron الدخاني عند فشل فحص dir=rtl.
  // كائن واحد مشترك على globalThis كي لا تضيع العدّادات لو استُدعيت الدالة أكثر من مرة.
  const g = globalThis as any;
  const diag = g.__SCD_RN_DIAG ?? (g.__SCD_RN_DIAG = { registered: 0, rendered: 0, patchedRegistry: false, hasRegistry: false });
  diag.hasRegistry = diag.hasRegistry || !!core.AppRegistry;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.setAttribute('lang', 'ar');
  }

  const registry = core.AppRegistry;
  if (registry && !registry[PATCHED]) {
    const original = registry.registerComponent;
    registry.registerComponent = function (appKey: string, provider: () => any, section?: boolean) {
      diag.registered++;
      let wrapped: any = null;
      return original.call(registry, appKey, () => {
        if (wrapped) return wrapped;
        const Inner = provider();
        wrapped = function ScdRtlRoot(props: any) {
          diag.rendered++;
          return core.createElement(core.View, { dir: 'rtl', lang: 'ar', style: { flex: 1 } }, core.createElement(Inner, props));
        };
        return wrapped;
      }, section);
    };
    registry[PATCHED] = true;
    diag.patchedRegistry = true;
  }

  // علامة يقرؤها فحص البناء الثابت وفحص Electron الدخاني.
  (globalThis as any).__SCD_RN_WEB__ = Object.freeze({ shim: 1, rtl: true, diag });

  return {
    Alert: { alert: showAlert },
    Share: Object.assign(createShare(browserShareEnv((t, m) => showAlert(t, m))), {
      sharedAction: 'sharedAction' as const,
      dismissedAction: 'dismissedAction' as const,
    }),
    I18nManager: I18nManagerWeb,
    DevSettings: DevSettingsWeb,
    StatusBar: core.StatusBar ?? StatusBarWeb,
  };
}
