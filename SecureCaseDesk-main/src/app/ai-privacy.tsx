// SECURECASEDESK_PHASE11_S5
// شاشة «فحص الخصوصية والصلاحيات» للذكاء الاصطناعي (لمدير النظام: ai.manage).
// تعرض تقريراً حياً بما يمكن التحقق منه محلياً، وتتيح مسح كل بيانات الذكاء الاصطناعي من الجهاز بتأكيد صريح.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { X, ShieldCheck, Trash2, RefreshCw } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Colors, Radius, Fonts, FontSizes } from '@/constants/theme';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration';
import { getAiPrivacyReport, resetAllAiData } from '@/modules/ai/ai-privacy-runtime';
import type { FindingLevel, PrivacyReport } from '@/modules/ai/ai-privacy-check';
import { aiErrorMessage, isAiError } from '@/modules/ai/ai-types';

const LEVEL_COLOR: Record<FindingLevel, string> = { ok: Colors.success, warn: Colors.warning, fail: Colors.danger };
const LEVEL_LABEL: Record<FindingLevel, string> = { ok: 'سليم', warn: 'تنبيه', fail: 'مشكلة' };

function errText(e: unknown): string {
  return isAiError(e) ? aiErrorMessage(e.code) : 'حدث خطأ غير متوقع.';
}

export default function AiPrivacyScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'ai.manage');
  const session = useMemo(() => (user ? { userId: user.id, role: user.role } : null), [user?.id, user?.role]);
  const [report, setReport] = useState<PrivacyReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user && !allowed) {
      void recordUnauthorizedAccess({
        userId: user.id, username: user.username, role: user.role,
        resource: 'screen:ai-privacy', detail: 'محاولة فتح فحص خصوصية الذكاء الاصطناعي',
      });
    }
  }, [user?.id, allowed]);

  const load = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try { setReport(await getAiPrivacyReport(session)); }
    catch (e) { Alert.alert('تعذر إعداد التقرير', errText(e)); }
    finally { setBusy(false); }
  }, [session]);

  useEffect(() => { if (allowed) void load(); }, [allowed, load]);

  const onReset = useCallback(() => {
    Alert.alert(
      'مسح كل بيانات الذكاء الاصطناعي؟',
      'سيُحذف مفتاح الخدمة السحابية والإقرار وكل الإعدادات من هذا الجهاز ويعود الذكاء الاصطناعي معطّلاً. لا يمسّ هذا أي قضية أو مذكرة. تُسجَّل العملية في سجل التدقيق.',
      [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'مسح', style: 'destructive', onPress: async () => {
          if (!session) return;
          setBusy(true);
          try { await resetAllAiData(session); await load(); Alert.alert('تم', 'مُسحت بيانات الذكاء الاصطناعي وعاد معطّلاً.'); }
          catch (e) { Alert.alert('تعذرت العملية', errText(e)); }
          finally { setBusy(false); }
        } },
      ]
    );
  }, [session, load]);

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()}><X size={20} color={Colors.textPrimary} /></Pressable>
      <Text style={styles.title}>فحص خصوصية الذكاء الاصطناعي</Text>
      <Pressable style={styles.iconBtn} onPress={() => void load()} disabled={busy}><RefreshCw size={18} color={Colors.textPrimary} /></Pressable>
    </View>
  );

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.denied}>غير مصرح لك بفتح فحص الخصوصية</Text>
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
            <ShieldCheck size={20} color={report ? LEVEL_COLOR[report.overall] : Colors.textMuted} />
            <Text style={[styles.sectionTitle, report && { color: LEVEL_COLOR[report.overall] }]}>
              {report ? 'الحالة العامة: ' + LEVEL_LABEL[report.overall] : 'جارٍ الفحص…'}
            </Text>
          </View>
          {report && <Text style={styles.muted}>سليم: {report.counts.ok} • تنبيه: {report.counts.warn} • مشكلة: {report.counts.fail}</Text>}
          <Text style={styles.muted}>هذا فحص لما يمكن التحقق منه محلياً فقط؛ لا يغني عن مراجعة المسؤول لسياسة الجهة.</Text>
        </View>

        {busy && !report && <ActivityIndicator color={Colors.primary} />}

        {report?.findings.map((f) => (
          <View key={f.id} style={[styles.card, { borderColor: LEVEL_COLOR[f.level] }]}>
            <Text style={[styles.statusText, { color: LEVEL_COLOR[f.level] }]}>{LEVEL_LABEL[f.level]} — {f.title}</Text>
            <Text style={styles.muted}>{f.detail}</Text>
          </View>
        ))}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>مسح بيانات الذكاء الاصطناعي</Text>
          <Text style={styles.muted}>يحذف مفتاح الخدمة السحابية والإقرار والإعدادات من هذا الجهاز فقط ويعيد الذكاء معطّلاً.</Text>
          <Pressable style={[styles.dangerBtn, busy && { opacity: 0.5 }]} disabled={busy} onPress={onReset}>
            <Trash2 size={18} color={Colors.danger} /><Text style={styles.dangerText}>مسح كل بيانات الذكاء الاصطناعي</Text>
          </Pressable>
        </View>
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
  dangerBtn: { height: 46, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.danger, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dangerText: { color: Colors.danger, fontFamily: Fonts.bold, fontSize: FontSizes.sm },
});
