// SECURECASEDESK_PHASE11_S1
// SECURECASEDESK_PHASE11_S2
// محوّل Expo لوحدة الذكاء الاصطناعي: يربط المنسّق بـ SecureStore وقاعدة البيانات وسجل التدقيق.
// 11.2: المزوّد السحابي صار حقيقياً بصيغة OpenAI القياسية (العنوان والنموذج والمفتاح من الإعدادات).
// المزوّد المحلي ما زال "صادقاً" بأنه غير مدمج. ⚠️ لم يُختبر على جهاز Android حقيقي بعد.

import * as SecureStore from 'expo-secure-store';
import { getDb } from '@/database/db';
import { recordAuditEvent } from '@/services/audit.service';
import {
  createAiManager, type AiManager, type SecretStoreLike,
} from './ai-manager';
import {
  AiProviderRegistry, createLocalPlaceholderProvider,
} from './ai-provider';
import { createOpenAiCompatibleProvider } from './ai-cloud-provider';
import { parseStoredSettings } from './ai-settings';
import { AI_SECRET_NAMES } from './ai-types';

const secretStore: SecretStoreLike = {
  get: (name) => SecureStore.getItemAsync(name),
  set: (name, value) => SecureStore.setItemAsync(name, value),
  remove: (name) => SecureStore.deleteItemAsync(name),
};

let manager: AiManager | null = null;

export function getAiManager(): AiManager {
  if (manager) return manager;

  const registry = new AiProviderRegistry();
  registry.register(createLocalPlaceholderProvider());
  registry.register(createOpenAiCompatibleProvider({
    async getConfig() {
      const { settings } = parseStoredSettings(await secretStore.get(AI_SECRET_NAMES.settings));
      const apiKey = await secretStore.get(AI_SECRET_NAMES.cloudKey);
      return { endpoint: settings.cloud.endpoint, model: settings.cloud.model, apiKey };
    },
  }));

  manager = createAiManager({
    secrets: secretStore,
    registry,
    async resolveActiveRole(userId) {
      const db = await getDb();
      const row = await db.getFirstAsync<{ role: string; is_active: number }>(
        'SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?', [userId]
      );
      return row && Number(row.is_active) === 1 ? String(row.role) : null;
    },
    async audit(event) {
      const db = await getDb();
      const u = await db.getFirstAsync<{ username: string }>(
        'SELECT username FROM users WHERE id = ?', [event.actorUserId]
      );
      await recordAuditEvent({
        operationType: event.operationType,
        entityType: event.entityType,
        entityId: event.entityId,
        previousValues: event.previousValues,
        newValues: event.newValues,
        reason: event.reason,
        actor: { id: event.actorUserId, username: u?.username ?? null },
      });
    },
    now: () => Date.now(),
  });
  return manager;
}
