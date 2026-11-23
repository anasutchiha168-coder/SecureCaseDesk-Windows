#!/usr/bin/env python3
# SecureCaseDesk v2.2 — إعادة تصميم الواجهة (UI v3) — الدفعة: التقارير + بطاقات المرفقات
# التشغيل من جذر المشروع:  python3 ui_v3_reports_attachments.py
# يكتب 4 ملفات فقط:
#   جديد : src/components/ui/Charts.tsx                          (رسم أعمدة + حلقة، من بيانات حقيقية)
#   يستبدل: src/app/reports.tsx                                   (لوحة تقارير: تحليلات + كتالوج + فلاتر + بطاقات ملفات)
#   يستبدل: src/components/attachments/AttachmentsPanel.tsx      (بطاقات مرفقات + حالة السلامة + بصمة SHA-256)
#   يستبدل: src/components/attachments/AttachmentsSheet.tsx      (يعتمد Sheet الموحّد + زر مرفقات بعدّاد)
# لا يمسّ أي خدمة أو صلاحية أو قاعدة بيانات أو تشفير أو اختبار. واجهات الاستيراد/التصدير لم تتغير
# (AttachmentsPanel وAttachmentsSheet وAttachmentsButton بنفس الـ props تماماً، فلا تحتاج cases/memos/detainees أي تعديل).
# يُنسخ كل ملف موجود احتياطياً باسم .bak_<وقت> قبل الكتابة. أي مرساة غير مطابقة = إيقاف قبل كتابة أي ملف.
import os, re, sys, shutil, subprocess, datetime

TS = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
MARK_R = 'SECURECASEDESK_UI_V3_REPORTS'
MARK_A = 'SECURECASEDESK_UI_V3_ATTACHMENTS'
CHARTS = 'src/components/ui/Charts.tsx'
REPORTS = 'src/app/reports.tsx'
PANEL = 'src/components/attachments/AttachmentsPanel.tsx'
SHEET = 'src/components/attachments/AttachmentsSheet.tsx'
def die(m): print('\n✘ ' + m); sys.exit(1)

if not (os.path.isfile('package.json') and os.path.isfile('src/database/db.ts')):
    die('شغّل الأمر من جذر مشروع SecureCaseDesk.')
if '"name": "securecasedesk"' not in open('package.json', encoding='utf8').read():
    die('package.json ليس لمشروع securecasedesk.')

def need(path, *needles):
    if not os.path.isfile(path): die('ملف مفقود (الدفعات السابقة غير مثبّتة؟): ' + path)
    t = open(path, encoding='utf8').read()
    for n in needles:
        if n not in t: die('المرساة غير موجودة في ' + path + ': ' + n)

# نظام التصميم الموحد والخدمات التي تعتمد عليها الشاشات الجديدة (للقراءة فقط).
need('src/components/ui/Kit.tsx', 'export function Screen', 'export function Sheet', 'export function PageHeader', 'export const StatStrip',
     'export function FilterChips', 'export function SearchField', 'export function Field', 'export function Btn', 'export const Card',
     'export function Pill', 'export function MetaItem', 'export function SectionTitle', 'export function IconBtn', 'export interface MiniStat', 'export interface ChipOpt')
need('src/components/ui/States.tsx', 'export function EmptyState', 'export function ErrorState')
need('src/components/ui/Motion.tsx', 'export function FadeIn', 'export function PressableScale', 'export function AnimatedNumber')
need('src/components/ui/Skeleton.tsx', 'export function Skeleton')
need('src/constants/theme.ts', 'export const Palette', 'export const Type', 'export function tint', 'export const Glow')
need('src/constants/rtl.ts', 'export const ROW')
need('src/services/stats.service.ts', 'export async function getDashboardStats', 'export async function getDashboardTrends', 'export function weekOverWeek')
need('src/services/cases.service.ts', 'export async function listDepartmentOptions', 'export interface DepartmentOption', 'export async function listCases')
need('src/services/memos.service.ts', 'export const MEMO_STATUSES')
need('src/modules/cases/cases-actions.ts', 'export const CASE_STATUSES', 'ARCHIVED_STATUS')
need('src/modules/attachments/attachments-ui-logic.ts', 'export function toArabicDigits', 'export function integrityMessage', 'export function formatFileSize')
need('src/services/attachments.service.ts', 'export async function checkAttachment', 'export async function openAttachmentToCache', 'export function purgeDecryptedCache')
need('src/services/reports.service.ts', 'export async function generateReport', 'export function listAvailableReports', 'export function deleteGeneratedReport')
need('src/services/reports-export.service.ts', 'export async function shareReportFile', 'export async function printReport')

# الملفات القديمة يجب أن تكون بشكلها المتوقع ولم تُستبدل من قبل.
def old(path, *anchors):
    if not os.path.isfile(path): die('ملف مفقود: ' + path)
    t = open(path, encoding='utf8').read()
    if MARK_R in t or MARK_A in t: die('الدفعة مُطبَّقة سابقاً (علامة UI_V3 موجودة في ' + path + ').')
    for a in anchors:
        if a not in t: die(path + ' الحالي لا يطابق المتوقع (مفقود: ' + a + ').')
    return t
old_reports = old(REPORTS, 'SECURECASEDESK_PHASE9_S3', 'shareReportFile', 'deleteGeneratedReport', 'REPORT_ERROR_MESSAGES')
old_panel = old(PANEL, 'SECURECASEDESK_PHASE9_S2', 'openAttachmentToCache', 'validateDeleteReason', 'purgeDecryptedCache')
old_sheet = old(SHEET, 'SECURECASEDESK_PHASE9_S2', 'export function AttachmentsButton', 'export function AttachmentsSheet')
if os.path.isfile(CHARTS) and MARK_R not in open(CHARTS, encoding='utf8').read():
    die(CHARTS + ' موجود مسبقاً بمحتوى مختلف؛ لن أكتب فوقه. أعد تسميته أو احذفه ثم أعد التشغيل.')

