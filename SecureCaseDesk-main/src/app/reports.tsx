// SECURECASEDESK_PHASE9_S3 + SECURECASEDESK_UI_V3_REPORTS — لوحة التقارير والمستندات.
// المنطق والصلاحيات وخدمات التوليد/المشاركة/الطباعة كما كانت؛ التغيير في العرض فقط (مع إظهار فلاتر القسم والحالة المدعومة أصلاً في ReportFilters).
// الصلاحيات هنا للعرض؛ الإنفاذ الفعلي في reports.service/reports-data.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, Alert, ActivityIndicator, TextInput } from 'react-native';
import { router } from 'expo-router';
import {
  ArrowRight, BarChart3, FileText, FileType2, FileCheck2, FolderOpen, Users, Shield, ShieldCheck, Layers,
  CalendarDays, Stamp, Printer, Share2, Trash2, Download, Check, Clock, Building2, Activity, ArrowUpRight, ArrowDownRight, Minus, Sparkles, Cpu,
} from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { Colors, Palette, Type, tint, Glow } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { can } from '@/security/permissions';
import { ForbiddenError, type Session } from '@/security/guard';
import { listCases, listDepartmentOptions, type CaseItem, type DepartmentOption } from '@/services/cases.service';
import { getDashboardStats, getDashboardTrends, weekOverWeek, type DashboardStats, type DashboardTrends } from '@/services/stats.service';
import { CASE_STATUSES, ARCHIVED_STATUS } from '@/modules/cases/cases-actions';
import { MEMO_STATUSES } from '@/services/memos.service';
import {
  generateReport, listAvailableReports, deleteGeneratedReport,
  ReportError, ReportStageError, REPORT_ERROR_MESSAGES, REPORT_STAGE_LABELS, type GeneratedReport, type ReportDefinition, type ReportFormat, type ReportSummaryOption,
} from '@/services/reports.service';
import { prepareReportAi, summarizeReportAi, reviewReportAi, type ReportAiPrepare, type AiDraft } from '@/services/reports-ai.service';
import { isAiError, aiErrorMessage } from '@/modules/ai/ai-types';
import { fmtDate, fmtDateTime, fmtSize, parseDateInput } from '@/modules/reports/reports-format';
import { shareReportFile, printReport, saveReportToDevice, ExportError, EXPORT_ERROR_MESSAGES } from '@/services/reports-export.service'; // SECURECASEDESK_PHASE9_S4
import type { ReportFilters, ReportKind, ReportSummaryMode } from '@/modules/reports/reports-types';
import { toArabicDigits } from '@/modules/attachments/attachments-ui-logic';
import {
  Screen, PageHeader, IconBtn, Card, Pill, MetaItem, StatStrip, SearchField, FilterChips, Btn, Field, Sheet, SectionTitle,
  type MiniStat, type ChipOpt,
} from '@/components/ui/Kit';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { FadeIn, PressableScale, AnimatedNumber } from '@/components/ui/Motion';
import { Skeleton } from '@/components/ui/Skeleton';
import { BarChart, DonutChart, LegendDot } from '@/components/ui/Charts';

/* ───────────── مظهر كل تقرير (عرض فقط) ───────────── */
type Group = 'all' | 'cases' | 'memos' | 'detainees' | 'admin';
const GROUP_LABEL: Record<Group, string> = { all: 'الكل', cases: 'القضايا', memos: 'المذكرات', detainees: 'المحتجزون', admin: 'إدارية' };
const KIND_LOOK: Record<ReportKind, { icon: React.ElementType; color: string; group: Exclude<Group, 'all'> }> = {
  case_file: { icon: FolderOpen, color: Palette.blue, group: 'cases' },
  cases_list: { icon: Layers, color: Palette.blue, group: 'cases' },
  memos_list: { icon: Stamp, color: Palette.gold, group: 'memos' },
  detainees_current: { icon: Users, color: Palette.green, group: 'detainees' },
  detainees_admissions_releases: { icon: Activity, color: Palette.green, group: 'detainees' },
  detainees_stats: { icon: BarChart3, color: Palette.green, group: 'detainees' },
  detainee_movements: { icon: Clock, color: Palette.green, group: 'detainees' },
  correction_history: { icon: FileCheck2, color: Palette.green, group: 'detainees' },
  admin_summary: { icon: Building2, color: Palette.purple, group: 'admin' },
  operations: { icon: Shield, color: Palette.purple, group: 'admin' },
};
const lookOf = (k: string) => KIND_LOOK[k as ReportKind] ?? { icon: FileText, color: Palette.cyan, group: 'admin' as const };

const DAY_MS = 86400000;
type RangeKey = 'all' | 'today' | 'week' | 'month' | 'year';
const RANGE_OPTS: ChipOpt<RangeKey>[] = [
  { key: 'all', label: 'كل الفترات' }, { key: 'today', label: 'اليوم' }, { key: 'week', label: 'آخر ٧ أيام' },
  { key: 'month', label: 'آخر ٣٠ يوماً' }, { key: 'year', label: 'هذه السنة' },
];
function rangeDates(k: RangeKey): { from: string; to: string } {
  const now = Date.now();
  if (k === 'all') return { from: '', to: '' };
  if (k === 'today') return { from: fmtDate(now), to: fmtDate(now) };
  if (k === 'week') return { from: fmtDate(now - 6 * DAY_MS), to: fmtDate(now) };
  if (k === 'month') return { from: fmtDate(now - 29 * DAY_MS), to: fmtDate(now) };
  return { from: new Date().getFullYear() + '-01-01', to: fmtDate(now) };
}

