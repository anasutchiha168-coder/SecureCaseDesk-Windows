// SECURECASEDESK_PHASE11_S3
// شاشة التلخيص الذكي: تلخيص قضية أو مذكرة مسموح للمستخدم بها فقط.
// الاستخراج الآلي (بدون ذكاء اصطناعي) متاح دائماً. ناتج الذكاء الاصطناعي مسودة تُراجَع وتُعتمد يدوياً،
// ولا يُحفظ في أي مكان: يختفي بمغادرة الشاشة.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert, TextInput, Share, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { X, Sparkles, FileText, FolderOpen, ListChecks, Check, Ban, Share2 } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Colors, Radius, Fonts, FontSizes } from '@/constants/theme';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration';
import { getAiSummary } from '@/modules/ai/ai-summary-runtime';
import type { SummaryPrepare, SummaryResult, SummaryStatus, SummaryTargetItem } from '@/modules/ai/ai-summary';
import type { SummaryKind } from '@/modules/ai/ai-summary-source';
import type { AiDraft } from '@/modules/ai/ai-review';
import { aiErrorMessage, isAiError } from '@/modules/ai/ai-types';

const ENGINE_LABEL: Record<SummaryResult['engine'], string> = {
  extractive: 'استخراج آلي (بدون ذكاء اصطناعي) — مقتطفات حرفية من السجل',
  ai_local: 'ملخص ذكي (محرك محلي)',
  ai_cloud: 'ملخص ذكي (سحابي — أُرسل نص السجل بعد تأكيدك)',
};

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate());
}

function errText(e: unknown): string {
  if (isAiError(e)) return aiErrorMessage(e.code);
  return 'حدث خطأ غير متوقع أثناء التلخيص.';
}

