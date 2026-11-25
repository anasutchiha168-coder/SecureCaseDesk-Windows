// SECURECASEDESK_PHASE9_S2 + SECURECASEDESK_UI_V3_DETAINEES — شاشة المحتجزين: لوحة إحصائيات + بحث وفلاتر + بطاقات + ملف محتجز بتبويبات (الحركة التاريخية وسجل التصحيحات).
// المنطق والصلاحيات واستعلامات القاعدة وعمليات الحفظ كما كانت؛ التغيير في العرض فقط (مع إضافة استعلامات قراءة للإحصائيات).
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, FlatList, Alert, ActivityIndicator } from 'react-native';
import {
  Users, UserPlus, UserMinus, LogIn, LogOut, ArrowLeftRight, ArrowLeft, Pencil, Check, Clock, CalendarDays,
  Tag, MapPin, ShieldCheck, History, UserRound, ArrowUpDown, Paperclip, Lock, AlertTriangle, Activity, Layers, FileText,
} from 'lucide-react-native';
import { getDb } from '@/database/db';
import { Colors, Palette, Type, tint, Glow } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { useAuth } from '@/context/AuthContext';
import AttachmentsPanel from '@/components/attachments/AttachmentsPanel';
import { can } from '@/security/permissions';
import { ID_TYPES, CASE_ROLES, LEGAL_STATUSES, EXIT_TYPES } from '@/modules/detainees/detainees-lists';
import { buildDetentionInput } from '@/modules/detainees/detainees-form';
import { listCrimeClassifications, type ClassificationRow } from '@/services/detainees.service';
import type { Session } from '@/security/guard';
import {
  createDetention,
  exitPeriod,
  redetainPerson,
  transferPeriod,
  correctPeriodField,
} from '@/services/detainees-actions.service';
import {
  Screen, PageHeader, IconBtn, Card, Pill, MetaItem, StatStrip, SearchField, FilterChips, Btn, Field, SelectField,
  Sheet, ListSkeleton, SectionTitle, type MiniStat, type ChipOpt,
} from '@/components/ui/Kit';
import { Timeline, CompareRow, type TimelineItem } from '@/components/ui/Timeline';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { FadeIn, PressableScale } from '@/components/ui/Motion';

interface DetaineeRow {
  id: string;
  reference_number: string;
  full_name: string;
  admission_date: number;
  release_date: number | null;
  status: string;
  category_name: string | null;
  detaining_authority: string | null;
}

interface CategoryRow {
  id: string;
  name: string;
}

interface DetaineeDetail {
  id: string;
  reference_number: string;
  full_name: string;
  category_id: string;
  category_name: string | null;
  admission_date: number;
  release_date: number | null;
  alleged_offense: string;
  detaining_authority: string;
  status: string;
  person_id: string;
  place_of_detention: string | null;
}

interface MovementRow {
  id: string;
  movement_number: string;
  movement_type: string;
  movement_date: number;
  previous_authority: string | null;
  new_authority: string | null;
  reason: string | null;
  created_at: number;
  executed_by_name: string | null;
}

type CorrectionField = 'full_name' | 'alleged_offense';

const CORRECTION_FIELDS: { key: CorrectionField; label: string }[] = [
  { key: 'full_name', label: 'الاسم الكامل' },
  { key: 'alleged_offense', label: 'التهمة المنسوبة' },
];

interface CorrectionRow {
  id: string;
  field_name: string;
  previous_value: string | null;
  new_value: string | null;
  reason: string;
  created_at: number;
  executed_by_name: string | null;
}

interface DetStats {
  total: number;
  current: number;
  admittedToday: number;
  transferred: number;
  released: number;
  avgDays: number | null;
}

type StatusFilter = 'all' | 'محتجز' | 'مفرج عنه';
type SortMode = 'newest' | 'oldest' | 'name';
type DetailTab = 'overview' | 'movements' | 'corrections' | 'files';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

const SORT_LABEL: Record<SortMode, string> = { newest: 'الأحدث دخولاً', oldest: 'الأقدم دخولاً', name: 'الاسم' };
const NEXT_SORT: Record<SortMode, SortMode> = { newest: 'oldest', oldest: 'name', name: 'newest' };

const SQL_BASE = `
  SELECT d.id, d.reference_number, d.full_name, d.admission_date,
         d.release_date, d.status, d.detaining_authority, c.name AS category_name
  FROM detainees d
  LEFT JOIN detainee_categories c ON c.id = d.category_id
`;
const SQL_ORDER = ' ORDER BY d.admission_date DESC, d.created_at DESC';

/* ───────────── أدوات مساعدة ───────────── */
function toArabicDigits(value: number | string): string {
  return String(value).replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)]);
}

function normalizeDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)));
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return toArabicDigits(d.getDate()) + ' ' + MONTHS[d.getMonth()] + ' ' + toArabicDigits(d.getFullYear());
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours() % 12 || 12;
  return toArabicDigits(h + ':' + String(d.getMinutes()).padStart(2, '0')) + ' ' + (d.getHours() >= 12 ? 'م' : 'ص');
}

function fmtDateTime(ts: number): string {
  return formatDate(ts) + ' • ' + fmtTime(ts);
}

function daysBetween(admission: number, release: number | null): number {
  const end = release ?? Date.now();
  return Math.max(0, Math.floor((end - admission) / DAY_MS));
}

function durationText(admission: number, release: number | null): string {
  const days = daysBetween(admission, release);
  if (days === 0) return 'أقل من يوم';
  if (days === 1) return 'يوم واحد';
  if (days === 2) return 'يومان';
  if (days <= 10) return toArabicDigits(days) + ' أيام';
  return toArabicDigits(days) + ' يوماً';
}

function parseDate(d: string, m: string, y: string): number | null {
  if (!/^[0-9]{1,2}$/.test(d) || !/^[0-9]{1,2}$/.test(m) || !/^[0-9]{4}$/.test(y)) return null;
  const dd = Number(d);
  const mm = Number(m);
  const yy = Number(y);
  if (yy < 1900 || yy > 2100) return null;
  const dt = new Date(yy, mm - 1, dd);
  if (dt.getFullYear() !== yy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  return dt.getTime();
}

function endOfToday(): number {
  const t = new Date();
  t.setHours(23, 59, 59, 999);
  return t.getTime();
}

function startOfToday(): number {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t.getTime();
}

function todayParts() {
  const t = new Date();
  return { d: String(t.getDate()), m: String(t.getMonth() + 1), y: String(t.getFullYear()) };
}

function fieldLabel(key: string): string {
  const f = CORRECTION_FIELDS.find((x) => x.key === key);
  return f ? f.label : key;
}

function statusColor(status: string): string {
  return status === 'مفرج عنه' ? Palette.purple : Palette.green;
}

function movementLook(type: string): { icon: React.ElementType; color: string } {
  if (type === 'إيداع') return { icon: LogIn, color: Palette.cyan };
  if (type === 'نقل') return { icon: ArrowLeftRight, color: Palette.blue };
  if (type === 'إفراج') return { icon: LogOut, color: Palette.purple };
  if (type === 'تصحيح') return { icon: Pencil, color: Palette.gold };
  return { icon: Activity, color: Palette.cyan };
}

/* ───────────── مكونات عرض محلية ───────────── */
function ErrorBanner({ text }: { text: string }) {
  if (!text) return null;
  return (
    <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: tint(Palette.red, 0.45), backgroundColor: tint(Palette.red, 0.1), marginBottom: 12 }}>
      <AlertTriangle color={Palette.red} size={18} />
      <Text style={[Type.body, { color: Palette.red, flex: 1, textAlign: 'right' }]}>{text}</Text>
    </View>
  );
}

function NoteBanner({ text, color = Palette.cyan, icon: Icon = ShieldCheck }: { text: string; color?: string; icon?: React.ElementType }) {
  return (
    <View style={{ flexDirection: ROW, alignItems: 'center', gap: 10, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: tint(color, 0.35), backgroundColor: tint(color, 0.08), marginBottom: 12 }}>
      <Icon color={color} size={20} />
      <Text style={[Type.body, { color: Colors.textSecondary, flex: 1, textAlign: 'right' }]}>{text}</Text>
    </View>
  );
}