const SUMMARY_OPTS: ChipOpt<ReportSummaryMode>[] = [
  { key: 'none', label: 'بدون ملخص' }, { key: 'auto', label: 'ملخص آلي', color: Palette.cyan }, { key: 'ai', label: 'ذكاء اصطناعي', color: Palette.purple },
];
const SUMMARY_HINT: Record<ReportSummaryMode, string> = {
  none: 'يُنشأ التقرير كما هو دون فقرة ملخص.',
  auto: 'فقرة ملخص تُحسب بقواعد ثابتة من أرقام التقرير نفسه، دون ذكاء اصطناعي ودون إرسال أي بيانات خارج الجهاز.',
  ai: 'يُرسل إلى المساعد الذكي خلاصة إحصائية بلا أسماء (تعرضها لك أولاً عند الوضع السحابي)، وتراجع المسودة وتعدّلها قبل أن تدخل التقرير. بيانات المحتجزين لا تُرسل سحابياً.',
};

type AiState =
  | { phase: 'loading' }
  | { phase: 'preview'; prep: ReportAiPrepare }
  | { phase: 'generating' }
  | { phase: 'review'; draft: AiDraft; text: string; notes: string[] }
  | { phase: 'unavailable'; message: string };

interface Metric { key: string; label: string; color: string; data: number[] }

