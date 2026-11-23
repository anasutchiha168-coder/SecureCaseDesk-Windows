// بديل I18nManager على Windows. التطبيق عربي دائماً (RTL)، وreact-native-web لا يدعم forceRTL.
// أندرويد: isRTL=true بعد forceRTL + إعادة تشغيل. على Windows الاتجاه ثابت فنعيد true دائماً،
// فيعطي ROW في src/constants/rtl.ts القيمة 'row' (تتجه يميناً-إلى-يسار بفضل dir="rtl")،
// ولا يدخل _layout.tsx في حلقة إعادة التحميل الخاصة بـ RTL.
export const I18nManagerWeb = {
  isRTL: true,
  doLeftAndRightSwapInRTL: true,
  allowRTL(_allow: boolean): void { /* اتجاه ثابت */ },
  forceRTL(_force: boolean): void { /* اتجاه ثابت */ },
  swapLeftAndRightInRTL(_swap: boolean): void { /* ثابت */ },
  getConstants() {
    return { isRTL: true, doLeftAndRightSwapInRTL: true, localeIdentifier: 'ar' };
  },
};

export const DevSettingsWeb = {
  reload(): void { if (typeof window !== 'undefined') window.location.reload(); },
  addMenuItem(_title: string, _handler: () => void): void { /* لا قائمة مطوّر */ },
};

// StatusBar غير موجود/غير ذي معنى على سطح المكتب: مكوّن فارغ بنفس الواجهة الثابتة.
function StatusBarNoop(_props: Record<string, unknown>): null { return null; }
export const StatusBarWeb = Object.assign(StatusBarNoop, {
  setBarStyle(): void {}, setBackgroundColor(): void {}, setHidden(): void {}, setTranslucent(): void {},
  setNetworkActivityIndicatorVisible(): void {}, currentHeight: 0,
});

// حارس RTL على مستوى DOM (القسم 3 — إصلاح 3).
// لفّ AppRegistry وSafeAreaProvider لم يصلا للشجرة في الحزمة الحقيقية (diag.registered=0 وrtlRoot=0)، فلا نعتمد على طريقة تركيب Expo:
// نضبط dir="rtl" lang="ar" على عقدة react-native-web الجذرية داخل #root فور ظهورها (وعند أي إعادة إنشاء لها).
export const RTL_DOM_GUARD_KEY = '__scdRtlDomGuard';
export function installRtlDomGuard(doc: any = (globalThis as any).document, g: any = globalThis): boolean {
  if (!doc || typeof doc.getElementById !== 'function') return false;
  if (g[RTL_DOM_GUARD_KEY]) return true;
  g[RTL_DOM_GUARD_KEY] = true;
  const diag = g.__SCD_RN_DIAG ?? (g.__SCD_RN_DIAG = {});
  const mark = (root: any): void => {
    const kids: any[] = root && root.children ? Array.prototype.slice.call(root.children) : [];
    for (const el of kids) {
      if (typeof el.getAttribute !== 'function' || typeof el.setAttribute !== 'function') continue;
      if (el.getAttribute('dir') !== 'rtl') { el.setAttribute('dir', 'rtl'); diag.domRoot = (diag.domRoot ?? 0) + 1; }
      if (el.getAttribute('lang') !== 'ar') el.setAttribute('lang', 'ar');
    }
  };
  const attach = (): boolean => {
    const root = doc.getElementById('root');
    if (!root) return false;
    mark(root);
    if (typeof g.MutationObserver === 'function') new g.MutationObserver(() => mark(root)).observe(root, { childList: true });
    return true;
  };
  if (!attach() && typeof doc.addEventListener === 'function') doc.addEventListener('DOMContentLoaded', () => { attach(); });
  return true;
}