export default function AiSummaryScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ kind?: string; id?: string }>();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'ai.use');
  const session = useMemo(() => (user ? { userId: user.id, role: user.role } : null), [user?.id, user?.role]);

  const [status, setStatus] = useState<SummaryStatus | null>(null);
  const [kind, setKind] = useState<SummaryKind>(params.kind === 'memo' ? 'memo' : 'case');
  const [filter, setFilter] = useState('');
  const [items, setItems] = useState<SummaryTargetItem[]>([]);
  const [selected, setSelected] = useState<{ kind: SummaryKind; id: string; title: string } | null>(null);
  const [includeLinked, setIncludeLinked] = useState(true);
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<SummaryPrepare | null>(null);
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [editText, setEditText] = useState('');
  const [finalText, setFinalText] = useState<string | null>(null);

  useEffect(() => {
    if (user && !allowed) {
      void recordUnauthorizedAccess({
        userId: user.id, username: user.username, role: user.role,
        resource: 'screen:ai-summary', detail: 'محاولة فتح التلخيص الذكي',
      });
    }
  }, [user?.id, allowed]);

  useEffect(() => {
    if (!allowed || !session) return;
    getAiSummary().getStatus(session).then((st) => {
      setStatus(st);
      if (kind === 'case' && !st.summarizable.case && st.summarizable.memo) setKind('memo');
      if (kind === 'memo' && !st.summarizable.memo && st.summarizable.case) setKind('case');
    }).catch((e) => Alert.alert('تعذر تحميل الحالة', errText(e)));
  }, [allowed, session]);

  useEffect(() => {
    if (!allowed || !session || !status) return;
    getAiSummary().listTargets(session, kind, filter).then(setItems).catch((e) => Alert.alert('تعذر تحميل السجلات', errText(e)));
  }, [allowed, session, status, kind, filter]);

  // اختيار مباشر قادم من شاشة البحث الذكي.
  useEffect(() => {
    if (!params.id || !params.kind || selected) return;
    const hit = items.find((i) => i.id === params.id && i.kind === params.kind);
    if (hit) setSelected({ kind: hit.kind, id: hit.id, title: hit.title });
  }, [items, params.id, params.kind, selected]);

  const clearOutput = useCallback(() => {
    setPrepared(null); setResult(null); setDraft(null); setEditText(''); setFinalText(null);
  }, []);

  const choose = (it: SummaryTargetItem) => { clearOutput(); setSelected({ kind: it.kind, id: it.id, title: it.title }); };

  const run = useCallback(async (useAi: boolean, confirmedToken?: string) => {
    if (!session || !selected) return;
    setBusy(true);
    try {
      const r = await getAiSummary().summarize(session, { kind: selected.kind, id: selected.id }, {
        includeLinked, useAi, confirmCloud: !!confirmedToken, confirmedToken,
      });
      setPrepared(null); setResult(r); setFinalText(null);
      setDraft(r.draft); setEditText(r.draft ? r.draft.generatedText : '');
    } catch (e) {
      Alert.alert('تعذر التلخيص', errText(e));
    } finally {
      setBusy(false);
    }
  }, [session, selected, includeLinked]);

  const onSmart = useCallback(async () => {
    if (!session || !selected || busy) return;
    clearOutput();
    if (!status?.cloudConfirmationNeeded) { await run(true); return; }
    setBusy(true);
    try {
      setPrepared(await getAiSummary().prepare(session, { kind: selected.kind, id: selected.id }, { includeLinked, useAi: true }));
    } catch (e) {
      Alert.alert('تعذرت المعاينة', errText(e));
    } finally {
      setBusy(false);
    }
  }, [session, selected, busy, status, includeLinked, run, clearOutput]);

  const onReview = useCallback(async (decision: 'accept' | 'reject') => {
    if (!session || !selected || !draft) return;
    setBusy(true);
    try {
      const r = await getAiSummary().reviewDraft(session, draft, { kind: selected.kind, id: selected.id }, decision, editText);
      setDraft(r.draft);
      setFinalText(r.finalText);
    } catch (e) {
      Alert.alert('تعذرت المراجعة', errText(e));
    } finally {
      setBusy(false);
    }
  }, [session, selected, draft, editText]);

  const onShare = useCallback(async () => {
    const text = finalText ?? (result?.engine === 'extractive' ? result.extractive : null);
    if (!text) return;
    try { await Share.share({ message: text }); } catch { /* أُلغيت المشاركة */ }
  }, [finalText, result]);

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()}><X size={20} color={Colors.textPrimary} /></Pressable>
      <Text style={styles.title}>التلخيص الذكي</Text>
      <View style={styles.iconBtn} />
    </View>
  );

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.denied}>غير مصرح لك باستخدام التلخيص الذكي</Text>
          <Text style={styles.muted}>تم تسجيل هذه المحاولة في سجل التدقيق</Text>
        </View>
      </SafeAreaView>
    );
  }

  const canCase = status?.summarizable.case ?? false;
  const canMemo = status?.summarizable.memo ?? false;
  const reviewPending = draft?.status === 'pending_review';
  const shown = result && (result.engine === 'extractive' ? result.extractive : null);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={[styles.statusText, { color: status?.aiUsable ? Colors.success : Colors.textSecondary }]}>
            {status ? status.message : 'جارٍ فحص الحالة…'}
          </Text>
          <Text style={styles.muted}>
            يشمل التلخيص ما تملك صلاحية الاطلاع عليه فقط. لا يشمل المحتجزين ولا المرفقات. لا يُحفظ الملخص في أي سجل.
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.segment}>
            {canCase && (
              <Pressable style={[styles.segBtn, kind === 'case' && styles.segOn]} onPress={() => { setKind('case'); setSelected(null); clearOutput(); }}>
                <FolderOpen size={16} color={kind === 'case' ? Colors.textOnPrimary : Colors.textSecondary} />
                <Text style={[styles.segText, kind === 'case' && { color: Colors.textOnPrimary }]}>قضايا</Text>
              </Pressable>
            )}
            {canMemo && (
              <Pressable style={[styles.segBtn, kind === 'memo' && styles.segOn]} onPress={() => { setKind('memo'); setSelected(null); clearOutput(); }}>
                <FileText size={16} color={kind === 'memo' ? Colors.textOnPrimary : Colors.textSecondary} />
                <Text style={[styles.segText, kind === 'memo' && { color: Colors.textOnPrimary }]}>مذكرات</Text>
              </Pressable>
            )}
          </View>
          <TextInput
            style={styles.input} value={filter} onChangeText={setFilter} maxLength={100} textAlign="right"
            placeholder="ابحث بالرقم أو العنوان لاختيار السجل" placeholderTextColor={Colors.textMuted}
          />
          {items.length === 0 && <Text style={styles.muted}>لا توجد سجلات.</Text>}
          {items.slice(0, 30).map((it) => {
            const on = selected?.id === it.id && selected?.kind === it.kind;
            return (
              <Pressable key={it.kind + it.id} style={[styles.row, on && styles.rowOn]} onPress={() => choose(it)}>
                <Text style={styles.rowTitle} numberOfLines={2}>{it.title}</Text>
                <Text style={styles.muted}>{it.subtitle} • {fmtDate(it.date)}{it.chars > 0 ? ' • ' + it.chars + ' حرف' : ''}</Text>
              </Pressable>
            );
          })}
          {items.length > 30 && <Text style={styles.muted}>يُعرض أول 30 سجلاً؛ ضيّق البحث لإظهار غيرها.</Text>}
        </View>

        {selected && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle} numberOfLines={2}>{selected.title}</Text>
            {canCase && canMemo && (
              <View style={styles.switchRow}>
                <Switch value={includeLinked} onValueChange={(v) => { setIncludeLinked(v); clearOutput(); }} />
                <Text style={styles.switchLabel}>تضمين السجلات المرتبطة (مذكرات القضية / قضية المذكرة)</Text>
              </View>
            )}
            {status?.aiUsable && (
              <Pressable style={[styles.primaryBtn, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void onSmart()}>
                {busy ? <ActivityIndicator color={Colors.textOnPrimary} /> : <Sparkles size={18} color={Colors.textOnPrimary} />}
                <Text style={styles.primaryText}>{status.cloudConfirmationNeeded ? 'معاينة ما سيُرسل ثم تلخيص ذكي' : 'تلخيص ذكي'}</Text>
              </Pressable>
            )}
            <Pressable style={[styles.ghostBtn, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => { clearOutput(); void run(false); }}>
              <ListChecks size={18} color={Colors.primary} />
              <Text style={styles.ghostText}>استخراج آلي بدون ذكاء اصطناعي</Text>
            </Pressable>
          </View>
        )}

        {prepared && (
          <View style={[styles.card, { borderColor: Colors.warning }]}>
            <Text style={styles.sectionTitle}>تأكيد الإرسال إلى الخدمة السحابية</Text>
            <Text style={styles.muted}>
              سيُرسل النص التالي بالضبط ({prepared.chars} حرفاً، {prepared.chunks} جزء). لن تُرسل بيانات محتجزين أو مرفقات.
              {prepared.withheldFields.length ? ' حُجبت: ' + prepared.withheldFields.join('، ') + '.' : ''}
              {prepared.redactions > 0 ? ' حُذف ' + prepared.redactions + ' عنصر حساس (هويات/أرقام طويلة/بريد/روابط).' : ''}
              {prepared.truncated ? ' المستند أطول من الحد؛ سيُرسل جزؤه الأول فقط.' : ''}
            </Text>
            <Text style={styles.warn}>تنبيه: لا يمكن كشف الأسماء داخل النص الحر آلياً. إن رأيت اسماً فاختر الاستخراج الآلي.</Text>
            <ScrollView style={styles.payload} nestedScrollEnabled>
              <Text style={styles.payloadText}>{prepared.cloudPayload}</Text>
            </ScrollView>
            <Pressable style={styles.primaryBtn} disabled={busy} onPress={() => void run(true, prepared.token ?? undefined)}>
              <Text style={styles.primaryText}>إرسال وتلخيص</Text>
            </Pressable>
            <Pressable style={styles.ghostBtn} onPress={() => setPrepared(null)}>
              <Text style={styles.ghostText}>إلغاء (لا يُرسل شيء)</Text>
            </Pressable>
          </View>
        )}

        {result && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>{ENGINE_LABEL[result.engine]}</Text>
            {result.notes.map((n) => <Text key={n} style={styles.warn}>{n}</Text>)}
            {result.warnings.unsupportedNumbers.length > 0 && (
              <Text style={styles.warn}>أرقام لم ترد في المصدر: {result.warnings.unsupportedNumbers.join('، ')}</Text>
            )}
            {result.warnings.judgmentTerms.length > 0 && (
              <Text style={styles.warn}>عبارات حكمية لم ترد في المصدر: {result.warnings.judgmentTerms.join('، ')}</Text>
            )}

            {shown && <Text style={styles.body} selectable>{shown}</Text>}

            {result.engine !== 'extractive' && draft && (
              <>
                {reviewPending && (
                  <Text style={styles.warn}>مسودة بانتظار مراجعتك — لم تُعتمد. عدّلها إن لزم ثم اعتمدها أو ارفضها.</Text>
                )}
                {draft.status === 'rejected' && <Text style={styles.warn}>رُفضت المسودة ولن تُستعمل.</Text>}
                {draft.status === 'accepted' && <Text style={[styles.statusText, { color: Colors.success }]}>اعتُمد النص{draft.edited ? ' (بعد تعديلك)' : ''}.</Text>}
                {draft.status !== 'rejected' && (
                  <TextInput
                    style={[styles.input, { minHeight: 180 }]} value={draft.status === 'accepted' ? (finalText ?? editText) : editText}
                    onChangeText={setEditText} editable={reviewPending} multiline textAlign="right" textAlignVertical="top"
                  />
                )}
                {reviewPending && (
                  <View style={styles.actions}>
                    <Pressable style={[styles.primaryBtn, { flex: 1 }, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void onReview('accept')}>
                      <Check size={18} color={Colors.textOnPrimary} /><Text style={styles.primaryText}>اعتماد</Text>
                    </Pressable>
                    <Pressable style={[styles.ghostBtn, { flex: 1 }, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void onReview('reject')}>
                      <Ban size={18} color={Colors.danger} /><Text style={[styles.ghostText, { color: Colors.danger }]}>رفض</Text>
                    </Pressable>
                  </View>
                )}
              </>
            )}

            {(finalText || result.engine === 'extractive') && (
              <Pressable style={styles.ghostBtn} onPress={() => void onShare()}>
                <Share2 size={18} color={Colors.primary} /><Text style={styles.ghostText}>مشاركة النص</Text>
              </Pressable>
            )}
            <Text style={styles.muted}>
              المصدر: {result.source.chars} حرفاً{result.source.chunks > 1 ? ' في ' + result.source.chunks + ' أجزاء' : ''}
              {result.source.linkedCount ? ' • سجلات مرتبطة: ' + result.source.linkedCount : ''}
            </Text>
          </View>
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
  segment: { flexDirection: 'row', gap: 8 },
  segBtn: { flex: 1, height: 40, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.borderLight, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  segOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  segText: { color: Colors.textSecondary, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm },
  input: { minHeight: 44, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.borderLight, backgroundColor: Colors.secondary, color: Colors.textPrimary, paddingHorizontal: 12, paddingVertical: 10, fontFamily: Fonts.regular, fontSize: FontSizes.md, textAlign: 'right' },
  row: { borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, padding: 10, gap: 2 },
  rowOn: { borderColor: Colors.primary, backgroundColor: Colors.secondary },
  rowTitle: { color: Colors.textPrimary, fontFamily: Fonts.semiBold, fontSize: FontSizes.md, textAlign: 'right' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  switchLabel: { flex: 1, color: Colors.textSecondary, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'right' },
  primaryBtn: { height: 46, borderRadius: Radius.md, backgroundColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  primaryText: { color: Colors.textOnPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md },
  ghostBtn: { height: 44, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.borderLight, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  ghostText: { color: Colors.primary, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm },
  actions: { flexDirection: 'row', gap: 8 },
  payload: { maxHeight: 240, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.secondary, padding: 10 },
  payloadText: { color: Colors.textPrimary, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'right' },
  body: { color: Colors.textPrimary, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'right', lineHeight: 22 },
});