NEW_CHARTS = r'''// SECURECASEDESK_UI_V3_REPORTS — رسوم بيانية خفيفة (أعمدة + حلقة) من بيانات حقيقية فقط.
// الأعمدة مبنية من View (لا SVG) كي تتبع اتجاه RTL تلقائياً عبر ROW: الأقدم يميناً والأحدث يساراً.
import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing, StyleSheet } from 'react-native';
import Svg, { Circle, G } from 'react-native-svg';
import { Colors, Palette, Type, tint } from '@/constants/theme';
import { ROW } from '@/constants/rtl';

export interface BarChartProps {
  data: number[];
  labels?: string[];          // تسمية لكل عمود (تُعرض بعضها فقط لتفادي الازدحام)
  color: string;
  height?: number;
  unit?: string;              // مثال: "قضية" — يظهر في وصف الوصول
  animKey?: string;           // تغيّره يعيد تشغيل حركة الدخول
}

export const BarChart = React.memo(function BarChart({ data, labels, color, height = 120, animKey }: BarChartProps) {
  const grow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    grow.setValue(0);
    const a = Animated.timing(grow, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [animKey, grow]);

  const max = Math.max(...data, 1);
  const peak = Math.max(...data);
  const step = data.length > 10 ? 3 : 1;
  return (
    <View accessible accessibilityLabel={'رسم بياني بالأعمدة، أعلى قيمة ' + peak}>
      <View style={{ height }}>
        {[0, 0.5, 1].map((p) => (
          <View key={p} style={[s.grid, { bottom: p * (height - 1) }]} />
        ))}
        <Animated.View style={[s.bars, { opacity: grow, transform: [{ scaleY: grow }] }]}>
          {data.map((v, i) => {
            const isLast = i === data.length - 1;
            const h = v === 0 ? 4 : Math.max(8, (v / max) * (height - 6));
            return (
              <View key={i} style={s.col}>
                <View style={[
                  s.bar,
                  { height: h, backgroundColor: v === 0 ? tint(color, 0.18) : isLast ? color : tint(color, 0.55) },
                  v > 0 && v === peak ? { backgroundColor: color } : null,
                ]} />
              </View>
            );
          })}
        </Animated.View>
      </View>
      {labels ? (
        <View style={s.labelRow}>
          {labels.map((l, i) => (
            <View key={i} style={s.col}>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'center' }]} numberOfLines={1}>
                {i % step === 0 || i === labels.length - 1 ? l : ''}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});

export interface DonutSegment { key: string; label: string; value: number; color: string }

export const DonutChart = React.memo(function DonutChart({ segments, size = 112, thickness = 12, centerValue, centerLabel }: {
  segments: DonutSegment[]; size?: number; thickness?: number; centerValue: string; centerLabel: string;
}) {
  const r = (size - thickness) / 2;
  const c = size / 2;
  const C = 2 * Math.PI * r;
  const total = segments.reduce((a, x) => a + Math.max(0, x.value), 0);
  const live = segments.filter((x) => x.value > 0);
  const gap = live.length > 1 ? 4 : 0;
  let acc = 0;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size}>
        <G rotation={-90} origin={c + ', ' + c}>
          <Circle cx={c} cy={c} r={r} stroke={tint('#94A3B8', 0.14)} strokeWidth={thickness} fill="none" />
          {total > 0 ? live.map((x) => {
            const len = (x.value / total) * C;
            const dash = Math.max(1, len - gap);
            const el = (
              <Circle key={x.key} cx={c} cy={c} r={r} stroke={x.color} strokeWidth={thickness} fill="none"
                strokeLinecap="round" strokeDasharray={dash + ' ' + (C - dash)} strokeDashoffset={-acc} />
            );
            acc += len;
            return el;
          }) : null}
        </G>
      </Svg>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={[Type.stat, { color: Colors.textPrimary, fontSize: 24, lineHeight: 32 }]}>{centerValue}</Text>
          <Text style={[Type.caption, { color: Colors.textMuted, marginTop: -4 }]} numberOfLines={1}>{centerLabel}</Text>
        </View>
      </View>
    </View>
  );
});

export function LegendDot({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8 }}>
      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color, borderWidth: 1, borderColor: tint(color, 0.5) }} />
      <Text style={[Type.body, { color: Colors.textSecondary, flex: 1, textAlign: 'right' }]} numberOfLines={1}>{label}</Text>
      <Text style={[Type.h3, { color: Colors.textPrimary }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  grid: { position: 'absolute', start: 0, end: 0, height: 1, backgroundColor: Palette.glassBorder },
  bars: { flex: 1, flexDirection: ROW, alignItems: 'flex-end', gap: 5, transformOrigin: 'bottom' },
  col: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '78%', borderTopLeftRadius: 7, borderTopRightRadius: 7, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 },
  labelRow: { flexDirection: ROW, gap: 5, marginTop: 6 },
});
'''

