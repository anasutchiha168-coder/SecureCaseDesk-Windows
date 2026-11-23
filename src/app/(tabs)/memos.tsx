// SECURECASEDESK_PHASE9_S2 + SECURECASEDESK_UI_V3_MEMOS — شاشة المذكرات الرسمية: لوحة إحصائيات + بحث وفلاتر + بطاقات + معاينة خطاب رسمي بتبويبات.
// المنطق والصلاحيات وخدمات البيانات كما كانت؛ التغيير في العرض فقط.
import React, { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue } from 'react';
import { View, Text, FlatList, Alert, Pressable, ActivityIndicator, TextInput, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router'; // SECURECASEDESK_PHASE11_S5
import { consumeMemoPrefill } from '@/modules/ai/ai-memo-handoff-runtime';
import type { MemoPrefill } from '@/modules/ai/ai-memo-handoff';
import {
  FileText, FilePlus, Send, Archive, Layers, Link2, Building2, CalendarDays, RefreshCw, Tag, ArrowUpDown,
  Check, Pencil, Sparkles, AlertTriangle, Stamp, Paperclip, Clock, UserRound, Printer, Download, Share2,
} from 'lucide-react-native';
import { Colors, Palette, Type, tint } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { Identity } from '@/constants/identity';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { ForbiddenError, type Session } from '@/security/guard';
import {
  listMemos, listMemoTypes, insertMemo, changeMemoStatus, DuplicateMemoError, MEMO_STATUSES,
  type MemoItem, type MemoTypeItem,
} from '@/services/memos.service';
import { listCaseOptions } from '@/services/cases.service';
import AttachmentsPanel from '@/components/attachments/AttachmentsPanel';
import { ChainInput } from '@/components/ui/Kit';
import { shareMemoPdf, saveMemoPdfToDevice, printMemo, MemoExportError, MEMO_EXPORT_MESSAGES } from '@/services/memo-export.service';
import {
  Screen, PageHeader, IconBtn, Card, Pill, MetaItem, StatStrip, SearchField, FilterChips, Btn, Field, SelectField,
  Sheet, ListSkeleton, SectionTitle, type MiniStat, type ChipOpt,
} from '@/components/ui/Kit';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { FadeIn, PressableScale } from '@/components/ui/Motion';

interface CaseOption { id: string; case_number: string; title: string }
type SortMode = 'newest' | 'date' | 'number';
type DetailTab = 'letter' | 'info' | 'files';

const SORT_LABEL: Record<SortMode, string> = { newest: 'الأحدث إضافة', date: 'تاريخ المذكرة', number: 'رقم المذكرة' };
const NEXT_SORT: Record<SortMode, SortMode> = { newest: 'date', date: 'number', number: 'newest' };

const STATUS_LOOK: Record<string, { color: string; icon: React.ElementType }> = {
  'مسودة': { color: Palette.gold, icon: Pencil },
  'مرسلة': { color: Palette.green, icon: Send },
  'مؤرشفة': { color: Colors.textMuted, icon: Archive },
};
const statusLook = (st: string) => STATUS_LOOK[st] ?? { color: Palette.blue, icon: FileText };

const fmtDate = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleDateString('ar-YE', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const fmtDateLong = (ts: number) => new Date(ts).toLocaleDateString('ar-YE', { year: 'numeric', month: 'long', day: 'numeric' });
const fmtDateTime = (ts: number) =>
  fmtDate(ts) + ' • ' + new Date(ts).toLocaleTimeString('ar-YE', { hour: '2-digit', minute: '2-digit' });

/* ───────────── بطاقة المذكرة ───────────── */
const MemoCard = React.memo(function MemoCard({ item, typeName, caseNumber, index, onOpen }: {
  item: MemoItem; typeName: string; caseNumber: string | null; index: number; onOpen: (m: MemoItem) => void;
}) {
  const look = statusLook(item.status);
  return (
    <FadeIn delay={Math.min(index, 8) * 40}>
      <Card accent={look.color} onPress={() => onOpen(item)} label={'فتح المذكرة ' + item.memo_number}>
        <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[Type.h3, { color: Palette.gold, fontFamily: 'Cairo_800ExtraBold' }]}>{item.memo_number}</Text>
          <Pill label={item.status} color={look.color} icon={look.icon} />
        </View>
        <Text style={[Type.h2, { color: Colors.textPrimary, textAlign: 'right', marginTop: 2 }]} numberOfLines={2}>{item.subject}</Text>
        <View style={{ flexDirection: ROW, flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <Pill label={typeName} color={Palette.purple} icon={Tag} />
          {caseNumber ? <Pill label={'قضية ' + caseNumber} color={Palette.blue} icon={Link2} /> : null}
        </View>
        <View style={{ flexDirection: ROW, flexWrap: 'wrap', rowGap: 8, columnGap: 12, marginTop: 12 }}>
          <MetaItem icon={Building2} label="الجهة المرسل إليها" value={item.recipient_organization} />
          <MetaItem icon={CalendarDays} label="تاريخ المذكرة" value={fmtDate(item.memo_date)} />
          <MetaItem icon={RefreshCw} label="آخر تحديث" value={fmtDate(item.updated_at)} />
        </View>
        {item.body ? (
          <Text style={[Type.body, { color: Colors.textSecondary, textAlign: 'right', marginTop: 10 }]} numberOfLines={2}>{item.body}</Text>
        ) : null}
      </Card>
    </FadeIn>
  );
});

/* ───────────── ورقة الخطاب الرسمي ───────────── */
function LetterLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: ROW, gap: 6, marginTop: 6 }}>
      <Text style={L.lineLabel}>{label}:</Text>
      <Text style={[L.lineValue, { flex: 1 }]}>{value}</Text>
    </View>
  );
}

