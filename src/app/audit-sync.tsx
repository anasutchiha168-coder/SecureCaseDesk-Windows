// SECURECASEDESK_PHASE8_S3
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { RefreshCw, X } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Colors, Spacing, Radius, Fonts, FontSizes } from '@/constants/theme';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration';
import {
  getAuditSyncStatus, syncAuditNow, type OutboxSummary,
} from '@/modules/audit/audit-outbox';
import { formatTime, syncStateLabel } from '@/modules/audit/audit-report';

const STATUS_LABELS: Record<string, string> = {
  failed: 'فشل وسيُعاد', conflict: 'تعارض', rejected: 'مرفوض',
};

export default function AuditSyncScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'audit.sync');
  const session = user ? { userId: user.id, role: user.role } : null;

  const [summary, setSummary] = useState<OutboxSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (user && !allowed) {
      void recordUnauthorizedAccess({
        userId: user.id, username: user.username, role: user.role,
        resource: 'screen:audit-sync', detail: 'محاولة فتح حالة المزامنة',
      });
    }
  }, [user?.id, allowed]);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      setSummary(await getAuditSyncStatus(session));
    } catch (e) {
      Alert.alert('تعذر تحميل الحالة', String((e as Error)?.message ?? 'حدث خطأ غير متوقع'));
    }
  }, [user?.id]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed]);

  const syncNow = async () => {
    if (!session || busy) return;
    setBusy(true);
    try {
      const r = await syncAuditNow(session);
      setMessage(r.message);
      await load();
    } catch (e) {
      Alert.alert('تعذرت المزامنة', String((e as Error)?.message ?? 'حدث خطأ غير متوقع'));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()}>
        <X size={20} color={Colors.textPrimary} />
      </Pressable>
      <Text style={styles.title}>مزامنة سجل التدقيق</Text>
      <Pressable style={styles.iconBtn} onPress={() => void load()} disabled={!allowed}>
        <RefreshCw size={20} color={Colors.primaryLight} />
      </Pressable>
    </View>
  );

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.denied}>غير مصرح لك بعرض حالة المزامنة</Text>
          <Text style={styles.muted}>تم تسجيل هذه المحاولة في سجل التدقيق</Text>
        </View>
      </SafeAreaView>
    );
  }

  const stuck = summary ? summary.counts.conflict + summary.counts.rejected : 0;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <ScrollView contentContainerStyle={styles.content}>
        {!summary && <ActivityIndicator color={Colors.primary} size="large" />}
        {summary && (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>الحالة</Text>
              <Line label="حالة المزامنة" value={syncStateLabel(summary.lastResult)}
                color={summary.lastResult === 'ok' ? Colors.success : Colors.warning} />
              <Line label="التهيئة" value={summary.configured ? 'مهيأة' : 'غير مهيأة'} />
              <Line label="الخادم" value={summary.serverHost ?? 'غير محدد'} />
              <Line label="آخر محاولة" value={formatTime(summary.lastAttemptAt)} />
              <Line label="آخر نجاح" value={formatTime(summary.lastSuccessAt)} />
              <Line label="معرّف الجهاز" value={summary.deviceId.slice(0, 8)} />
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>الصندوق الصادر</Text>
              <Line label="بانتظار الإرسال" value={summary.counts.pending + summary.counts.failed} />
              <Line label="تمت مزامنتها" value={summary.counts.sent} />
              <Line label="تعارض / مرفوضة" value={stuck} color={stuck ? Colors.danger : undefined} />
            </View>

            {stuck > 0 && (
              <View style={[styles.card, { borderColor: Colors.danger }]}>
                <Text style={[styles.cardTitle, { color: Colors.danger }]}>
                  المزامنة متوقفة بسبب تعارض
                </Text>
                <Text style={styles.muted}>
                  لا يُكتب فوق أي سجل. يجب أن يراجع مدير النظام التعارض على الخادم قبل استئناف الإرسال.
                </Text>
              </View>
            )}

            {summary.attention.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>سجلات تحتاج متابعة</Text>
                {summary.attention.map((a) => (
                  <Line key={a.sequence_no}
                    label={'سجل ' + a.sequence_no + ' — محاولات ' + a.retry_count}
                    value={STATUS_LABELS[a.status] ?? a.status}
                    color={a.status === 'failed' ? Colors.warning : Colors.danger} />
                ))}
              </View>
            )}
          </>
        )}

        {!!message && <Text style={styles.message}>{message}</Text>}

        <Pressable style={styles.btn} onPress={syncNow} disabled={busy}>
          {busy ? <ActivityIndicator color={Colors.textOnPrimary} /> : null}
          <Text style={styles.btnText}>{busy ? 'جارٍ المزامنة...' : 'مزامنة الآن'}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Line({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, color ? { color } : null]}>{String(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    padding: Spacing.lg, flexDirection: 'row-reverse', alignItems: 'center',
    justifyContent: 'space-between', gap: Spacing.sm,
  },
  title: { flex: 1, color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.lg, textAlign: 'center' },
  iconBtn: {
    width: 42, height: 42, borderRadius: Radius.md, backgroundColor: Colors.secondary,
    alignItems: 'center', justifyContent: 'center',
  },
  content: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, padding: Spacing.xl },
  denied: { color: Colors.danger, fontFamily: Fonts.bold, fontSize: FontSizes.lg, textAlign: 'center' },
  muted: { color: Colors.textSecondary, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'right' },
  message: { color: Colors.secondaryAccent, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'center' },
  card: {
    backgroundColor: Colors.card, borderColor: Colors.border, borderWidth: 1,
    borderRadius: Radius.lg, padding: Spacing.lg, gap: Spacing.sm,
  },
  cardTitle: { color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md, textAlign: 'right' },
  row: { flexDirection: 'row-reverse', justifyContent: 'space-between', gap: Spacing.md },
  rowLabel: { flex: 1, color: Colors.textSecondary, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'right' },
  rowValue: { color: Colors.textPrimary, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'left', flexShrink: 1 },
  btn: {
    minHeight: 50, borderRadius: Radius.md, backgroundColor: Colors.primary,
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.sm, padding: Spacing.md,
  },
  btnText: { color: Colors.textOnPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md },
});
