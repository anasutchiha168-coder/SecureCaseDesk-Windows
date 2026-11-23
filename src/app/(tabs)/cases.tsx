// SECURECASEDESK_PHASE9_S2 + SECURECASEDESK_UI_V3 — شاشة القضايا: لوحة إحصائيات + فلاتر + بطاقات + تفاصيل بتبويبات.
// المنطق والصلاحيات وخدمات البيانات كما كانت؛ التغيير في العرض فقط (مع عرض سجل التعديلات للقراءة).
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, FlatList, Alert, Pressable } from 'react-native';
import {
  FolderOpen, FolderPlus, FolderCheck, AlertTriangle, Layers, Building2, Tag, CalendarDays, RefreshCw,
  UserRound, MapPin, ArrowUpDown, History, Paperclip, Check, Pencil, ArrowRightLeft, Archive, ArchiveRestore, UserCog,
} from 'lucide-react-native';
import { Colors, Palette, Type } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { AttachmentsButton } from '@/components/attachments/AttachmentsSheet';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { ForbiddenError, type Session } from '@/security/guard';
import { listCases, listDepartmentOptions, insertCase, DuplicateCaseError, type CaseItem } from '@/services/cases.service';
import { getCaseHistory, type CaseHistoryItem } from '@/services/cases-actions.service';
import { CASE_STATUSES, ARCHIVED_STATUS, CLOSED_STATUSES } from '@/modules/cases/cases-actions';
import {
  Screen, PageHeader, IconBtn, Card, Pill, MetaItem, StatStrip, SearchField, FilterChips, Btn, Field, SelectField,
  Sheet, ListSkeleton, SectionTitle, type MiniStat, type ChipOpt,
} from '@/components/ui/Kit';
import { Timeline, CompareRow, type TimelineItem } from '@/components/ui/Timeline';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { FadeIn } from '@/components/ui/Motion';

interface DepartmentItem { id: string; name: string }
type SortMode = 'newest' | 'oldest' | 'number';
type DetailTab = 'overview' | 'people' | 'history' | 'files';

const SORT_LABEL: Record<SortMode, string> = { newest: 'الأحدث تحديثاً', oldest: 'الأقدم', number: 'رقم القضية' };
const NEXT_SORT: Record<SortMode, SortMode> = { newest: 'oldest', oldest: 'number', number: 'newest' };

function statusColor(status: string): string {
  if (status === 'قيد التحقيق') return Palette.red;
  if (status === 'محالة') return Palette.purple;
  if (status === 'مغلقة') return Palette.green;
  if (status === ARCHIVED_STATUS) return Colors.textMuted;
  return Palette.blue; // جديدة
}

const fmtDate = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleDateString('ar-YE', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const fmtDateTime = (ts: number) =>
  new Date(ts).toLocaleDateString('ar-YE', { year: 'numeric', month: 'short', day: 'numeric' }) + ' • ' +
  new Date(ts).toLocaleTimeString('ar-YE', { hour: '2-digit', minute: '2-digit' });

const FIELD_LABEL: Record<string, string> = {
  title: 'العنوان', complainant: 'المُبلغ / المجني عليه', suspects: 'المشتبه بهم', case_type: 'نوع القضية',
  incident_location: 'موقع الحادث', incident_details: 'تفاصيل الواقعة', status: 'الحالة',
  officer_id: 'المسؤول عن القضية', department_id: 'القسم',
};
const ACTION_LOOK: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  update: { label: 'تعديل بيانات', icon: Pencil, color: Palette.gold },
  status: { label: 'تغيير الحالة', icon: ArrowRightLeft, color: Palette.cyan },
  archive: { label: 'أرشفة', icon: Archive, color: Colors.textMuted },
  unarchive: { label: 'إلغاء الأرشفة', icon: ArchiveRestore, color: Palette.green },
  assign: { label: 'إسناد', icon: UserCog, color: Palette.purple },
  transfer: { label: 'نقل بين الأقسام', icon: ArrowRightLeft, color: Palette.blue },
};

