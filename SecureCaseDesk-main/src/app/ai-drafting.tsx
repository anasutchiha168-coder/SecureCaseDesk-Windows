// SECURECASEDESK_PHASE11_S4
// شاشة المساعد الذكي لصياغة المستندات: صياغة مذكرة/تقرير/خطاب أو مراجعة نص موجود.
// القالب الآلي والفحص الآلي (بدون ذكاء اصطناعي) متاحان دائماً. ناتج الذكاء الاصطناعي مسودة تُراجَع وتُعتمد يدوياً،
// ولا يُحفظ في أي مكان ولا يُنشئ أي سجل: يختفي بمغادرة الشاشة، والمستخدم هو من ينشئ المذكرة الفعلية.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert, TextInput, Share, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { X, Sparkles, ListChecks, Check, Ban, Share2, FilePlus } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Colors, Radius, Fonts, FontSizes } from '@/constants/theme';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration';
import { getAiDrafting } from '@/modules/ai/ai-drafting-runtime';
import type { DraftingCaseItem, DraftingPrepare, DraftingRequest, DraftingResult, DraftingStatus } from '@/modules/ai/ai-drafting';
import {
  DOC_KINDS, DOC_KIND_LABEL, DRAFT_LIMITS, DRAFT_TONES, TONE_LABEL,
  type DraftDocKind, type DraftMode, type DraftTone,
} from '@/modules/ai/ai-drafting-text';
import type { AiDraft } from '@/modules/ai/ai-review';
import { aiErrorMessage, isAiError } from '@/modules/ai/ai-types';
import { stashMemoPrefill } from '@/modules/ai/ai-memo-handoff-runtime'; // SECURECASEDESK_PHASE11_S5

const ENGINE_LABEL: Record<DraftingResult['engine'], string> = {
  template: 'قالب رسمي آلي (بدون ذكاء اصطناعي) — يرتّب ما كتبته فقط ويترك الباقي فراغاً',
  rules: 'فحص آلي للنص (بدون ذكاء اصطناعي)',
  ai_local: 'مسودة ذكية (محرك محلي)',
  ai_cloud: 'مسودة ذكية (سحابي — أُرسل ما كتبته بعد تأكيدك)',
};

function errText(e: unknown): string {
  if (isAiError(e)) return aiErrorMessage(e.code);
  return 'حدث خطأ غير متوقع أثناء الصياغة.';
}

