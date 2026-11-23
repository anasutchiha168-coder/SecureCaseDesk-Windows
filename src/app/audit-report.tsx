// SECURECASEDESK_PHASE8_S3
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert, Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ShieldCheck, RefreshCw, X } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Colors, Spacing, Radius, Fonts, FontSizes } from '@/constants/theme';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration';
import {
  buildAuditVerificationReport, formatReportArabic, formatTime,
  recordReportExport, syncStateLabel, type AuditVerificationReport,
} from '@/modules/audit/audit-report';
import { auditEntityLabel, auditOperationLabel } from '@/modules/audit/audit-labels';
import {
  runAuditIntegrationTests, type IntegrationTestResult,
} from '@/modules/audit/audit-integration-tests';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, color ? { color } : null]}>{String(value)}</Text>
    </View>
  );
}

export default function AuditReportScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'audit.verify');

  const [report, setReport] = useState<AuditVerificationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tests, setTests] = useState<IntegrationTestResult | null>(null);

  const session = user ? { userId: user.id, role: user.role } : null;

  useEffect(() => {
    if (user && !allowed) {
      void recordUnauthorizedAccess({
        userId: user.id, username: user.username, role: user.role,
        resource: 'screen:audit-report', detail: 'محاولة فتح تقرير التحقق',
      });
    }
  }, [user?.id, allowed]);

  const run = useCallback(async () => {
    if (!session || loading) return;
    setLoading(true);
    try {
      setReport(await buildAuditVerificationReport(session));
    } catch (e) {
      Alert.alert('تعذر إنشاء التقرير', String((e as Error)?.message ?? 'حدث خطأ غير متوقع'));
    } finally {
      setLoading(false);
    }
  }, [user?.id, loading]);

  useEffect(() => {
    if (allowed) void run();
  }, [allowed]);

  const share = async () => {
    if (!report || !session) return;
    try {
      await recordReportExport(session);
      await Share.share({ message: formatReportArabic(report) });
    } catch (e) {
      Alert.alert('تعذرت المشاركة', String((e as Error)?.message ?? 'حدث خطأ غير متوقع'));
    }
  };

  const runTests = async () => {
    if (!session || testing) return;
    setTesting(true);
    setTests(null);
    try {
      setTests(await runAuditIntegrationTests(session));
      await run();
    } catch (e) {
      Alert.alert('تعذر تشغيل الاختبارات', String((e as Error)?.message ?? 'حدث خطأ غير متوقع'));
    } finally {
      setTesting(false);
    }
  };

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()}>
        <X size={20} color={Colors.textPrimary} />
      </Pressable>
      <Text style={styles.title}>تقرير التحقق من سجل التدقيق</Text>
      <Pressable style={styles.iconBtn} onPress={() => void run()} disabled={loading || !allowed}>
        <RefreshCw size={20} color={Colors.primaryLight} />
      </Pressable>
    </View>
  );

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.denied}>غير مصرح لك بعرض تقرير التحقق</Text>
          <Text style={styles.muted}>تم تسجيل هذه المحاولة في سجل التدقيق</Text>
        </View>
      </SafeAreaView>
    );
  }

  const chainColor = report?.chain.ok ? Colors.success : Colors.danger;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <ScrollView contentContainerStyle={styles.content}>
        {loading && !report && <ActivityIndicator color={Colors.primary} size="large" />}

        {report && (
          <>
            <View style={[styles.banner, { borderColor: chainColor }]}>
              <ShieldCheck color={chainColor} size={30} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.bannerTitle, { color: chainColor }]}>
                  {report.chain.ok ? 'سجل التدقيق سليم' : 'تحذير: سجل التدقيق غير سليم'}
                </Text>
                <Text style={styles.muted}>{report.chain.label}</Text>
              </View>
            </View>

            <Card title="نتيجة الفحص">
              <Row label="عدد السجلات المفحوصة" value={report.chain.count} />
              <Row label="الاختبار الذاتي للتوقيع" value={report.chain.selfTestOk ? 'ناجح' : 'فاشل'}
                color={report.chain.selfTestOk ? Colors.success : Colors.danger} />
              {report.chain.badSequence !== null && (
                <Row label="أول سجل مشتبه به" value={report.chain.badSequence} color={Colors.danger} />
              )}
              <Row label="أول سجل" value={formatTime(report.totals.firstAt)} />
              <Row label="آخر سجل" value={formatTime(report.totals.lastAt)} />
              <Row label="وقت إنشاء التقرير" value={formatTime(report.generatedAt)} />
            </Card>

            <Card title="الأمن">
              <Row label="محاولات وصول غير مصرح بها" value={report.security.unauthorizedTotal}
                color={report.security.unauthorizedTotal > 0 ? Colors.warning : undefined} />
              <Row label="خلال آخر 24 ساعة" value={report.security.unauthorizedLast24h} />
              <Row label="محاولات دخول فاشلة" value={report.security.failedLogins} />
              {report.security.topUnauthorizedUsers.map((u) => (
                <Row key={u.key} label={'  ' + u.key} value={u.count} />
              ))}
            </Card>

            <Card title="تغطية التدقيق">
              <Row label="جداول مغطاة" value={report.coverage.covered.length} />
              <Row label="مطلوبة وغير مغطاة"
                value={report.coverage.missingRequired.join('، ') || 'لا يوجد'}
                color={report.coverage.missingRequired.length ? Colors.danger : Colors.success} />
              <Row label="جداول بلا تغطية"
                value={report.coverage.partial.concat(report.coverage.uncovered).join('، ') || 'لا يوجد'} />
            </Card>

            <Card title="حسب نوع العملية">
              {report.byOperation.map((i) => (
                <Row key={i.key} label={auditOperationLabel(i.key)} value={i.count} />
              ))}
            </Card>

            <Card title="حسب الوحدة">
              {report.byEntity.map((i) => (
                <Row key={i.key} label={auditEntityLabel(i.key)} value={i.count} />
              ))}
            </Card>

            <Card title="المزامنة">
              <Row label="الحالة" value={syncStateLabel(report.sync.lastResult)} />
              <Row label="بانتظار الإرسال" value={report.sync.counts.pending + report.sync.counts.failed} />
              <Row label="تمت مزامنتها" value={report.sync.counts.sent} />
              <Row label="تعارضات/مرفوضة" value={report.sync.counts.conflict + report.sync.counts.rejected}
                color={report.sync.counts.conflict + report.sync.counts.rejected > 0 ? Colors.danger : undefined} />
            </Card>

            <Pressable style={styles.btnPrimary} onPress={share}>
              <Text style={styles.btnText}>مشاركة التقرير كنص</Text>
            </Pressable>
          </>
        )}

        <Pressable style={styles.btnSecondary} onPress={runTests} disabled={testing}>
          {testing ? <ActivityIndicator color={Colors.textPrimary} /> : null}
          <Text style={styles.btnText}>{testing ? 'جارٍ تشغيل الاختبارات...' : 'تشغيل اختبارات التكامل النهائية'}</Text>
        </Pressable>

        {tests && (
          <Card title={tests.ok ? 'نتيجة الاختبارات: نجحت كلها' : 'نتيجة الاختبارات: توجد إخفاقات'}>
            <Row label="ناجحة" value={tests.passed} color={Colors.success} />
            <Row label="فاشلة" value={tests.failed} color={tests.failed ? Colors.danger : undefined} />
            {tests.lines.map((l, i) => (
              <Text key={i} style={[styles.testLine, l.startsWith('فشل') && { color: Colors.danger }]}>{l}</Text>
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
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
  banner: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.md, padding: Spacing.lg,
    backgroundColor: Colors.card, borderWidth: 1.5, borderRadius: Radius.lg,
  },
  bannerTitle: { fontFamily: Fonts.bold, fontSize: FontSizes.lg, textAlign: 'right' },
  card: {
    backgroundColor: Colors.card, borderColor: Colors.border, borderWidth: 1,
    borderRadius: Radius.lg, padding: Spacing.lg, gap: Spacing.sm,
  },
  cardTitle: { color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md, textAlign: 'right' },
  row: { flexDirection: 'row-reverse', justifyContent: 'space-between', gap: Spacing.md },
  rowLabel: { flex: 1, color: Colors.textSecondary, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'right' },
  rowValue: { color: Colors.textPrimary, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'left', flexShrink: 1 },
  btnPrimary: {
    minHeight: 50, borderRadius: Radius.md, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center', padding: Spacing.md,
  },
  btnSecondary: {
    minHeight: 50, borderRadius: Radius.md, backgroundColor: Colors.secondary,
    borderWidth: 1, borderColor: Colors.border, flexDirection: 'row-reverse',
    alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, padding: Spacing.md,
  },
  btnText: { color: Colors.textOnPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md },
  testLine: { color: Colors.textSecondary, fontFamily: Fonts.regular, fontSize: FontSizes.xs, textAlign: 'right' },
});
