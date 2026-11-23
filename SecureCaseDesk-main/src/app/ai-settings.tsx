// SECURECASEDESK_PHASE11_S1
// شاشة إعدادات الذكاء الاصطناعي (مدير النظام فقط). التحكم بالتفعيل/التعطيل ووضع التشغيل والميزات.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert, Switch, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { RefreshCw, X } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Colors, Radius, Fonts, FontSizes } from '@/constants/theme';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration';
import { getAiManager } from '@/modules/ai/ai-runtime';
import type { AiPublicState } from '@/modules/ai/ai-manager';
import {
  AI_FEATURES, AI_CONSENT_VERSION, aiErrorMessage, isAiError, type AiMode,
} from '@/modules/ai/ai-types';

const MODE_LABELS: Record<AiMode, string> = { disabled: 'معطّل', local: 'محلي', cloud: 'سحابي' };
const MODES: AiMode[] = ['disabled', 'local', 'cloud'];

const CONSENT_TEXT =
  'عند تفعيل الوضع السحابي قد تُرسَل نصوص تختارها أنت إلى خدمة خارجية خارج الجهاز. ' +
  'لا تُرسل بيانات المحتجزين ولا المرفقات أبداً. لا يُرسل أي شيء إلا بعد تأكيدك الصريح في كل طلب. ' +
  'مخرجات الذكاء الاصطناعي مسودات تخضع لمراجعتك قبل اعتمادها ولا تُعدّل أي سجل تلقائياً.';

function errText(e: unknown): string {
  if (isAiError(e)) return aiErrorMessage(e.code);
  return 'حدث خطأ غير متوقع';
}