function LetterPaper({ memo, typeName, caseNumber }: { memo: MemoItem; typeName: string; caseNumber: string | null }) {
  return (
    <View style={L.paper}>
      <View style={L.ribbon} />
      <View style={L.head}>
        <Text style={L.ministry}>{Identity.ministry}</Text>
        <Text style={L.dept}>{Identity.department}</Text>
        <Text style={L.gov}>{Identity.governorate}</Text>
      </View>
      <View style={L.ruleThick} />
      <View style={L.ruleThin} />

      <View style={{ flexDirection: ROW, gap: 10, marginTop: 14 }}>
        <View style={L.metaBox}>
          <Text style={L.metaLabel}>رقم المذكرة</Text>
          <Text style={L.metaValue}>{memo.memo_number}</Text>
        </View>
        <View style={L.metaBox}>
          <Text style={L.metaLabel}>التاريخ</Text>
          <Text style={L.metaValue}>{fmtDateLong(memo.memo_date)}</Text>
        </View>
      </View>

      <LetterLine label="النوع" value={typeName} />
      <LetterLine label="إلى" value={memo.recipient_organization} />
      {caseNumber ? <LetterLine label="مرتبطة بالقضية رقم" value={caseNumber} /> : null}

      <View style={L.subjectBand}>
        <Text style={L.subjectLabel}>الموضوع</Text>
        <Text style={L.subject}>{memo.subject}</Text>
      </View>

      <Text style={L.body}>{memo.body || 'لا يوجد نص مُدخل لهذه المذكرة.'}</Text>

      <View style={L.signatureArea}>
        <View style={L.signatureBlock}>
          <Text style={L.signatureLabel}>التوقيع</Text>
          <View style={L.signatureLine} />
        </View>
        <View style={L.signatureBlock}>
          <Text style={L.signatureLabel}>الختم الرسمي</Text>
          <View style={L.signatureLine} />
        </View>
      </View>
    </View>
  );
}

