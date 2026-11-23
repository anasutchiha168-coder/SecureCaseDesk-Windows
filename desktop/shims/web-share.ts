// بديل Share.share على Windows (القسم 3: سلوك آمن بسيط؛ القسم 5 يضيف مشاركة الملفات الفعلية).
// react-native-web لا يوفّر Share أصلاً. ثلاث مراتب: navigator.share ← نسخ إلى الحافظة مع إشعار ← خطأ صريح.
// يُستعمل في src عبر: Share.share({ message }) لنصوص التقارير/الملخصات/المسودات.

export interface ShareContent { message?: string; url?: string; title?: string }
export interface ShareOptions { dialogTitle?: string; subject?: string }
export interface ShareResult { action: 'sharedAction' | 'dismissedAction'; activityType?: string | null }

export interface ShareEnv {
  navigatorShare?: (data: { text?: string; title?: string; url?: string }) => Promise<void>;
  writeClipboard?: (text: string) => Promise<boolean>;
  notify?: (title: string, message: string) => void;
}

export const COPIED_TITLE = 'تم النسخ';
export const COPIED_MESSAGE = 'نُسخ النص إلى الحافظة. الصقه في أي تطبيق لمشاركته.';

export function buildShareText(content: ShareContent): string {
  const parts: string[] = [];
  if (content && typeof content.message === 'string' && content.message.length > 0) parts.push(content.message);
  if (content && typeof content.url === 'string' && content.url.length > 0) parts.push(content.url);
  return parts.join('\n');
}

export function createShare(env: ShareEnv) {
  async function share(content: ShareContent, _options?: ShareOptions): Promise<ShareResult> {
    const text = buildShareText(content);
    if (!text) throw new Error('Expected either `message` or `url` to be defined');

    if (env.navigatorShare) {
      try {
        await env.navigatorShare({ text, title: content.title });
        return { action: 'sharedAction', activityType: null };
      } catch (e) {
        if (e && (e as { name?: string }).name === 'AbortError') return { action: 'dismissedAction' };
        // أي خطأ آخر (غير مدعوم/ممنوع): ننتقل إلى الحافظة.
      }
    }
    if (env.writeClipboard) {
      let ok = false;
      try { ok = await env.writeClipboard(text); } catch { ok = false; }
      if (ok) {
        env.notify?.(COPIED_TITLE, COPIED_MESSAGE);
        return { action: 'sharedAction', activityType: null };
      }
    }
    throw new Error('تعذّرت المشاركة: لا توجد وسيلة مشاركة أو نسخ متاحة.');
  }
  return { share };
}

// نسخ للحافظة: Clipboard API ثم execCommand (يعمل بإيماءة مستخدم حتى مع رفض الصلاحيات في Electron).
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* ننتقل للبديل */ }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    const prev = document.activeElement as HTMLElement | null;
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (prev && typeof prev.focus === 'function') prev.focus();
    return ok;
  } catch { return false; }
}

export function browserShareEnv(notify: (title: string, message: string) => void): ShareEnv {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { share?: (d: object) => Promise<void> }) : undefined;
  return {
    navigatorShare: nav && typeof nav.share === 'function' ? (d) => nav.share!(d) : undefined,
    writeClipboard: copyToClipboard,
    notify,
  };
}
