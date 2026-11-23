// SECURECASEDESK_PHASE11_S2
// مزوّد سحابي بصيغة "Chat Completions" القياسية (POST {endpoint}/chat/completions).
// يعمل مع OpenAI (مثل gpt-4o-mini) ومع Gemini عبر واجهته المتوافقة مع OpenAI
// (https://generativelanguage.googleapis.com/v1beta/openai) ومع أي مزوّد يتبع الصيغة نفسها؛
// تغيير المزوّد = تغيير العنوان والنموذج والمفتاح من شاشة الإعدادات دون أي تعديل في الكود.
//
// أمان: لا يُسجَّل المفتاح ولا المحتوى، ولا تحمل رسائل الأخطاء أي نص من ردّ الخادم.
// البوابة (authorizeUse في ai-manager) هي التي تفرض الإقرار والتأكيد؛ هذا المزوّد ينفّذ الاتصال فقط.

import { AiError } from './ai-types';
import { normalizeCloudEndpoint } from './ai-settings';
import type { AiGenerateRequest, AiGenerateResult, AiProvider, AiProviderStatus } from './ai-provider';

export interface CloudProviderConfig {
  endpoint: string | null;
  model: string | null;
  apiKey: string | null;
}

export interface CloudProviderDeps {
  getConfig(): Promise<CloudProviderConfig>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxResponseChars?: number;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_CHARS = 200000;
const SUFFIX = '/chat/completions';

export function buildChatCompletionsUrl(endpoint: string): string {
  return endpoint.endsWith(SUFFIX) ? endpoint : endpoint + SUFFIX;
}

function extractText(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const msg = (choices[0] as { message?: { content?: unknown } } | null)?.message;
  const content = msg?.content;
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join('');
    return parts.trim() || null;
  }
  return null;
}

export function createOpenAiCompatibleProvider(deps: CloudProviderDeps): AiProvider {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = deps.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;

  async function post(
    url: string, key: string, body: Record<string, unknown>, external?: AbortSignal
  ): Promise<{ status: number; text: string }> {
    const doFetch = deps.fetchFn ?? fetch;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort(); else external.addEventListener('abort', onAbort);
    }
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      } as RequestInit);
      const text = await res.text();
      return { status: res.status, text: text.length > maxChars ? text.slice(0, maxChars) : text };
    } catch {
      throw new AiError('PROVIDER_UNAVAILABLE', timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    }
  }

  return {
    id: 'cloud',

    // لا يتصل بالشبكة: يفحص اكتمال الإعداد فقط. نجاح الاتصال الفعلي يظهر عند أول طلب.
    async getStatus(): Promise<AiProviderStatus> {
      let cfg: CloudProviderConfig;
      try { cfg = await deps.getConfig(); } catch { return { state: 'not_configured', detail: 'تعذرت قراءة إعدادات الخدمة.' }; }
      if (!cfg.endpoint || !cfg.model || !cfg.apiKey) {
        return { state: 'not_configured', detail: 'العنوان أو النموذج أو المفتاح غير مكتمل.' };
      }
      return { state: 'ready', detail: 'خدمة سحابية بصيغة OpenAI القياسية (النموذج: ' + cfg.model + '). لم يُختبر الاتصال بعد.' };
    },

    async generate(request: AiGenerateRequest, signal?: AbortSignal): Promise<AiGenerateResult> {
      const cfg = await deps.getConfig();
      if (!cfg.endpoint || !cfg.model || !cfg.apiKey) throw new AiError('CLOUD_NOT_CONFIGURED');
      const endpoint = normalizeCloudEndpoint(cfg.endpoint);
      if (!endpoint) throw new AiError('CLOUD_ENDPOINT_INVALID');
      const url = buildChatCompletionsUrl(endpoint);

      const base: Record<string, unknown> = {
        model: cfg.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
      };
      const limit = request.maxOutputTokens ?? 400;

      let res = await post(url, cfg.apiKey, { ...base, max_tokens: limit }, signal);
      // بعض النماذج الحديثة ترفض max_tokens وتطلب max_completion_tokens: إعادة محاولة واحدة.
      if (res.status === 400 && res.text.includes('max_completion_tokens')) {
        res = await post(url, cfg.apiKey, { ...base, max_completion_tokens: limit }, signal);
      }

      if (res.status === 401 || res.status === 403) throw new AiError('CLOUD_KEY_INVALID');
      if (res.status < 200 || res.status >= 300) throw new AiError('PROVIDER_UNAVAILABLE', 'http-' + res.status);

      let json: unknown;
      try { json = JSON.parse(res.text); } catch { throw new AiError('PROVIDER_BAD_RESPONSE', 'json'); }
      const text = extractText(json);
      if (!text) throw new AiError('PROVIDER_BAD_RESPONSE', 'empty');
      return { text, providerId: 'cloud', model: cfg.model };
    },
  };
}
