// SECURECASEDESK_PHASE11_S5
// محوّل Expo لتقرير الخصوصية: يقرأ الحالة العامة من المنسّق (بلا مفتاح ولا نص) ويبني التقرير. للقراءة فقط.
import type { Session } from '@/security/guard';
import { buildSecretSpecs } from '@/modules/backup/backup-inventory';
import { getAiManager } from './ai-runtime';
import { buildPrivacyReport, type PrivacyReport } from './ai-privacy-check';

export async function getAiPrivacyReport(session: Session | null | undefined): Promise<PrivacyReport> {
  const st = await getAiManager().getState(session);
  return buildPrivacyReport({
    state: {
      mode: st.mode, features: st.features, settingsRecovered: st.settingsRecovered,
      cloud: { endpoint: st.cloud.endpoint, model: st.cloud.model, hasKey: st.cloud.hasKey, consentValid: st.cloud.consentValid },
    },
    backupSecretSpecs: buildSecretSpecs([1], false),
  });
}

export async function resetAllAiData(session: Session | null | undefined): Promise<void> {
  await getAiManager().resetAll(session);
}