function ActionBtn({ label, icon: Icon, color, onPress, solid, loading, disabled }: {
  label: string; icon?: React.ElementType; color: string; onPress: () => void; solid?: boolean; loading?: boolean; disabled?: boolean;
}) {
  const off = !!(disabled || loading);
  return (
    <PressableScale onPress={onPress} disabled={off} accessibilityRole="button" accessibilityLabel={label}
      style={[
        { flex: 1, flexDirection: ROW, alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 16, paddingHorizontal: 12 },
        solid ? { backgroundColor: color, ...Glow(color) } : { backgroundColor: tint(color, 0.12), borderWidth: 1, borderColor: tint(color, 0.45) },
        off && { opacity: 0.55 },
      ]}>
      {loading ? <ActivityIndicator color={solid ? '#fff' : color} /> : (
        <>
          {Icon ? <Icon color={solid ? '#fff' : color} size={18} /> : null}
          <Text style={[Type.h3, { color: solid ? '#fff' : color }]} numberOfLines={1}>{label}</Text>
        </>
      )}
    </PressableScale>
  );
}

function DateFields({ label, d, m, y, setD, setM, setY, editable }: {
  label: string; d: string; m: string; y: string; setD: (v: string) => void; setM: (v: string) => void; setY: (v: string) => void; editable: boolean;
}) {
  return (
    <View>
      <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right', marginBottom: 8 }]}>{label}</Text>
      <View style={{ flexDirection: ROW, gap: 8 }}>
        <View style={{ flex: 1 }}><Field label="اليوم" value={d} onChangeText={setD} editable={editable} keyboardType="number-pad" maxLength={2} style={{ textAlign: 'center' }} /></View>
        <View style={{ flex: 1 }}><Field label="الشهر" value={m} onChangeText={setM} editable={editable} keyboardType="number-pad" maxLength={2} style={{ textAlign: 'center' }} /></View>
        <View style={{ flex: 1.6 }}><Field label="السنة" value={y} onChangeText={setY} editable={editable} keyboardType="number-pad" maxLength={4} style={{ textAlign: 'center' }} /></View>
      </View>
    </View>
  );
}

/* ───────────── بطاقة المحتجز ───────────── */
const DetaineeCard = React.memo(function DetaineeCard({ item, index, onOpen }: { item: DetaineeRow; index: number; onOpen: (id: string) => void }) {
  const released = item.status === 'مفرج عنه';
  const color = statusColor(item.status);
  return (
    <FadeIn delay={Math.min(index, 8) * 40}>
      <Card accent={color} onPress={() => onOpen(item.id)} label={'فتح ملف المحتجز ' + item.full_name}>
        <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12 }}>
          <View style={{ width: 46, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: tint(color, 0.45), backgroundColor: tint(color, 0.14) }}>
            <Text style={[Type.h2, { color }]}>{item.full_name.trim().charAt(0)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[Type.h2, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={2}>{item.full_name}</Text>
            <Text style={[Type.caption, { color: Palette.cyan, textAlign: 'right', fontFamily: 'Cairo_700Bold' }]} numberOfLines={1}>{'رقم الملف: ' + item.reference_number}</Text>
          </View>
          <Pill label={item.status} color={color} />
        </View>
        <View style={{ flexDirection: ROW, flexWrap: 'wrap', rowGap: 8, columnGap: 12, marginTop: 12 }}>
          <MetaItem icon={Tag} label="الفئة" value={item.category_name ?? 'غير محددة'} />
          <MetaItem icon={MapPin} label="جهة الإيداع" value={item.detaining_authority ? item.detaining_authority : 'غير محدد'} />
          <MetaItem icon={CalendarDays} label="تاريخ الدخول" value={formatDate(item.admission_date)} />
          <MetaItem icon={Clock} label={released ? 'مدة الاحتجاز (انتهت)' : 'مدة الاحتجاز'} value={durationText(item.admission_date, item.release_date)} />
          {released && item.release_date !== null ? <MetaItem icon={LogOut} label="تاريخ الإفراج" value={formatDate(item.release_date)} color={Palette.purple} /> : null}
        </View>
      </Card>
    </FadeIn>
  );
});

/* ───────────── الحركة التاريخية ───────────── */
function MovementExtra({ m }: { m: MovementRow }) {
  const both = !!(m.previous_authority && m.new_authority);
  return (
    <View style={{ marginTop: 8, gap: 8 }}>
      {both ? (
        <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1, borderRadius: 12, borderWidth: 1, borderColor: tint(Palette.gold, 0.35), backgroundColor: tint(Palette.gold, 0.07), padding: 8 }}>
            <Text style={[Type.caption, { color: Palette.gold, textAlign: 'right' }]}>من</Text>
            <Text style={[Type.body, { color: Colors.textPrimary, textAlign: 'right' }]}>{m.previous_authority}</Text>
          </View>
          <ArrowLeft color={Palette.cyan} size={16} />
          <View style={{ flex: 1, borderRadius: 12, borderWidth: 1, borderColor: tint(Palette.green, 0.4), backgroundColor: tint(Palette.green, 0.08), padding: 8 }}>
            <Text style={[Type.caption, { color: Palette.green, textAlign: 'right' }]}>إلى</Text>
            <Text style={[Type.body, { color: Colors.textPrimary, textAlign: 'right' }]}>{m.new_authority}</Text>
          </View>
        </View>
      ) : m.new_authority ? (
        <MetaItem icon={MapPin} label="جهة الإيداع" value={m.new_authority} color={Palette.green} />
      ) : m.previous_authority ? (
        <MetaItem icon={MapPin} label="جهة الإيداع السابقة" value={m.previous_authority} color={Palette.gold} />
      ) : null}
      {m.reason ? (
        <View>
          <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>الملاحظات</Text>
          <Text style={[Type.body, { color: Colors.textSecondary, textAlign: 'right' }]}>{m.reason}</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: ROW, flexWrap: 'wrap', columnGap: 12, rowGap: 6 }}>
        <MetaItem icon={UserRound} label="المستخدم" value={m.executed_by_name ?? '—'} />
        <MetaItem icon={Layers} label="رقم الحركة" value={m.movement_number} />
      </View>
    </View>
  );
}

const MovementsTab = React.memo(function MovementsTab({ movements }: { movements: MovementRow[] }) {
  const asc = useMemo(() => movements.slice().reverse(), [movements]);
  const flow = useMemo(() => asc.filter((m) => m.movement_type !== 'تصحيح'), [asc]);
  const items: TimelineItem[] = useMemo(() => asc.map((m, i) => {
    const look = movementLook(m.movement_type);
    return {
      key: m.id, icon: look.icon, color: look.color, title: m.movement_type,
      subtitle: formatDate(m.movement_date),
      time: 'سُجّلت الساعة ' + fmtTime(m.created_at),
      badge: i === asc.length - 1 ? { label: 'الأحدث', color: look.color } : undefined,
      extra: <MovementExtra m={m} />,
    };
  }), [asc]);

  if (movements.length === 0) {
    return <EmptyState icon={History} title="لا توجد حركات مسجلة" hint="أي حركة إيداع أو نقل أو إفراج تُحفظ هنا ولا تُحذف." color={Palette.cyan} />;
  }
  return (
    <View style={{ gap: 12 }}>
      <Card>
        <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]}>مسار الاحتجاز</Text>
        <View style={{ flexDirection: ROW, flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 10 }}>
          {flow.map((m, i) => (
            <React.Fragment key={m.id}>
              <Pill label={m.movement_type} color={movementLook(m.movement_type).color} icon={movementLook(m.movement_type).icon} />
              {i < flow.length - 1 ? <ArrowLeft color={Colors.textMuted} size={14} /> : null}
            </React.Fragment>
          ))}
        </View>
      </Card>
      <Card>
        <Timeline items={items} />
      </Card>
      <NoteBanner icon={Lock} color={Palette.cyan} text="سجل الحركات للإلحاق فقط، ولا يقبل التعديل أو الحذف." />
    </View>
  );
});