export default function AiSettingsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'ai.manage');
  const session = user ? { userId: user.id, role: user.role } : null;

  const [state, setState] = useState<AiPublicState | null>(null);
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    if (user && !allowed) {
      void recordUnauthorizedAccess({
        userId: user.id, username: user.username, role: user.role,
        resource: 'screen:ai-settings', detail: 'محاولة فتح إعدادات الذكاء الاصطناعي',
      });
    }
  }, [user?.id, allowed]);

  const apply = (s: AiPublicState) => {
    setState(s);
    setEndpoint(s.cloud.endpoint ?? '');
    setModel(s.cloud.model ?? '');
  };

  const load = useCallback(async () => {
    if (!session) return;
    try {
      apply(await getAiManager().getState(session));
    } catch (e) {
      Alert.alert('تعذر تحميل الإعدادات', errText(e));
    }
  }, [user?.id]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed]);

  const run = async (task: () => Promise<AiPublicState>) => {
    if (!session || busy) return;
    setBusy(true);
    try {
      apply(await task());
    } catch (e) {
      Alert.alert('تعذر تنفيذ العملية', errText(e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const mgr = getAiManager();

  const changeMode = (mode: AiMode) => {
    if (!state || mode === state.mode) return;
    if (mode === 'cloud') {
      Alert.alert('تفعيل الوضع السحابي', 'سيُسمح بإرسال نصوص إلى خدمة خارجية بعد تأكيدك في كل طلب. هل تريد المتابعة؟', [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'متابعة', onPress: () => void run(() => mgr.updateSettings(session, { mode })) },
      ]);
      return;
    }
    void run(() => mgr.updateSettings(session, { mode }));
  };

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()}>
        <X size={20} color={Colors.textPrimary} />
      </Pressable>
      <Text style={styles.title}>إعدادات الذكاء الاصطناعي</Text>
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
          <Text style={styles.denied}>غير مصرح لك بإدارة الذكاء الاصطناعي</Text>
          <Text style={styles.muted}>تم تسجيل هذه المحاولة في سجل التدقيق</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!state) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}><ActivityIndicator color={Colors.primary} /></View>
      </SafeAreaView>
    );
  }

  const cloudReady = !!state.cloud.endpoint && !!state.cloud.model && state.cloud.hasKey && state.cloud.consentValid;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {state.settingsRecovered && (
          <View style={[styles.card, { borderColor: Colors.warning }]}>
            <Text style={styles.warn}>تعذرت قراءة الإعدادات المحفوظة فأُعيد الوضع إلى "معطّل" حفاظاً على الأمان.</Text>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>الحالة</Text>
          <Text style={[styles.statusText, { color: state.availability.available ? Colors.success : Colors.textSecondary }]}>
            {state.availability.message}
          </Text>
          {state.providerStatus && <Text style={styles.muted}>المزوّد: {state.providerStatus.detail}</Text>}
          <Text style={styles.muted}>
            التطبيق بكامل وحداته الأساسية يعمل دون الذكاء الاصطناعي. البحث الذكي (11.2) والتلخيص الذكي (11.3) والمساعد في صياغة المستندات (11.4) متاحة؛ الفحص النهائي في قسم لاحق.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>وضع التشغيل</Text>
          <View style={styles.modeRow}>
            {MODES.map((m) => (
              <Pressable
                key={m}
                disabled={busy}
                onPress={() => changeMode(m)}
                style={[styles.modeBtn, state.mode === m && styles.modeBtnActive]}
              >
                <Text style={[styles.modeText, state.mode === m && styles.modeTextActive]}>{MODE_LABELS[m]}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>الميزات</Text>
          {AI_FEATURES.map((f) => (
            <View key={f.id} style={styles.featureRow}>
              <Switch
                value={state.features[f.id]}
                disabled={busy}
                onValueChange={(v) => void run(() => mgr.updateSettings(session, { features: { [f.id]: v } }))}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.featureLabel}>{f.label}</Text>
                <Text style={styles.muted}>{f.description}</Text>
                <Text style={styles.muted}>تُنفَّذ في القسم {f.section}</Text>
              </View>
            </View>
          ))}
          {state.mode === 'disabled' && (
            <Text style={styles.muted}>الميزات لا تعمل ما دام الوضع "معطّل" حتى لو كانت مفعّلة هنا.</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>الخدمة السحابية (اختيارية)</Text>
          <Text style={styles.label}>عنوان الخدمة (HTTPS فقط)</Text>
          <TextInput
            style={styles.input} value={endpoint} onChangeText={setEndpoint}
            autoCapitalize="none" autoCorrect={false} keyboardType="url"
            placeholder="https://api.example.com/v1" placeholderTextColor={Colors.textMuted}
          />
          <Text style={styles.label}>اسم النموذج</Text>
          <TextInput
            style={styles.input} value={model} onChangeText={setModel}
            autoCapitalize="none" autoCorrect={false}
            placeholder="model-name" placeholderTextColor={Colors.textMuted}
          />
          <Pressable
            disabled={busy}
            style={styles.actionBtn}
            onPress={() => void run(() => mgr.updateSettings(session, { cloudEndpoint: endpoint.trim(), cloudModel: model.trim() }))}
          >
            <Text style={styles.actionText}>حفظ العنوان والنموذج</Text>
          </Pressable>

          <Text style={[styles.label, { marginTop: 12 }]}>
            مفتاح الخدمة {state.cloud.hasKey ? '(محفوظ في التخزين الآمن)' : '(غير محفوظ)'}
          </Text>
          <TextInput
            style={styles.input} value={apiKey} onChangeText={setApiKey}
            autoCapitalize="none" autoCorrect={false} secureTextEntry
            placeholder="أدخل مفتاحاً جديداً" placeholderTextColor={Colors.textMuted}
          />
          <View style={styles.row}>
            <Pressable
              disabled={busy || apiKey.length === 0}
              style={[styles.actionBtn, { flex: 1 }]}
              onPress={() => void run(async () => {
                const s = await mgr.saveCloudKey(session, apiKey);
                setApiKey('');
                return s;
              })}
            >
              <Text style={styles.actionText}>حفظ المفتاح</Text>
            </Pressable>
            <Pressable
              disabled={busy || !state.cloud.hasKey}
              style={[styles.actionBtn, { flex: 1, borderColor: Colors.danger }]}
              onPress={() => Alert.alert('حذف المفتاح', 'سيُعاد الوضع إلى "معطّل" إن كان سحابياً. هل تريد المتابعة؟', [
                { text: 'إلغاء', style: 'cancel' },
                { text: 'حذف', style: 'destructive', onPress: () => void run(() => mgr.clearCloudKey(session)) },
              ])}
            >
              <Text style={[styles.actionText, { color: Colors.danger }]}>حذف المفتاح</Text>
            </Pressable>
          </View>

          <Text style={[styles.label, { marginTop: 12 }]}>
            الإقرار (إصدار {AI_CONSENT_VERSION}) {state.cloud.consentValid ? '— ساري' : '— غير ساري'}
          </Text>
          <Text style={styles.muted}>{CONSENT_TEXT}</Text>
          <Pressable
            disabled={busy || !state.cloud.endpoint}
            style={[styles.actionBtn, !state.cloud.endpoint && { opacity: 0.5 }]}
            onPress={() => Alert.alert('الإقرار', CONSENT_TEXT, [
              { text: 'إلغاء', style: 'cancel' },
              { text: 'أقرّ وأوافق', onPress: () => void run(() => mgr.acceptCloudConsent(session)) },
            ])}
          >
            <Text style={styles.actionText}>الإقرار بالشروط</Text>
          </Pressable>

          <Text style={[styles.muted, { marginTop: 8 }]}>
            جاهزية الوضع السحابي: {cloudReady ? 'مكتملة' : 'ناقصة (العنوان، النموذج، المفتاح، الإقرار)'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>الوضع المحلي</Text>
          <Text style={styles.muted}>لم يُدمج محرك ذكاء اصطناعي محلي في هذا الإصدار. لن يعمل الوضع المحلي قبل دمجه.</Text>
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
  warn: { color: Colors.warning, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'right' },
  card: { backgroundColor: Colors.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, padding: 16, gap: 8 },
  sectionTitle: { color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md, textAlign: 'right' },
  statusText: { fontFamily: Fonts.semiBold, fontSize: FontSizes.md, textAlign: 'right' },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeBtn: { flex: 1, height: 44, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.borderLight, alignItems: 'center', justifyContent: 'center' },
  modeBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  modeText: { color: Colors.textSecondary, fontFamily: Fonts.semiBold, fontSize: FontSizes.sm },
  modeTextActive: { color: Colors.textOnPrimary },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  featureLabel: { color: Colors.textPrimary, fontFamily: Fonts.semiBold, fontSize: FontSizes.md, textAlign: 'right' },
  label: { color: Colors.textSecondary, fontFamily: Fonts.medium, fontSize: FontSizes.sm, textAlign: 'right' },
  input: { height: 44, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.borderLight, backgroundColor: Colors.secondary, color: Colors.textPrimary, paddingHorizontal: 12, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'left' },
  row: { flexDirection: 'row', gap: 8 },
  actionBtn: { height: 44, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  actionText: { color: Colors.primaryLight, fontFamily: Fonts.bold, fontSize: FontSizes.sm },
});