NEW_REPORTS = r'''// SECURECASEDESK_PHASE9_S3 + SECURECASEDESK_UI_V3_REPORTS — لوحة التقارير والمستندات.
// المنطق والصلاحيات وخدمات التوليد/المشاركة/الطباعة كما كانت؛ التغيير في العرض فقط (مع إظهار فلاتر القسم والحالة المدعومة أصلاً في ReportFilters).
// الصلاحيات هنا للعرض؛ الإنفاذ الفعلي في reports.service/reports-data.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import {
  ArrowRight, BarChart3, FileText, FileType2, FileCheck2, FolderOpen, Users, Shield, ShieldCheck, Layers,
  CalendarDays, Stamp, Printer, Share2, Trash2, Check, Clock, Building2, Activity, ArrowUpRight, ArrowDownRight, Minus,
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
  ReportError, REPORT_ERROR_MESSAGES, type GeneratedReport, type ReportDefinition, type ReportFormat,
} from '@/services/reports.service';
import { fmtDate, fmtDateTime, fmtSize, parseDateInput } from '@/modules/reports/reports-format';
import { shareReportFile, printReport, ExportError, EXPORT_ERROR_MESSAGES } from '@/services/reports-export.service'; // SECURECASEDESK_PHASE9_S4
import type { ReportFilters, ReportKind } from '@/modules/reports/reports-types';
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
  const metaRef = useRef(new Map<string, { kind: string; filters: ReportFilters }>());
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
    setSelected(d); setCaseId(null); setFrom(''); setTo(''); setRange('all'); setStatus('all'); setDepartmentId('all'); setCaseQuery('');
    if (d.needsCase) void searchCases('');
    if (d.kind === 'cases_list' && session) { listDepartmentOptions(session).then(setDepartments).catch(() => setDepartments([])); }
  };

  const applyRange = (k: RangeKey) => { setRange(k); const r = rangeDates(k); setFrom(r.from); setTo(r.to); };

  const run = async (format: ReportFormat) => {
    if (!session || !selected || busyRef.current) return;
    const dFrom = parseDateInput(from), dTo = parseDateInput(to);
    if (dFrom === null || dTo === null) { Alert.alert('تاريخ غير صالح', 'اكتب التاريخ بالصيغة 2026-11-20 أو اتركه فارغاً.'); return; }
    if (selected.needsCase && !caseId) { Alert.alert('اختر قضية', REPORT_ERROR_MESSAGES.CASE_REQUIRED); return; }
    const th = parseInt(threshold, 10);
    const filters: ReportFilters = {
      caseId: caseId ?? undefined, dateFrom: dFrom, dateTo: dTo, thresholdDays: Number.isFinite(th) ? th : undefined,
      status: (selected.kind === 'cases_list' || selected.kind === 'memos_list') && status !== 'all' ? status : undefined,
      departmentId: selected.kind === 'cases_list' && departmentId !== 'all' ? departmentId : undefined,
    };
    busyRef.current = true; setBusy(format);
    try {
      const r = await generateReport(session, selected.kind, format, filters);
      metaRef.current.set(r.uri, { kind: selected.kind, filters });
      setResults((p) => [r, ...p]);
      setSelected(null);
      Alert.alert('تم إنشاء التقرير', r.title + '\n' + fmtSize(r.sizeBytes) + ' — ' + r.rowCount + ' سجل');
    } catch (e) {
      if (e instanceof ForbiddenError) Alert.alert('غير مصرح', 'ليست لديك صلاحية على هذا التقرير.');
      else if (e instanceof ReportError) Alert.alert('تعذر إنشاء التقرير', REPORT_ERROR_MESSAGES[e.code]);
      else { console.error('[Reports]', e); Alert.alert('تعذر إنشاء التقرير', 'حدث خطأ غير متوقع. لم يُحفظ أي ملف ناقص.'); }
    } finally { busyRef.current = false; setBusy(null); }
  };

  const fail = (e: unknown) => {
    if (e instanceof ForbiddenError) Alert.alert('غير مصرح', 'ليست لديك صلاحية على هذا التقرير.');
    else if (e instanceof ReportError) Alert.alert('تعذر التنفيذ', REPORT_ERROR_MESSAGES[e.code]);
    else if (e instanceof ExportError) Alert.alert('تعذر التصدير', EXPORT_ERROR_MESSAGES[e.code]);
    else { console.error('[ReportsExport]', e); Alert.alert('تعذر التنفيذ', 'حدث خطأ غير متوقع.'); }
  };

  const share = async (r: GeneratedReport) => {
    const m = metaRef.current.get(r.uri);
    if (!session || !m || acting) return;
    setActing(r.uri + ':share');
    try { await shareReportFile(session, r, m.kind); } catch (e) { fail(e); } finally { setActing(null); }
  };

  const printIt = async (r: GeneratedReport) => {
    const m = metaRef.current.get(r.uri);
    if (!session || !m || acting) return;
    setActing(r.uri + ':print');
    try { await printReport(session, m.kind, m.filters); } catch (e) { fail(e); } finally { setActing(null); }
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
    { key: 'd', label: 'ملفات Word', value: results.filter((r) => r.format === 'docx').length, color: Palette.blue, icon: FileType2 },
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
          <SectionTitle title="اختر التقرير" hint="اضغط على تقرير لضبط الفلاتر ثم أنشئه بصيغة PDF أو Word" />
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
          <SectionTitle title="الملفات المنشأة" hint="مؤقتة، تظهر هنا طوال هذه الجلسة" />
          {results.length === 0 ? (
            <Card><EmptyState icon={FileCheck2} color={Palette.cyan} compact title="لم تُنشأ ملفات بعد" hint="ستظهر هنا التقارير التي تنشئها مع بصمة SHA-256 وخيارات المشاركة والطباعة." /></Card>
          ) : (
            <View style={{ gap: 12 }}>
              {results.map((r) => (
                <GeneratedFileCard key={r.uri} r={r} acting={acting} onShare={() => void share(r)} onPrint={() => void printIt(r)} onRemove={() => remove(r)} />
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
          <>
            <Btn label="إنشاء PDF" icon={FileText} loading={busy === 'pdf'} disabled={!!busy} onPress={() => void run('pdf')} style={{ flex: 1 }} />
            <Btn label="إنشاء Word" icon={FileType2} variant="ghost" loading={busy === 'docx'} disabled={!!busy} onPress={() => void run('docx')} style={{ flex: 1 }} />
          </>
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

            {!selected.needsCase && !selected.supportsDates && selected.kind !== 'detainees_stats' ? (
              <Text style={[Type.body, { color: Colors.textMuted, textAlign: 'right' }]}>لا فلاتر لهذا التقرير: يُبنى من البيانات الحالية كاملة ضمن صلاحياتك.</Text>
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

/* ───────────── بطاقة ملف منشأ ───────────── */
const GeneratedFileCard = React.memo(function GeneratedFileCard({ r, acting, onShare, onPrint, onRemove }: {
  r: GeneratedReport; acting: string | null; onShare: () => void; onPrint: () => void; onRemove: () => void;
}) {
  const isPdf = r.format === 'pdf';
  const c = isPdf ? Palette.red : Palette.blue;
  const Icon = isPdf ? FileText : FileType2;
  return (
    <Card accent={c} style={Glow(c)}>
      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12 }}>
        <View style={{ width: 52, height: 62, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(c, 0.14), borderWidth: 1, borderColor: tint(c, 0.45) }}>
          <Icon color={c} size={24} />
          <Text style={[Type.caption, { color: c, fontFamily: 'Cairo_800ExtraBold', marginTop: 2 }]}>{isPdf ? 'PDF' : 'DOCX'}</Text>
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
'''