/* ───────────── بطاقة القضية ───────────── */
const CaseCard = React.memo(function CaseCard({ item, dept, index, onOpen }: { item: CaseItem; dept: string; index: number; onOpen: (c: CaseItem) => void }) {
  const color = statusColor(item.status);
  return (
    <FadeIn delay={Math.min(index, 8) * 40}>
      <Card accent={color} onPress={() => onOpen(item)} label={'فتح تفاصيل القضية ' + item.case_number}>
        <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[Type.h3, { color: Palette.cyan, fontFamily: 'Cairo_800ExtraBold' }]}>{item.case_number}</Text>
          <Pill label={item.status} color={color} />
        </View>
        <Text style={[Type.h2, { color: Colors.textPrimary, textAlign: 'right', marginTop: 2 }]} numberOfLines={2}>{item.title}</Text>
        <View style={{ flexDirection: ROW, flexWrap: 'wrap', rowGap: 8, columnGap: 12, marginTop: 10 }}>
          <MetaItem icon={Building2} label="القسم" value={dept} />
          <MetaItem icon={Tag} label="نوع القضية" value={item.case_type} />
          <MetaItem icon={CalendarDays} label="تاريخ التسجيل" value={fmtDate(item.registration_date)} />
          <MetaItem icon={RefreshCw} label="آخر تحديث" value={fmtDate(item.updated_at)} />
        </View>
        {item.incident_details ? (
          <Text style={[Type.body, { color: Colors.textSecondary, textAlign: 'right', marginTop: 10 }]} numberOfLines={2}>{item.incident_details}</Text>
        ) : null}
        <View style={{ marginTop: 6 }}>
          <AttachmentsButton entityType="case" entityId={item.id} title={'مرفقات القضية ' + item.case_number} />
        </View>
      </Card>
    </FadeIn>
  );
});

