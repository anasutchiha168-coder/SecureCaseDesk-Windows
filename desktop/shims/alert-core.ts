// منطق نقي (بلا DOM وبلا React) لـ Alert.alert على Windows.
// السبب: react-native-web يعرّف Alert.alert كدالة فارغة، بينما src تستدعيها ~100 مرة
// (تأكيد الحذف، رسائل الخطأ، الاستعادة...). صمتها يعني ضياع وظائف، فنبني بديلاً حقيقياً.
// كُتب بصيغة TypeScript قابلة للتجريد (بلا enum ولا parameter properties) ليُختبر مباشرة بـ node.

export type AlertButtonStyle = 'default' | 'cancel' | 'destructive';

export interface AlertButtonInput {
  text?: string;
  onPress?: (value?: string) => void;
  style?: AlertButtonStyle;
  isPreferred?: boolean;
}

export interface AlertOptions {
  cancelable?: boolean;
  onDismiss?: () => void;
}

export interface NormalizedButton {
  text: string;
  style: AlertButtonStyle;
  onPress?: (value?: string) => void;
  isPreferred: boolean;
}

export interface AlertRequest {
  id: number;
  title: string;
  message: string;
  buttons: NormalizedButton[];
  cancelable: boolean;
  onDismiss?: () => void;
}

export const DEFAULT_OK_TEXT = 'حسناً';

const STYLES: readonly string[] = ['default', 'cancel', 'destructive'];

export function normalizeButtons(buttons?: readonly AlertButtonInput[] | null): NormalizedButton[] {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    return [{ text: DEFAULT_OK_TEXT, style: 'default', isPreferred: false }];
  }
  return buttons.map((b) => {
    const style = b && typeof b.style === 'string' && STYLES.includes(b.style) ? b.style : 'default';
    const text = b && typeof b.text === 'string' && b.text.length > 0 ? b.text : (style === 'cancel' ? 'إلغاء' : DEFAULT_OK_TEXT);
    return {
      text,
      style,
      onPress: b && typeof b.onPress === 'function' ? b.onPress : undefined,
      isPreferred: Boolean(b && b.isPreferred),
    };
  });
}

// أي زر يأخذ التركيز عند الفتح. لا نركّز أبداً على زر "destructive" تلقائياً حتى لا يحذف Enter عن طريق الخطأ.
export function initialFocusIndex(buttons: readonly NormalizedButton[]): number {
  const preferred = buttons.findIndex((b) => b.isPreferred && b.style !== 'destructive');
  if (preferred >= 0) return preferred;
  for (let i = buttons.length - 1; i >= 0; i--) if (buttons[i].style === 'default') return i;
  const cancel = buttons.findIndex((b) => b.style === 'cancel');
  if (cancel >= 0) return cancel;
  return 0;
}

export type CloseAction =
  | { kind: 'press'; index: number }
  | { kind: 'dismiss' }
  | { kind: 'none' };

// مفتاح Escape: زر "إلغاء" إن وُجد؛ وإلا dismiss إن كان cancelable؛ وإلا الزر الوحيد؛ وإلا لا شيء.
// (لا نضغط زراً من بين عدة أزرار بلا معنى واضح، فقد يكون حذفاً.)
export function escapeAction(req: Pick<AlertRequest, 'buttons' | 'cancelable'>): CloseAction {
  const cancel = req.buttons.findIndex((b) => b.style === 'cancel');
  if (cancel >= 0) return { kind: 'press', index: cancel };
  if (req.cancelable) return { kind: 'dismiss' };
  if (req.buttons.length === 1) return { kind: 'press', index: 0 };
  return { kind: 'none' };
}

// النقر على الخلفية: مثل أندرويد، لا يُغلق إلا إن كان cancelable.
export function backdropAction(req: Pick<AlertRequest, 'cancelable'>): CloseAction {
  return req.cancelable ? { kind: 'dismiss' } : { kind: 'none' };
}

export interface AlertQueueOptions {
  // تُستدعى عند رمي onPress/onDismiss خطأً. الافتراضي: إعادة الرمي غير المتزامن كي لا ينكسر الطابور.
  reportError?: (e: unknown) => void;
}

export interface AlertQueue {
  enqueue(title: unknown, message?: unknown, buttons?: readonly AlertButtonInput[] | null, options?: AlertOptions | null): number;
  current(): AlertRequest | null;
  size(): number;
  subscribe(listener: () => void): () => void;
  press(index: number): void;
  dismiss(): void;
  close(action: CloseAction): void;
}

export function createAlertQueue(opts: AlertQueueOptions = {}): AlertQueue {
  const reportError = opts.reportError ?? ((e: unknown) => { setTimeout(() => { throw e; }, 0); });
  const items: AlertRequest[] = [];
  const listeners = new Set<() => void>();
  let seq = 0;

  const emit = () => { for (const l of [...listeners]) l(); };
  const invoke = (fn: (() => void) | undefined) => {
    if (!fn) return;
    try { fn(); } catch (e) { reportError(e); }
  };

  return {
    enqueue(title, message, buttons, options) {
      const req: AlertRequest = {
        id: ++seq,
        title: title == null ? '' : String(title),
        message: message == null ? '' : String(message),
        buttons: normalizeButtons(buttons),
        cancelable: Boolean(options && options.cancelable),
        onDismiss: options && typeof options.onDismiss === 'function' ? options.onDismiss : undefined,
      };
      items.push(req);
      emit();
      return req.id;
    },
    current() { return items[0] ?? null; },
    size() { return items.length; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    press(index) {
      const req = items[0];
      if (!req || !Number.isInteger(index) || index < 0 || index >= req.buttons.length) return;
      items.shift();
      emit(); // نُظهر التالي (إن وُجد) قبل تنفيذ رد النداء، فتصطف التنبيهات المتولدة منه خلفه.
      invoke(req.buttons[index].onPress);
    },
    dismiss() {
      const req = items[0];
      if (!req) return;
      items.shift();
      emit();
      invoke(req.onDismiss);
    },
    close(action) {
      if (action.kind === 'press') this.press(action.index);
      else if (action.kind === 'dismiss') this.dismiss();
    },
  };
}