NEW_PANEL = r'''// SECURECASEDESK_PHASE9_S2 + SECURECASEDESK_UI_V3_ATTACHMENTS
// لوحة المرفقات (عربية RTL): بطاقات ملفات مع حالة السلامة وبصمة SHA-256، إضافة، معاينة، فحص سلامة، حذف مصرّح (للمدير فقط مع سبب).
// الواجهة تُخفي الأزرار حسب الدور، لكن الإنفاذ الفعلي في خدمة المرفقات وطبقة البيانات (لم يتغير شيء منه).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Modal, Image, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File } from 'expo-file-system';
import { FileText, Image as ImageIcon, Plus, Shield, ShieldCheck, ShieldAlert, Trash2, X, Eye, Check, Clock, UserRound, HardDrive, Paperclip, Lock, AlertTriangle } from 'lucide-react-native';
import { Colors, Palette, Type, tint, Glow } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { useAuth } from '@/context/AuthContext';
import type { Session } from '@/security/guard';
import {
  addAttachmentFromUri, getAttachments, removeAttachment, checkAttachment,
  openAttachmentToCache, purgeDecryptedCache,
  type AttachmentInfo, type AttachmentEntityType,
} from '@/services/attachments.service';
import {
  attachmentUiPermissions, formatFileSize, fileTypeLabel, isImageMime, precheckPickedFile,
  validateDeleteReason, friendlyAttachmentError, integrityMessage, toArabicDigits, ENTITY_LABELS,
} from '@/modules/attachments/attachments-ui-logic';
import { Card, Pill, Btn, Field } from '@/components/ui/Kit';
import { EmptyState } from '@/components/ui/States';
import { PressableScale, FadeIn } from '@/components/ui/Motion';
import { Skeleton } from '@/components/ui/Skeleton';

const p2 = (n: number) => String(n).padStart(2, '0');
function formatDate(ts: number): string {
  const d = new Date(ts);
  return toArabicDigits(`${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`);
}
function formatTime(ts: number): string {
  const d = new Date(ts);
  return toArabicDigits(`${p2(d.getHours())}:${p2(d.getMinutes())}`);
}
// بصمة مختصرة للعرض فقط (الأصلية كاملة في قاعدة البيانات).
function shortHash(h: string): string {
  return h.length > 16 ? h.slice(0, 8) + '…' + h.slice(-6) : h;
}

type Verify = { state: 'busy' } | { state: 'ok'; at: number } | { state: 'bad'; message: string };

interface Props {
  entityType: AttachmentEntityType;
  entityId: string;
  onCountChange?: (count: number) => void;
}

export default function AttachmentsPanel({ entityType, entityId, onCountChange }: Props) {
  const { user } = useAuth();
  const session = useMemo<Session | null>(
    () => (user ? { userId: user.id, role: user.role } : null),
    [user?.id, user?.role]
  );
  const perms = useMemo(() => attachmentUiPermissions(user?.role, entityType), [user?.role, entityType]);

  const [items, setItems] = useState<AttachmentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // 'add' أو معرّف المرفق قيد المعالجة
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageName, setImageName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AttachmentInfo | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, Verify>>({});

  const load = useCallback(async () => {
    if (!perms.canView) { setItems([]); setLoading(false); return; }
    try {
      const list = await getAttachments(session, entityType, entityId);
      setItems(list);
      onCountChange?.(list.length);
    } catch (e) {
      setMessage({ text: friendlyAttachmentError(e), ok: false });
    } finally {
      setLoading(false);
    }
  }, [session, entityType, entityId, perms.canView, onCountChange]);

  useEffect(() => {
    purgeDecryptedCache(); // تنظيف أي نسخ مفكوكة متبقية من جلسة سابقة
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async () => {
    if (busy) return;
    setMessage(null);
    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/jpeg', 'image/png'],
        copyToCacheDirectory: true,
        multiple: false,
      });
    } catch {
      setMessage({ text: 'تعذر فتح منتقي الملفات.', ok: false });
      return;
    }
    if (picked.canceled || !picked.assets?.length) return;
    const asset = picked.assets[0];

    const pre = precheckPickedFile({ name: asset.name, size: asset.size ?? null });
    if (pre) {
      deleteCacheCopy(asset.uri);
      setMessage({ text: pre, ok: false });
      return;
    }

    setBusy('add');
    try {
      await addAttachmentFromUri(session, entityType, entityId,
        { uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null });
      setMessage({ text: 'تمت إضافة المرفق وتشفيره بنجاح.', ok: true });
      await load();
    } catch (e) {
      setMessage({ text: friendlyAttachmentError(e), ok: false });
    } finally {
      deleteCacheCopy(asset.uri); // لا تبقى نسخة غير مشفرة في الكاش
      setBusy(null);
    }
  };

  const handleOpen = async (a: AttachmentInfo) => {
    if (busy) return;
    setMessage(null);
    setBusy(a.id);
    try {
      const out = await openAttachmentToCache(session, a.id);
      if (isImageMime(out.mimeType)) {
        setImageName(out.name);
        setImageUri(out.uri);
      } else {
        if (!(await Sharing.isAvailableAsync())) {
          purgeDecryptedCache();
          setMessage({ text: 'لا يتوفر تطبيق لعرض ملفات PDF على هذا الجهاز.', ok: false });
        } else {
          await Sharing.shareAsync(out.uri, { mimeType: 'application/pdf', dialogTitle: out.name });
        }
      }
    } catch (e) {
      setMessage({ text: friendlyAttachmentError(e), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const closeImage = () => {
    setImageUri(null);
    purgeDecryptedCache();
  };

  const handleVerify = async (a: AttachmentInfo) => {
    if (busy) return;
    setBusy(a.id);
    setVerified((p) => ({ ...p, [a.id]: { state: 'busy' } }));
    try {
      const r = await checkAttachment(session, a.id);
      setVerified((p) => ({ ...p, [a.id]: r.ok ? { state: 'ok', at: Date.now() } : { state: 'bad', message: integrityMessage(r.problem) } }));
    } catch (e) {
      setVerified((p) => { const n = { ...p }; delete n[a.id]; return n; });
      setMessage({ text: friendlyAttachmentError(e), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const err = validateDeleteReason(reason);
    if (err) { setReasonError(err); return; }
    setBusy(deleteTarget.id);
    try {
      await removeAttachment(session, deleteTarget.id, reason.trim());
      setDeleteTarget(null); setReason(''); setReasonError(null);
      setMessage({ text: 'تم حذف المرفق وتسجيل العملية في سجل التدقيق.', ok: true });
      await load();
    } catch (e) {
      setReasonError(friendlyAttachmentError(e));
    } finally {
      setBusy(null);
    }
  };

  if (!perms.canView) {
    return <EmptyState icon={Lock} color={Palette.red} compact title="ليس لديك صلاحية عرض المرفقات." />;
  }

  const totalBytes = items.reduce((a, x) => a + (x.size_bytes || 0), 0);

  return (
    <View style={{ gap: 12 }}>
      <View style={s.headerRow}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8 }}>
            <Text style={[Type.h3, { color: Colors.textPrimary }]}>المرفقات</Text>
            <Pill label={toArabicDigits(items.length)} color={Palette.cyan} />
          </View>
          <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]} numberOfLines={1}>
            {items.length > 0 ? 'الحجم الإجمالي ' + formatFileSize(totalBytes) + ' • مشفّرة على الجهاز' : 'كل ملف يُشفَّر قبل حفظه على الجهاز'}
          </Text>
        </View>
        {perms.canAdd ? (
          <Btn label="إضافة مرفق" icon={Plus} onPress={handleAdd} loading={busy === 'add'} disabled={busy !== null} style={s.addBtn} />
        ) : null}
      </View>

      {message ? (
        <FadeIn>
          <View style={[s.msg, { backgroundColor: tint(message.ok ? Palette.green : Palette.red, 0.1), borderColor: tint(message.ok ? Palette.green : Palette.red, 0.4) }]}>
            {message.ok ? <Check color={Palette.green} size={18} /> : <AlertTriangle color={Palette.red} size={18} />}
            <Text style={[Type.body, { flex: 1, textAlign: 'right', color: message.ok ? Palette.green : Palette.red, fontFamily: 'Cairo_600SemiBold' }]}>{message.text}</Text>
            <Pressable onPress={() => setMessage(null)} hitSlop={10} accessibilityLabel="إخفاء الرسالة"><X color={Colors.textMuted} size={16} /></Pressable>
          </View>
        </FadeIn>
      ) : null}

      {busy === 'add' ? (
        <View style={[s.uploading, { borderColor: tint(Palette.cyan, 0.4), backgroundColor: tint(Palette.cyan, 0.08) }]}>
          <ActivityIndicator color={Palette.cyan} />
          <View style={{ flex: 1 }}>
            <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]}>جارٍ تشفير الملف وحفظه…</Text>
            <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>لا تغلق هذه النافذة حتى يكتمل الحفظ.</Text>
          </View>
        </View>
      ) : null}

      {loading ? (
        <View style={{ gap: 12 }}>{[0, 1].map((i) => <AttachmentSkeleton key={i} />)}</View>
      ) : items.length === 0 && busy !== 'add' ? (
        <EmptyState icon={Paperclip} color={Palette.cyan} title="لا توجد مرفقات لهذا السجل" hint="الملفات المسموحة: PDF وJPG وPNG حتى ١٥ ميغابايت."
          actionLabel={perms.canAdd ? 'إضافة مرفق' : undefined} onAction={perms.canAdd ? handleAdd : undefined} />
      ) : (
        items.map((a) => (
          <AttachmentCard
            key={a.id} a={a} v={verified[a.id]} working={busy === a.id} locked={busy !== null}
            canVerify={perms.canVerify} canDelete={perms.canDelete}
            onOpen={() => void handleOpen(a)} onVerify={() => void handleVerify(a)}
            onDelete={() => { setDeleteTarget(a); setReason(''); setReasonError(null); }}
          />
        ))
      )}

      {/* معاينة الصور */}
      <Modal visible={imageUri !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={closeImage}>
        <View style={s.imgOverlay}>
          <View style={s.imgTop}>
            <View style={{ flex: 1 }}>
              <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={1}>{imageName}</Text>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>نسخة مؤقتة مفكوكة التشفير تُحذف عند الإغلاق</Text>
            </View>
            <Pressable onPress={closeImage} accessibilityLabel="إغلاق المعاينة" hitSlop={10} style={s.closeBtn}><X size={20} color={Colors.textPrimary} /></Pressable>
          </View>
          {imageUri ? <Image source={{ uri: imageUri }} style={s.img} resizeMode="contain" /> : null}
        </View>
      </Modal>

      {/* سبب الحذف */}
      <Modal visible={deleteTarget !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setDeleteTarget(null)}>
        <View style={s.dlgOverlay}>
          <View style={s.dlg}>
            <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12 }}>
              <View style={[s.dlgIcon, { backgroundColor: tint(Palette.red, 0.14), borderColor: tint(Palette.red, 0.45) }]}><Trash2 color={Palette.red} size={22} /></View>
              <View style={{ flex: 1 }}>
                <Text style={[Type.h2, { color: Colors.textPrimary, textAlign: 'right' }]}>حذف المرفق</Text>
                <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]} numberOfLines={2}>{deleteTarget?.original_name}</Text>
              </View>
            </View>
            <View style={s.dlgNote}>
              <ShieldCheck color={Palette.cyan} size={16} />
              <Text style={[Type.caption, { flex: 1, color: Colors.textSecondary, textAlign: 'right' }]}>
                يُحذف الملف المشفر ويبقى سجل المرفق (الاسم والبصمة والسبب والمنفّذ) محفوظاً في السجل.
              </Text>
            </View>
            <View style={{ marginTop: 14 }}>
              <Field
                label={'سبب الحذف (٥ أحرف على الأقل) — ' + toArabicDigits(reason.trim().length)}
                placeholder="اكتب سبب الحذف"
                value={reason}
                onChangeText={(t) => { setReason(t); setReasonError(null); }}
                multiline
              />
              {reasonError ? <Text style={[Type.caption, { color: Palette.red, textAlign: 'right', marginTop: -8, marginBottom: 8 }]}>{reasonError}</Text> : null}
            </View>
            <View style={{ flexDirection: ROW, gap: 10 }}>
              <Btn label="إلغاء" variant="ghost" onPress={() => setDeleteTarget(null)} style={{ flex: 1 }} />
              <Btn label="تأكيد الحذف" variant="danger" icon={Trash2} onPress={() => void confirmDelete()} loading={busy !== null && busy === deleteTarget?.id} disabled={busy !== null} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* ───────────── بطاقة المرفق ───────────── */
const AttachmentCard = React.memo(function AttachmentCard({ a, v, working, locked, canVerify, canDelete, onOpen, onVerify, onDelete }: {
  a: AttachmentInfo; v: Verify | undefined; working: boolean; locked: boolean; canVerify: boolean; canDelete: boolean;
  onOpen: () => void; onVerify: () => void; onDelete: () => void;
}) {
  const img = isImageMime(a.mime_type);
  const c = img ? Palette.cyan : Palette.red;
  const Icon = img ? ImageIcon : FileText;
  const ext = a.extension.toLowerCase() === 'jpeg' ? 'JPG' : a.extension.toUpperCase();
  const st = v?.state;
  const sc = st === 'ok' ? Palette.green : st === 'bad' ? Palette.red : Palette.cyan;
  return (
    <Card accent={c}>
      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12 }}>
        <View style={[s.tile, { backgroundColor: tint(c, 0.14), borderColor: tint(c, 0.45) }, Glow(c)]}>
          <Icon color={c} size={22} />
          <Text style={[Type.caption, { color: c, fontFamily: 'Cairo_800ExtraBold', marginTop: 1 }]}>{ext}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={2}>{a.original_name}</Text>
          <View style={{ flexDirection: ROW, marginTop: 4 }}>
            <Pill label={fileTypeLabel(a.mime_type)} color={c} />
          </View>
        </View>
      </View>

      <View style={s.metaGrid}>
        <MetaCell icon={HardDrive} label="الحجم" value={formatFileSize(a.size_bytes)} />
        <MetaCell icon={Clock} label="تاريخ الرفع" value={formatDate(a.created_at) + ' • ' + formatTime(a.created_at)} />
        {a.created_by_name ? <MetaCell icon={UserRound} label="أضافه" value={a.created_by_name} /> : null}
      </View>

      <View style={[s.integrity, { backgroundColor: tint(sc, st ? 0.1 : 0.06), borderColor: tint(sc, st ? 0.4 : 0.25) }]}>
        {st === 'busy' ? <ActivityIndicator size="small" color={sc} /> : st === 'ok' ? <ShieldCheck color={sc} size={20} /> : st === 'bad' ? <ShieldAlert color={sc} size={20} /> : <Shield color={Colors.textMuted} size={20} />}
        <View style={{ flex: 1, gap: 2 }}>
          {st === 'ok' ? (
            <>
              <StatusLine color={sc} text="ملف سليم" />
              <StatusLine color={sc} text="تم التحقق من SHA-256 وفك التشفير" />
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>آخر فحص: {formatTime((v as { at: number }).at)}</Text>
            </>
          ) : st === 'bad' ? (
            <Text style={[Type.body, { color: sc, fontFamily: 'Cairo_700Bold', textAlign: 'right' }]}>{(v as { message: string }).message}</Text>
          ) : st === 'busy' ? (
            <Text style={[Type.body, { color: Colors.textSecondary, textAlign: 'right' }]}>جارٍ فحص السلامة…</Text>
          ) : (
            <>
              <Text style={[Type.body, { color: Colors.textSecondary, fontFamily: 'Cairo_600SemiBold', textAlign: 'right' }]}>لم يُفحص في هذه الجلسة</Text>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>يُتحقق منه تلقائياً عند كل فتح.</Text>
            </>
          )}
          <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', writingDirection: 'ltr' }]} numberOfLines={1}>SHA-256: {shortHash(a.sha256_plain)}</Text>
        </View>
      </View>

      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8, marginTop: 12 }}>
        <PressableScale onPress={onOpen} disabled={locked} accessibilityRole="button" accessibilityLabel={img ? 'معاينة' : 'فتح'}
          style={[s.act, { flex: 1.2, backgroundColor: Palette.blue, borderColor: Palette.blue, opacity: locked && !working ? 0.55 : 1 }, Glow(Palette.blue)]}>
          {working && st !== 'busy' ? <ActivityIndicator size="small" color="#fff" /> : <Eye color="#fff" size={17} />}
          <Text style={[Type.body, { color: '#fff', fontFamily: 'Cairo_700Bold' }]}>{img ? 'معاينة' : 'فتح'}</Text>
        </PressableScale>
        {canVerify ? (
          <PressableScale onPress={onVerify} disabled={locked} accessibilityRole="button" accessibilityLabel="فحص السلامة"
            style={[s.act, { flex: 1.4, backgroundColor: tint(Palette.green, 0.12), borderColor: tint(Palette.green, 0.45), opacity: locked && !working ? 0.55 : 1 }]}>
            <ShieldCheck color={Palette.green} size={17} />
            <Text style={[Type.body, { color: Palette.green, fontFamily: 'Cairo_700Bold' }]}>{st === 'ok' ? 'إعادة الفحص' : 'فحص السلامة'}</Text>
          </PressableScale>
        ) : null}
        {canDelete ? (
          <PressableScale onPress={onDelete} disabled={locked} accessibilityRole="button" accessibilityLabel="حذف المرفق"
            style={[s.act, { width: 46, backgroundColor: tint(Palette.red, 0.12), borderColor: tint(Palette.red, 0.45), opacity: locked && !working ? 0.55 : 1 }]}>
            <Trash2 color={Palette.red} size={17} />
          </PressableScale>
        ) : null}
      </View>
    </Card>
  );
});

function StatusLine({ color, text }: { color: string; text: string }) {
  return (
    <View style={{ flexDirection: ROW, alignItems: 'center', gap: 6 }}>
      <Check color={color} size={14} />
      <Text style={[Type.body, { color, fontFamily: 'Cairo_700Bold', textAlign: 'right' }]}>{text}</Text>
    </View>
  );
}

function MetaCell({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <View style={s.metaCell}>
      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 5 }}>
        <Icon color={Colors.textMuted} size={12} />
        <Text style={[Type.caption, { color: Colors.textMuted }]} numberOfLines={1}>{label}</Text>
      </View>
      <Text style={[Type.body, { color: Colors.textPrimary, textAlign: 'right', fontFamily: 'Cairo_600SemiBold' }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function AttachmentSkeleton() {
  return (
    <View style={s.skel}>
      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12 }}>
        <Skeleton width={52} height={62} radius={14} />
        <View style={{ flex: 1, gap: 8 }}>
          <Skeleton width="80%" height={16} />
          <Skeleton width={70} height={20} radius={999} />
        </View>
      </View>
      <Skeleton height={44} radius={14} style={{ marginTop: 14 }} />
      <Skeleton height={44} radius={14} style={{ marginTop: 12 }} />
    </View>
  );
}

function deleteCacheCopy(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // فشل تنظيف الكاش لا يؤثر على نتيجة العملية.
  }
}

const s = StyleSheet.create({
  headerRow: { flexDirection: ROW, alignItems: 'center', gap: 10 },
  addBtn: { height: 44, paddingHorizontal: 14, borderRadius: 14 },
  msg: { flexDirection: ROW, alignItems: 'center', gap: 10, padding: 12, borderRadius: 16, borderWidth: 1 },
  uploading: { flexDirection: ROW, alignItems: 'center', gap: 12, padding: 14, borderRadius: 18, borderWidth: 1 },
  tile: { width: 52, height: 62, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  metaGrid: { flexDirection: ROW, flexWrap: 'wrap', gap: 10, marginTop: 14 },
  metaCell: { flexBasis: '46%', flexGrow: 1, gap: 1 },
  integrity: { flexDirection: ROW, alignItems: 'center', gap: 10, marginTop: 12, padding: 12, borderRadius: 16, borderWidth: 1 },
  act: { height: 46, borderRadius: 14, flexDirection: ROW, alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1 },
  skel: { backgroundColor: Palette.surface, borderRadius: 22, padding: 16, borderWidth: 1, borderColor: Palette.glassBorder },
  imgOverlay: { flex: 1, backgroundColor: 'rgba(3,6,14,0.96)', paddingTop: 44 },
  imgTop: { flexDirection: ROW, alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingBottom: 14 },
  closeBtn: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(148,163,255,0.14)' },
  img: { flex: 1, width: '100%' },
  dlgOverlay: { flex: 1, backgroundColor: 'rgba(3,6,14,0.78)', justifyContent: 'center', padding: 20 },
  dlg: { backgroundColor: Palette.surface, borderRadius: 26, padding: 18, borderWidth: 1, borderColor: tint(Palette.red, 0.35) },
  dlgIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  dlgNote: { flexDirection: ROW, alignItems: 'center', gap: 8, marginTop: 14, padding: 10, borderRadius: 14, backgroundColor: tint(Palette.cyan, 0.08), borderWidth: 1, borderColor: tint(Palette.cyan, 0.28) },
});
'''

