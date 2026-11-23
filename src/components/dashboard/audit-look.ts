// SECURECASEDESK_UI_V3 — مظهر الأحداث الأمنية (أيقونة + لون + خطورة) تشاركه اللوحة وشاشة التدقيق.
import type React from 'react';
import {
  LogIn, LogOut, FilePlus2, Pencil, Trash2, ShieldAlert, DatabaseBackup, FileOutput, Activity, Paperclip, KeyRound, RefreshCcw, Sparkles,
} from 'lucide-react-native';
import { Colors, Palette } from '@/constants/theme';

export type Severity = 'critical' | 'warning' | 'info';
export interface AuditLook { icon: React.ElementType; color: string; severity: Severity }
export const SEVERITY_META: Record<Severity, { label: string; color: string }> = {
  critical: { label: 'حرج', color: Palette.red },
  warning: { label: 'تحذير', color: Palette.gold },
  info: { label: 'معلومة', color: Palette.cyan },
};

const CRITICAL = new Set(['failed_login', 'unauthorized_access', 'attachment_integrity_failure', 'sync_conflict', 'sync_denied']);
const WARNING = new Set(['update', 'delete', 'permission_change', 'backup_restore', 'ai_key_change', 'ai_settings_change', 'attachment_delete', 'ai_reset']);

export function auditLook(op: string): AuditLook {
  const severity: Severity = CRITICAL.has(op) ? 'critical' : WARNING.has(op) ? 'warning' : 'info';
  if (op === 'login') return { icon: LogIn, color: Palette.green, severity };
  if (op === 'logout') return { icon: LogOut, color: Colors.textMuted, severity };
  if (op === 'create') return { icon: FilePlus2, color: Palette.blue, severity };
  if (op === 'update') return { icon: Pencil, color: Palette.gold, severity };
  if (op === 'delete' || op === 'attachment_delete') return { icon: Trash2, color: Palette.red, severity };
  if (severity === 'critical') return { icon: ShieldAlert, color: Palette.red, severity };
  if (op.startsWith('backup')) return { icon: DatabaseBackup, color: Palette.cyan, severity };
  if (op.startsWith('report')) return { icon: FileOutput, color: Palette.purple, severity };
  if (op.startsWith('attachment')) return { icon: Paperclip, color: Palette.blue, severity };
  if (op.startsWith('sync')) return { icon: RefreshCcw, color: Palette.cyan, severity };
  if (op.startsWith('ai')) return { icon: Sparkles, color: Palette.purple, severity };
  if (op === 'permission_change') return { icon: KeyRound, color: Palette.gold, severity };
  return { icon: Activity, color: Palette.cyan, severity };
}
