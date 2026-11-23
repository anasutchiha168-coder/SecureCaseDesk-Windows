// عرض Alert.alert كحوار داخل التطبيق (DOM مباشر، بلا اعتماد على React) على Windows.
// جذر مستقل مُلحَق بـ <body> فيعمل فوق Modal الخاصة بـ react-native-web وفوق أي شاشة.
// الصفات: عربي RTL بخط Cairo، تصميم داكن، تركيز لوحة مفاتيح محصور، Escape/Enter، تعطيل الخلفية (inert).
import { createAlertQueue, escapeAction, backdropAction, initialFocusIndex } from './alert-core';
import type { AlertButtonInput, AlertOptions, AlertRequest } from './alert-core';

// ألوان مطابقة لـ src/constants/theme.ts (منسوخة عمداً كي لا يعتمد الـ shim على src).
const C = {
  overlay: 'rgba(7, 11, 22, 0.78)', card: '#111A2E', border: '#232C47', borderHi: '#33405F',
  text: '#F9FAFB', muted: '#9CA3AF', primary: '#2563EB', primaryHi: '#3B82F6', danger: '#EF4444', secondary: '#16213B',
};
const FONT_BOLD = "'Cairo_700Bold','Cairo_600SemiBold','Segoe UI',Tahoma,sans-serif";
const FONT_BODY = "'Cairo_400Regular','Segoe UI',Tahoma,sans-serif";
const STYLE_ID = 'scd-alert-style';
const Z = '2147483000';

const CSS = `
.scd-alert-overlay{position:fixed;inset:0;z-index:${Z};display:flex;align-items:center;justify-content:center;padding:24px;background:${C.overlay};direction:rtl;animation:scd-fade .14s ease-out}
.scd-alert{box-sizing:border-box;width:100%;max-width:440px;max-height:calc(100vh - 48px);display:flex;flex-direction:column;background:${C.card};color:${C.text};border:1px solid ${C.border};border-radius:20px;box-shadow:0 24px 60px rgba(0,0,0,.55);padding:22px 22px 18px;font-family:${FONT_BODY};text-align:right;outline:none;animation:scd-pop .16s ease-out}
.scd-alert-title{margin:0 0 8px;font:700 18px/1.6 ${FONT_BOLD};color:${C.text}}
.scd-alert-message{margin:0 0 18px;font:400 14px/1.9 ${FONT_BODY};color:${C.muted};white-space:pre-wrap;overflow-wrap:anywhere;overflow-y:auto;user-select:text;-webkit-user-select:text}
.scd-alert-actions{display:flex;gap:10px;flex-direction:row}
.scd-alert-actions.scd-stack{flex-direction:column}
.scd-alert-btn{flex:1;min-height:44px;padding:8px 16px;border-radius:14px;border:1px solid ${C.borderHi};background:${C.secondary};color:${C.text};font:600 15px/1.6 ${FONT_BOLD};cursor:pointer;transition:background .12s,border-color .12s,transform .06s}
.scd-alert-btn:hover{background:#1c2a4a;border-color:#44527a}
.scd-alert-btn:active{transform:scale(.98)}
.scd-alert-btn:focus-visible{outline:2px solid ${C.primaryHi};outline-offset:2px}
.scd-alert-btn.scd-default{background:${C.primary};border-color:${C.primary}}
.scd-alert-btn.scd-default:hover{background:${C.primaryHi};border-color:${C.primaryHi}}
.scd-alert-btn.scd-destructive{background:transparent;border-color:${C.danger};color:${C.danger}}
.scd-alert-btn.scd-destructive:hover{background:rgba(239,68,68,.14)}
.scd-alert-btn.scd-cancel{font-weight:500}
@keyframes scd-fade{from{opacity:0}to{opacity:1}}
@keyframes scd-pop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.scd-alert-overlay,.scd-alert{animation:none}.scd-alert-btn{transition:none}}
`;

const queue = createAlertQueue();

let overlay: HTMLElement | null = null;
let shownId = 0;
let restoreFocusTo: Element | null = null;
let inertRoot: Element | null = null;
let wired = false;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function buttons(el: HTMLElement): HTMLButtonElement[] {
  return Array.from(el.querySelectorAll<HTMLButtonElement>('button.scd-alert-btn'));
}