NEW_SHEET = r'''// SECURECASEDESK_PHASE9_S2 + SECURECASEDESK_UI_V3_ATTACHMENTS
// نافذة سفلية موحدة (Sheet) تحمل لوحة المرفقات، وزر "المرفقات" الذي يفتحها ويعرض العدد.

import React, { useEffect, useMemo, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { Paperclip } from 'lucide-react-native';
import { Colors, Palette, Type, tint } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { useAuth } from '@/context/AuthContext';
import { getAttachmentCount, type AttachmentEntityType } from '@/services/attachments.service';
import { attachmentUiPermissions, toArabicDigits } from '@/modules/attachments/attachments-ui-logic';
import { Sheet } from '@/components/ui/Kit';
import { PressableScale } from '@/components/ui/Motion';
import AttachmentsPanel from './AttachmentsPanel';

export function AttachmentsSheet(props: {
  visible: boolean; onClose: () => void; entityType: AttachmentEntityType; entityId: string; title: string;
}) {
  return (
    <Sheet visible={props.visible} onClose={props.onClose} title={props.title} subtitle="ملفات مشفّرة على الجهاز، تُفحص سلامتها بالبصمة عند الفتح">
      {props.visible ? <AttachmentsPanel entityType={props.entityType} entityId={props.entityId} /> : null}
    </Sheet>
  );
}

// زر مضغوط للبطاقات: لا يظهر أصلاً لمن لا يملك صلاحية عرض مرفقات هذا النوع.
export function AttachmentsButton(props: { entityType: AttachmentEntityType; entityId: string; title: string }) {
  const { user } = useAuth();
  const session = useMemo(() => (user ? { userId: user.id, role: user.role } : null), [user?.id, user?.role]);
  const canView = attachmentUiPermissions(user?.role, props.entityType).canView;
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!canView || open) return;
    let alive = true;
    getAttachmentCount(session, props.entityType, props.entityId)
      .then((c) => { if (alive) setCount(c); })
      .catch(() => { if (alive) setCount(null); });
    return () => { alive = false; };
  }, [canView, open, session, props.entityType, props.entityId]);

  if (!canView) return null;
  const has = (count ?? 0) > 0;
  const c = Palette.cyan;
  return (
    <>
      <PressableScale onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="المرفقات"
        style={[styles.btn, { backgroundColor: tint(c, has ? 0.14 : 0.08), borderColor: tint(c, has ? 0.5 : 0.3) }]}>
        <Paperclip size={15} color={c} />
        <Text style={[Type.body, { color: c, fontFamily: 'Cairo_700Bold' }]}>المرفقات</Text>
        {count !== null ? (
          <View style={[styles.badge, { backgroundColor: has ? c : tint('#94A3B8', 0.2) }]}>
            <Text style={[Type.caption, { color: has ? Palette.bg0 : Colors.textMuted, fontFamily: 'Cairo_800ExtraBold' }]}>{toArabicDigits(count)}</Text>
          </View>
        ) : null}
      </PressableScale>
      <AttachmentsSheet visible={open} onClose={() => setOpen(false)}
        entityType={props.entityType} entityId={props.entityId} title={props.title} />
    </>
  );
}

const styles = StyleSheet.create({
  btn: { flexDirection: ROW, alignItems: 'center', alignSelf: 'flex-start', gap: 7, marginTop: 8, paddingHorizontal: 12, height: 36, borderRadius: 12, borderWidth: 1 },
  badge: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
'''