export default function ReportsScreen() {
  const { user } = useAuth();
  const session = useMemo<Session | null>(() => (user ? { userId: user.id, role: user.role } : null), [user?.id, user?.role]);
  const available = useMemo(() => listAvailableReports(session), [session]);
  const canDash = can(user?.role, 'dashboard.view');

  const [group, setGroup] = useState<Group>('all');
  const [selected, setSelected] = useState<ReportDefinition | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [range, setRange] = useState<RangeKey>('all');
  const [threshold, setThreshold] = useState('30');
  const [caseQuery, setCaseQuery] = useState('');
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [status, setStatus] = useState('all');
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [departmentId, setDepartmentId] = useState('all');
  const [busy, setBusy] = useState<ReportFormat | null>(null);
  const [results, setResults] = useState<GeneratedReport[]>([]);
  const busyRef = useRef(false);
  const metaRef = useRef(new Map<string, { kind: string; filters: ReportFilters; summary: ReportSummaryOption }>());
  const [summaryMode, setSummaryMode] = useState<ReportSummaryMode>('none');
  const [aiSt, setAiSt] = useState<AiState | null>(null);
  const aiCtx = useRef<{ format: ReportFormat; filters: ReportFilters; kind: string } | null>(null);
  const aiAbort = useRef<AbortController | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  // التحليلات: نفس خدمتي لوحة التحكم (نفس الصلاحيات والنطاق). تُخفى كلياً إن لم يملك الدور dashboard.view.
  const [anState, setAnState] = useState<'loading' | 'ready' | 'error' | 'hidden'>(canDash ? 'loading' : 'hidden');
  const [an, setAn] = useState<{ stats: DashboardStats; trends: DashboardTrends } | null>(null);
  const [metricKey, setMetricKey] = useState('cases');

  const loadAn = useCallback(async () => {
    if (!session || !canDash) { setAnState('hidden'); return; }
    setAnState('loading');
    try {
      const [stats, trends] = await Promise.all([getDashboardStats(session), getDashboardTrends(session)]);
      setAn({ stats, trends }); setAnState('ready');
    } catch (e) {
      if (e instanceof ForbiddenError) setAnState('hidden');
      else { console.error('[Reports] analytics', e); setAnState('error'); }
    }
  }, [session, canDash]);
  useEffect(() => { void loadAn(); }, [loadAn]);

  const metrics = useMemo<Metric[]>(() => {
    if (!an) return [];
    const t = an.trends, m: Metric[] = [];
    if (t.casesCreated) m.push({ key: 'cases', label: 'قضايا جديدة', color: Palette.blue, data: t.casesCreated });
    if (t.memosCreated) m.push({ key: 'memos', label: 'مذكرات جديدة', color: Palette.gold, data: t.memosCreated });
    if (t.admissions) m.push({ key: 'adm', label: 'إيداعات', color: Palette.green, data: t.admissions });
    if (t.releases) m.push({ key: 'rel', label: 'إفراجات', color: Palette.cyan, data: t.releases });
    return m;
  }, [an]);
  const metric = metrics.find((x) => x.key === metricKey) ?? metrics[0];
  const dayLabels = useMemo(() => Array.from({ length: 14 }, (_, i) => toArabicDigits(new Date(Date.now() - (13 - i) * DAY_MS).getDate())), []);

  const searchCases = useCallback(async (q: string) => {
    setCaseQuery(q);
    if (!session) return;
    try { setCases((await listCases(session, q)).slice(0, 20)); } catch { setCases([]); }
  }, [session]);

  const pick = (d: ReportDefinition) => {
    setSelected(d); setSummaryMode('none'); setCaseId(null); setFrom(''); setTo(''); setRange('all'); setStatus('all'); setDepartmentId('all'); setCaseQuery('');
    if (d.needsCase) void searchCases('');
    if (d.kind === 'cases_list' && session) { listDepartmentOptions(session).then(setDepartments).catch(() => setDepartments([])); }
  };

  const applyRange = (k: RangeKey) => { setRange(k); const r = rangeDates(k); setFrom(r.from); setTo(r.to); };

  const collectFilters = (): ReportFilters | null => {
    if (!selected) return null;
    const dFrom = parseDateInput(from), dTo = parseDateInput(to);
    if (dFrom === null || dTo === null) { Alert.alert('تاريخ غير صالح', 'اكتب التاريخ بالصيغة 2026-11-20 أو اتركه فارغاً.'); return null; }
    if (selected.needsCase && !caseId) { Alert.alert('اختر قضية', REPORT_ERROR_MESSAGES.CASE_REQUIRED); return null; }
    const th = parseInt(threshold, 10);
    return {
      caseId: caseId ?? undefined, dateFrom: dFrom, dateTo: dTo, thresholdDays: Number.isFinite(th) ? th : undefined,
      status: (selected.kind === 'cases_list' || selected.kind === 'memos_list') && status !== 'all' ? status : undefined,
      departmentId: selected.kind === 'cases_list' && departmentId !== 'all' ? departmentId : undefined,
    };
  };

  // يُنشئ الملف فعلاً (بعد اختيار الملخص وإتمام مراجعته إن كان ذكياً).
  const finish = async (format: ReportFormat, filters: ReportFilters, summary: ReportSummaryOption) => {
    if (!session || !selected || busyRef.current) return;
    busyRef.current = true; setBusy(format);
    try {
      const r = await generateReport(session, selected.kind, format, filters, summary);
      metaRef.current.set(r.uri, { kind: selected.kind, filters, summary });
      setResults((p) => [r, ...p]);
      setSelected(null);
      Alert.alert('تم إنشاء التقرير', r.title + '\n' + fmtSize(r.sizeBytes) + ' — ' + r.rowCount + ' سجل');
    } catch (e) {
      if (e instanceof ForbiddenError) Alert.alert('غير مصرح', 'ليست لديك صلاحية على هذا التقرير.');
      else if (e instanceof ReportError) Alert.alert('تعذر إنشاء التقرير', REPORT_ERROR_MESSAGES[e.code]);
      else if (e instanceof ReportStageError) {
        Alert.alert('تعذر إنشاء التقرير', 'فشلت مرحلة: ' + REPORT_STAGE_LABELS[e.stage] + '\n\nالسبب التقني:\n' + e.detail + '\n\nلم يُحفظ أي ملف ناقص.');
      } else { console.error('[Reports]', e); Alert.alert('تعذر إنشاء التقرير', 'حدث خطأ غير متوقع. لم يُحفظ أي ملف ناقص.'); }
    } finally { busyRef.current = false; setBusy(null); }
  };

  const run = async (format: ReportFormat) => {
    if (!session || !selected || busyRef.current) return;
    const filters = collectFilters();
    if (!filters) return;
    if (summaryMode === 'ai') { await startAi(format, filters); return; }
    await finish(format, filters, summaryMode === 'auto' ? { mode: 'auto' } : { mode: 'none' });
  };

  /* ───── الملخص بالذكاء الاصطناعي: معاينة ← توليد ← مراجعة واعتماد ← إنشاء ───── */
  const startAi = async (format: ReportFormat, filters: ReportFilters) => {
    if (!session || !selected) return;
    aiCtx.current = { format, filters, kind: selected.kind };
    setAiSt({ phase: 'loading' });
    try {
      const prep = await prepareReportAi(session, selected.kind, filters);
      setAiSt(prep.aiUsable ? { phase: 'preview', prep } : { phase: 'unavailable', message: prep.message });
    } catch (e) { setAiSt(null); fail(e); }
  };

  const generateAi = async (prep: ReportAiPrepare) => {
    const c = aiCtx.current;
    if (!session || !c) return;
    const ctrl = new AbortController(); aiAbort.current = ctrl;
    setAiSt({ phase: 'generating' });
    try {
      const res = await summarizeReportAi(session, c.kind, c.filters, { confirmCloud: prep.willSendToCloud, confirmedToken: prep.token ?? undefined }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (res.draft) setAiSt({ phase: 'review', draft: res.draft, text: res.draft.finalText, notes: res.notes });
      else setAiSt({ phase: 'unavailable', message: res.notes.join(' ') || 'تعذر توليد الملخص.' });
    } catch (e) { setAiSt(null); fail(e); }
  };

  const acceptAi = async () => {
    const c = aiCtx.current;
    if (!session || !c || aiSt?.phase !== 'review') return;
    try {
      const { finalText } = await reviewReportAi(session, c.kind, c.filters, aiSt.draft, 'accept', aiSt.text);
      setAiSt(null);
      if (finalText) await finish(c.format, c.filters, { mode: 'ai', text: finalText });
    } catch (e) { fail(e); }
  };

  const closeAi = () => {
    aiAbort.current?.abort();
    const c = aiCtx.current;
    if (session && c && aiSt?.phase === 'review') void reviewReportAi(session, c.kind, c.filters, aiSt.draft, 'reject').catch(() => undefined);
    setAiSt(null);
  };

  const finishWith = async (summary: ReportSummaryOption) => {
    const c = aiCtx.current;
    setAiSt(null);
    if (c) await finish(c.format, c.filters, summary);
  };

  const fail = (e: unknown) => {
    if (e instanceof ForbiddenError) Alert.alert('غير مصرح', 'ليست لديك صلاحية على هذا التقرير.');
    else if (e instanceof ReportError) Alert.alert('تعذر التنفيذ', REPORT_ERROR_MESSAGES[e.code]);
    else if (isAiError(e)) Alert.alert('الذكاء الاصطناعي', aiErrorMessage(e.code));
    else if (e instanceof ExportError) Alert.alert('تعذر التصدير', EXPORT_ERROR_MESSAGES[e.code]);
    else { console.error('[ReportsExport]', e); Alert.alert('تعذر التنفيذ', 'حدث خطأ غير متوقع.'); }
  };

  const share = async (r: GeneratedReport) => {
    const m = metaRef.current.get(r.uri);
    if (!session || !m || acting) return;
    setActing(r.uri + ':share');
    try { await shareReportFile(session, r, m.kind); } catch (e) { fail(e); } finally { setActing(null); }
  };

  const saveIt = async (r: GeneratedReport) => {
    const m = metaRef.current.get(r.uri);
    if (!session || !m || acting) return;
    setActing(r.uri + ':save');
    try {
      const name = await saveReportToDevice(session, r, m.kind);
      if (name) Alert.alert('تم الحفظ', 'حُفظ الملف في المجلد الذي اخترته:\n' + name);
      else Alert.alert('لم يُحفظ الملف', 'لم تختر مجلداً. في أندرويد 11 وما فوق لا يُسمح بالحفظ في جذر «التنزيلات» أو الذاكرة الداخلية. أنشئ مجلداً جديداً (مثل SecureCaseDesk) داخل «المستندات» أو «التنزيلات» ثم اضغط «استخدام هذا المجلد». أو اضغط «مشاركة» واختر «الملفات» أو Drive.', [{ text: 'إغلاق', style: 'cancel' }, { text: 'مشاركة', onPress: () => { void share(r); } }]);
    } catch (e) { fail(e); } finally { setActing(null); }
  };

  const printIt = async (r: GeneratedReport) => {
    const m = metaRef.current.get(r.uri);
    if (!session || !m || acting) return;
    setActing(r.uri + ':print');
    try { await printReport(session, m.kind, m.filters, m.summary); } catch (e) { fail(e); } finally { setActing(null); }
  };

  const remove = (r: GeneratedReport) => {
    Alert.alert('حذف الملف', 'سيُحذف ملف التقرير المؤقت من الجهاز. البيانات الأصلية لا تتأثر.', [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'حذف', style: 'destructive', onPress: () => { try { deleteGeneratedReport(r.uri); setResults((p) => p.filter((x) => x.uri !== r.uri)); } catch { Alert.alert('خطأ', 'تعذر حذف الملف.'); } } },
    ]);
  };

  /* ───────────── مشتقات العرض ───────────── */
  const groupOpts = useMemo<ChipOpt<Group>[]>(() => {
    const keys: Group[] = ['all', 'cases', 'memos', 'detainees', 'admin'];
    return keys
      .map((k) => ({ key: k, label: GROUP_LABEL[k], count: k === 'all' ? available.length : available.filter((d) => lookOf(d.kind).group === k).length, color: Palette.purple }))
      .filter((o) => o.key === 'all' || (o.count ?? 0) > 0);
  }, [available]);
  const shown = useMemo(() => (group === 'all' ? available : available.filter((d) => lookOf(d.kind).group === group)), [available, group]);

  const stats: MiniStat[] = [
    { key: 'a', label: 'تقارير متاحة', value: available.length, color: Palette.purple, icon: BarChart3 },
    { key: 'g', label: 'ملفات هذه الجلسة', value: results.length, color: Palette.cyan, icon: FileCheck2 },
    { key: 'p', label: 'ملفات PDF', value: results.filter((r) => r.format === 'pdf').length, color: Palette.red, icon: FileText },
    { key: 'd', label: 'Word / Excel / نص', value: results.filter((r) => r.format !== 'pdf').length, color: Palette.blue, icon: FileType2 },
  ];

  const statusOpts = useMemo<ChipOpt<string>[]>(() => {
    if (!selected) return [];
    const list: string[] = selected.kind === 'cases_list' ? [...CASE_STATUSES, ARCHIVED_STATUS] : selected.kind === 'memos_list' ? [...MEMO_STATUSES] : [];
    return list.length ? [{ key: 'all', label: 'كل الحالات' }, ...list.map((x) => ({ key: x, label: x }))] : [];
  }, [selected]);
  const deptOpts = useMemo<ChipOpt<string>[]>(() => [{ key: 'all', label: 'كل الأقسام' }, ...departments.map((d) => ({ key: d.id, label: d.name }))], [departments]);

  const total = metric ? metric.data.reduce((a, b) => a + b, 0) : 0;
  const pct = metric ? weekOverWeek(metric.data) : null;
  const casesDonut = an?.stats.cases ?? null;
  const detDonut = an?.stats.detainees ?? null;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 56 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: ROW, alignItems: 'center', paddingHorizontal: 18, paddingTop: 6, gap: 12 }}>
          <IconBtn icon={ArrowRight} onPress={() => router.back()} label="رجوع" />
          <View style={{ flex: 1, marginHorizontal: -18 }}>
            <PageHeader title="التقارير والمستندات" subtitle="تقارير رسمية بصيغتي PDF وWord مع طباعة" icon={BarChart3} color={Palette.purple} />
          </View>
        </View>

        <StatStrip items={stats} />

        <FadeIn delay={60} style={{ paddingHorizontal: 18, marginTop: 12 }}>
          <View style={{ flexDirection: ROW, alignItems: 'center', gap: 10, padding: 12, borderRadius: 16, backgroundColor: tint(Palette.green, 0.08), borderWidth: 1, borderColor: tint(Palette.green, 0.3) }}>
            <ShieldCheck color={Palette.green} size={20} />
            <Text style={[Type.caption, { color: Colors.textSecondary, flex: 1, textAlign: 'right' }]}>
              يُسجَّل إنشاء كل تقرير في سجل التدقيق دون محتواه، وتُحذف الملفات المؤقتة تلقائياً بعد ٢٤ ساعة.
            </Text>
          </View>
        </FadeIn>

        {/* ───── لمحة تحليلية ───── */}
        {anState !== 'hidden' ? (
          <View style={{ paddingHorizontal: 18 }}>
            <SectionTitle title="لمحة تحليلية" hint="نشاط آخر ١٤ يوماً من بيانات الجهاز" />
            {anState === 'loading' ? (
              <Card>
                <Skeleton width={110} height={30} />
                <Skeleton height={110} radius={14} style={{ marginTop: 14 }} />
              </Card>
            ) : anState === 'error' ? (
              <ErrorState message="تعذر تحميل التحليلات." onRetry={() => void loadAn()} />
            ) : (
              <View style={{ gap: 12 }}>
                {metric ? (
                  <Card accent={metric.color}>
                    <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
                      <View>
                        <AnimatedNumber value={total} style={[Type.stat, { color: Colors.textPrimary, textAlign: 'right' }]} />
                        <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', marginTop: -6 }]}>{metric.label} خلال ١٤ يوماً</Text>
                      </View>
                      {pct != null ? (
                        <View style={{ flexDirection: ROW, alignItems: 'center', gap: 3, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, backgroundColor: tint(pct > 0 ? Palette.green : pct < 0 ? Palette.red : '#94A3B8', 0.14) }}>
                          {pct > 0 ? <ArrowUpRight color={Palette.green} size={14} /> : pct < 0 ? <ArrowDownRight color={Palette.red} size={14} /> : <Minus color={Colors.textMuted} size={14} />}
                          <Text style={[Type.caption, { color: pct > 0 ? Palette.green : pct < 0 ? Palette.red : Colors.textMuted, fontFamily: 'Cairo_700Bold' }]}>{toArabicDigits(Math.abs(pct))}٪ عن الأسبوع السابق</Text>
                        </View>
                      ) : null}
                    </View>
                    <View style={{ marginHorizontal: -16, marginTop: 12 }}>
                      <FilterChips options={metrics.map((x) => ({ key: x.key, label: x.label, color: x.color }))} value={metric.key} onChange={setMetricKey} />
                    </View>
                    <View style={{ marginTop: 16 }}>
                      <BarChart data={metric.data} labels={dayLabels} color={metric.color} animKey={metric.key} />
                    </View>
                    {total === 0 ? <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'center', marginTop: 8 }]}>لا نشاط مسجَّل في هذه الفترة.</Text> : null}
                  </Card>
                ) : (
                  <EmptyState icon={BarChart3} color={Palette.purple} title="لا توجد بيانات تحليلية" hint="لا تتاح لدورك أقسام يمكن تحليلها." compact />
                )}

                {casesDonut || detDonut ? (
                  <View style={{ flexDirection: ROW, gap: 12 }}>
                    {casesDonut ? (
                      <Card style={{ flex: 1, alignItems: 'center', paddingHorizontal: 12 }}>
                        <Text style={[Type.h3, { color: Colors.textPrimary, alignSelf: 'stretch', textAlign: 'right', marginBottom: 10 }]}>القضايا المفتوحة</Text>
                        <DonutChart size={104} centerValue={toArabicDigits(casesDonut.open)} centerLabel="مفتوحة"
                          segments={[
                            { key: 'inv', label: 'قيد التحقيق', value: casesDonut.underInvestigation, color: Palette.red },
                            { key: 'oth', label: 'مفتوحة أخرى', value: Math.max(0, casesDonut.open - casesDonut.underInvestigation), color: Palette.blue },
                          ]} />
                        <View style={{ alignSelf: 'stretch', gap: 6, marginTop: 12 }}>
                          <LegendDot color={Palette.red} label="قيد التحقيق" value={toArabicDigits(casesDonut.underInvestigation)} />
                          <LegendDot color={Palette.blue} label="أخرى" value={toArabicDigits(Math.max(0, casesDonut.open - casesDonut.underInvestigation))} />
                        </View>
                      </Card>
                    ) : null}
                    {detDonut ? (
                      <Card style={{ flex: 1, alignItems: 'center', paddingHorizontal: 12 }}>
                        <Text style={[Type.h3, { color: Colors.textPrimary, alignSelf: 'stretch', textAlign: 'right', marginBottom: 10 }]}>حركة اليوم</Text>
                        <DonutChart size={104} centerValue={toArabicDigits(detDonut.admissionsToday + detDonut.releasesToday)} centerLabel="حركة"
                          segments={[
                            { key: 'adm', label: 'إيداع', value: detDonut.admissionsToday, color: Palette.green },
                            { key: 'rel', label: 'إفراج', value: detDonut.releasesToday, color: Palette.cyan },
                          ]} />
                        <View style={{ alignSelf: 'stretch', gap: 6, marginTop: 12 }}>
                          <LegendDot color={Palette.green} label="إيداعات" value={toArabicDigits(detDonut.admissionsToday)} />
                          <LegendDot color={Palette.cyan} label="إفراجات" value={toArabicDigits(detDonut.releasesToday)} />
                        </View>
                      </Card>
                    ) : null}
                  </View>
                ) : null}
              </View>
            )}
          </View>
        ) : null}

        {/* ───── كتالوج التقارير ───── */}
        <View style={{ paddingHorizontal: 18 }}>
          <SectionTitle title="اختر التقرير" hint="اضغط على تقرير لضبط الفلاتر ثم أنشئه بصيغة PDF أو Word أو Excel أو نص" />
        </View>
        {groupOpts.length > 2 ? <FilterChips options={groupOpts} value={group} onChange={setGroup} /> : null}
        <View style={{ paddingHorizontal: 18, gap: 10, marginTop: 12 }}>
          {available.length === 0 ? (
            <EmptyState icon={BarChart3} color={Palette.purple} title="لا توجد تقارير متاحة" hint="لا تشمل صلاحياتك أي تقرير حالياً." />
          ) : shown.map((d) => {
            const look = lookOf(d.kind), Icon = look.icon;
            return (
              <Card key={d.kind} accent={look.color} onPress={() => pick(d)} label={d.title}>
                <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12 }}>
                  <View style={{ width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(look.color, 0.14), borderWidth: 1, borderColor: tint(look.color, 0.42) }}>
                    <Icon color={look.color} size={22} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={1}>{d.title}</Text>
                    <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]} numberOfLines={2}>{d.description}</Text>
                  </View>
                </View>
                {d.needsCase || d.supportsDates || d.kind === 'detainees_stats' ? (
                  <View style={{ flexDirection: ROW, flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                    {d.needsCase ? <Pill label="قضية محددة" color={look.color} icon={FolderOpen} /> : null}
                    {d.supportsDates ? <Pill label="فترة زمنية" color={look.color} icon={CalendarDays} /> : null}
                    {d.kind === 'detainees_stats' ? <Pill label="حد المدة" color={look.color} icon={Clock} /> : null}
                    {d.kind === 'cases_list' ? <Pill label="قسم وحالة" color={look.color} icon={Building2} /> : null}
                    {d.kind === 'memos_list' ? <Pill label="حالة المذكرة" color={look.color} icon={Stamp} /> : null}
                  </View>
                ) : null}
              </Card>
            );
          })}
        </View>

        {/* ───── الملفات المنشأة ───── */}
        <View style={{ paddingHorizontal: 18 }}>
          <SectionTitle title="الملفات المنشأة" hint="مؤقتة داخل التطبيق — اضغط «حفظ في الجهاز» لتجدها في مجلد من اختيارك" />
          {results.length === 0 ? (
            <Card><EmptyState icon={FileCheck2} color={Palette.cyan} compact title="لم تُنشأ ملفات بعد" hint="ستظهر هنا التقارير التي تنشئها مع بصمة SHA-256 وخيارات المشاركة والطباعة." /></Card>
          ) : (
            <View style={{ gap: 12 }}>
              {results.map((r) => (
                <GeneratedFileCard key={r.uri} r={r} acting={acting} onShare={() => void share(r)} onSave={() => void saveIt(r)} onPrint={() => void printIt(r)} onRemove={() => remove(r)} />
              ))}
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>الطباعة تعيد بناء التقرير من البيانات الحالية.</Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* ───── ضبط التقرير ───── */}
      <Sheet
        visible={!!selected}
        title={selected?.title ?? ''}
        subtitle={selected?.description}
        onClose={() => { if (!busy) setSelected(null); }}
        footer={selected ? (
          <View style={{ flex: 1, gap: 8 }}>
            <View style={{ flexDirection: ROW, gap: 8 }}>
              <Btn label="PDF" icon={FileText} loading={busy === 'pdf'} disabled={!!busy} onPress={() => void run('pdf')} style={{ flex: 1 }} />
              <Btn label="Word" icon={FileType2} variant="ghost" loading={busy === 'docx'} disabled={!!busy} onPress={() => void run('docx')} style={{ flex: 1 }} />
            </View>
            <View style={{ flexDirection: ROW, gap: 8 }}>
              <Btn label="Excel" icon={BarChart3} variant="ghost" loading={busy === 'xlsx'} disabled={!!busy} onPress={() => void run('xlsx')} style={{ flex: 1 }} />
              <Btn label="نص TXT" icon={FileText} variant="ghost" loading={busy === 'txt'} disabled={!!busy} onPress={() => void run('txt')} style={{ flex: 1 }} />
            </View>
          </View>
        ) : undefined}
      >
        {selected ? (
          <View>
            {selected.needsCase ? (
              <View style={{ marginBottom: 14 }}>
                <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right', marginBottom: 6 }]}>القضية</Text>
                <View style={{ marginHorizontal: -18 }}><SearchField value={caseQuery} onChangeText={(t) => void searchCases(t)} placeholder="ابحث برقم القضية أو عنوانها" /></View>
                <View style={{ gap: 8, marginTop: 10 }}>
                  {cases.length === 0 ? <EmptyState compact icon={FolderOpen} title="لا توجد قضايا مطابقة" color={Palette.blue} /> : cases.map((c) => {
                    const on = caseId === c.id;
                    return (
                      <PressableScale key={c.id} onPress={() => setCaseId(c.id)} accessibilityRole="button" accessibilityState={{ selected: on }}
                        style={{ flexDirection: ROW, alignItems: 'center', gap: 10, padding: 12, borderRadius: 16, borderWidth: 1, backgroundColor: on ? tint(Palette.green, 0.12) : Palette.bg1, borderColor: on ? tint(Palette.green, 0.6) : Palette.glassBorder }}>
                        <View style={{ flex: 1 }}>
                          <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={1}>{c.title}</Text>
                          <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]} numberOfLines={1}>{c.case_number}</Text>
                        </View>
                        {on ? <Check color={Palette.green} size={20} /> : null}
                      </PressableScale>
                    );
                  })}
                </View>
              </View>
            ) : null}

            {selected.kind === 'cases_list' && departments.length > 0 ? (
              <View style={{ marginBottom: 14 }}>
                <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right', marginBottom: 8 }]}>القسم</Text>
                <View style={{ marginHorizontal: -18 }}><FilterChips options={deptOpts} value={departmentId} onChange={setDepartmentId} /></View>
              </View>
            ) : null}

            {statusOpts.length > 0 ? (
              <View style={{ marginBottom: 14 }}>
                <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right', marginBottom: 8 }]}>الحالة</Text>
                <View style={{ marginHorizontal: -18 }}><FilterChips options={statusOpts} value={status} onChange={setStatus} /></View>
              </View>
            ) : null}

            {selected.supportsDates ? (
              <View>
                <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right', marginBottom: 8 }]}>الفترة الزمنية</Text>
                <View style={{ marginHorizontal: -18, marginBottom: 14 }}><FilterChips options={RANGE_OPTS} value={range} onChange={applyRange} /></View>
                <View style={{ flexDirection: ROW, gap: 10 }}>
                  <View style={{ flex: 1 }}><Field label="من تاريخ (اختياري)" value={from} onChangeText={(t) => { setFrom(t); setRange('all'); }} placeholder="2026-01-01" keyboardType="numbers-and-punctuation" /></View>
                  <View style={{ flex: 1 }}><Field label="إلى تاريخ (اختياري)" value={to} onChangeText={(t) => { setTo(t); setRange('all'); }} placeholder="2026-12-31" keyboardType="numbers-and-punctuation" /></View>
                </View>
              </View>
            ) : null}

            {selected.kind === 'detainees_stats' ? (
              <Field label="حد مدة الاحتجاز بالأيام" value={threshold} onChangeText={setThreshold} keyboardType="number-pad" />
            ) : null}

            <View style={{ marginTop: 16, marginBottom: 6 }}>
              <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right', marginBottom: 8 }]}>التلخيص داخل التقرير</Text>
              <View style={{ marginHorizontal: -18 }}><FilterChips options={SUMMARY_OPTS} value={summaryMode} onChange={setSummaryMode} /></View>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', marginTop: 8 }]}>{SUMMARY_HINT[summaryMode]}</Text>
            </View>

            {!selected.needsCase && !selected.supportsDates && selected.kind !== 'detainees_stats' ? (
              <Text style={[Type.body, { color: Colors.textMuted, textAlign: 'right' }]}>لا فلاتر لهذا التقرير: يُبنى من البيانات الحالية كاملة ضمن صلاحياتك.</Text>
            ) : null}
          </View>
        ) : null}
      </Sheet>

      {/* ───── ملخص بالذكاء الاصطناعي ───── */}
      <Sheet
        visible={!!aiSt}
        title="ملخص بالذكاء الاصطناعي"
        subtitle={aiSt?.phase === 'review' ? 'مسودة بانتظار مراجعتك' : 'خلاصة إحصائية بلا أسماء'}
        onClose={closeAi}
        footer={aiSt?.phase === 'preview' ? (
          <View style={{ flex: 1, gap: 8 }}>
            <Btn label={aiSt.prep.willSendToCloud ? 'أؤكد الإرسال وأولّد الملخص' : 'توليد الملخص'} icon={Sparkles} onPress={() => void generateAi(aiSt.prep)} />
            <Btn label="ملخص آلي بدلاً منه" icon={Cpu} variant="ghost" onPress={() => void finishWith({ mode: 'auto' })} />
          </View>
        ) : aiSt?.phase === 'review' ? (
          <View style={{ flex: 1, gap: 8 }}>
            <Btn label="اعتماد وإنشاء التقرير" icon={Check} onPress={() => void acceptAi()} disabled={aiSt.text.trim().length < 5} />
            <Btn label="رفض الملخص" icon={Trash2} variant="ghost" onPress={closeAi} />
          </View>
        ) : aiSt?.phase === 'unavailable' ? (
          <View style={{ flex: 1, gap: 8 }}>
            <Btn label="إنشاء بملخص آلي" icon={Cpu} onPress={() => void finishWith({ mode: 'auto' })} />
            <Btn label="إنشاء بدون ملخص" icon={FileText} variant="ghost" onPress={() => void finishWith({ mode: 'none' })} />
          </View>
        ) : undefined}
      >
        {aiSt?.phase === 'loading' || aiSt?.phase === 'generating' ? (
          <View style={{ alignItems: 'center', gap: 12, paddingVertical: 24 }}>
            <ActivityIndicator color={Palette.purple} />
            <Text style={[Type.body, { color: Colors.textSecondary, textAlign: 'center' }]}>{aiSt.phase === 'loading' ? 'جارٍ تجهيز الخلاصة…' : 'جارٍ توليد الملخص…'}</Text>
          </View>
        ) : null}

        {aiSt?.phase === 'preview' ? (
          <View style={{ gap: 12 }}>
            <Text style={[Type.body, { color: Colors.textPrimary, textAlign: 'right' }]}>{aiSt.prep.message}</Text>
            {aiSt.prep.payload ? (
              <View style={{ borderRadius: 14, borderWidth: 1, borderColor: tint(Palette.gold, 0.5), backgroundColor: tint(Palette.gold, 0.07), padding: 10, maxHeight: 280 }}>
                <ScrollView nestedScrollEnabled>
                  <Text selectable style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right' }]}>{aiSt.prep.payload}</Text>
                </ScrollView>
              </View>
            ) : null}
            {aiSt.prep.withheldFields.length > 0 ? (
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>لا يُمرَّر إلى الذكاء الاصطناعي: {aiSt.prep.withheldFields.join('، ')}.</Text>
            ) : null}
          </View>
        ) : null}

        {aiSt?.phase === 'review' ? (
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8, padding: 10, borderRadius: 14, backgroundColor: tint(Palette.gold, 0.1), borderWidth: 1, borderColor: tint(Palette.gold, 0.4) }}>
              <ShieldCheck color={Palette.gold} size={18} />
              <Text style={[Type.caption, { color: Colors.textSecondary, flex: 1, textAlign: 'right' }]}>هذا الملخص من الذكاء الاصطناعي وقد يخطئ. راجعه وعدّله؛ لا يدخل التقرير إلا بعد اعتمادك.</Text>
            </View>
            {aiSt.notes.map((n, i) => <Text key={i} style={[Type.caption, { color: Palette.gold, textAlign: 'right' }]}>{n}</Text>)}
            <TextInput
              value={aiSt.text} multiline onChangeText={(t) => setAiSt((p) => (p && p.phase === 'review' ? { ...p, text: t } : p))}
              style={{ minHeight: 220, textAlignVertical: 'top', textAlign: 'right', color: Colors.textPrimary, borderRadius: 14, borderWidth: 1, borderColor: Palette.glassBorder, backgroundColor: Palette.bg1, padding: 12, fontFamily: 'Cairo_400Regular' }}
            />
          </View>
        ) : null}

        {aiSt?.phase === 'unavailable' ? (
          <View style={{ gap: 10 }}>
            <Text style={[Type.body, { color: Colors.textPrimary, textAlign: 'right' }]}>{aiSt.message}</Text>
            <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>يمكنك إنشاء التقرير الآن بملخص آلي (بقواعد ثابتة) أو بدون ملخص.</Text>
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

/* ───────────── بطاقة ملف منشأ ───────────── */
const FORMAT_LOOK: Record<ReportFormat, { color: string; icon: React.ElementType; label: string }> = {
  pdf: { color: Palette.red, icon: FileText, label: 'PDF' },
  docx: { color: Palette.blue, icon: FileType2, label: 'DOCX' },
  xlsx: { color: Palette.green, icon: BarChart3, label: 'XLSX' },
  txt: { color: Palette.gold, icon: FileText, label: 'TXT' },
};

const GeneratedFileCard = React.memo(function GeneratedFileCard({ r, acting, onShare, onSave, onPrint, onRemove }: {
  r: GeneratedReport; acting: string | null; onShare: () => void; onSave: () => void; onPrint: () => void; onRemove: () => void;
}) {
  const look = FORMAT_LOOK[r.format];
  const c = look.color;
  const Icon = look.icon;
  return (
    <Card accent={c} style={Glow(c)}>
      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12 }}>
        <View style={{ width: 52, height: 62, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(c, 0.14), borderWidth: 1, borderColor: tint(c, 0.45) }}>
          <Icon color={c} size={24} />
          <Text style={[Type.caption, { color: c, fontFamily: 'Cairo_800ExtraBold', marginTop: 2 }]}>{look.label}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={2}>{r.title}</Text>
          <View style={{ flexDirection: ROW, marginTop: 4 }}>
            <Pill label={r.documentNumber} color={c} icon={Stamp} />
          </View>
        </View>
      </View>

      <View style={{ flexDirection: ROW, gap: 10, marginTop: 14 }}>
        <MetaItem icon={Clock} label="تاريخ الإنشاء" value={fmtDateTime(r.createdAt)} />
        <MetaItem icon={FileCheck2} label="الحجم والسجلات" value={fmtSize(r.sizeBytes) + ' • ' + r.rowCount + ' سجل'} />
      </View>

      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 10, marginTop: 12, padding: 10, borderRadius: 14, backgroundColor: tint(Palette.green, 0.09), borderWidth: 1, borderColor: tint(Palette.green, 0.32) }}>
        <ShieldCheck color={Palette.green} size={18} />
        <View style={{ flex: 1 }}>
          <Text style={[Type.caption, { color: Palette.green, fontFamily: 'Cairo_700Bold', textAlign: 'right' }]}>تم التحقق من صحة الملف عند الإنشاء</Text>
          <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', writingDirection: 'ltr' }]} numberOfLines={1}>SHA-256: {r.sha256.slice(0, 20)}…</Text>
        </View>
      </View>

      <View style={{ flexDirection: ROW, gap: 8, marginTop: 12 }}>
        <ActionBtn label="حفظ" icon={Download} color={Palette.green} busy={acting === r.uri + ':save'} disabled={!!acting} onPress={onSave} />
        <ActionBtn label="مشاركة" icon={Share2} color={Palette.cyan} busy={acting === r.uri + ':share'} disabled={!!acting} onPress={onShare} />
        <ActionBtn label="طباعة" icon={Printer} color={Palette.cyan} busy={acting === r.uri + ':print'} disabled={!!acting} onPress={onPrint} />
        <ActionBtn label="حذف" icon={Trash2} color={Palette.red} disabled={!!acting} onPress={onRemove} />
      </View>
    </Card>
  );
});

function ActionBtn({ label, icon: Icon, color, onPress, busy, disabled }: {
  label: string; icon: React.ElementType; color: string; onPress: () => void; busy?: boolean; disabled?: boolean;
}) {
  return (
    <PressableScale onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}
      style={{ flex: 1, height: 44, borderRadius: 14, flexDirection: ROW, alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: tint(color, 0.12), borderWidth: 1, borderColor: tint(color, 0.42), opacity: disabled && !busy ? 0.55 : 1 }}>
      {busy ? <ActivityIndicator size="small" color={color} /> : <Icon color={color} size={17} />}
      <Text style={[Type.body, { color, fontFamily: 'Cairo_700Bold' }]}>{label}</Text>
    </PressableScale>
  );
}
