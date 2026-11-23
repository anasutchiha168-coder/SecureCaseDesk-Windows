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
