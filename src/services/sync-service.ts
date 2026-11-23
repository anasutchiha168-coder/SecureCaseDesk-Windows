// SECURECASEDESK_PHASE16_STAGE_B
// واجهة خدمة المزامنة. لا تنفيذ فعلي قبل المرحلة 13. لا محاكاة ولا ردود خادم وهمية.
export interface SyncStatus {
  available: boolean;       // false دائماً حتى يوجد خادم حقيقي
  reason: 'not_configured' | 'offline' | 'ready';
}

export interface SyncService {
  getStatus(): Promise<SyncStatus>;
  // تُرفع العمليات المعلّقة وتُنزَّل التحديثات؛ في المرحلة 13 فقط.
  synchronize(): Promise<{ uploaded: number; downloaded: number; conflicts: number }>;
}

export class UnavailableSyncService implements SyncService {
  async getStatus(): Promise<SyncStatus> { return { available: false, reason: 'not_configured' }; }
  async synchronize(): Promise<never> { throw new Error('المزامنة غير متاحة: الخادم المركزي لم يُنفَّذ بعد (المرحلة 13).'); }
}
