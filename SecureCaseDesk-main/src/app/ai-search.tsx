// SECURECASEDESK_PHASE11_S2
// شاشة البحث الذكي: بحث باللغة الطبيعية في القضايا والمذكرات المسموح للمستخدم بها فقط.
// البحث المحلي يعمل دائماً؛ الذكاء الاصطناعي (إن فُعّل) يحسّن فهم السؤال دون إرسال أي سجلات.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Search, X, ChevronDown, ChevronUp, FolderOpen, FileText } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Colors, Radius, Fonts, FontSizes } from '@/constants/theme';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration';
import { getAiSearch } from '@/modules/ai/ai-search-runtime';
import type { SearchRunResult, SearchStatus } from '@/modules/ai/ai-search';
import { sanitizeQueryForAi } from '@/modules/ai/ai-search-plan';
import { aiErrorMessage, isAiError } from '@/modules/ai/ai-types';

const EXAMPLES = ['قضايا سرقة الشهر الماضي', 'مذكرات هذا الأسبوع', 'القضايا المغلقة هذه السنة', 'مذكرات المستشفى السعودي'];

const ENGINE_LABEL: Record<SearchRunResult['engine'], string> = {
  local: 'بحث محلي (بدون ذكاء اصطناعي)',
  ai_local: 'بحث ذكي (محرك محلي)',
  ai_cloud: 'بحث ذكي (سحابي — أُرسل نص السؤال المنقّى فقط)',
};

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate());
}

function errText(e: unknown): string {
  if (isAiError(e)) return aiErrorMessage(e.code);
  return 'حدث خطأ غير متوقع أثناء البحث.';
}

