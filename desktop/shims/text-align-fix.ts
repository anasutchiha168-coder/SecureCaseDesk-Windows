// تكافؤ textAlign بين react-native-web والأصل (القسم 4). دوال نقية بلا React.
// المشكلة المحتملة: react-native-web يقلب قيم textAlign (left↔right) داخل سياق RTL، بينما src مكتوبة على سلوك الأصل
// (textAlign:'right' = يمين فعلاً، وعليها اختُبر التطبيق على الجهاز). لو انقلبت فستظهر كل النصوص العربية على اليسار.
// لا نخمّن: يقيس react-native.tsx فعلياً عند الإقلاع (عنصر Text تجريبي داخل <View dir="rtl">) ثم يعوّض القلب فقط إن حدث.

export type Align = 'left' | 'right' | 'center' | 'justify' | 'auto' | string;

export const swapAlign = (v: Align): Align => (v === 'left' ? 'right' : v === 'right' ? 'left' : v);

/** نتيجة القياس: textAlign المحسوب لعنصر كُتب له 'right'. 'left' ⇒ انقلب. 'right' ⇒ سليم. غير ذلك ⇒ غير معروف (لا تعويض). */
export function interpretProbe(computed: string | null | undefined): boolean | null {
  if (computed === 'left') return true;
  if (computed === 'right') return false;
  return null;
}

/** يعيد نمطاً مسطّحاً بعد تعويض القلب؛ يعيد نفس الكائن إن لم يلزم تغيير (بلا تخصيص). */
export function compensateStyle<T extends { textAlign?: Align } | null | undefined>(flat: T, flipped: boolean): T {
  if (!flipped || !flat) return flat;
  const a = flat.textAlign;
  if (a !== 'left' && a !== 'right') return flat;
  return { ...(flat as object), textAlign: swapAlign(a) } as T;
}
