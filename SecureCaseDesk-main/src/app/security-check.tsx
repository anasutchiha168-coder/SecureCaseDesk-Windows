// SECURECASEDESK_PHASE12_S2
// شاشة «فحص الأمان على الجهاز» (لمدير النظام: audit.verify). تقرير حي للقراءة فقط، يُلتقط بلقطة شاشة كدليل في اختبار الجهاز الحقيقي.
// لا تعرض المفتاح ولا أي بيانات قضايا. الفحوص: SQLCipher، ترويسة الملف، مفتاح خاطئ، إعادة فتح (بزر)، اختبار سلسلة HMAC الذاتي.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { X, ShieldCheck, RefreshCw, RotateCcw } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Colors, Radius, Fonts, FontSizes } from '@/constants/theme';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration';
import { evaluateEncryptionFacts, summarizeChecks, type Check, type CheckLevel } from '@/modules/diagnostics/security-check';
import { collectEncryptionFacts, runAuditSelfTestSafe } from '@/modules/diagnostics/security-check-runtime';

const LEVEL_COLOR: Record<CheckLevel, string> = { pass: Colors.success, warn: Colors.warning, fail: Colors.danger };
const LEVEL_LABEL: Record<CheckLevel, string> = { pass: 'نجح', warn: 'لم يُفحص/تنبيه', fail: 'فشل' };

export default function SecurityCheckScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'audit.verify');
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState('');

  useEffect(() => {
    if (user && !allowed) {
      void recordUnauthorizedAccess({
        userId: user.id, username: user.username, role: user.role,
        resource: 'screen:security-check', detail: 'محاولة فتح فحص الأمان على الجهاز',
      });
    }
  }, [user?.id, allowed]);

  const run = useCallback(async (withReopen: boolean) => {
    setBusy(true);
    try {
      const facts = await collectEncryptionFacts({ withReopen });
      const list = evaluateEncryptionFacts(facts);
      const audit = runAuditSelfTestSafe();
      list.push({ id: 'hmac', title: 'اختبار سلسلة HMAC الذاتي', level: audit.ok ? 'pass' : 'fail', detail: audit.detail });
      setChecks(list);
      setStamp(new Date().toISOString());
    } catch {
      Alert.alert('تعذّر الفحص', 'حدث خطأ غير متوقع أثناء الفحص.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { if (allowed) void run(false); }, [allowed, run]);

  const onReopen = useCallback(() => {
    Alert.alert(
      'فحص إعادة فتح القاعدة',
      'سيُغلق اتصال القاعدة ويُعاد فتحه بالمفتاح المخزَّن. لا يغيّر أي بيانات. تأكد أنه لا توجد عملية حفظ جارية.',
      [{ text: 'إلغاء', style: 'cancel' }, { text: 'تنفيذ', onPress: () => void run(true) }]
    );
  }, [run]);

  const summary = useMemo(() => (checks ? summarizeChecks(checks) : null), [checks]);

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()}><X size={20} color={Colors.textPrimary} /></Pressable>
      <Text style={styles.title}>فحص الأمان على الجهاز</Text>
      <Pressable style={styles.iconBtn} onPress={() => void run(false)} disabled={busy}><RefreshCw size={18} color={Colors.textPrimary} /></Pressable>
    </View>
  );

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.denied}>غير مصرح لك بفتح هذه الشاشة</Text>
          <Text style={styles.muted}>تم تسجيل هذه المحاولة في سجل التدقيق</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.card}>
          <View style={styles.row}>
            <ShieldCheck size={20} color={summary ? LEVEL_COLOR[summary.overall] : Colors.textMuted} />
            <Text style={[styles.sectionTitle, summary && { color: LEVEL_COLOR[summary.overall] }]}>
              {summary ? 'الحالة العامة: ' + LEVEL_LABEL[summary.overall] : 'جارٍ الفحص…'}
            </Text>
          </View>
          {summary && <Text style={styles.muted}>نجح: {summary.pass} • تنبيه: {summary.warn} • فشل: {summary.fail}</Text>}
          <Text style={styles.muted}>الجهاز: {Platform.OS} {String(Platform.Version)} • الوقت: {stamp || '—'}</Text>
          <Text style={styles.muted}>هذا الفحص دليل مساعد؛ لا يغني عن بقية اختبارات الجهاز الحقيقي الموثقة.</Text>
        </View>

        {busy && !checks && <ActivityIndicator color={Colors.primary} />}

        {checks?.map((c) => (
          <View key={c.id} style={[styles.card, { borderColor: LEVEL_COLOR[c.level] }]}>
            <Text style={[styles.statusText, { color: LEVEL_COLOR[c.level] }]}>{LEVEL_LABEL[c.level]} — {c.title}</Text>
            <Text style={styles.muted}>{c.detail}</Text>
          </View>
        ))}

        <Pressable style={[styles.actionBtn, busy && { opacity: 0.5 }]} disabled={busy} onPress={onReopen}>
          <RotateCcw size={18} color={Colors.primary} /><Text style={styles.actionText}>تنفيذ فحص إعادة فتح القاعدة</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  iconBtn: { width: 40, height: 40, borderRadius: Radius.md, backgroundColor: Colors.card, alignItems: 'center', justifyContent: 'center' },
  title: { color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.lg },
  scroll: { paddingHorizontal: 16, paddingBottom: 40, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  denied: { color: Colors.danger, fontFamily: Fonts.bold, fontSize: FontSizes.md },
  muted: { color: Colors.textMuted, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'right' },
  card: { backgroundColor: Colors.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, padding: 16, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md, textAlign: 'right' },
  statusText: { fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'right' },
  actionBtn: { height: 46, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  actionText: { color: Colors.primary, fontFamily: Fonts.bold, fontSize: FontSizes.sm },
});