function onKeyDown(e: KeyboardEvent): void {
  const req = queue.current();
  if (!req || !overlay) return;
  if (e.key === 'Escape') {
    const a = escapeAction(req);
    if (a.kind !== 'none') { e.preventDefault(); e.stopPropagation(); queue.close(a); }
    return;
  }
  if (e.key === 'Tab') {
    const list = buttons(overlay);
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i < 0 || i >= list.length - 1 ? 0 : i + 1);
    list[next].focus();
  }
}

// يمنع هروب التركيز إلى عناصر خلف الحوار (مثل Modal الخاصة بـ react-native-web خارج #root).
function onFocusIn(e: FocusEvent): void {
  if (!overlay || !queue.current()) return;
  if (e.target instanceof Node && !overlay.contains(e.target)) {
    const list = buttons(overlay);
    const i = initialFocusIndex(queue.current()!.buttons);
    (list[i] ?? list[0])?.focus();
  }
}

function wire(): void {
  if (wired) return;
  wired = true;
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusin', onFocusIn, true);
}

function build(req: AlertRequest): HTMLElement {
  const ov = document.createElement('div');
  ov.className = 'scd-alert-overlay';
  ov.setAttribute('data-scd-alert', String(req.id));
  ov.setAttribute('dir', 'rtl');
  ov.setAttribute('lang', 'ar');
  ov.addEventListener('mousedown', (e) => {
    if (e.target === ov) {
      e.preventDefault(); // يبقي التركيز على الزر: لا نفقد Enter/Escape بعد النقر على الخلفية
      const a = backdropAction(req);
      if (a.kind !== 'none') queue.close(a);
    }
  });

  const box = document.createElement('div');
  box.className = 'scd-alert';
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-modal', 'true');
  box.tabIndex = -1;

  const titleId = `scd-alert-title-${req.id}`;
  const msgId = `scd-alert-msg-${req.id}`;
  if (req.title) {
    const h = document.createElement('h2');
    h.className = 'scd-alert-title';
    h.id = titleId;
    h.textContent = req.title; // textContent فقط: لا HTML أبداً
    box.appendChild(h);
    box.setAttribute('aria-labelledby', titleId);
  }
  if (req.message) {
    const p = document.createElement('p');
    p.className = 'scd-alert-message';
    p.id = msgId;
    p.textContent = req.message;
    box.appendChild(p);
    box.setAttribute('aria-describedby', msgId);
  }

  const actions = document.createElement('div');
  actions.className = 'scd-alert-actions' + (req.buttons.length > 2 ? ' scd-stack' : '');
  req.buttons.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `scd-alert-btn scd-${b.style}`;
    btn.textContent = b.text;
    btn.addEventListener('click', () => queue.press(i));
    actions.appendChild(btn);
  });
  box.appendChild(actions);
  ov.appendChild(box);
  return ov;
}

function render(): void {
  const req = queue.current();
  if (!req) {
    if (overlay) { overlay.remove(); overlay = null; }
    shownId = 0;
    if (inertRoot) { inertRoot.removeAttribute('inert'); inertRoot.removeAttribute('aria-hidden'); inertRoot = null; }
    const back = restoreFocusTo as HTMLElement | null;
    restoreFocusTo = null;
    if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    return;
  }
  if (req.id === shownId) return;

  if (!overlay) {
    restoreFocusTo = document.activeElement;
    const root = document.getElementById('root');
    if (root) { root.setAttribute('inert', ''); root.setAttribute('aria-hidden', 'true'); inertRoot = root; }
  } else {
    overlay.remove();
  }
  ensureStyle();
  wire();
  overlay = build(req);
  shownId = req.id;
  document.body.appendChild(overlay);
  const list = buttons(overlay);
  (list[initialFocusIndex(req.buttons)] ?? list[0])?.focus();
}

queue.subscribe(() => {
  if (typeof document === 'undefined') return;
  render();
});

// نفس توقيع React Native: Alert.alert(title, message?, buttons?, options?)
export function showAlert(title: string, message?: string, buttons?: AlertButtonInput[], options?: AlertOptions): void {
  if (typeof document === 'undefined' || !document.body) {
    // خارج المتصفح (اختبارات/SSR): لا واجهة، لكن لا نبتلع الرسالة بصمت.
    try { console.warn('[SecureCaseDesk] Alert بلا DOM:', title, message ?? ''); } catch { /* لا شيء */ }
    return;
  }
  queue.enqueue(title, message, buttons, options);
}

// لأغراض الاختبار والفحص فقط.
export const __alertQueue = queue;
