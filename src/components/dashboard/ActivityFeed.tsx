// SECURECASEDESK_UI_V2 — آخر الأنشطة: خط زمني من سجل التدقيق الفعلي (للمدير فقط، كما يفرضه getAuditLogs).
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Activity } from 'lucide-react-native';
import { auditLook } from './audit-look';
import { Colors, Palette, Type, tint } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { auditOperationLabel, auditEntityLabel } from '@/modules/audit/audit-labels';
import type { AuditLogRow } from '@/services/audit.service';
import { EmptyState } from '@/components/ui/States';

function ago(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return 'قبل ' + m + ' دقيقة';
  const h = Math.floor(m / 60);
  if (h < 24) return 'قبل ' + h + ' ساعة';
  return new Date(ts).toLocaleDateString('ar-YE', { month: 'short', day: 'numeric' });
}

export const ActivityFeed = React.memo(function ActivityFeed({ rows }: { rows: AuditLogRow[] }) {
  if (!rows.length) return <EmptyState compact icon={Activity} title="لا توجد أنشطة بعد" hint="ستظهر هنا أحدث العمليات المسجّلة." />;
  return (
    <View style={s.wrap}>
      {rows.map((r, i) => {
        const { icon: Icon, color } = auditLook(r.operation_type);
        return (
          <View key={r.sequence_no} style={{ flexDirection: ROW, alignItems: 'stretch' }}>
            <View style={{ alignItems: 'center', width: 36 }}>
              <View style={[s.dot, { backgroundColor: tint(color, 0.16), borderColor: tint(color, 0.45) }]}><Icon color={color} size={15} /></View>
              {i < rows.length - 1 ? <View style={s.line} /> : null}
            </View>
            <View style={{ flex: 1, paddingBottom: i < rows.length - 1 ? 14 : 0, paddingHorizontal: 10 }}>
              <View style={{ flexDirection: ROW, justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[Type.h3, { color: Colors.textPrimary, flexShrink: 1, textAlign: 'right' }]} numberOfLines={1}>{auditOperationLabel(r.operation_type)}</Text>
                <Text style={[Type.caption, { color: Colors.textMuted }]}>{ago(r.created_at)}</Text>
              </View>
              <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right' }]} numberOfLines={1}>
                {auditEntityLabel(r.entity_type)}{r.username ? ' • ' + r.username : ''}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
});

const s = StyleSheet.create({
  wrap: { backgroundColor: Palette.surface, borderRadius: 22, padding: 16, borderWidth: 1, borderColor: Palette.glassBorder },
  dot: { width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  line: { flex: 1, width: 1.5, marginTop: 4, backgroundColor: Palette.glassBorder },
});