/* ───────────── تفاصيل القضية ───────────── */
function CaseDetails({ item, dept, session, onClose }: { item: CaseItem | null; dept: string; session: Session | null; onClose: () => void }) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const [history, setHistory] = useState<CaseHistoryItem[] | null>(null);
  const [hErr, setHErr] = useState(false);
  const id = item?.id;

  useEffect(() => { setTab('overview'); setHistory(null); setHErr(false); }, [id]);
  const loadHistory = useCallback(async () => {
    if (!id) return;
    setHErr(false);
    try { setHistory(await getCaseHistory(session, id)); }
    catch (e) { setHistory(null); if (!(e instanceof ForbiddenError)) console.error('[cases] history error:', e); setHErr(true); }
  }, [id, session]);
  useEffect(() => { if (tab === 'history' && history === null && !hErr) void loadHistory(); }, [tab, history, hErr, loadHistory]);

  const tabs: ChipOpt<DetailTab>[] = [
    { key: 'overview', label: 'نظرة عامة' }, { key: 'people', label: 'الأشخاص' },
    { key: 'history', label: 'سجل التعديلات', count: history?.length }, { key: 'files', label: 'المرفقات' },
  ];
  const color = item ? statusColor(item.status) : Palette.blue;

  const timeline: TimelineItem[] = (history ?? []).slice().reverse().map((h) => {
    const look = ACTION_LOOK[h.action] ?? { label: h.action, icon: History, color: Palette.cyan };
    return {
      key: h.id, icon: look.icon, color: look.color, title: look.label,
      subtitle: (h.executed_by_name ?? '—') + (h.reason ? ' • السبب: ' + h.reason : ''),
      time: fmtDateTime(h.created_at),
      extra: <CompareRow label={FIELD_LABEL[h.field_name] ?? h.field_name} from={h.previous_value} to={h.new_value} />,
    };
  });

  return (
    <Sheet visible={!!item} onClose={onClose} title={item ? 'قضية ' + item.case_number : ''} subtitle={item?.title}>
      {item ? (
        <>
          <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Pill label={item.status} color={color} />
            <Text style={[Type.caption, { color: Colors.textMuted }]}>آخر تحديث: {fmtDate(item.updated_at)}</Text>
          </View>
          <View style={{ marginHorizontal: -18, marginBottom: 14 }}><FilterChips options={tabs} value={tab} onChange={setTab} /></View>

          {tab === 'overview' ? (
            <Card>
              <View style={{ flexDirection: ROW, flexWrap: 'wrap', rowGap: 12, columnGap: 12 }}>
                <MetaItem icon={Layers} label="رقم القضية" value={item.case_number} />
                <MetaItem icon={Tag} label="نوع القضية" value={item.case_type} />
                <MetaItem icon={Building2} label="القسم" value={dept} />
                <MetaItem icon={CalendarDays} label="تاريخ التسجيل" value={fmtDate(item.registration_date)} />
                <MetaItem icon={MapPin} label="موقع الحادث" value={item.incident_location || '—'} />
                <MetaItem icon={RefreshCw} label="آخر تحديث" value={fmtDate(item.updated_at)} />
              </View>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', marginTop: 14 }]}>ملخص الواقعة</Text>
              <Text style={[Type.bodyLg, { color: Colors.textPrimary, textAlign: 'right' }]}>{item.incident_details || 'لا توجد تفاصيل مسجلة.'}</Text>
            </Card>
          ) : null}

          {tab === 'people' ? (
            <View style={{ gap: 12 }}>
              <Card accent={Palette.blue}>
                <MetaItem icon={UserRound} label="المُبلغ / المجني عليه" value={item.complainant || 'غير مسجل'} color={Palette.blue} />
              </Card>
              <Card accent={Palette.red}>
                <MetaItem icon={UserRound} label="المشتبه بهم" value={item.suspects || 'غير مسجل'} color={Palette.red} />
              </Card>
            </View>
          ) : null}

          {tab === 'history' ? (
            hErr ? <ErrorState message="تعذر تحميل سجل التعديلات." onRetry={() => { setHErr(false); setHistory(null); }} />
              : history === null ? <ListSkeleton count={2} />
              : history.length === 0 ? <EmptyState icon={History} title="لا توجد تعديلات مسجلة" hint="أي تعديل لاحق على القضية سيُحفظ هنا ولا يُحذف." color={Palette.gold} />
              : <Card><Timeline items={timeline} /></Card>
          ) : null}

          {tab === 'files' ? (
            <Card>
              <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8 }}>
                <Paperclip color={Palette.cyan} size={18} />
                <Text style={[Type.h3, { color: Colors.textPrimary }]}>مرفقات القضية</Text>
              </View>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', marginTop: 2 }]}>كل ملف يُتحقق من سلامته بالتجزئة SHA-256 عند فتحه.</Text>
              <AttachmentsButton entityType="case" entityId={item.id} title={'مرفقات القضية ' + item.case_number} />
            </Card>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}

/* ───────────── الشاشة ───────────── */
export default function CasesScreen() {
  const { user } = useAuth();
  const session = useMemo<Session | null>(() => (user ? { userId: user.id, role: user.role } : null), [user?.id, user?.role]);
  const canManage = can(user?.role, 'cases.manage');
  const deniedAlerted = useRef(false);
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [allCases, setAllCases] = useState<CaseItem[]>([]); // بلا بحث: أساس الإحصائيات
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [deptPickerVisible, setDeptPickerVisible] = useState(false);
  const [detail, setDetail] = useState<CaseItem | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sort, setSort] = useState<SortMode>('newest');

  const [caseNumber, setCaseNumber] = useState('');
  const [title, setTitle] = useState('');
  const [caseType, setCaseType] = useState('');
  const [complainant, setComplainant] = useState('');
  const [suspects, setSuspects] = useState('');
  const [incidentLocation, setIncidentLocation] = useState('');
  const [incidentDetails, setIncidentDetails] = useState('');
  const [selectedDept, setSelectedDept] = useState<DepartmentItem | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const deptMap = useMemo(() => {
    const map: Record<string, string> = {};
    departments.forEach((d) => { map[d.id] = d.name; });
    return map;
  }, [departments]);
  const deptName = useCallback((c: CaseItem) => (c.department_id ? (deptMap[c.department_id] ?? '—') : 'بدون قسم'), [deptMap]);

  const loadDepartments = useCallback(async () => {
    if (!session) return;
    try { setDepartments(await listDepartmentOptions(session)); }
    catch (error) {
      setDepartments([]);
      if (!(error instanceof ForbiddenError)) console.error('[cases] loadDepts error:', error);
    }
  }, [session]);

  const loadCases = useCallback(async (query: string = '') => {
    if (!session) return;
    try {
      const rows = await listCases(session, query);
      setCases(rows);
      if (query === '') setAllCases(rows);
      setFailed(false);
    } catch (error) {
      setCases([]);
      if (error instanceof ForbiddenError) {
        if (!deniedAlerted.current) { deniedAlerted.current = true; Alert.alert('تنبيه', 'ليست لديك صلاحية'); }
      } else {
        console.error('[cases] loadCases error:', error);
        setFailed(true);
      }
    } finally { setLoading(false); }
  }, [session]);

  useEffect(() => { loadDepartments(); loadCases(); }, [loadDepartments, loadCases]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { loadCases(searchQuery); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery, loadCases]);

  const resetForm = () => {
    setCaseNumber(''); setTitle(''); setCaseType(''); setComplainant('');
    setSuspects(''); setIncidentLocation(''); setIncidentDetails(''); setSelectedDept(null);
  };

  const handleSaveCase = async () => {
    const trimmedNumber = caseNumber.trim();
    const trimmedTitle = title.trim();
    const trimmedType = caseType.trim();
    if (!trimmedNumber || !trimmedTitle || !trimmedType) {
      Alert.alert('تنبيه', 'يرجى إدخال رقم القضية وعنوانها ونوع القضية'); return;
    }
    setSaving(true);
    try {
      await insertCase(session, {
        caseNumber: trimmedNumber, title: trimmedTitle, caseType: trimmedType,
        complainant, suspects, incidentLocation, incidentDetails, departmentId: selectedDept?.id ?? null,
      });
      setModalVisible(false); resetForm(); await loadCases(searchQuery);
      if (searchQuery !== '') await loadCases('');
    } catch (error) {
      if (error instanceof ForbiddenError) Alert.alert('تنبيه', 'ليست لديك صلاحية');
      else if (error instanceof DuplicateCaseError) Alert.alert('خطأ', `رقم القضية "${trimmedNumber}" مستخدم مسبقاً`);
      else { console.error('[cases] save error:', error); Alert.alert('خطأ', 'فشل حفظ القضية'); }
    } finally { setSaving(false); }
  };

  const stats = useMemo(() => {
    const total = allCases.length;
    const closed = allCases.filter((c) => c.status === 'مغلقة').length;
    const open = allCases.filter((c) => !CLOSED_STATUSES.includes(c.status)).length;
    const inv = allCases.filter((c) => c.status === 'قيد التحقيق').length;
    return { total, closed, open, inv };
  }, [allCases]);

  const tiles: MiniStat[] = [
    { key: 't', label: 'إجمالي القضايا', value: stats.total, color: Palette.blue, icon: Layers },
    { key: 'o', label: 'القضايا المفتوحة', value: stats.open, color: Palette.cyan, icon: FolderOpen },
    { key: 'c', label: 'القضايا المغلقة', value: stats.closed, color: Palette.green, icon: FolderCheck },
    { key: 'i', label: 'قيد التحقيق', value: stats.inv, color: Palette.red, icon: AlertTriangle },
  ];

  const chips: ChipOpt<string>[] = useMemo(() => ([
    { key: 'all', label: 'الكل', count: cases.length },
    ...CASE_STATUSES.map((st) => ({ key: st as string, label: st as string, count: cases.filter((c) => c.status === st).length, color: statusColor(st) })),
  ]), [cases]);

  const visible = useMemo(() => {
    const rows = statusFilter === 'all' ? cases.slice() : cases.filter((c) => c.status === statusFilter);
    if (sort === 'newest') rows.sort((a, b) => b.updated_at - a.updated_at);
    else if (sort === 'oldest') rows.sort((a, b) => a.updated_at - b.updated_at);
    else rows.sort((a, b) => a.case_number.localeCompare(b.case_number, 'ar', { numeric: true }));
    return rows;
  }, [cases, statusFilter, sort]);

  const openDetail = useCallback((c: CaseItem) => setDetail(c), []);
  const renderItem = useCallback(({ item, index }: { item: CaseItem; index: number }) => (
    <View style={{ paddingHorizontal: 18, marginBottom: 12 }}>
      <CaseCard item={item} dept={deptName(item)} index={index} onOpen={openDetail} />
    </View>
  ), [deptName, openDetail]);

  const hasQuery = searchQuery.length > 0 || statusFilter !== 'all';
  const header = (
    <View>
      <StatStrip items={tiles} />
      <SectionTitle title="سجل القضايا" hint={visible.length + ' من ' + cases.length + ' قضية'} top={20}
        action={
          <Pressable onPress={() => setSort(NEXT_SORT[sort])} accessibilityRole="button" accessibilityLabel="تغيير الترتيب"
            style={{ flexDirection: ROW, alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: 999, backgroundColor: Palette.surface, borderWidth: 1, borderColor: Palette.glassBorder }}>
            <ArrowUpDown color={Palette.cyan} size={14} />
            <Text style={[Type.caption, { color: Colors.textSecondary }]}>{SORT_LABEL[sort]}</Text>
          </Pressable>
        } />
    </View>
  );

  return (
    <Screen>
      <PageHeader title="القضايا" subtitle="إدارة ومتابعة ملفات القضايا" icon={FolderOpen} color={Palette.blue}
        actions={canManage ? <IconBtn icon={FolderPlus} label="إضافة قضية جديدة" solid color={Palette.blue} onPress={() => setModalVisible(true)} /> : undefined} />
      <SearchField value={searchQuery} onChangeText={setSearchQuery} placeholder="ابحث برقم القضية أو العنوان..." />
      <View style={{ height: 10 }} />
      <FilterChips options={chips} value={statusFilter} onChange={setStatusFilter} />
      <View style={{ height: 14 }} />

      {loading ? <ListSkeleton /> : failed ? (
        <View style={{ paddingHorizontal: 18 }}><ErrorState message="حدث خطأ أثناء تحميل القضايا." onRetry={() => { setLoading(true); void loadCases(searchQuery); }} /></View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 40, flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={6}
          windowSize={7}
          removeClippedSubviews
          ListEmptyComponent={
            <EmptyState
              icon={FolderOpen}
              title={hasQuery ? 'لا توجد نتائج مطابقة' : 'لا توجد قضايا مسجلة حالياً'}
              hint={hasQuery ? 'جرّب تغيير كلمات البحث أو الفلتر.' : 'لا توجد بيانات متاحة حالياً.'}
              actionLabel={!hasQuery && canManage ? 'إضافة قضية' : undefined}
              onAction={!hasQuery && canManage ? () => setModalVisible(true) : undefined}
            />
          }
        />
      )}

      <CaseDetails item={detail} dept={detail ? deptName(detail) : ''} session={session} onClose={() => setDetail(null)} />

      <Sheet visible={modalVisible} onClose={() => { setModalVisible(false); resetForm(); }} title="تسجيل قضية جديدة" subtitle="الحقول المعلّمة بنجمة إلزامية"
        footer={<>
          <Btn label="حفظ القضية" icon={Check} onPress={handleSaveCase} loading={saving} style={{ flex: 1 }} />
          <Btn label="إلغاء" variant="ghost" onPress={() => { setModalVisible(false); resetForm(); }} disabled={saving} />
        </>}>
        <Field label="رقم القضية *" value={caseNumber} onChangeText={setCaseNumber} editable={!saving} placeholder="مثال: 2025/001" />
        <Field label="عنوان القضية *" value={title} onChangeText={setTitle} editable={!saving} placeholder="عنوان موجز للقضية" />
        <Field label="نوع القضية *" value={caseType} onChangeText={setCaseType} editable={!saving} placeholder="مثال: سرقة، اعتداء" />
        <SelectField label="القسم" value={selectedDept?.name} placeholder="اختر القسم (اختياري)" onPress={() => setDeptPickerVisible(true)} disabled={saving} />
        <Field label="المُبلغ / المجني عليه" value={complainant} onChangeText={setComplainant} editable={!saving} />
        <Field label="المشتبه بهم" value={suspects} onChangeText={setSuspects} editable={!saving} />
        <Field label="موقع الحادث" value={incidentLocation} onChangeText={setIncidentLocation} editable={!saving} />
        <Field label="تفاصيل الواقعة" value={incidentDetails} onChangeText={setIncidentDetails} editable={!saving} multiline />
      </Sheet>

      <Sheet visible={deptPickerVisible} onClose={() => setDeptPickerVisible(false)} title="اختر القسم">
        <View style={{ gap: 8 }}>
          {[{ id: '', name: 'بدون قسم' }, ...departments].map((d) => {
            const on = d.id === '' ? !selectedDept : selectedDept?.id === d.id;
            return (
              <Card key={d.id || 'none'} accent={on ? Palette.cyan : undefined}
                onPress={() => { setSelectedDept(d.id === '' ? null : d); setDeptPickerVisible(false); }} label={d.name}>
                <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={[Type.bodyLg, { color: Colors.textPrimary }]}>{d.name}</Text>
                  {on ? <Check color={Palette.cyan} size={18} /> : null}
                </View>
              </Card>
            );
          })}
        </View>
      </Sheet>
    </Screen>
  );
}