/* ───────────── سجل التصحيحات ───────────── */
const CorrectionsTab = React.memo(function CorrectionsTab({ corrections }: { corrections: CorrectionRow[] }) {
  if (corrections.length === 0) {
    return <EmptyState icon={Pencil} title="لا توجد تصحيحات مسجلة" hint="أي تصحيح لاحق على البيانات يُحفظ هنا بقيمته السابقة والجديدة ولا يُحذف." color={Palette.gold} />;
  }
  return (
    <View style={{ gap: 12 }}>
      <NoteBanner icon={ShieldCheck} color={Palette.gold} text="القيم السابقة محفوظة بالكامل في هذا السجل، ولا يمكن تعديله أو حذف أي سطر منه." />
      {corrections.map((c) => (
        <Card key={c.id} accent={Palette.gold}>
          <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Pill label={'تصحيح: ' + fieldLabel(c.field_name)} color={Palette.gold} icon={Pencil} />
            <Text style={[Type.caption, { color: Colors.textMuted }]}>{fmtDateTime(c.created_at)}</Text>
          </View>
          <CompareRow label={fieldLabel(c.field_name)} from={c.previous_value} to={c.new_value} />
          <View style={{ marginTop: 12 }}>
            <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>سبب التصحيح</Text>
            <Text style={[Type.bodyLg, { color: Colors.textPrimary, textAlign: 'right' }]}>{c.reason}</Text>
          </View>
          <View style={{ flexDirection: ROW, flexWrap: 'wrap', columnGap: 12, marginTop: 10 }}>
            <MetaItem icon={UserRound} label="المنفّذ" value={c.executed_by_name ?? '—'} />
            <MetaItem icon={Clock} label="وقت التسجيل" value={fmtTime(c.created_at)} />
          </View>
        </Card>
      ))}
    </View>
  );
});

