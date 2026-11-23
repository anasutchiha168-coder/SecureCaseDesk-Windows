// جذر RTL مشترك (القسم 3 — إصلاح 2).
// المشكلة: لفّ AppRegistry.registerComponent وحده لا يكفي — في الحزمة الحقيقية لم يُستدعَ إطلاقاً (diag.registered=0)
// فلم تظهر عقدة dir="rtl" وفشل فحص Electron. الحل: نضمن الجذر من مكانين مستقلّين يتشاركان نفس السياق:
//   1) AppRegistry.registerComponent (rnw-extras.ts)       — إن مرّ التسجيل من هناك.
//   2) SafeAreaProvider (safe-area-context.tsx)            — موجود دائماً في src/app/_layout.tsx وفي expo-router.
// لا يستورد هذا الملف react ولا react-native: يستلم React وView من المستدعي، فيُختبر دون شبكة ودون حلقات استيراد.

export interface ReactLike {
  createContext: (defaultValue: any) => any;
  createElement: (...args: any[]) => any;
  useContext: (ctx: any) => any;
}

export const RTL_CTX_KEY = '__scdRtlRootCtx';
export const RTL_DIAG_KEY = '__SCD_RN_DIAG';

// عدّادات تشخيصية يقرؤها فحص Electron عند الفشل. كائن واحد مشترك على globalThis.
export function getDiag(g: any = globalThis): Record<string, any> {
  const diag = g[RTL_DIAG_KEY] ?? (g[RTL_DIAG_KEY] = {});
  const defaults: Record<string, any> = {
    registered: 0, rendered: 0, patchedRegistry: false, hasRegistry: false, rtlRoot: 0, rtlRootNested: 0,
  };
  for (const k of Object.keys(defaults)) if (diag[k] === undefined) diag[k] = defaults[k];
  return diag;
}

// يضمن وجود dir/lang على عقدة DOM الفعلية حتى لو لم تمرّرهما react-native-web لعنصر View.
export function applyRtlAttrs(el: any): void {
  if (el && typeof el.setAttribute === 'function') {
    el.setAttribute('dir', 'rtl');
    el.setAttribute('lang', 'ar');
  }
}

export function createRtlRoot(React: ReactLike, View: any, diag: Record<string, any> = getDiag()) {
  const g = globalThis as any;
  // السياق نفسه يُشارَك بين كل النسخ (ESM/CJS أو أكثر من استدعاء) كي لا يتكرر اللفّ.
  const Ctx = g[RTL_CTX_KEY] ?? (g[RTL_CTX_KEY] = React.createContext(false));
  return function ScdRtlRoot(props: { children?: any }) {
    const inside = React.useContext(Ctx);
    // داخل جذر RTL آخر، أو لفّ AppRegistry يعمل فوقنا (rendered>0) ⇒ لا نلفّ ثانيةً.
    if (inside || diag.rendered > 0) {
      diag.rtlRootNested++;
      return props.children ?? null;
    }
    diag.rtlRoot++;
    return React.createElement(
      Ctx.Provider,
      { value: true },
      React.createElement(View, { dir: 'rtl', lang: 'ar', ref: applyRtlAttrs, style: { flex: 1 } }, props.children),
    );
  };
}