def write(path, text):
    exists = os.path.isfile(path)
    prev = open(path, encoding='utf8').read() if exists else None
    if prev == text: print('  = بلا تغيير: ' + path); return
    if exists:
        shutil.copy(path, path + '.bak_' + TS); print('  ! نُسخ احتياطياً: ' + path + '.bak_' + TS)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf8', newline='\n') as f: f.write(text)
    print('  ✔ ' + ('كُتب: ' if exists else 'أُنشئ: ') + path)

print('\n▶ تطبيق الدفعة: التقارير + بطاقات المرفقات')
write(CHARTS, NEW_CHARTS)
write(REPORTS, NEW_REPORTS)
write(PANEL, NEW_PANEL)
write(SHEET, NEW_SHEET)

# ───── التحقق ─────
def run(label, cmd):
    print('\n▶ ' + label + '  (' + cmd + ')')
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf8')
    out = (r.stdout or '') + (r.stderr or '')
    if label.startswith('tsc'):
        print(out.strip()[-3000:] or '  (لا أخطاء)')
    else:
        m = re.findall(r'^# (tests|pass|fail|todo) (\d+)', out, re.M)
        print('  ' + ' | '.join(k + '=' + v for k, v in m) if m else out.strip()[-1500:])
    return r.returncode == 0

