// SECURECASEDESK_PHASE11_S1
// واجهة مزوّد الذكاء الاصطناعي. القسم 11.1 يعرّف الواجهة والسجل فقط:
// لا يوجد هنا أي تنفيذ وهمي يتظاهر بإنتاج ردود. المزوّدات الحالية تُبلغ بصدق أنها غير جاهزة.

import { AiError, type AiFeatureId, type AiMode } from './ai-types';
import type { ProviderState } from './ai-policy';

export type AiProviderId = 'local' | 'cloud';

export interface AiProviderStatus {
  state: ProviderState;
  detail: string;
}

export interface AiGenerateRequest {
  feature: AiFeatureId;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
}

export interface AiGenerateResult {
  text: string;
  providerId: AiProviderId;
  model: string | null;
}

export interface AiProvider {
  readonly id: AiProviderId;
  getStatus(): Promise<AiProviderStatus>;
  generate(request: AiGenerateRequest, signal?: AbortSignal): Promise<AiGenerateResult>;
}

// مزوّد محلي: لم يُدمج أي محرك على الجهاز بعد.
export function createLocalPlaceholderProvider(): AiProvider {
  return {
    id: 'local',
    async getStatus() {
      return { state: 'not_installed', detail: 'لم يُدمج محرك محلي بعد.' };
    },
    async generate() {
      throw new AiError('PROVIDER_NOT_IMPLEMENTED', 'local');
    },
  };
}

// مزوّد سحابي: صيغة الطلب مع المزوّد الفعلي تُحسم في 11.2 بعد اختيار الخدمة. لا اتصال شبكي هنا.
export function createCloudPlaceholderProvider(): AiProvider {
  return {
    id: 'cloud',
    async getStatus() {
      return { state: 'not_installed', detail: 'اتصال الخدمة السحابية غير مُنفَّذ بعد (11.2).' };
    },
    async generate() {
      throw new AiError('PROVIDER_NOT_IMPLEMENTED', 'cloud');
    },
  };
}

export class AiProviderRegistry {
  private readonly providers = new Map<AiProviderId, AiProvider>();

  register(provider: AiProvider): void {
    this.providers.set(provider.id, provider);
  }

  forMode(mode: AiMode): AiProvider | null {
    if (mode === 'disabled') return null;
    return this.providers.get(mode) ?? null;
  }
}