export default function AiDraftingScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'ai.use') && can(user.role, 'memos.view');
  const session = useMemo(() => (user ? { userId: user.id, role: user.role } : null), [user?.id, user?.role]);

  const [status, setStatus] = useState<DraftingStatus | null>(null);
  const [mode, setMode] = useState<DraftMode>('compose');
  const [docKind, setDocKind] = useState<DraftDocKind>('memo');
  const [tone, setTone] = useState<DraftTone>('formal');
  const [memoTypes, setMemoTypes] = useState<string[]>([]);
  const [memoType, setMemoType] = useState('');
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [points, setPoints] = useState('');
  const [existing, setExisting] = useState('');
  const [caseFilter, setCaseFilter] = useState('');
  const [caseItems, setCaseItems] = useState<DraftingCaseItem[]>([]);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [caseDetails, setCaseDetails] = useState(false);

  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<DraftingPrepare | null>(null);
  const [result, setResult] = useState<DraftingResult | null>(null);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [editText, setEditText] = useState('');
  const [finalText, setFinalText] = useState<string | null>(null);

  useEffect(() => {
    if (user && !allowed) {
      void recordUnauthorizedAccess({
        userId: user.id, username: user.username, role: user.role,
        resource: 'screen:ai-drafting', detail: 'محاولة فتح المساعد الذكي لصياغة المستندات',
      });
    }
  }, [user?.id, allowed]);

  useEffect(() => {
    if (!allowed || !session) return;
    const ai = getAiDrafting();
    ai.getStatus(session).then(setStatus).catch((e) => Alert.alert('تعذر تحميل الحالة', errText(e)));
    ai.listMemoTypeNames(session).then(setMemoTypes).catch(() => setMemoTypes([]));
  }, [allowed, session]);

  useEffect(() => {
    if (!allowed || !session || !status?.canUseCases || mode !== 'compose') return;
    getAiDrafting().listCases(session, caseFilter).then(setCaseItems).catch(() => setCaseItems([]));
  }, [allowed, session, status, mode, caseFilter]);

  const clearOutput = useCallback(() => {
    setPrepared(null); setResult(null); setDraft(null); setEditText(''); setFinalText(null);
  }, []);

  const buildRequest = useCallback((): DraftingRequest => ({
    mode, docKind, tone,
    memoTypeName: docKind === 'memo' ? memoType : '',
    recipient, subject, points, existingText: existing,
    caseId: mode === 'compose' ? caseId : null,
    includeCaseDetails: caseDetails,
  }), [mode, docKind, tone, memoType, recipient, subject, points, existing, caseId, caseDetails]);

  const run = useCallback(async (useAi: boolean, confirmedToken?: string) => {
    if (!session) return;
    setBusy(true);
    try {
      const r = await getAiDrafting().generate(session, buildRequest(), { useAi, confirmCloud: !!confirmedToken, confirmedToken });
      setPrepared(null); setResult(r); setFinalText(null);
      setDraft(r.draft); setEditText(r.draft ? r.draft.generatedText : '');
    } catch (e) {
      Alert.alert('تعذرت العملية', errText(e));
    } finally {
      setBusy(false);
    }
  }, [session, buildRequest]);

  const onSmart = useCallback(async () => {
    if (!session || busy) return;
    clearOutput();
    if (!status?.cloudConfirmationNeeded) { await run(true); return; }
    setBusy(true);
    try {
      setPrepared(await getAiDrafting().prepare(session, buildRequest()));
    } catch (e) {
      Alert.alert('تعذرت المعاينة', errText(e));
    } finally {
      setBusy(false);
    }
  }, [session, busy, status, buildRequest, run, clearOutput]);

  const onReview = useCallback(async (decision: 'accept' | 'reject') => {
    if (!session || !draft) return;
    setBusy(true);
    try {
      const r = await getAiDrafting().reviewDraft(session, draft, { mode, docKind }, decision, editText);
      setDraft(r.draft);
      setFinalText(r.finalText);
    } catch (e) {
      Alert.alert('تعذرت المراجعة', errText(e));
    } finally {
      setBusy(false);
    }
  }, [session, draft, mode, docKind, editText]);

  const onShare = useCallback(async () => {
    const text = finalText ?? result?.offlineText ?? null;
    if (!text) return;
    try { await Share.share({ message: text }); } catch { /* أُلغيت المشاركة */ }
  }, [finalText, result]);

  // SECURECASEDESK_PHASE11_S5: يفتح نموذج المذكرة معبّأً دون حفظ. النص يُسلَّم عبر الذاكرة (لا عبر مسار التنقل)،
  // ولا يُقبل نص ذكاء اصطناعي إلا بعد اعتماده بشرياً. الحفظ الفعلي يدوي من شاشة المذكرات.
  const canCreateMemo = docKind === 'memo' && !!user && can(user.role, 'memos.manage') &&
    ((draft?.status === 'accepted' && !!finalText) || (result?.engine === 'template' && !!result.offlineText));
  const onCreateMemo = useCallback(async () => {
    if (!session || busy) return;
    setBusy(true);
    try {
      const common = { recipient, subject, memoTypeName: memoType, caseId: mode === 'compose' ? caseId : null };
      if (draft && draft.status === 'accepted' && finalText) {
        await stashMemoPrefill(session, { origin: 'ai_accepted', draft, ...common });
      } else if (result?.engine === 'template' && result.offlineText) {
        await stashMemoPrefill(session, { origin: 'template', text: result.offlineText, ...common });
      } else {
        return;
      }
      router.push('/(tabs)/memos' as never);
    } catch (e) {
      Alert.alert('تعذر فتح نموذج المذكرة', errText(e));
    } finally {
      setBusy(false);
    }
  }, [session, busy, draft, finalText, result, recipient, subject, memoType, mode, caseId, router]);

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()}><X size={20} color={Colors.textPrimary} /></Pressable>
      <Text style={styles.title}>المساعد في صياغة المستندات</Text>
      <View style={styles.iconBtn} />
    </View>
  );

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.denied}>غير مصرح لك باستخدام المساعد في صياغة المستندات</Text>
          <Text style={styles.muted}>تم تسجيل هذه المحاولة في سجل التدقيق</Text>
        </View>
      </SafeAreaView>
    );
  }

  const reviewPending = draft?.status === 'pending_review';
  const canSubmitCompose = subject.trim().length >= DRAFT_LIMITS.minSubject || points.trim().length >= DRAFT_LIMITS.minPoints;
  const canSubmit = mode === 'compose' ? canSubmitCompose : existing.trim().length >= DRAFT_LIMITS.minExisting;
  const w = result?.warnings;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={[styles.statusText, { color: status?.aiUsable ? Colors.success : Colors.textSecondary }]}>
            {status ? status.message : 'جارٍ فحص الحالة…'}
          </Text>
          <Text style={styles.muted}>
            المسودة اقتراح فقط: لا تُحفظ في أي سجل ولا تُنشئ مذكرة. راجعها واعتمدها ثم أنشئ المذكرة بنفسك من شاشة المذكرات. لا تُدرج أسماء أطراف القضية آلياً، ولا بيانات المحتجزين أو المرفقات.
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.segment}>
            <Pressable style={[styles.segBtn, mode === 'compose' && styles.segOn]} onPress={() => { setMode('compose'); clearOutput(); }}>
              <Text style={[styles.segText, mode === 'compose' && { color: Colors.textOnPrimary }]}>صياغة جديدة</Text>
            </Pressable>
            <Pressable style={[styles.segBtn, mode === 'review' && styles.segOn]} onPress={() => { setMode('review'); clearOutput(); }}>
              <Text style={[styles.segText, mode === 'review' && { color: Colors.textOnPrimary }]}>مراجعة نص</Text>
            </Pressable>
          </View>
          <View style={styles.segment}>
            {DOC_KINDS.map((k) => (
              <Pressable key={k} style={[styles.segBtn, docKind === k && styles.segOn]} onPress={() => { setDocKind(k); clearOutput(); }}>
                <Text style={[styles.segText, docKind === k && { color: Colors.textOnPrimary }]}>{DOC_KIND_LABEL[k]}</Text>
              </Pressable>
            ))}
          </View>
          {mode === 'compose' && (
            <View style={styles.segment}>
              {DRAFT_TONES.map((t) => (
                <Pressable key={t} style={[styles.segBtn, tone === t && styles.segOn]} onPress={() => { setTone(t); clearOutput(); }}>
                  <Text style={[styles.segText, tone === t && { color: Colors.textOnPrimary }]}>{TONE_LABEL[t]}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>

        {mode === 'compose' ? (
          <View style={styles.card}>
            {docKind === 'memo' && memoTypes.length > 0 && (
              <>
                <Text style={styles.label}>نوع المذكرة (اختياري)</Text>
                <View style={styles.chips}>
                  {memoTypes.map((n) => (
                    <Pressable key={n} style={[styles.chip, memoType === n && styles.chipOn]} onPress={() => setMemoType(memoType === n ? '' : n)}>
                      <Text style={[styles.chipText, memoType === n && { color: Colors.textOnPrimary }]}>{n}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
            <Text style={styles.label}>الجهة الموجّهة إليها</Text>
            <TextInput style={styles.input} value={recipient} onChangeText={setRecipient} maxLength={DRAFT_LIMITS.recipient} textAlign="right" placeholder="مثال: المستشفى السعودي" placeholderTextColor={Colors.textMuted} />
            <Text style={styles.label}>الموضوع</Text>
            <TextInput style={styles.input} value={subject} onChangeText={setSubject} maxLength={DRAFT_LIMITS.subject} textAlign="right" placeholder="موضوع المستند" placeholderTextColor={Colors.textMuted} />
            <Text style={styles.label}>النقاط المطلوب تضمينها (سطر لكل نقطة)</Text>
            <TextInput
              style={[styles.input, { minHeight: 130 }]} value={points} onChangeText={setPoints} maxLength={DRAFT_LIMITS.points}
              multiline textAlign="right" textAlignVertical="top" placeholder="اكتب الوقائع والأرقام والتواريخ بدقة؛ لن يُضاف شيء من خارجها" placeholderTextColor={Colors.textMuted}
            />
            <Text style={styles.muted}>{points.length} / {DRAFT_LIMITS.points}</Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.label}>النص المراد مراجعته</Text>
            <TextInput
              style={[styles.input, { minHeight: 200 }]} value={existing} onChangeText={setExisting} maxLength={DRAFT_LIMITS.existing}
              multiline textAlign="right" textAlignVertical="top" placeholder="الصق نص المذكرة أو التقرير أو الخطاب هنا" placeholderTextColor={Colors.textMuted}
            />
            <Text style={styles.muted}>{existing.length} / {DRAFT_LIMITS.existing} — النص الأطول من الحد يُرفض ولا يُقتطع.</Text>
          </View>
        )}

        {mode === 'compose' && status?.canUseCases && (
          <View style={styles.card}>
            <Text style={styles.label}>ربط قضية للاسترشاد (اختياري)</Text>
            <TextInput style={styles.input} value={caseFilter} onChangeText={setCaseFilter} maxLength={100} textAlign="right" placeholder="ابحث برقم القضية أو عنوانها" placeholderTextColor={Colors.textMuted} />
            {caseItems.slice(0, 8).map((c) => {
              const on = caseId === c.id;
              return (
                <Pressable key={c.id} style={[styles.row, on && styles.rowOn]} onPress={() => setCaseId(on ? null : c.id)}>
                  <Text style={styles.rowTitle} numberOfLines={2}>{c.title}</Text>
                  <Text style={styles.muted}>{c.subtitle}</Text>
                </Pressable>
              );
            })}
            {caseId && (
              <View style={styles.switchRow}>
                <Switch value={caseDetails} onValueChange={setCaseDetails} />
                <Text style={styles.switchLabel}>تضمين تفاصيل الحادث (أسماء المدّعي والمتهمين لا تُضمَّن أبداً)</Text>
              </View>
            )}
          </View>
        )}

        <View style={styles.card}>
          {status?.aiUsable && (
            <Pressable style={[styles.primaryBtn, (busy || !canSubmit) && { opacity: 0.5 }]} disabled={busy || !canSubmit} onPress={() => void onSmart()}>
              {busy ? <ActivityIndicator color={Colors.textOnPrimary} /> : <Sparkles size={18} color={Colors.textOnPrimary} />}
              <Text style={styles.primaryText}>
                {status.cloudConfirmationNeeded ? 'معاينة ما سيُرسل ثم ' : ''}{mode === 'compose' ? 'صياغة ذكية' : 'مراجعة ذكية'}
              </Text>
            </Pressable>
          )}
          <Pressable style={[styles.ghostBtn, (busy || !canSubmit) && { opacity: 0.5 }]} disabled={busy || !canSubmit} onPress={() => { clearOutput(); void run(false); }}>
            <ListChecks size={18} color={Colors.primary} />
            <Text style={styles.ghostText}>{mode === 'compose' ? 'قالب رسمي بدون ذكاء اصطناعي' : 'فحص آلي بدون ذكاء اصطناعي'}</Text>
          </Pressable>
        </View>

        {prepared && (
          <View style={[styles.card, { borderColor: Colors.warning }]}>
            <Text style={styles.sectionTitle}>تأكيد الإرسال إلى الخدمة السحابية</Text>
            <Text style={styles.muted}>
              سيُرسل النص التالي بالضبط ({prepared.chars} حرفاً) مع تعليمات ثابتة للتطبيق لا تحوي بياناتك. لن تُرسل بيانات محتجزين أو مرفقات أو أسماء أطراف القضية.
              {prepared.redactions > 0 ? ' حُذف ' + prepared.redactions + ' عنصر حساس (هويات/أرقام طويلة/بريد/روابط).' : ''}
            </Text>
            <Text style={styles.warn}>تنبيه: لا يمكن كشف الأسماء داخل ما كتبته آلياً. إن رأيت اسماً لا تريد إرساله فاختر القالب أو الفحص الآلي.</Text>
            <ScrollView style={styles.payload} nestedScrollEnabled>
              <Text style={styles.payloadText}>{prepared.cloudPayload}</Text>
            </ScrollView>
            <Pressable style={styles.primaryBtn} disabled={busy} onPress={() => void run(true, prepared.token ?? undefined)}>
              <Text style={styles.primaryText}>إرسال وصياغة</Text>
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
            {w && w.unsupportedNumbers.length > 0 && <Text style={styles.warn}>أرقام لم ترد فيما كتبته: {w.unsupportedNumbers.join('، ')}</Text>}
            {w && w.droppedNumbers.length > 0 && <Text style={styles.warn}>أرقام كتبتها ولم تظهر في المسودة: {w.droppedNumbers.join('، ')}</Text>}
            {w && w.judgmentTerms.length > 0 && <Text style={styles.warn}>عبارات حكمية لم ترد فيما كتبته: {w.judgmentTerms.join('، ')}</Text>}
            {w && w.placeholders > 0 && <Text style={styles.muted}>فراغات بانتظار تعبئتك: {w.placeholders}</Text>}

            {result.offlineText && <Text style={styles.body} selectable>{result.offlineText}</Text>}

            {result.engine === 'rules' && result.ruleFindings.length === 0 && (
              <Text style={[styles.statusText, { color: Colors.success }]}>لم يجد الفحص الآلي ملاحظات شكلية. (هذا لا يغني عن مراجعتك للمضمون.)</Text>
            )}

            {result.engine !== 'template' && result.engine !== 'rules' && draft && (
              <>
                {reviewPending && <Text style={styles.warn}>مسودة بانتظار مراجعتك — لم تُعتمد. عدّلها إن لزم ثم اعتمدها أو ارفضها.</Text>}
                {draft.status === 'rejected' && <Text style={styles.warn}>رُفضت المسودة ولن تُستعمل.</Text>}
                {draft.status === 'accepted' && <Text style={[styles.statusText, { color: Colors.success }]}>اعتُمد النص{draft.edited ? ' (بعد تعديلك)' : ''}.</Text>}
                {draft.status !== 'rejected' && (
                  <TextInput
                    style={[styles.input, { minHeight: 240 }]} value={draft.status === 'accepted' ? (finalText ?? editText) : editText}
                    onChangeText={setEditText} editable={reviewPending} multiline textAlign="right" textAlignVertical="top"
                  />
                )}
                {result.reviewNotes && (
                  <>
                    <Text style={styles.label}>ملاحظات المراجعة (ليست جزءاً من النص)</Text>
                    <Text style={styles.body} selectable>{result.reviewNotes}</Text>
                  </>
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

            {result.ruleFindings.length > 0 && (
              <>
                <Text style={styles.label}>نتائج الفحص الآلي</Text>
                {result.ruleFindings.map((m) => <Text key={m} style={styles.muted}>• {m}</Text>)}
              </>
            )}

            {canCreateMemo && (
              <>
                <Pressable style={[styles.primaryBtn, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void onCreateMemo()}>
                  <FilePlus size={18} color={Colors.textOnPrimary} /><Text style={styles.primaryText}>أنشئ مذكرة من المسودة</Text>
                </Pressable>
                <Text style={styles.muted}>يفتح نموذج المذكرة معبّأً دون حفظ: راجع الحقول واكتب رقم المذكرة بنفسك ثم احفظ.</Text>
              </>
            )}

            {(finalText || result.offlineText) && (
              <Pressable style={styles.ghostBtn} onPress={() => void onShare()}>
                <Share2 size={18} color={Colors.primary} /><Text style={styles.ghostText}>مشاركة النص</Text>
              </Pressable>
            )}
            <Text style={styles.muted}>
              المرسَل/المعالَج: {result.source.chars} حرفاً{result.source.caseLinked ? ' • مع بيانات قضية مرتبطة' : ''}
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
  label: { color: Colors.textSecondary, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'right' },
  card: { backgroundColor: Colors.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, padding: 16, gap: 8 },
  sectionTitle: { color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md, textAlign: 'right' },
  statusText: { fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'right' },
  segment: { flexDirection: 'row', gap: 8 },
  segBtn: { flex: 1, minHeight: 40, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.borderLight, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 4 },
  segOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  segText: { color: Colors.textSecondary, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  chip: { borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.borderLight, paddingHorizontal: 10, paddingVertical: 6 },
  chipOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { color: Colors.textSecondary, fontFamily: Fonts.regular, fontSize: FontSizes.sm },
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
