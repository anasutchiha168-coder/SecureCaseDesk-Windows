// SECURECASEDESK_PHASE8_S3
import { useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { installAuditIntegration } from './audit-integration';
import { startAuditSyncLoop } from './audit-outbox';

export function AuditRuntime() {
  const { user } = useAuth();

  useEffect(() => {
    installAuditIntegration();
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    return startAuditSyncLoop();
  }, [user?.id]);

  return null;
}