ok = True
checked = False
if os.path.isdir('node_modules'):
    checked = True
    ok &= run('tsc فحص الأنواع', 'npx tsc --noEmit')
    ok &= run('اختبار RTL والخطوط واللغة', 'npm run test:rtl')
    ok &= run('اختبار منطق واجهة المرفقات', 'npm run test:attachments-ui')
    ok &= run('اختبار التقارير', 'npm run test:reports')
    ok &= run('اختبار تصدير التقارير', 'npm run test:reports-export')
else:
    print('\n! node_modules غير موجودة هنا: شغّل يدوياً  npx tsc --noEmit && npm run test:rtl && npm run test:attachments-ui && npm run test:reports')

print('\n' + (('✔ تمّت الدفعة وكل الفحوص نجحت.' if checked else '✔ كُتبت الملفات، لكن الفحوص لم تُشغَّل (node_modules غير موجودة).') if ok else '✘ فشل فحص واحد على الأقل — راجع الإخراج أعلاه. للتراجع: انسخ ملفات .bak_' + TS + ' فوق الأصل (واحذف Charts.tsx).'))
print('بعدها على الجهاز: التقارير (تحليلات/فلاتر/إنشاء PDF وWord/مشاركة/طباعة/حذف) — ثم مرفقات قضية ومذكرة ومحتجز (إضافة/معاينة/فحص سلامة/حذف مع سبب).')