/* ───────────── تصدير المذكرة: PDF / حفظ / طباعة ───────────── */
function MemoExportBar({ memoId, session }: { memoId: string; session: Session | null }) {
  const [busy, setBusy] = useState<'save' | 'share' | 'print' | null>(null);

  const fail = (e: unknown) => {
    if (e instanceof ForbiddenError) Alert.alert('غير مصرح', 'ليست لديك صلاحية على هذه المذكرة.');
    else if (e instanceof MemoExportError) Alert.alert('تعذر التنفيذ', MEMO_EXPORT_MESSAGES[e.code]);
    else { console.error('[MemoExport]', e); Alert.alert('تعذر التنفيذ', 'حدث خطأ غير متوقع.'); }
  };
  const act = async (kind: 'save' | 'share' | 'print') => {
    if (busy || !session) return;
    setBusy(kind);
    try {
      if (kind === 'share') await shareMemoPdf(session, memoId);
      else if (kind === 'print') await printMemo(session, memoId);
      else {
        const name = await saveMemoPdfToDevice(session, memoId);
        if (name) Alert.alert('تم الحفظ', 'حُفظ الملف في المجلد الذي اخترته:\n' + name);
      else Alert.alert('لم يُحفظ الملف', 'لم تختر مجلداً. في أندرويد 11 وما فوق لا يُسمح بالحفظ في جذر «التنزيلات» أو الذاكرة الداخلية. أنشئ مجلداً جديداً (مثل SecureCaseDesk) داخل «المستندات» أو «التنزيلات» ثم اضغط «استخدام هذا المجلد». أو اضغط «مشاركة» واختر «الملفات» أو Drive.', [{ text: 'إغلاق', style: 'cancel' }, { text: 'مشاركة', onPress: () => { void act('share'); } }]);
      }
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  return (
    <View style={{ marginTop: 14 }}>
      <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', marginBottom: 8 }]}>
        إخراج المذكرة كورقة رسمية — الطباعة تعرض الطابعات المتصلة بالجهاز (Wi-Fi أو USB أو بلوتوث)
      </Text>
      <View style={{ flexDirection: ROW, gap: 8 }}>
        <Btn label="طباعة" icon={Printer} loading={busy === 'print'} disabled={!!busy} onPress={() => void act('print')} style={{ flex: 1 }} />
        <Btn label="حفظ PDF" icon={Download} variant="ghost" loading={busy === 'save'} disabled={!!busy} onPress={() => void act('save')} style={{ flex: 1 }} />
        <Btn label="مشاركة" icon={Share2} variant="ghost" loading={busy === 'share'} disabled={!!busy} onPress={() => void act('share')} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

/* ───────────── أزرار تغيير الحالة ───────────── */
function StatusButton({ status, current, pending, onPress }: { status: string; current: boolean; pending: boolean; onPress: () => void }) {
  const look = statusLook(status);
  const Icon = look.icon;
  return (
    <PressableScale onPress={onPress} disabled={current || pending} accessibilityRole="button" accessibilityLabel={'تغيير الحالة إلى ' + status}
      accessibilityState={{ selected: current, disabled: current || pending }}
      style={[
        S.statusBtn,
        current ? { backgroundColor: tint(look.color, 0.2), borderColor: tint(look.color, 0.65) } : null,
        !current && pending ? { opacity: 0.55 } : null,
      ]}>
      {pending ? <ActivityIndicator size="small" color={look.color} /> : (
        <>
          {current ? <Check color={look.color} size={16} /> : <Icon color={look.color} size={16} />}
          <Text style={[Type.h3, { color: current ? look.color : Colors.textSecondary }]}>{status}</Text>
        </>
      )}
    </PressableScale>
  );
}

/* ───────────── تفاصيل المذكرة ───────────── */
function MemoDetails({ item, session, typeName, caseNumber, isOwner, canManage, pendingStatus, onChangeStatus, onClose }: {
  item: MemoItem | null; session: Session | null; typeName: string; caseNumber: string | null; isOwner: boolean; canManage: boolean;
  pendingStatus: string | null; onChangeStatus: (s: string) => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>('letter');
  const id = item?.id;
  useEffect(() => { setTab('letter'); }, [id]);

  const tabs: ChipOpt<DetailTab>[] = [
    { key: 'letter', label: 'الخطاب' }, { key: 'info', label: 'المعلومات' }, { key: 'files', label: 'المرفقات' },
  ];
  const look = item ? statusLook(item.status) : statusLook('');

  const footer = item && canManage ? (
    <View style={{ flex: 1 }}>
      <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', marginBottom: 8 }]}>تغيير حالة المذكرة</Text>
      <View style={{ flexDirection: ROW, gap: 8 }}>
        {MEMO_STATUSES.map((st) => (
          <View key={st} style={{ flex: 1 }}>
            <StatusButton status={st} current={st === item.status} pending={pendingStatus === st} onPress={() => onChangeStatus(st)} />
          </View>
        ))}
      </View>
    </View>
  ) : undefined;

  return (
    <Sheet visible={!!item} onClose={onClose} title={item ? 'مذكرة ' + item.memo_number : ''} subtitle={item?.subject} footer={footer}>
      {item ? (
        <>
          <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Pill label={item.status} color={look.color} icon={look.icon} />
            <Text style={[Type.caption, { color: Colors.textMuted }]}>آخر تحديث: {fmtDate(item.updated_at)}</Text>
          </View>
          <View style={{ marginHorizontal: -18, marginBottom: 14 }}><FilterChips options={tabs} value={tab} onChange={setTab} /></View>

          {tab === 'letter' ? (
            <>
              <LetterPaper memo={item} typeName={typeName} caseNumber={caseNumber} />
              <MemoExportBar memoId={item.id} session={session} />
            </>
          ) : null}

          {tab === 'info' ? (
            <Card accent={look.color}>
              <View style={{ flexDirection: ROW, flexWrap: 'wrap', rowGap: 12, columnGap: 12 }}>
                <MetaItem icon={Stamp} label="رقم المذكرة" value={item.memo_number} />
                <MetaItem icon={Tag} label="نوع المذكرة" value={typeName} />
                <MetaItem icon={CalendarDays} label="تاريخ المذكرة" value={fmtDateLong(item.memo_date)} />
                <MetaItem icon={Building2} label="الجهة المرسل إليها" value={item.recipient_organization} />
                <MetaItem icon={Link2} label="القضية المرتبطة" value={caseNumber ?? 'غير مرتبطة'} />
                <MetaItem icon={Clock} label="تاريخ الإنشاء" value={fmtDateTime(item.created_at)} />
                <MetaItem icon={RefreshCw} label="آخر تحديث" value={fmtDateTime(item.updated_at)} />
                {isOwner ? <MetaItem icon={UserRound} label="أنشأها" value="أنت" /> : null}
              </View>
            </Card>
          ) : null}

          {tab === 'files' ? (
            <Card>
              <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8 }}>
                <Paperclip color={Palette.cyan} size={18} />
                <Text style={[Type.h3, { color: Colors.textPrimary }]}>مرفقات المذكرة</Text>
              </View>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', marginTop: 2, marginBottom: 8 }]}>كل ملف يُتحقق من سلامته بالتجزئة SHA-256 عند فتحه.</Text>
              <AttachmentsPanel entityType="memo" entityId={item.id} />
            </Card>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}

/* ───────────── الشاشة ───────────── */
export default function MemosScreen() {
  const { user } = useAuth();
  const session = useMemo<Session | null>(
    () => (user ? { userId: user.id, role: user.role } : null),
    [user?.id, user?.role]
  );
  const canManage = can(user?.role, 'memos.manage');
  const deniedAlerted = useRef(false);
  const [memos, setMemos] = useState<MemoItem[]>([]);
  const [memoTypes, setMemoTypes] = useState<MemoTypeItem[]>([]);
  const [caseOptions, setCaseOptions] = useState<CaseOption[]>([]);

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [typePickerVisible, setTypePickerVisible] = useState(false);
  const [casePickerVisible, setCasePickerVisible] = useState(false);
  const [caseQuery, setCaseQuery] = useState('');

  // معاينة المذكرة
  const [previewMemo, setPreviewMemo] = useState<MemoItem | null>(null);

  // البحث والفلاتر والترتيب
  const [searchQuery, setSearchQuery] = useState('');
  const query = useDeferredValue(searchQuery);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sort, setSort] = useState<SortMode>('newest');

  // حقول النموذج
  const [memoNumber, setMemoNumber] = useState('');
  const [recipientOrg, setRecipientOrg] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [selectedType, setSelectedType] = useState<MemoTypeItem | null>(null);
  const [selectedCase, setSelectedCase] = useState<CaseOption | null>(null);

  const today = new Date();
  const [dayStr, setDayStr] = useState(String(today.getDate()));
  const [monthStr, setMonthStr] = useState(String(today.getMonth() + 1));
  const [yearStr, setYearStr] = useState(String(today.getFullYear()));
  const [pendingPrefill, setPendingPrefill] = useState<MemoPrefill | null>(null); // SECURECASEDESK_PHASE11_S5
  const [prefillNote, setPrefillNote] = useState<string | null>(null);
  const placeholderAck = useRef(false);

  const typeMap = useMemo(() => {
    const map: Record<string, string> = {};
    memoTypes.forEach((t) => { map[t.id] = t.name; });
    return map;
  }, [memoTypes]);

  const caseMap = useMemo(() => {
    const map: Record<string, string> = {};
    caseOptions.forEach((c) => { map[c.id] = c.case_number; });
    return map;
  }, [caseOptions]);

  const loadMemoTypes = useCallback(async () => {
    if (!session) return;
    try { setMemoTypes(await listMemoTypes(session)); }
    catch (error) {
      setMemoTypes([]);
      if (!(error instanceof ForbiddenError)) console.error('[memos] loadMemoTypes error:', error);
    }
  }, [session]);

  const loadCaseOptions = useCallback(async () => {
    if (!session) return;
    try { setCaseOptions(await listCaseOptions(session)); }
    catch (error) {
      setCaseOptions([]); // بلا صلاحية عرض القضايا: لا ربط بقضية، ولا تنبيه
      if (!(error instanceof ForbiddenError)) console.error('[memos] loadCaseOptions error:', error);
    }
  }, [session]);

  const loadMemos = useCallback(async () => {
    if (!session) return; // الجلسة لم تُحمَّل بعد: لا استعلام ولا تنبيه
    try { setMemos(await listMemos(session)); setFailed(false); }
    catch (error) {
      setMemos([]);
      if (error instanceof ForbiddenError) {
        if (!deniedAlerted.current) {
          deniedAlerted.current = true;
          Alert.alert('تنبيه', 'ليست لديك صلاحية');
        }
      } else {
        console.error('[memos] loadMemos error:', error);
        setFailed(true);
      }
    }
    finally { setLoading(false); }
  }, [session]);

  useEffect(() => {
    loadMemoTypes();
    loadCaseOptions();
    loadMemos();
  }, [loadMemoTypes, loadCaseOptions, loadMemos]);

  const resetForm = () => {
    setMemoNumber('');
    setRecipientOrg('');
    setSubject('');
    setBody('');
    setSelectedType(null);
    setSelectedCase(null);
    setPrefillNote(null);
    const now = new Date();
    setDayStr(String(now.getDate()));
    setMonthStr(String(now.getMonth() + 1));
    setYearStr(String(now.getFullYear()));
  };

  // SECURECASEDESK_PHASE11_S5: تعبئة النموذج من مسودة المساعد الذكي (دون حفظ). تُستهلك مرة واحدة عند فتح الشاشة.
  useFocusEffect(useCallback(() => {
    let alive = true;
    if (session) {
      void consumeMemoPrefill(session).then((p) => { if (alive && p) setPendingPrefill(p); }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [session]));

  // SECURECASEDESK_FIX_CASE_PICKER: التبويبات تبقى محمّلة في الذاكرة، فكانت قائمة القضايا تُجلب مرة واحدة عند أول فتح
  // ولا تظهر القضية المسجَّلة بعدها. نعيد الجلب عند كل عودة إلى هذه الشاشة وعند فتح قائمة الربط.
  useFocusEffect(useCallback(() => { void loadCaseOptions(); }, [loadCaseOptions]));

  useEffect(() => {
    if (!pendingPrefill) return;
    if (memoTypes.length === 0 && loading) return; // انتظر تحميل أنواع المذكرات
    const p = pendingPrefill;
    setPendingPrefill(null);
    resetForm();
    setRecipientOrg(p.recipient);
    setSubject(p.subject);
    setBody(p.body);
    setSelectedType(memoTypes.find((t) => t.name.trim() === p.memoTypeName) ?? null);
    setSelectedCase(p.caseId ? caseOptions.find((c) => c.id === p.caseId) ?? null : null);
    setPrefillNote(
      'معبّأ من مسودة المساعد الذكي ولم يُحفظ بعد. اكتب رقم المذكرة، وتحقق من النوع والتاريخ وكل الحقول، وأكمل الفراغات' +
      (p.placeholders > 0 ? ' (' + p.placeholders + ' فراغ بصيغة [......] في النص)' : '') + ' قبل الحفظ.'
    );
    setModalVisible(true);
  }, [pendingPrefill, memoTypes, caseOptions, loading]);

  const buildMemoDateTimestamp = (): number | null => {
    const day = parseInt(dayStr, 10);
    const month = parseInt(monthStr, 10);
    const year = parseInt(yearStr, 10);
    if (
      !Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year) ||
      day < 1 || day > 31 || month < 1 || month > 12 || year < 2000 || year > 2100
    ) {
      return null;
    }
    const date = new Date(year, month - 1, day);
    if (date.getMonth() !== month - 1) return null;
    return date.getTime();
  };

  const handleSaveMemo = async () => {
    const trimmedNumber = memoNumber.trim(); const trimmedRecipient = recipientOrg.trim(); const trimmedSubject = subject.trim();
    if (!trimmedNumber || !trimmedRecipient || !trimmedSubject || !selectedType) { Alert.alert('تنبيه', 'يرجى إدخال رقم المذكرة، الجهة المرسل إليها، الموضوع، واختيار نوع المذكرة'); return; }
    const memoDateTs = buildMemoDateTimestamp();
    if (memoDateTs === null) { Alert.alert('تنبيه', 'تاريخ المذكرة غير صحيح'); return; }
    // SECURECASEDESK_PHASE11_S5: فراغات [......] المتبقية تحتاج إقراراً صريحاً قبل الحفظ.
    const leftover = (body.match(/\[(?:\.{2,}|\u2026+)\]/g) ?? []).length;
    if (leftover > 0 && !placeholderAck.current) {
      Alert.alert('فراغات لم تُملأ', 'يحتوي نص المذكرة على ' + leftover + ' فراغ بصيغة [......]. أكملها قبل الحفظ، أو احفظ كما هي.', [
        { text: 'رجوع للتعديل', style: 'cancel' },
        { text: 'حفظ كما هي', onPress: () => { placeholderAck.current = true; void handleSaveMemo(); } },
      ]);
      return;
    }
    placeholderAck.current = false;
    setSaving(true);
    try {
      await insertMemo(session, {
        memoNumber: trimmedNumber,
        memoTypeId: selectedType.id,
        memoDate: memoDateTs,
        recipientOrganization: trimmedRecipient,
        subject: trimmedSubject,
        body,
        linkedCaseId: selectedCase?.id ?? null,
      });
      setModalVisible(false); resetForm(); await loadMemos();
    } catch (error) {
      if (error instanceof ForbiddenError) {
        Alert.alert('تنبيه', 'ليست لديك صلاحية');
      } else if (error instanceof DuplicateMemoError) {
        Alert.alert('خطأ', `رقم المذكرة \"${trimmedNumber}\" مستخدم مسبقاً`);
      } else {
        console.error('[memos] save error:', error);
        Alert.alert('خطأ', 'فشل حفظ المذكرة');
      }
    }
    finally { setSaving(false); }
  };

  const openPreview = useCallback((memo: MemoItem) => setPreviewMemo(memo), []);

  const handleChangeStatus = async (newStatus: string) => {
    if (!previewMemo || newStatus === previewMemo.status || pendingStatus) return;
    setPendingStatus(newStatus);
    try {
      const updatedAt = await changeMemoStatus(session, previewMemo.id, newStatus);
      const updatedMemo: MemoItem = { ...previewMemo, status: newStatus, updated_at: updatedAt };
      setPreviewMemo(updatedMemo); setMemos((prev) => prev.map((m) => (m.id === updatedMemo.id ? updatedMemo : m)));
    } catch (error) {
      if (error instanceof ForbiddenError) {
        Alert.alert('تنبيه', 'ليست لديك صلاحية');
      } else {
        console.error('[memos] status error:', error);
        Alert.alert('فشل تحديث الحالة', 'تعذر تحديث حالة المذكرة');
      }
    }
    finally { setPendingStatus(null); }
  };

  const closeForm = () => { setModalVisible(false); resetForm(); };

  /* ── الإحصائيات والفلاتر ── */
  const stats = useMemo(() => {
    const by = (st: string) => memos.filter((m) => m.status === st).length;
    return { total: memos.length, draft: by('مسودة'), sent: by('مرسلة'), archived: by('مؤرشفة') };
  }, [memos]);

  const tiles: MiniStat[] = [
    { key: 't', label: 'إجمالي المذكرات', value: stats.total, color: Palette.blue, icon: Layers },
    { key: 'd', label: 'مسودات', value: stats.draft, color: Palette.gold, icon: Pencil },
    { key: 's', label: 'مرسلة', value: stats.sent, color: Palette.green, icon: Send },
    { key: 'a', label: 'مؤرشفة', value: stats.archived, color: Colors.textMuted, icon: Archive },
  ];

  const statusChips: ChipOpt<string>[] = useMemo(() => ([
    { key: 'all', label: 'الكل', count: memos.length },
    ...MEMO_STATUSES.map((st) => ({ key: st, label: st, count: memos.filter((m) => m.status === st).length, color: statusLook(st).color })),
  ]), [memos]);

  const typeChips: ChipOpt<string>[] = useMemo(() => {
    const counts: Record<string, number> = {};
    memos.forEach((m) => { counts[m.memo_type_id] = (counts[m.memo_type_id] ?? 0) + 1; });
    const used = memoTypes.filter((t) => counts[t.id] > 0);
    if (used.length === 0) return [];
    return [{ key: 'all', label: 'كل الأنواع', color: Palette.purple }, ...used.map((t) => ({ key: t.id, label: t.name, count: counts[t.id], color: Palette.purple }))];
  }, [memos, memoTypes]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = memos.filter((m) => (statusFilter === 'all' || m.status === statusFilter) && (typeFilter === 'all' || m.memo_type_id === typeFilter));
    if (q) {
      rows = rows.filter((m) => (
        m.memo_number + ' ' + m.subject + ' ' + m.recipient_organization + ' ' + (m.body ?? '') + ' ' +
        (typeMap[m.memo_type_id] ?? '') + ' ' + (m.linked_case_id ? caseMap[m.linked_case_id] ?? '' : '')
      ).toLowerCase().includes(q));
    } else {
      rows = rows.slice();
    }
    if (sort === 'newest') rows.sort((a, b) => b.created_at - a.created_at);
    else if (sort === 'date') rows.sort((a, b) => b.memo_date - a.memo_date);
    else rows.sort((a, b) => a.memo_number.localeCompare(b.memo_number, 'ar', { numeric: true }));
    return rows;
  }, [memos, query, statusFilter, typeFilter, sort, typeMap, caseMap]);

  const renderItem = useCallback(({ item, index }: { item: MemoItem; index: number }) => (
    <View style={{ paddingHorizontal: 18, marginBottom: 12 }}>
      <MemoCard item={item} typeName={typeMap[item.memo_type_id] ?? '—'}
        caseNumber={item.linked_case_id ? (caseMap[item.linked_case_id] ?? '—') : null} index={index} onOpen={openPreview} />
    </View>
  ), [typeMap, caseMap, openPreview]);

  const hasQuery = searchQuery.length > 0 || statusFilter !== 'all' || typeFilter !== 'all';
  const header = (
    <View>
      <StatStrip items={tiles} />
      <SectionTitle title="سجل المذكرات" hint={visible.length + ' من ' + memos.length + ' مذكرة'} top={20}
        action={
          <Pressable onPress={() => setSort(NEXT_SORT[sort])} accessibilityRole="button" accessibilityLabel="تغيير الترتيب" style={S.sortBtn}>
            <ArrowUpDown color={Palette.cyan} size={14} />
            <Text style={[Type.caption, { color: Colors.textSecondary }]}>{SORT_LABEL[sort]}</Text>
          </Pressable>
        } />
    </View>
  );

  const filteredCases = useMemo(() => {
    const q = caseQuery.trim().toLowerCase();
    return q ? caseOptions.filter((c) => (c.case_number + ' ' + c.title).toLowerCase().includes(q)) : caseOptions;
  }, [caseOptions, caseQuery]);

  return (
    <Screen>
      <PageHeader title="المذكرات الرسمية" subtitle="إنشاء ومتابعة المذكرات والمراسلات" icon={FileText} color={Palette.gold}
        actions={canManage ? <IconBtn icon={FilePlus} label="إضافة مذكرة جديدة" solid color={Palette.blue} onPress={() => setModalVisible(true)} /> : undefined} />
      <SearchField value={searchQuery} onChangeText={setSearchQuery} placeholder="ابحث برقم المذكرة أو الموضوع أو الجهة..." />
      <View style={{ height: 10 }} />
      <FilterChips options={statusChips} value={statusFilter} onChange={setStatusFilter} />
      {typeChips.length > 0 ? (
        <>
          <View style={{ height: 8 }} />
          <FilterChips options={typeChips} value={typeFilter} onChange={setTypeFilter} />
        </>
      ) : null}
      <View style={{ height: 14 }} />

      {loading ? <ListSkeleton /> : failed ? (
        <View style={{ paddingHorizontal: 18 }}><ErrorState message="حدث خطأ أثناء تحميل المذكرات." onRetry={() => { setLoading(true); void loadMemos(); }} /></View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 40, flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={6}
          windowSize={7}
          removeClippedSubviews
          ListEmptyComponent={
            <EmptyState
              icon={FileText}
              color={Palette.gold}
              title={hasQuery ? 'لا توجد نتائج مطابقة' : 'لا توجد مذكرات مسجلة حالياً'}
              hint={hasQuery ? 'جرّب تغيير كلمات البحث أو الفلاتر.' : 'لا توجد بيانات متاحة حالياً.'}
              actionLabel={!hasQuery && canManage ? 'إنشاء مذكرة' : undefined}
              onAction={!hasQuery && canManage ? () => setModalVisible(true) : undefined}
            />
          }
        />
      )}

      <MemoDetails
        item={previewMemo}
        session={session}
        typeName={previewMemo ? (typeMap[previewMemo.memo_type_id] ?? '—') : ''}
        caseNumber={previewMemo?.linked_case_id ? (caseMap[previewMemo.linked_case_id] ?? '—') : null}
        isOwner={!!previewMemo && !!user && previewMemo.created_by === user.id}
        canManage={canManage}
        pendingStatus={pendingStatus}
        onChangeStatus={(s) => { void handleChangeStatus(s); }}
        onClose={() => setPreviewMemo(null)}
      />

      {/* نافذة إضافة مذكرة */}
      <Sheet visible={modalVisible} onClose={closeForm} title="تسجيل مذكرة جديدة" subtitle="الحقول المعلّمة بنجمة إلزامية"
        footer={<>
          <Btn label="حفظ المذكرة" icon={Check} onPress={handleSaveMemo} loading={saving} style={{ flex: 1 }} />
          <Btn label="إلغاء" variant="ghost" onPress={closeForm} disabled={saving} />
        </>}>
        {prefillNote ? (
          <View style={S.note}>
            <Sparkles color={Palette.gold} size={18} />
            <Text style={[Type.body, { color: Palette.gold, flex: 1, textAlign: 'right', fontFamily: 'Cairo_600SemiBold' }]}>{prefillNote}</Text>
          </View>
        ) : null}
        <Field label="رقم المذكرة *" value={memoNumber} onChangeText={setMemoNumber} editable={!saving} placeholder="مثال: 2025/001" />
        <SelectField label="نوع المذكرة *" value={selectedType?.name} placeholder="اختر نوع المذكرة" onPress={() => setTypePickerVisible(true)} disabled={saving} />

        <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right', marginBottom: 6 }]}>تاريخ المذكرة *</Text>
        <View style={{ flexDirection: ROW, gap: 8, marginBottom: 14 }}>
          <ChainInput style={S.dateInput} placeholder="يوم" placeholderTextColor={Colors.textMuted} keyboardType="number-pad"
            value={dayStr} onChangeText={setDayStr} maxLength={2} editable={!saving} />
          <ChainInput style={S.dateInput} placeholder="شهر" placeholderTextColor={Colors.textMuted} keyboardType="number-pad"
            value={monthStr} onChangeText={setMonthStr} maxLength={2} editable={!saving} />
          <ChainInput style={[S.dateInput, { flex: 1.4 }]} placeholder="سنة" placeholderTextColor={Colors.textMuted} keyboardType="number-pad"
            value={yearStr} onChangeText={setYearStr} maxLength={4} editable={!saving} />
        </View>

        <Field label="الجهة المرسل إليها *" value={recipientOrg} onChangeText={setRecipientOrg} editable={!saving} />
        <Field label="الموضوع *" value={subject} onChangeText={setSubject} editable={!saving} />
        <Field label="نص المذكرة" value={body} onChangeText={setBody} editable={!saving} multiline style={{ height: 140 }} />
        <SelectField label="ربط بقضية" value={selectedCase ? selectedCase.case_number + ' - ' + selectedCase.title : null} placeholder="ربط بقضية (اختياري)" onPress={() => { void loadCaseOptions(); setCasePickerVisible(true); }} disabled={saving} />
      </Sheet>

      {/* نافذة اختيار نوع المذكرة */}
      <Sheet visible={typePickerVisible} onClose={() => setTypePickerVisible(false)} title="اختر نوع المذكرة">
        <View style={{ gap: 8 }}>
          {memoTypes.map((t) => {
            const on = selectedType?.id === t.id;
            return (
              <Card key={t.id} accent={on ? Palette.purple : undefined}
                onPress={() => { setSelectedType(t); setTypePickerVisible(false); }} label={t.name}>
                <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={[Type.bodyLg, { color: Colors.textPrimary }]}>{t.name}</Text>
                  {on ? <Check color={Palette.purple} size={18} /> : null}
                </View>
              </Card>
            );
          })}
          {memoTypes.length === 0 ? <EmptyState compact icon={Tag} color={Palette.purple} title="لا توجد أنواع مذكرات" hint="لا توجد بيانات متاحة حالياً." /> : null}
        </View>
      </Sheet>

      {/* نافذة اختيار القضية */}
      <Sheet visible={casePickerVisible} onClose={() => { setCasePickerVisible(false); setCaseQuery(''); }} title="اختر القضية المرتبطة">
        {caseOptions.length > 5 ? (
          <View style={{ marginHorizontal: -18, marginBottom: 12 }}>
            <SearchField value={caseQuery} onChangeText={setCaseQuery} placeholder="ابحث برقم القضية أو عنوانها..." />
          </View>
        ) : null}
        <View style={{ gap: 8 }}>
          <Card accent={!selectedCase ? Palette.cyan : undefined}
            onPress={() => { setSelectedCase(null); setCasePickerVisible(false); setCaseQuery(''); }} label="بدون ربط بقضية">
            <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={[Type.bodyLg, { color: Colors.textPrimary }]}>بدون ربط بقضية</Text>
              {!selectedCase ? <Check color={Palette.cyan} size={18} /> : null}
            </View>
          </Card>
          {filteredCases.map((c) => {
            const on = selectedCase?.id === c.id;
            return (
              <Card key={c.id} accent={on ? Palette.cyan : undefined}
                onPress={() => { setSelectedCase(c); setCasePickerVisible(false); setCaseQuery(''); }} label={c.case_number + ' - ' + c.title}>
                <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[Type.h3, { color: Palette.cyan, textAlign: 'right' }]}>{c.case_number}</Text>
                    <Text style={[Type.body, { color: Colors.textSecondary, textAlign: 'right' }]} numberOfLines={2}>{c.title}</Text>
                  </View>
                  {on ? <Check color={Palette.cyan} size={18} /> : null}
                </View>
              </Card>
            );
          })}
          {caseOptions.length === 0 ? <EmptyState compact icon={AlertTriangle} color={Palette.gold} title="لا توجد قضايا مسجلة بعد" hint="سجّل قضية أولاً لتتمكن من ربط المذكرة بها." /> : null}
        </View>
      </Sheet>
    </Screen>
  );
}

/* ───────────── أنماط ───────────── */
const S = StyleSheet.create({
  sortBtn: { flexDirection: ROW, alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: 999, backgroundColor: Palette.surface, borderWidth: 1, borderColor: Palette.glassBorder },
  statusBtn: { flexDirection: ROW, alignItems: 'center', justifyContent: 'center', gap: 6, height: 46, borderRadius: 14, backgroundColor: Palette.bg1, borderWidth: 1, borderColor: Palette.glassBorder },
  dateInput: { flex: 1, minHeight: 48, borderRadius: 14, paddingVertical: 0, backgroundColor: Palette.bg1, borderWidth: 1, borderColor: Palette.glassBorder, color: Colors.textPrimary, fontFamily: 'Cairo_600SemiBold', fontSize: 15, textAlign: 'center' },
  note: { flexDirection: ROW, alignItems: 'flex-start', gap: 10, padding: 12, marginBottom: 14, borderRadius: 16, backgroundColor: tint(Palette.gold, 0.1), borderWidth: 1, borderColor: tint(Palette.gold, 0.4) },
});

// ورقة الخطاب: ورقية فاتحة بالتصميم الرسمي المعتاد، وتبقى كذلك في الوضع الداكن ليشبه المستند المطبوع.
const INK = '#1F2937';
const L = StyleSheet.create({
  paper: { backgroundColor: '#F4F3EF', borderRadius: 14, overflow: 'hidden', paddingHorizontal: 20, paddingBottom: 22, borderWidth: 1, borderColor: '#D9D6CB' },
  ribbon: { height: 5, marginHorizontal: -20, backgroundColor: '#1E3A8A' },
  head: { alignItems: 'center', paddingTop: 16, paddingBottom: 10 },
  ministry: { fontFamily: 'Cairo_800ExtraBold', fontSize: 18, lineHeight: 28, color: INK },
  dept: { fontFamily: 'Cairo_700Bold', fontSize: 14, lineHeight: 22, color: '#374151' },
  gov: { fontFamily: 'Cairo_600SemiBold', fontSize: 13, lineHeight: 20, color: '#4B5563' },
  ruleThick: { height: 2, backgroundColor: '#1E3A8A' },
  ruleThin: { height: 1, marginTop: 3, backgroundColor: '#C9C7BE' },
  metaBox: { flex: 1, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: '#E9E7DF', borderWidth: 1, borderColor: '#D3D0C4' },
  metaLabel: { fontFamily: 'Cairo_500Medium', fontSize: 11, lineHeight: 18, color: '#6B7280', textAlign: 'right' },
  metaValue: { fontFamily: 'Cairo_700Bold', fontSize: 14, lineHeight: 22, color: INK, textAlign: 'right' },
  lineLabel: { fontFamily: 'Cairo_700Bold', fontSize: 13, lineHeight: 22, color: '#374151', textAlign: 'right' },
  lineValue: { fontFamily: 'Cairo_500Medium', fontSize: 13, lineHeight: 22, color: INK, textAlign: 'right' },
  subjectBand: { marginTop: 14, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#E9E7DF', borderStartWidth: 3, borderStartColor: '#1E3A8A' },
  subjectLabel: { fontFamily: 'Cairo_600SemiBold', fontSize: 11, lineHeight: 18, color: '#6B7280', textAlign: 'right' },
  subject: { fontFamily: 'Cairo_800ExtraBold', fontSize: 16, lineHeight: 26, color: INK, textAlign: 'right' },
  body: { marginTop: 16, fontFamily: 'Cairo_500Medium', fontSize: 15, lineHeight: 30, color: INK, textAlign: 'right' },
  signatureArea: { flexDirection: ROW, justifyContent: 'space-between', gap: 24, marginTop: 34 },
  signatureBlock: { flex: 1, alignItems: 'center' },
  signatureLabel: { fontFamily: 'Cairo_600SemiBold', fontSize: 13, lineHeight: 22, color: '#374151' },
  signatureLine: { alignSelf: 'stretch', height: 1, marginTop: 30, backgroundColor: '#8A8878' },
});