/* ───────────── نظرة عامة ───────────── */
const OverviewTab = React.memo(function OverviewTab({ detail, transfers }: { detail: DetaineeDetail; transfers: number }) {
  const released = detail.status === 'مفرج عنه';
  const color = statusColor(detail.status);
  const days = daysBetween(detail.admission_date, detail.release_date);
  return (
    <View style={{ gap: 12 }}>
      <Card accent={color}>
        <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
          <View>
            <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>{released ? 'مدة الاحتجاز الكلية' : 'مدة الاحتجاز حتى الآن'}</Text>
            <View style={{ flexDirection: ROW, alignItems: 'flex-end', gap: 6 }}>
              <Text style={[Type.stat, { color: Colors.textPrimary }]}>{toArabicDigits(days)}</Text>
              <Text style={[Type.bodyLg, { color: Colors.textSecondary, marginBottom: 6 }]}>يوم</Text>
            </View>
          </View>
          <View style={{ width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: tint(color, 0.45), backgroundColor: tint(color, 0.14), ...Glow(color) }}>
            {released ? <LogOut color={color} size={26} /> : <ShieldCheck color={color} size={26} />}
          </View>
        </View>
        <View style={{ height: 1, backgroundColor: Palette.glassBorder, marginVertical: 14 }} />
        <View style={{ flexDirection: ROW, gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>تاريخ الدخول</Text>
            <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]}>{formatDate(detail.admission_date)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>عدد النقلات</Text>
            <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right' }]}>{toArabicDigits(transfers)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>{released ? 'تاريخ الإفراج' : 'الحالة'}</Text>
            <Text style={[Type.h3, { color: released ? Palette.purple : Palette.green, textAlign: 'right' }]}>
              {released && detail.release_date !== null ? formatDate(detail.release_date) : 'لا يزال محتجزاً'}
            </Text>
          </View>
        </View>
      </Card>

      <Card>
        <View style={{ flexDirection: ROW, flexWrap: 'wrap', rowGap: 12, columnGap: 12 }}>
          <MetaItem icon={Layers} label="رقم الملف" value={detail.reference_number} />
          <MetaItem icon={Tag} label="الفئة" value={detail.category_name ?? 'غير محددة'} />
          <MetaItem icon={MapPin} label="جهة الإيداع" value={detail.detaining_authority !== '' ? detail.detaining_authority : 'غير محدد'} />
          <MetaItem icon={MapPin} label="مكان الاحتجاز أو السجن" value={detail.place_of_detention ? detail.place_of_detention : 'غير محدد'} />
          <MetaItem icon={Clock} label="مدة الاحتجاز" value={durationText(detail.admission_date, detail.release_date)} />
        </View>
        <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', marginTop: 14 }]}>التهمة المنسوبة</Text>
        <Text style={[Type.bodyLg, { color: Colors.textPrimary, textAlign: 'right' }]}>{detail.alleged_offense}</Text>
      </Card>
    </View>
  );
});

/* ───────────── الشاشة ───────────── */
export default function DetaineesScreen() {
  const { user } = useAuth();
  const session = useMemo<Session | null>(
    () => (user ? { userId: user.id, role: user.role } : null),
    [user?.id, user?.role]
  );
  const canAdd = can(user?.role, 'detainees.manage');
  const canCorrect = can(user?.role, 'detainees.correct');

  const [items, setItems] = useState<DetaineeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [stats, setStats] = useState<DetStats | null>(null);
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortMode>('newest');
  const requestId = useRef(0);

  const [showForm, setShowForm] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [categories, setCategories] = useState<CategoryRow[]>([]);

  const [fullName, setFullName] = useState('');
  const [refNumber, setRefNumber] = useState('');
  const [offense, setOffense] = useState('');
  const [authority, setAuthority] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [day, setDay] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');
  const [fIdType, setFIdType] = useState<string | null>(null);
  const [fIdNumber, setFIdNumber] = useState('');
  const [fPhone, setFPhone] = useState('');
  const [fAge, setFAge] = useState('');
  const [fGov, setFGov] = useState('');
  const [fDistrict, setFDistrict] = useState('');
  const [fSub, setFSub] = useState('');
  const [fResidence, setFResidence] = useState('');
  const [fJob, setFJob] = useState('');
  const [fRole, setFRole] = useState<string | null>(null);
  const [fReport, setFReport] = useState('');
  const [fStatus, setFStatus] = useState<string | null>(null);
  const [fRefD, setFRefD] = useState('');
  const [fRefM, setFRefM] = useState('');
  const [fRefY, setFRefY] = useState('');
  const [fNotes, setFNotes] = useState('');
  const [fPlace, setFPlace] = useState('');
  const [fListPick, setFListPick] = useState<'id' | 'role' | 'status' | null>(null);
  const [fClasses, setFClasses] = useState<ClassificationRow[]>([]);
  const [fClsId, setFClsId] = useState<string | null>(null);
  const [fClsQuery, setFClsQuery] = useState('');
  const [fShowCls, setFShowCls] = useState(false);

  const loadStats = useCallback(async () => {
    try {
      const db = await getDb();
      const total = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM detainees');
      const current = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM detainees WHERE status = ?', ['محتجز']);
      const released = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM detainees WHERE status = ?', ['مفرج عنه']);
      const today = await db.getFirstAsync<{ c: number }>(
        'SELECT COUNT(*) AS c FROM detainees WHERE admission_date >= ? AND admission_date <= ?',
        [startOfToday(), endOfToday()]
      );
      const moved = await db.getFirstAsync<{ c: number }>(
        'SELECT COUNT(DISTINCT detainee_id) AS c FROM detainee_movements WHERE movement_type = ?', ['نقل']
      );
      const avg = await db.getFirstAsync<{ a: number | null }>(
        'SELECT AVG(admission_date) AS a FROM detainees WHERE status = ?', ['محتجز']
      );
      setStats({
        total: total?.c ?? 0, current: current?.c ?? 0, released: released?.c ?? 0,
        admittedToday: today?.c ?? 0, transferred: moved?.c ?? 0,
        avgDays: avg && avg.a !== null && avg.a !== undefined ? Math.max(0, (Date.now() - avg.a) / DAY_MS) : null,
      });
    } catch (e) {
      console.error('[Detainees] stats error:', e);
    }
  }, []);

  const loadDetainees = useCallback(async (q: string) => {
    const current = ++requestId.current;
    try {
      const db = await getDb();
      const term = q.trim();
      const rows = term
        ? await db.getAllAsync<DetaineeRow>(
            SQL_BASE + ' WHERE d.full_name LIKE ? OR d.reference_number LIKE ?' + SQL_ORDER,
            ['%' + term + '%', '%' + term + '%']
          )
        : await db.getAllAsync<DetaineeRow>(SQL_BASE + SQL_ORDER);
      if (current === requestId.current) { setItems(rows); setFailed(false); }
    } catch (e) {
      console.error('[Detainees] load error:', e);
      if (current === requestId.current) setFailed(true);
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQuery(normalizeDigits(searchText)), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  useEffect(() => {
    loadDetainees(query);
  }, [query, loadDetainees]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const resetForm = () => {
    const t = todayParts();
    setFullName('');
    setRefNumber('');
    setOffense('');
    setAuthority('');
    setCategoryId(null);
    setDay(t.d);
    setMonth(t.m);
    setYear(t.y);
    setFIdType(null); setFIdNumber(''); setFPhone(''); setFAge('');
    setFGov(''); setFDistrict(''); setFSub(''); setFResidence(''); setFJob('');
    setFRole(null); setFReport(''); setFStatus(null);
    setFRefD(''); setFRefM(''); setFRefY(''); setFNotes('');
    setFListPick(null);
    setFClsId(null); setFClsQuery(''); setFShowCls(false);
    setFormError('');
  };

  const openForm = async () => {
    if (!canAdd) return;
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<CategoryRow>(
        'SELECT id, name FROM detainee_categories WHERE is_active = 1 ORDER BY rowid'
      );
      setCategories(rows);
    } catch (e) {
      console.error('[Detainees] categories error:', e);
      Alert.alert('خطأ', 'تعذر تحميل فئات المحتجزين');
      return;
    }
    resetForm();
    try {
      setFClasses(await listCrimeClassifications(session));
    } catch (e) {
      console.error('[Detainees] classifications error:', e);
      setFClasses([]);
    }
    setFPlace('');
    setShowForm(true);
  };

  const closeForm = () => {
    if (saving) return;
    setShowPicker(false);
    setFListPick(null);
    setFShowCls(false);
    setShowForm(false);
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdd || !user) {
      setFormError('ليست لديك صلاحية تسجيل المحتجزين');
      return;
    }

    const built = buildDetentionInput({
      fullName, refNumber, offense, authority, categoryId,
      admission: { d: day, m: month, y: year },
      idType: fIdType, idNumber: fIdNumber, phone: fPhone, age: fAge,
      governorate: fGov, district: fDistrict, subDistrict: fSub, residence: fResidence, occupation: fJob,
      caseRole: fRole, reportNumber: fReport, legalStatus: fStatus,
      referral: { d: fRefD, m: fRefM, y: fRefY }, notes: fNotes, placeOfDetention: fPlace, classificationId: fClsId,
    });
    if (!built.ok) { setFormError(built.error); return; }

    setSaving(true);
    setFormError('');
    try {
      await createDetention(session, built.input);

      setShowPicker(false);
      setShowForm(false);
      await loadDetainees(query);
      void loadStats();
      Alert.alert('تم الحفظ', 'تم تسجيل المحتجز وإضافة حركة الإيداع بنجاح');
    } catch (e) {
      console.error('[Detainees] save error:', e);
      const msg = String((e as Error)?.message ?? '');
      if (msg.includes('FORBIDDEN')) {
        setFormError('ليست لديك صلاحية تسجيل المحتجزين');
      } else if (msg.includes('DUPLICATE_REFERENCE') || (msg.includes('UNIQUE') && msg.includes('reference_number'))) {
        setFormError('الرقم المرجعي مستخدم لمحتجز آخر');
      } else {
        setFormError('تعذر الحفظ ولم يتم تسجيل أي بيانات، حاول مرة أخرى');
      }
    } finally {
      setSaving(false);
    }
  };

  /* ───── ملف المحتجز ───── */
  const [showDetail, setShowDetail] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [detail, setDetail] = useState<DetaineeDetail | null>(null);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [action, setAction] = useState<'release' | 'transfer' | null>(null);
  const [showTransferPicker, setShowTransferPicker] = useState(false);
  const [aSaving, setASaving] = useState(false);
  const [aError, setAError] = useState('');
  const [aDay, setADay] = useState('');
  const [aMonth, setAMonth] = useState('');
  const [aYear, setAYear] = useState('');
  const [aReason, setAReason] = useState('');
  const [aAuthority, setAAuthority] = useState('');
  const [aCategoryId, setACategoryId] = useState<string | null>(null);
  const [aExitType, setAExitType] = useState<string | null>(null);
  const [aProcedure, setAProcedure] = useState('');
  const [aSource, setASource] = useState('');
  const [showExitPicker, setShowExitPicker] = useState(false);
  // إعادة الاحتجاز
  const [showRe, setShowRe] = useState(false);
  const [showRePicker, setShowRePicker] = useState(false);
  const [reRef, setReRef] = useState('');
  const [reOffense, setReOffense] = useState('');
  const [reAuthority, setReAuthority] = useState('');
  const [reCategoryId, setReCategoryId] = useState<string | null>(null);
  const [reDay, setReDay] = useState('');
  const [reMonth, setReMonth] = useState('');
  const [reYear, setReYear] = useState('');
  const [reError, setReError] = useState('');
  const [reSaving, setReSaving] = useState(false);
  const [corrections, setCorrections] = useState<CorrectionRow[]>([]);
  const [showCorrection, setShowCorrection] = useState(false);
  const [cField, setCField] = useState<CorrectionField>('full_name');
  const [cValue, setCValue] = useState('');
  const [cReason, setCReason] = useState('');
  const [cSaving, setCSaving] = useState(false);
  const [cError, setCError] = useState('');

  const loadDetail = async (id: string) => {
    const db = await getDb();
    const row = await db.getFirstAsync<DetaineeDetail>(
      `SELECT d.id, d.reference_number, d.full_name, d.category_id, d.admission_date,
              d.release_date, d.alleged_offense, d.detaining_authority, d.status,
              d.person_id, d.place_of_detention, c.name AS category_name
       FROM detainees d
       LEFT JOIN detainee_categories c ON c.id = d.category_id
       WHERE d.id = ?`,
      [id]
    );
    if (!row) throw new Error('NOT_FOUND');
    const moves = await db.getAllAsync<MovementRow>(
      `SELECT m.id, m.movement_number, m.movement_type, m.movement_date,
              m.previous_authority, m.new_authority, m.reason, m.created_at, u.username AS executed_by_name
       FROM detainee_movements m
       LEFT JOIN users u ON u.id = m.executed_by
       WHERE m.detainee_id = ?
       ORDER BY m.movement_date DESC, m.created_at DESC, m.rowid DESC`,
      [id]
    );
    const corr = await db.getAllAsync<CorrectionRow>(
      `SELECT h.id, h.field_name, h.previous_value, h.new_value, h.reason, h.created_at,
              u.username AS executed_by_name
       FROM correction_history h
       LEFT JOIN users u ON u.id = h.executed_by
       WHERE h.detainee_id = ?
       ORDER BY h.created_at DESC, h.rowid DESC`,
      [id]
    );
    setDetail(row);
    setMovements(moves);
    setCorrections(corr);
  };

  const refreshAfterAction = async (id: string) => {
    try {
      await loadDetail(id);
      await loadDetainees(query);
      void loadStats();
    } catch (e) {
      console.error('[Detainees] refresh error:', e);
    }
  };

  const openDetail = useCallback(async (id: string) => {
    setDetail(null);
    setMovements([]);
    setCorrections([]);
    setTab('overview');
    setDetailId(id);
    setDetailFailed(false);
    setShowDetail(true);
    setDetailLoading(true);
    try {
      await loadDetail(id);
    } catch (e) {
      console.error('[Detainees] detail error:', e);
      setDetailFailed(true);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = () => {
    if (aSaving) return;
    setAction(null);
    setShowTransferPicker(false);
    setShowDetail(false);
    setDetail(null);
    setMovements([]);
    setCorrections([]);
    setDetailId(null);
  };

  const openAction = async (type: 'release' | 'transfer') => {
    if (!canAdd || !detail) return;
    if (detail.status !== 'محتجز') {
      Alert.alert('تنبيه', 'هذا المحتجز مفرج عنه مسبقاً');
      return;
    }
    if (type === 'transfer') {
      try {
        const db = await getDb();
        const rows = await db.getAllAsync<CategoryRow>(
          'SELECT id, name FROM detainee_categories WHERE is_active = 1 ORDER BY rowid'
        );
        setCategories(rows);
      } catch (e) {
        console.error('[Detainees] categories error:', e);
        Alert.alert('خطأ', 'تعذر تحميل فئات المحتجزين');
        return;
      }
    }
    const t = todayParts();
    setADay(t.d);
    setAMonth(t.m);
    setAYear(t.y);
    setAReason('');
    setAExitType(null);
    setAProcedure('');
    setASource('');
    setAError('');
    setAAuthority(detail.detaining_authority);
    setACategoryId(detail.category_id);
    setAction(type);
  };

  const closeAction = () => {
    if (aSaving) return;
    setShowTransferPicker(false);
    setAction(null);
  };

  const persistAction = async (
    ts: number,
    reason: string,
    target: CategoryRow | null,
    newAuthority: string
  ) => {
    if (!action || !detail || !user || !canAdd) return;
    const type = action;
    setASaving(true);
    setAError('');
    try {
      if (type === 'release') {
        await exitPeriod(session, {
          detaineeId: detail.id, exitDate: ts, exitType: aExitType ?? '',
          exitProcedure: aProcedure.trim() || null, exitDirectiveSource: aSource.trim() || null, reason,
        });
      } else {
        if (!target) throw new Error('NO_TARGET');
        await transferPeriod(session, {
          detaineeId: detail.id,
          targetCategoryId: target.id,
          newAuthority,
          transferDate: ts,
          reason,
        });
      }

      setShowTransferPicker(false);
      setAction(null);
      await refreshAfterAction(detail.id);
      Alert.alert('تم الحفظ', type === 'release' ? 'تم تسجيل الإفراج بنجاح' : 'تم تسجيل النقل بنجاح');
    } catch (e) {
      console.error('[Detainees] action error:', e);
      const msg = String((e as Error)?.message ?? '');
      if (msg.includes('FORBIDDEN')) {
        setAError('ليست لديك صلاحية تنفيذ هذا الإجراء');
      } else if (msg.includes('DATE_BEFORE_ADMISSION')) {
        setAError('تاريخ الإجراء لا يمكن أن يسبق تاريخ الدخول');
      } else if (msg.includes('DATE_BEFORE_LAST_MOVEMENT')) {
        setAError('تاريخ الإجراء لا يمكن أن يسبق آخر حركة مسجلة');
      } else if (msg.includes('STATE_CHANGED')) {
        setAError('تغيّرت حالة المحتجز ولم يتم تسجيل أي حركة');
        await refreshAfterAction(detail.id);
      } else if (msg.includes('VALIDATION:exit_type')) {
        setAError('اختر نوع الخروج');
      } else if (msg.includes('CHECK constraint')) {
        setAError('التاريخ غير مقبول، ولم يتم تسجيل أي حركة');
      } else {
        setAError('تعذر الحفظ ولم يتم تسجيل أي بيانات، حاول مرة أخرى');
      }
    } finally {
      setASaving(false);
    }
  };

  const submitAction = () => {
    if (aSaving || !action || !detail) return;
    if (!canAdd || !user) {
      setAError('ليست لديك صلاحية تنفيذ هذا الإجراء');
      return;
    }
    if (detail.status !== 'محتجز') {
      setAError('هذا المحتجز مفرج عنه مسبقاً');
      return;
    }

    const ts = parseDate(normalizeDigits(aDay.trim()), normalizeDigits(aMonth.trim()), normalizeDigits(aYear.trim()));
    if (ts === null) {
      setAError('التاريخ غير صحيح، تأكد من اليوم والشهر والسنة');
      return;
    }
    if (ts > endOfToday()) {
      setAError('التاريخ لا يمكن أن يكون في المستقبل');
      return;
    }
    if (ts < detail.admission_date) {
      setAError('التاريخ لا يمكن أن يسبق تاريخ الدخول (' + formatDate(detail.admission_date) + ')');
      return;
    }

    const newAuthority = aAuthority.trim();
    let target: CategoryRow | null = null;
    if (action === 'transfer') {
      target =
        categories.find((c) => c.id === aCategoryId) ??
        (aCategoryId === detail.category_id
          ? { id: detail.category_id, name: detail.category_name ?? '' }
          : null);
      if (!target) {
        setAError('اختر الفئة الجديدة');
        return;
      }
      if (target.id === detail.category_id && newAuthority === detail.detaining_authority) {
        setAError('لم يتم تغيير الفئة أو جهة الحجز');
        return;
      }
    }

    if (action === 'release' && !aExitType) {
      setAError('اختر نوع الخروج');
      return;
    }
    setAError('');
    const reason = aReason.trim();
    const chosenTarget = target;
    Alert.alert(
      action === 'release' ? 'تأكيد الإفراج' : 'تأكيد النقل',
      'سيتم تسجيل الحركة في السجل التاريخي ولا يمكن حذفها لاحقاً. هل تريد المتابعة؟',
      [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'تأكيد', onPress: () => persistAction(ts, reason, chosenTarget, newAuthority) },
      ]
    );
  };

  const openRedetain = async () => {
    if (!canAdd || !detail) return;
    if (detail.status === 'محتجز') {
      Alert.alert('تنبيه', 'هذا الشخص محتجز حالياً');
      return;
    }
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<CategoryRow>(
        'SELECT id, name FROM detainee_categories WHERE is_active = 1 ORDER BY rowid'
      );
      setCategories(rows);
    } catch (e) {
      console.error('[Detainees] categories error:', e);
      Alert.alert('خطأ', 'تعذر تحميل فئات المحتجزين');
      return;
    }
    const t = todayParts();
    setReDay(t.d); setReMonth(t.m); setReYear(t.y);
    setReRef('');
    setReOffense(detail.alleged_offense);
    setReAuthority(detail.detaining_authority);
    setReCategoryId(detail.category_id);
    setReError('');
    setShowRe(true);
  };

  const closeRedetain = () => {
    if (reSaving) return;
    setShowRePicker(false);
    setShowRe(false);
  };

  const submitRedetain = async () => {
    if (reSaving || !detail || !user || !canAdd) return;
    const ref = normalizeDigits(reRef.trim());
    if (!ref) { setReError('الرقم المرجعي الجديد مطلوب'); return; }
    if (!reOffense.trim()) { setReError('التهمة المنسوبة مطلوبة'); return; }
    if (!reCategoryId) { setReError('اختر الفئة'); return; }
    const ts = parseDate(normalizeDigits(reDay.trim()), normalizeDigits(reMonth.trim()), normalizeDigits(reYear.trim()));
    if (ts === null) { setReError('التاريخ غير صحيح، تأكد من اليوم والشهر والسنة'); return; }
    if (ts > endOfToday()) { setReError('التاريخ لا يمكن أن يكون في المستقبل'); return; }
    if (detail.release_date !== null && ts < detail.release_date) {
      setReError('تاريخ الدخول الجديد لا يسبق تاريخ الخروج السابق (' + formatDate(detail.release_date) + ')');
      return;
    }
    setReSaving(true);
    setReError('');
    try {
      await redetainPerson(session, {
        personId: detail.person_id, referenceNumber: ref, allegedOffense: reOffense.trim(),
        categoryId: reCategoryId, detainingAuthority: reAuthority.trim(), admissionDate: ts,
      });
      setShowRePicker(false);
      setShowRe(false);
      closeDetail();
      await loadDetainees(query);
      void loadStats();
      Alert.alert('تم الحفظ', 'تم تسجيل فترة احتجاز جديدة لنفس الشخص');
    } catch (e) {
      console.error('[Detainees] redetain error:', e);
      const msg = String((e as Error)?.message ?? '');
      if (msg.includes('FORBIDDEN')) setReError('ليست لديك صلاحية تنفيذ هذا الإجراء');
      else if (msg.includes('PERSON_ALREADY_HELD')) setReError('هذا الشخص محتجز حالياً في فترة مفتوحة');
      else if (msg.includes('DATE_BEFORE_PREVIOUS_EXIT')) setReError('تاريخ الدخول الجديد يسبق تاريخ الخروج السابق');
      else if (msg.includes('DUPLICATE_REFERENCE')) setReError('الرقم المرجعي مستخدم لمحتجز آخر');
      else if (msg.includes('CATEGORY_NOT_FOUND')) setReError('الفئة المختارة غير متاحة');
      else setReError('تعذر الحفظ ولم يتم تسجيل أي بيانات، حاول مرة أخرى');
    } finally {
      setReSaving(false);
    }
  };

  const selectedCategory = categories.find((c) => c.id === categoryId);
  const selectedCls = fClasses.find((c) => c.id === fClsId);
  const nz = (s: string) => s.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
  const clsMatches = (() => {
    const q = nz(fClsQuery.trim());
    const all = q ? fClasses.filter((c) => nz(c.name + ' ' + c.sub_category).includes(q)) : fClasses;
    return all.slice(0, 40);
  })();
  const pickClassification = (c: ClassificationRow | null) => {
    setFClsId(c ? c.id : null);
    if (c && !offense.trim()) setOffense(c.name);
    setFShowCls(false);
  };
  const pickListValue = (value: string | null) => {
    if (fListPick === 'id') setFIdType(value);
    else if (fListPick === 'role') setFRole(value);
    else if (fListPick === 'status') setFStatus(value);
    setFListPick(null);
  };
  const transferCategoryName =
    categories.find((c) => c.id === aCategoryId)?.name ??
    (detail && aCategoryId === detail.category_id ? detail.category_name : null);

  const currentFieldValue = (field: CorrectionField): string => {
    if (!detail) return '';
    return field === 'full_name' ? detail.full_name : detail.alleged_offense;
  };

  const openCorrection = () => {
    if (!canCorrect || !detail) return;
    setCField('full_name');
    setCValue(detail.full_name);
    setCReason('');
    setCError('');
    setShowCorrection(true);
  };

  const closeCorrection = () => {
    if (cSaving) return;
    setShowCorrection(false);
  };

  const selectCorrectionField = (field: CorrectionField) => {
    if (cSaving) return;
    setCField(field);
    setCValue(currentFieldValue(field));
    setCError('');
  };

  const persistCorrection = async (
    field: CorrectionField,
    previous: string,
    next: string,
    reason: string
  ) => {
    if (!detail || !user || !canCorrect) return;
    const detaineeId = detail.id;
    setCSaving(true);
    setCError('');
    try {
      await correctPeriodField(session, { detaineeId, field, previous, next, reason });

      setShowCorrection(false);
      await refreshAfterAction(detaineeId);
      Alert.alert('تم الحفظ', 'تم تسجيل التصحيح وحفظ القيمة السابقة في السجل');
    } catch (e) {
      console.error('[Detainees] correction error:', e);
      const msg = String((e as Error)?.message ?? '');
      if (msg.includes('FORBIDDEN')) {
        setCError('التصحيح من صلاحيات المدير فقط');
      } else if (msg.includes('VALUE_CHANGED')) {
        setCError('تغيّرت القيمة الحالية، تم تحديث البيانات، راجعها وأعد المحاولة');
        await refreshAfterAction(detaineeId);
      } else {
        setCError('تعذر الحفظ ولم يتم تسجيل أي بيانات، حاول مرة أخرى');
      }
    } finally {
      setCSaving(false);
    }
  };

  const submitCorrection = () => {
    if (cSaving || !detail) return;
    if (!canCorrect || !user) {
      setCError('التصحيح من صلاحيات المدير فقط');
      return;
    }
    const previous = currentFieldValue(cField);
    const next = cValue.trim();
    const reason = cReason.trim();
    if (next === '') {
      setCError('القيمة الجديدة مطلوبة');
      return;
    }
    if (next === previous) {
      setCError('القيمة الجديدة مطابقة للقيمة الحالية');
      return;
    }
    if (reason === '') {
      setCError('سبب التصحيح مطلوب');
      return;
    }
    setCError('');
    const field = cField;
    Alert.alert(
      'تأكيد التصحيح',
      'ستُحفظ القيمة السابقة في سجل التصحيحات ولا يمكن تعديله أو حذفه لاحقاً. هل تريد المتابعة؟',
      [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'تأكيد', onPress: () => persistCorrection(field, previous, next, reason) },
      ]
    );
  };

  /* ───── مشتقات العرض ───── */
  const tiles: MiniStat[] = useMemo(() => {
    const s = stats;
    return [
      { key: 'cur', label: 'المحتجزون حالياً', value: s ? s.current : 0, color: Palette.green, icon: Users },
      { key: 'today', label: 'المقبولون اليوم', value: s ? s.admittedToday : 0, color: Palette.cyan, icon: UserPlus },
      { key: 'mov', label: 'المحوّلون', value: s ? s.transferred : 0, color: Palette.blue, icon: ArrowLeftRight },
      { key: 'rel', label: 'المفرج عنهم', value: s ? s.released : 0, color: Palette.purple, icon: UserMinus },
      { key: 'avg', label: 'متوسط مدة الاحتجاز (يوم)', value: s && s.avgDays !== null ? toArabicDigits(Math.round(s.avgDays)) : '—', color: Palette.gold, icon: Clock },
      { key: 'all', label: 'إجمالي الملفات', value: s ? s.total : 0, color: Palette.blue, icon: FileText },
    ];
  }, [stats]);

  const chips: ChipOpt<StatusFilter>[] = useMemo(() => ([
    { key: 'all', label: 'الكل', count: items.length },
    { key: 'محتجز', label: 'محتجز', count: items.filter((i) => i.status === 'محتجز').length, color: Palette.green },
    { key: 'مفرج عنه', label: 'مفرج عنه', count: items.filter((i) => i.status === 'مفرج عنه').length, color: Palette.purple },
  ]), [items]);

  const visible = useMemo(() => {
    const rows = statusFilter === 'all' ? items.slice() : items.filter((i) => i.status === statusFilter);
    if (sort === 'newest') rows.sort((a, b) => b.admission_date - a.admission_date);
    else if (sort === 'oldest') rows.sort((a, b) => a.admission_date - b.admission_date);
    else rows.sort((a, b) => a.full_name.localeCompare(b.full_name, 'ar'));
    return rows;
  }, [items, statusFilter, sort]);

  const renderItem = useCallback(({ item, index }: { item: DetaineeRow; index: number }) => (
    <View style={{ paddingHorizontal: 18, marginBottom: 12 }}>
      <DetaineeCard item={item} index={index} onOpen={openDetail} />
    </View>
  ), [openDetail]);

  const hasQuery = query.length > 0 || statusFilter !== 'all';
  const header = (
    <View>
      <StatStrip items={tiles} />
      <SectionTitle title="سجل المحتجزين" hint={toArabicDigits(visible.length) + ' من ' + toArabicDigits(items.length) + ' ملف'} top={20}
        action={
          <PressableScale onPress={() => setSort(NEXT_SORT[sort])} accessibilityRole="button" accessibilityLabel="تغيير الترتيب"
            style={{ flexDirection: ROW, alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: 999, backgroundColor: Palette.surface, borderWidth: 1, borderColor: Palette.glassBorder }}>
            <ArrowUpDown color={Palette.cyan} size={14} />
            <Text style={[Type.caption, { color: Colors.textSecondary }]}>{SORT_LABEL[sort]}</Text>
          </PressableScale>
        } />
    </View>
  );

  const detailTabs: ChipOpt<DetailTab>[] = [
    { key: 'overview', label: 'نظرة عامة' },
    { key: 'movements', label: 'الحركة التاريخية', count: movements.length },
    { key: 'corrections', label: 'سجل التصحيحات', count: corrections.length },
    { key: 'files', label: 'المرفقات' },
  ];
  const transfersCount = movements.filter((m) => m.movement_type === 'نقل').length;
  const canRelease = !!detail && canAdd && detail.status === 'محتجز';
  const canRedetain = !!detail && canAdd && detail.status === 'مفرج عنه';
  const detailFooter = detail && (canRelease || canRedetain || canCorrect) ? (
    <>
      {canRelease ? <ActionBtn label="إفراج" icon={LogOut} color={Palette.green} solid onPress={() => openAction('release')} /> : null}
      {canRelease ? <ActionBtn label="نقل" icon={ArrowLeftRight} color={Palette.blue} onPress={() => openAction('transfer')} /> : null}
      {canRedetain ? <ActionBtn label="إعادة احتجاز" icon={LogIn} color={Palette.cyan} solid onPress={openRedetain} /> : null}
      {canCorrect ? <ActionBtn label="تصحيح" icon={Pencil} color={Palette.gold} onPress={openCorrection} /> : null}
    </>
  ) : undefined;

  const categoryList = (selectedId: string | null, onPick: (c: CategoryRow) => void) => (
    <View style={{ gap: 8 }}>
      {categories.length === 0 ? <EmptyState compact icon={Tag} title="لا توجد فئات" hint="لا توجد فئات محتجزين مفعّلة." /> : null}
      {categories.map((c) => {
        const on = c.id === selectedId;
        return (
          <Card key={c.id} accent={on ? Palette.cyan : undefined} onPress={() => onPick(c)} label={c.name}>
            <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={[Type.bodyLg, { color: on ? Palette.cyan : Colors.textPrimary }]}>{c.name}</Text>
              {on ? <Check color={Palette.cyan} size={18} /> : null}
            </View>
          </Card>
        );
      })}
    </View>
  );

  return (
    <Screen>
      <PageHeader title="المحتجزون" subtitle="الملفات والحركة التاريخية وسجل التصحيحات" icon={Users} color={Palette.green}
        actions={canAdd ? <IconBtn icon={UserPlus} label="تسجيل محتجز جديد" solid color={Palette.green} onPress={openForm} /> : undefined} />
      <SearchField value={searchText} onChangeText={setSearchText} placeholder="ابحث بالاسم أو الرقم المرجعي..." />
      <View style={{ height: 10 }} />
      <FilterChips options={chips} value={statusFilter} onChange={setStatusFilter} />
      <View style={{ height: 14 }} />

      {loading ? <ListSkeleton /> : failed ? (
        <View style={{ paddingHorizontal: 18 }}>
          <ErrorState message="حدث خطأ أثناء تحميل بيانات المحتجزين." onRetry={() => { setLoading(true); void loadDetainees(query); void loadStats(); }} />
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(d) => d.id}
          renderItem={renderItem}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 40, flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={6}
          windowSize={7}
          removeClippedSubviews
          ListEmptyComponent={
            <EmptyState
              icon={Users}
              color={Palette.green}
              title={hasQuery ? 'لا توجد نتائج مطابقة' : 'لا يوجد محتجزون مسجلون حالياً'}
              hint={hasQuery ? 'جرّب تغيير كلمات البحث أو الفلتر.' : 'لا توجد بيانات متاحة حالياً.'}
              actionLabel={!hasQuery && canAdd ? 'تسجيل محتجز' : undefined}
              onAction={!hasQuery && canAdd ? openForm : undefined}
            />
          }
        />
      )}

      {/* ملف المحتجز */}
      <Sheet visible={showDetail} onClose={closeDetail}
        title={detail ? detail.full_name : 'ملف المحتجز'}
        subtitle={detail ? 'رقم الملف: ' + detail.reference_number : undefined}
        footer={detailFooter}>
        {detailFailed ? (
          <ErrorState message="تعذر تحميل ملف المحتجز." onRetry={() => { if (detailId) void openDetail(detailId); }} />
        ) : detailLoading || !detail ? (
          <View style={{ marginHorizontal: -18 }}><ListSkeleton count={2} /></View>
        ) : (
          <>
            <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Pill label={detail.status} color={statusColor(detail.status)} />
              <Text style={[Type.caption, { color: Colors.textMuted }]}>{'مدة الاحتجاز: ' + durationText(detail.admission_date, detail.release_date)}</Text>
            </View>
            <View style={{ marginHorizontal: -18, marginBottom: 14 }}><FilterChips options={detailTabs} value={tab} onChange={setTab} /></View>

            {tab === 'overview' ? <OverviewTab detail={detail} transfers={transfersCount} /> : null}
            {tab === 'movements' ? <MovementsTab movements={movements} /> : null}
            {tab === 'corrections' ? <CorrectionsTab corrections={corrections} /> : null}
            {tab === 'files' ? (
              <View style={{ gap: 12 }}>
                <NoteBanner icon={Paperclip} color={Palette.cyan} text="كل ملف يُتحقق من سلامته بالتجزئة SHA-256 عند فتحه." />
                <AttachmentsPanel entityType="detainee" entityId={detail.id} />
              </View>
            ) : null}
          </>
        )}
      </Sheet>

      {/* تسجيل محتجز جديد */}
      <Sheet visible={showForm} onClose={closeForm} title="تسجيل محتجز جديد" subtitle="الحقول المعلّمة بنجمة إلزامية"
        footer={<>
          <Btn label="حفظ" icon={Check} onPress={handleSave} loading={saving} style={{ flex: 1 }} />
          <Btn label="إلغاء" variant="ghost" onPress={closeForm} disabled={saving} />
        </>}>
        <ErrorBanner text={formError} />
        <SectionTitle title="بيانات الشخص" top={0} />
        <Field label="الاسم الكامل *" value={fullName} onChangeText={setFullName} editable={!saving} placeholder="الاسم الرباعي" />
        <SelectField label="نوع الهوية" value={fIdType} placeholder="اختر نوع الهوية" onPress={() => setFListPick('id')} disabled={saving} />
        <Field label="رقم الهوية" value={fIdNumber} onChangeText={setFIdNumber} editable={!saving} placeholder="اختياري" keyboardType="number-pad" />
        <Field label="رقم الهاتف" value={fPhone} onChangeText={setFPhone} editable={!saving} placeholder="اختياري" keyboardType="phone-pad" />
        <Field label="العمر" value={fAge} onChangeText={setFAge} editable={!saving} placeholder="اختياري" keyboardType="number-pad" maxLength={3} />
        <Field label="المحافظة" value={fGov} onChangeText={setFGov} editable={!saving} placeholder="اختياري" />
        <Field label="المديرية" value={fDistrict} onChangeText={setFDistrict} editable={!saving} placeholder="اختياري" />
        <Field label="العزلة" value={fSub} onChangeText={setFSub} editable={!saving} placeholder="اختياري" />
        <Field label="السكن الحالي" value={fResidence} onChangeText={setFResidence} editable={!saving} placeholder="اختياري" />
        <Field label="العمل" value={fJob} onChangeText={setFJob} editable={!saving} placeholder="اختياري" />
        <SectionTitle title="بيانات الاحتجاز" />
        <Field label="الرقم المرجعي *" value={refNumber} onChangeText={setRefNumber} editable={!saving} placeholder="الرقم المرجعي الفريد" autoCapitalize="characters" />
        <SelectField label="التصنيف القانوني للجريمة" value={selectedCls?.name} placeholder="اختر من القائمة (اختياري)" onPress={() => setFShowCls(true)} disabled={saving} />
        <Field label="التهمة المنسوبة *" value={offense} onChangeText={setOffense} editable={!saving} placeholder="التهمة" />
        <SelectField label="صفة المحتجز في القضية" value={fRole} placeholder="اختر الصفة" onPress={() => setFListPick('role')} disabled={saving} />
        <Field label="رقم البلاغ" value={fReport} onChangeText={setFReport} editable={!saving} placeholder="اختياري" />
        <Field label="جهة الإيداع" value={authority} onChangeText={setAuthority} editable={!saving} placeholder="اختياري" />
        <Field label="مكان الاحتجاز أو السجن" value={fPlace} onChangeText={setFPlace} editable={!saving} placeholder="مثال: الحجز الاحتياطي" />
        <SelectField label="الفئة *" value={selectedCategory?.name} placeholder="اختر الفئة" onPress={() => setShowPicker(true)} disabled={saving} />
        <DateFields label="تاريخ الدخول *" d={day} m={month} y={year} setD={setDay} setM={setMonth} setY={setYear} editable={!saving} />
        <SelectField label="وضع المحتجز" value={fStatus} placeholder="اختر الوضع" onPress={() => setFListPick('status')} disabled={saving} />
        <DateFields label="تاريخ إحالة الملف إلى النيابة (اختياري)" d={fRefD} m={fRefM} y={fRefY} setD={setFRefD} setM={setFRefM} setY={setFRefY} editable={!saving} />
        <Field label="ملاحظات" value={fNotes} onChangeText={setFNotes} editable={!saving} placeholder="مثال: سبب التأخير، تمديد بتاريخ..." multiline />
      </Sheet>

      <Sheet visible={showPicker} onClose={() => setShowPicker(false)} title="اختر الفئة">
        {categoryList(categoryId, (c) => { setCategoryId(c.id); setShowPicker(false); })}
      </Sheet>

      <Sheet visible={fListPick !== null} onClose={() => setFListPick(null)}
        title={fListPick === 'id' ? 'نوع الهوية' : fListPick === 'role' ? 'صفة المحتجز في القضية' : 'وضع المحتجز'}>
        <View style={{ gap: 8 }}>
          {(fListPick === 'id' ? ID_TYPES : fListPick === 'role' ? CASE_ROLES : LEGAL_STATUSES).map((opt) => {
            const cur = fListPick === 'id' ? fIdType : fListPick === 'role' ? fRole : fStatus;
            const on = opt === cur;
            return (
              <Card key={opt} accent={on ? Palette.cyan : undefined} onPress={() => pickListValue(opt)} label={opt}>
                <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={[Type.bodyLg, { color: on ? Palette.cyan : Colors.textPrimary }]}>{opt}</Text>
                  {on ? <Check color={Palette.cyan} size={18} /> : null}
                </View>
              </Card>
            );
          })}
          <Btn label="مسح الاختيار" variant="ghost" onPress={() => pickListValue(null)} />
        </View>
      </Sheet>

      <Sheet visible={fShowCls} onClose={() => setFShowCls(false)} title="التصنيف القانوني للجريمة"
        subtitle={'عدد التصنيفات: ' + toArabicDigits(fClasses.length)}>
        <Field label="بحث" value={fClsQuery} onChangeText={setFClsQuery} placeholder="اكتب جزءاً من اسم الجريمة" />
        <View style={{ gap: 8 }}>
          {clsMatches.length === 0 ? <EmptyState compact icon={Tag} title="لا توجد نتائج" hint="جرّب كلمة أخرى." /> : null}
          {clsMatches.map((c) => {
            const on = c.id === fClsId;
            return (
              <Card key={c.id} accent={on ? Palette.cyan : undefined} onPress={() => pickClassification(c)} label={c.name}>
                <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[Type.bodyLg, { color: on ? Palette.cyan : Colors.textPrimary, textAlign: 'right' }]}>{c.name}</Text>
                    <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>{c.severity + ' · ' + c.sub_category}</Text>
                  </View>
                  {on ? <Check color={Palette.cyan} size={18} /> : null}
                </View>
              </Card>
            );
          })}
          {fClasses.length > 40 && !fClsQuery.trim() ? (
            <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'center' }]}>تظهر أول 40 نتيجة، استخدم البحث للوصول لبقية التصنيفات</Text>
          ) : null}
          <Btn label="مسح الاختيار" variant="ghost" onPress={() => pickClassification(null)} />
        </View>
      </Sheet>

      {/* إفراج / نقل */}
      <Sheet visible={action !== null} onClose={closeAction}
        title={action === 'release' ? 'تسجيل خروج' : 'تسجيل نقل'}
        subtitle={detail ? detail.full_name : undefined}
        footer={<>
          <ActionBtn label={action === 'release' ? 'تسجيل الإفراج' : 'تسجيل النقل'} icon={Check} solid
            color={action === 'release' ? Palette.green : Palette.blue} onPress={submitAction} loading={aSaving} />
          <Btn label="إلغاء" variant="ghost" onPress={closeAction} disabled={aSaving} />
        </>}>
        <ErrorBanner text={aError} />
        <NoteBanner icon={Lock} color={action === 'release' ? Palette.green : Palette.blue}
          text="تُسجَّل الحركة في السجل التاريخي ولا يمكن حذفها أو تعديلها لاحقاً." />
        {action === 'transfer' ? (
          <>
            <SelectField label="الفئة الجديدة *" value={transferCategoryName} placeholder="اختر الفئة" onPress={() => setShowTransferPicker(true)} disabled={aSaving} />
            <Field label="جهة الحجز الجديدة" value={aAuthority} onChangeText={setAAuthority} editable={!aSaving} placeholder="اختياري" />
          </>
        ) : null}
        <DateFields label={action === 'release' ? 'تاريخ الإفراج *' : 'تاريخ النقل *'} d={aDay} m={aMonth} y={aYear} setD={setADay} setM={setAMonth} setY={setAYear} editable={!aSaving} />
        {action === 'release' ? (
          <>
            <SelectField label="نوع الخروج *" value={aExitType} placeholder="اختر نوع الخروج" onPress={() => setShowExitPicker(true)} disabled={aSaving} />
            <Field label="إجراءات الخروج" value={aProcedure} onChangeText={setAProcedure} editable={!aSaving} placeholder="اختياري" />
            <Field label="مصدر التوجيه بالخروج" value={aSource} onChangeText={setASource} editable={!aSaving} placeholder="اختياري: اسم الجهة أو المسؤول" />
          </>
        ) : null}
        <Field label="السبب" value={aReason} onChangeText={setAReason} editable={!aSaving} placeholder="اختياري" />
      </Sheet>

      <Sheet visible={showExitPicker} onClose={() => setShowExitPicker(false)} title="نوع الخروج">
        <View style={{ gap: 8 }}>
          {EXIT_TYPES.map((opt) => {
            const on = opt === aExitType;
            return (
              <Card key={opt} accent={on ? Palette.green : undefined} onPress={() => { setAExitType(opt); setShowExitPicker(false); }} label={opt}>
                <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={[Type.bodyLg, { color: on ? Palette.green : Colors.textPrimary }]}>{opt}</Text>
                  {on ? <Check color={Palette.green} size={18} /> : null}
                </View>
              </Card>
            );
          })}
        </View>
      </Sheet>

      <Sheet visible={showRe} onClose={closeRedetain} title="إعادة احتجاز" subtitle={detail ? detail.full_name : undefined}
        footer={<>
          <ActionBtn label="تسجيل فترة جديدة" icon={Check} solid color={Palette.cyan} onPress={submitRedetain} loading={reSaving} />
          <Btn label="إلغاء" variant="ghost" onPress={closeRedetain} disabled={reSaving} />
        </>}>
        <ErrorBanner text={reError} />
        <NoteBanner icon={Lock} color={Palette.cyan}
          text="تُفتح فترة احتجاز جديدة لنفس الشخص دون إنشاء شخص جديد، وتبقى الفترة السابقة وحركاتها كما هي." />
        <Field label="الرقم المرجعي الجديد *" value={reRef} onChangeText={setReRef} editable={!reSaving} placeholder="رقم مرجعي فريد" autoCapitalize="characters" />
        <Field label="التهمة المنسوبة *" value={reOffense} onChangeText={setReOffense} editable={!reSaving} placeholder="التهمة" />
        <SelectField label="الفئة *" value={categories.find((c) => c.id === reCategoryId)?.name} placeholder="اختر الفئة" onPress={() => setShowRePicker(true)} disabled={reSaving} />
        <Field label="جهة الإيداع" value={reAuthority} onChangeText={setReAuthority} editable={!reSaving} placeholder="اختياري" />
        <DateFields label="تاريخ الدخول الجديد *" d={reDay} m={reMonth} y={reYear} setD={setReDay} setM={setReMonth} setY={setReYear} editable={!reSaving} />
      </Sheet>

      <Sheet visible={showRePicker} onClose={() => setShowRePicker(false)} title="اختر الفئة">
        {categoryList(reCategoryId, (c) => { setReCategoryId(c.id); setShowRePicker(false); })}
      </Sheet>

      <Sheet visible={showTransferPicker} onClose={() => setShowTransferPicker(false)} title="اختر الفئة الجديدة">
        {categoryList(aCategoryId, (c) => { setACategoryId(c.id); setShowTransferPicker(false); })}
      </Sheet>

      {/* تصحيح البيانات */}
      <Sheet visible={showCorrection} onClose={closeCorrection} title="تصحيح بيانات المحتجز" subtitle={detail ? detail.full_name : undefined}
        footer={<>
          <ActionBtn label="حفظ التصحيح" icon={Check} solid color={Palette.gold} onPress={submitCorrection} loading={cSaving} />
          <Btn label="إلغاء" variant="ghost" onPress={closeCorrection} disabled={cSaving} />
        </>}>
        <ErrorBanner text={cError} />
        <NoteBanner icon={ShieldCheck} color={Palette.gold}
          text="لا تُحذف القيمة القديمة، بل تُحفظ في سجل التصحيحات مع السبب واسم المنفّذ، ولا يمكن تعديل السجل أو حذفه." />
        <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right', marginBottom: 8 }]}>الحقل المراد تصحيحه</Text>
        <View style={{ marginHorizontal: -18, marginBottom: 14 }}>
          <FilterChips
            options={CORRECTION_FIELDS.map((f) => ({ key: f.key, label: f.label, color: Palette.gold }))}
            value={cField} onChange={selectCorrectionField} />
        </View>
        <View style={{ borderRadius: 14, borderWidth: 1, borderColor: tint(Palette.gold, 0.35), backgroundColor: tint(Palette.gold, 0.07), padding: 12, marginBottom: 14 }}>
          <Text style={[Type.caption, { color: Palette.gold, textAlign: 'right' }]}>القيمة الحالية (ستبقى محفوظة في السجل)</Text>
          <Text style={[Type.bodyLg, { color: Colors.textPrimary, textAlign: 'right' }]}>{currentFieldValue(cField)}</Text>
        </View>
        <Field label="القيمة الجديدة *" value={cValue} onChangeText={setCValue} editable={!cSaving} placeholder="القيمة الصحيحة" />
        <Field label="سبب التصحيح *" value={cReason} onChangeText={setCReason} editable={!cSaving} placeholder="مثال: خطأ في الإدخال" />
      </Sheet>
    </Screen>
  );
}