export default function AiSearchScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'ai.use');
  const session = useMemo(() => (user ? { userId: user.id, role: user.role } : null), [user?.id, user?.role]);

  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SearchRunResult | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (user && !allowed) {
      void recordUnauthorizedAccess({
        userId: user.id, username: user.username, role: user.role,
        resource: 'screen:ai-search', detail: 'محاولة فتح البحث الذكي',
      });
    }
  }, [user?.id, allowed]);

  useEffect(() => {
    if (!allowed || !session) return;
    getAiSearch().getStatus(session).then(setStatus).catch((e) => Alert.alert('تعذر تحميل الحالة', errText(e)));
  }, [allowed, session]);

  const execute = useCallback(async (confirmCloud: boolean) => {
    if (!session) return;
    setBusy(true);
    try {
      const r = await getAiSearch().search(session, query, { confirmCloud });
      setResult(r);
      setExpanded(null);
    } catch (e) {
      Alert.alert('تعذر البحث', errText(e));
    } finally {
      setBusy(false);
    }
  }, [session, query]);

  const onSearch = useCallback(() => {
    if (busy) return;
    if (status?.cloudConfirmationNeeded) {
      const clean = sanitizeQueryForAi(query);
      Alert.alert(
        'تأكيد الإرسال إلى الخدمة السحابية',
        'سيُرسل النص التالي فقط (بعد حذف الأرقام الطويلة والبريد). لن تُرسل أي قضايا أو مذكرات أو بيانات محتجزين أو مرفقات:\n\n«' + clean.text + '»' +
          (clean.redactions > 0 ? '\n\n(حُذف ' + clean.redactions + ' عنصر حساس)' : '') +
          '\n\nتنبيه: لا يمكن كشف الأسماء آلياً. إن كان فيه اسم شخص فاختر البحث المحلي.',
        [
          { text: 'إلغاء', style: 'cancel' },
          { text: 'بحث محلي فقط', onPress: () => void execute(false) },
          { text: 'إرسال وبحث ذكي', onPress: () => void execute(true) },
        ]
      );
      return;
    }
    void execute(false);
  }, [busy, status, query, execute]);

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()}><X size={20} color={Colors.textPrimary} /></Pressable>
      <Text style={styles.title}>البحث الذكي</Text>
      <View style={styles.iconBtn} />
    </View>
  );

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.denied}>غير مصرح لك باستخدام البحث الذكي</Text>
          <Text style={styles.muted}>تم تسجيل هذه المحاولة في سجل التدقيق</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={[styles.statusText, { color: status?.aiUsable ? Colors.success : Colors.textSecondary }]}>
            {status ? status.message : 'جارٍ فحص الحالة…'}
          </Text>
          <Text style={styles.muted}>
            يشمل البحث ما تملك صلاحية الاطلاع عليه فقط
            {status ? ' (' + [status.searchable.case ? 'القضايا' : null, status.searchable.memo ? 'المذكرات' : null].filter(Boolean).join(' و') + ')' : ''}.
            لا يشمل المحتجزين ولا المرفقات.
          </Text>
        </View>

        <View style={styles.card}>
          <TextInput
            style={styles.input} value={query} onChangeText={setQuery} multiline
            placeholder="مثال: قضايا سرقة سيارة الشهر الماضي" placeholderTextColor={Colors.textMuted}
            maxLength={300} textAlign="right" returnKeyType="search" blurOnSubmit onSubmitEditing={onSearch}
          />
          <Pressable
            style={[styles.searchBtn, (busy || query.trim().length < 2) && { opacity: 0.5 }]}
            disabled={busy || query.trim().length < 2} onPress={onSearch}
          >
            {busy ? <ActivityIndicator color={Colors.textOnPrimary} /> : <Search size={18} color={Colors.textOnPrimary} />}
            <Text style={styles.searchBtnText}>بحث</Text>
          </Pressable>
          <View style={styles.chips}>
            {EXAMPLES.map((ex) => (
              <Pressable key={ex} style={styles.chip} onPress={() => setQuery(ex)}>
                <Text style={styles.chipText}>{ex}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {result && (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>{ENGINE_LABEL[result.engine]}</Text>
              {result.aiNote && <Text style={styles.warn}>{result.aiNote}</Text>}
              <Text style={styles.muted}>
                فُهم السؤال: {result.summary.entities.map((e) => (e === 'case' ? 'قضايا' : 'مذكرات')).join(' + ') || '—'}
                {result.summary.rangeLabel ? ' • الفترة: ' + result.summary.rangeLabel : ''}
                {result.summary.groups.length ? ' • الكلمات: ' + result.summary.groups.map((g) => g.join('/')).join('، ') : ''}
              </Text>
              <Text style={styles.muted}>
                {result.outcome.totalMatched === 0
                  ? 'لا نتائج.'
                  : 'النتائج: ' + result.outcome.totalMatched + (result.outcome.truncated ? ' (يُعرض أول ' + result.outcome.hits.length + ')' : '')}
              </Text>
            </View>

            {result.outcome.hits.map((h) => {
              const open = expanded === h.kind + h.id;
              const Icon = h.kind === 'case' ? FolderOpen : FileText;
              return (
                <Pressable key={h.kind + h.id} style={styles.card} onPress={() => setExpanded(open ? null : h.kind + h.id)}>
                  <View style={styles.hitHead}>
                    <Icon size={18} color={Colors.primaryLight} />
                    <Text style={styles.hitTitle} numberOfLines={open ? undefined : 2}>{h.title}</Text>
                    {open ? <ChevronUp size={18} color={Colors.textMuted} /> : <ChevronDown size={18} color={Colors.textMuted} />}
                  </View>
                  <Text style={styles.muted}>{h.subtitle} • {fmtDate(h.date)}</Text>
                  {h.snippet && <Text style={styles.snippet}>{h.snippet}</Text>}
                  {h.matched.length > 0 && <Text style={styles.matched}>تطابق في: {h.matched.join('، ')}</Text>}
                  {open && ( // SECURECASEDESK_PHASE11_S3
                    <Pressable
                      onPress={() => router.push({ pathname: '/ai-summary', params: { kind: h.kind, id: h.id } } as never)}
                      style={{ borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.primary, paddingVertical: 8, alignItems: 'center' }}
                    >
                      <Text style={{ color: Colors.primary, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm }}>تلخيص هذا السجل</Text>
                    </Pressable>
                  )}
                  {open && h.details.map((x) => (
                    <View key={x.label} style={styles.detailRow}>
                      <Text style={styles.detailLabel}>{x.label}</Text>
                      <Text style={styles.detailValue}>{x.value}</Text>
                    </View>
                  ))}
                </Pressable>
              );
            })}
          </>
        )}
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
  warn: { color: Colors.warning, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'right' },
  card: { backgroundColor: Colors.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, padding: 16, gap: 8 },
  sectionTitle: { color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md, textAlign: 'right' },
  statusText: { fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'right' },
  input: { minHeight: 56, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.borderLight, backgroundColor: Colors.secondary, color: Colors.textPrimary, paddingHorizontal: 12, paddingVertical: 10, fontFamily: Fonts.regular, fontSize: FontSizes.md, textAlign: 'right' },
  searchBtn: { height: 46, borderRadius: Radius.md, backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  searchBtnText: { color: Colors.textOnPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: Radius.full, borderWidth: 1, borderColor: Colors.borderLight, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { color: Colors.textSecondary, fontFamily: Fonts.regular, fontSize: FontSizes.xs },
  hitHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hitTitle: { flex: 1, color: Colors.textPrimary, fontFamily: Fonts.semiBold, fontSize: FontSizes.md, textAlign: 'right' },
  snippet: { color: Colors.textSecondary, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'right' },
  matched: { color: Colors.info, fontFamily: Fonts.regular, fontSize: FontSizes.xs, textAlign: 'right' },
  detailRow: { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 6, gap: 2 },
  detailLabel: { color: Colors.textMuted, fontFamily: Fonts.medium, fontSize: FontSizes.xs, textAlign: 'right' },
  detailValue: { color: Colors.textPrimary, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'right' },
});
