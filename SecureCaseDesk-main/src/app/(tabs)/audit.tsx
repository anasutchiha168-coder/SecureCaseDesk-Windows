// SECURECASEDESK_PHASE8 + SECURECASEDESK_UI_V3 — سجل التدقيق كواجهة مراقبة أمنية.
// المنطق (التحميل، التصفية، التحقق من السلسلة، الصلاحيات) كما كان؛ التغيير في العرض فقط.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Alert } from 'react-native';
import { useRouter } from 'expo-router'; // SECTION3
import { auditOperationLabel, auditEntityLabel } from '@/modules/audit/audit-labels';
import { RefreshCw, ShieldCheck, ShieldAlert, Shield, FileCheck2, RefreshCcw, SlidersHorizontal, Clock, UserRound, Lock } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { Colors, Palette, Type, tint } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { auditLook, SEVERITY_META, type Severity } from '@/components/dashboard/audit-look';
import { Screen, PageHeader, IconBtn, Card, Pill, SearchField, FilterChips, Btn, Field, Sheet, ListSkeleton, type ChipOpt } from '@/components/ui/Kit';
import { CompareRow } from '@/components/ui/Timeline';
import { EmptyState } from '@/components/ui/States';
import { FadeIn } from '@/components/ui/Motion';
import {
  getAuditLogs, verifyAuditChain, flushAuditQueue,
  type AuditLogRow
} from '@/services/audit.service';

const PAGE_SIZE = 30;

function operationLabel(value: string): string {
  const names: Record<string, string> = {
    create: 'إنشاء',
    update: 'تعديل',
    delete: 'حذف',
    login: 'تسجيل دخول',
    logout: 'تسجيل خروج',
    session: 'جلسة',
    failed_login: 'محاولة دخول فاشلة',
    protection_test: 'فحص حماية ذاتي',
  };
  return names[value] ?? auditOperationLabel(value);
}

function entityLabel(value: string): string {
  const names: Record<string, string> = {
    users: 'المستخدمون',
    departments: 'الأقسام',
    cases: 'القضايا',
    memos: 'المذكرات',
    detainees: 'المحتجزون',
    detainee_movements: 'حركات المحتجزين',
    correction_history: 'سجل التصحيحات',
    session: 'جلسات الدخول',
    self_test: 'فحص ذاتي',
  };
  return names[value] ?? auditEntityLabel(value);
}

function readable(value: string | null): string {
  if (!value) return 'غير متوفر';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function parseDate(value: string, end: boolean): number | null {
  if (!value.trim()) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error('اكتب التاريخ بصيغة السنة-الشهر-اليوم');
  }

  const d = new Date(
    value.trim() + (end ? 'T23:59:59.999' : 'T00:00:00')
  );

  if (Number.isNaN(d.getTime()) ||
      d.toISOString().slice(0, 10) !== value.trim()) {
    throw new Error('التاريخ المدخل غير صحيح');
  }

  return d.getTime();
}

export default function AuditScreen() {
  const { user } = useAuth();
  const router = useRouter();

  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [query, setQuery] = useState('');
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [integrity, setIntegrity] = useState<'unknown' | 'ok' | 'broken'>('unknown');
  const [severity, setSeverity] = useState<'all' | Severity>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [detail, setDetail] = useState<AuditLogRow | null>(null);

  const load = useCallback(async (reset: boolean) => {
    if (!user) return;

    setLoading(true);

    try {
      await flushAuditQueue();

      const from = parseDate(fromText, false);
      const to = parseDate(toText, true);

      if (from !== null && to !== null && from > to) {
        throw new Error('تاريخ البداية أكبر من تاريخ النهاية');
      }

      const nextOffset = reset ? 0 : offset;

      const result = await getAuditLogs(user.id, {
        query,
        from,
        to,
        offset: nextOffset,
        limit: PAGE_SIZE,
      });

      setRows((previous) => reset ? result : [...previous, ...result]);
      setOffset(nextOffset + result.length);
      setMore(result.length === PAGE_SIZE);

    } catch (e) {
      Alert.alert(
        'تعذر تحميل السجل',
        String((e as Error)?.message ?? 'حدث خطأ غير متوقع')
      );
    } finally {
      setLoading(false);
    }
  }, [user?.id, query, fromText, toText, offset]);

  useEffect(() => {
    void load(true);
  }, [user?.id]);

  const verify = async () => {
    if (!user || verifying) return;

    setVerifying(true);

    try {
      const result = await verifyAuditChain(user.id);
      const test = result.selfTest;
      setIntegrity(result.ok ? 'ok' : 'broken');

      if (result.ok) {
        Alert.alert(
          'التحقق من سلامة السجل',
          'سجل التدقيق سليم.\n' +
          'عدد السجلات: ' + result.count +
          '\nاختبار HMAC: ناجح' +
          '\nاختبار التعديل: ناجح' +
          '\nاختبار الحذف والانقطاع: ناجح' +
          '\nاختبار الترتيب: ناجح'
        );
      } else {
        const messages: Record<string, string> = {
          SEQUENCE_GAP: 'تم اكتشاف سجل مفقود أو انقطاع في التسلسل.',
          BROKEN_LINK: 'تم اكتشاف انقطاع في رابط السجل السابق.',
          INVALID_HMAC: 'تم اكتشاف تغيير في محتويات أحد السجلات.',
          UNKNOWN_VERSION: 'إصدار التوقيع غير معروف.',
          SELF_TEST_FAILED: 'فشل الاختبار الداخلي لخوارزمية HMAC.',
        };

        Alert.alert(
          'تحذير أمني',
          (messages[result.code] ?? 'تعذر التحقق من سلامة السجل.') +
          (result.badSequence
            ? '\nرقم السجل المتأثر: ' + result.badSequence
            : '')
        );
      }
    } catch (e) {
      const message = String((e as Error)?.message ?? '');

      const translated =
        message.includes('AUDIT_KEY_MISSING') ||
        message.includes('AUDIT_KEY_NOT_INITIALIZED')
          ? 'مفتاح حماية سجل التدقيق غير متوفر. لم يتم إنشاء مفتاح بديل.'
          : message.includes('FORBIDDEN')
          ? 'عرض سجل التدقيق من صلاحيات المدير النشط فقط.'
          : 'تعذر إكمال التحقق. لم تُعلن سلامة السجل.';

      Alert.alert('تعذر التحقق', translated);
    } finally {
      setVerifying(false);
    }
  };

  const sevCounts = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0 };
    for (const r of rows) c[auditLook(r.operation_type).severity] += 1;
    return c;
  }, [rows]);
  const chips: ChipOpt<'all' | Severity>[] = [
    { key: 'all', label: 'كل الأحداث', count: rows.length },
    { key: 'critical', label: 'حرجة', count: sevCounts.critical, color: Palette.red },
    { key: 'warning', label: 'تحذيرية', count: sevCounts.warning, color: Palette.gold },
    { key: 'info', label: 'معلوماتية', count: sevCounts.info, color: Palette.cyan },
  ];
  const visible = useMemo(() => (severity === 'all' ? rows : rows.filter((r) => auditLook(r.operation_type).severity === severity)), [rows, severity]);

  const integ = integrity === 'ok'
    ? { color: Palette.green, icon: ShieldCheck, label: 'السلسلة سليمة', hint: 'آخر تحقق ناجح في هذه الجلسة' }
    : integrity === 'broken'
      ? { color: Palette.red, icon: ShieldAlert, label: 'تم اكتشاف خلل', hint: 'راجع تقرير التحقق فوراً' }
      : { color: Palette.gold, icon: Shield, label: 'لم يُتحقق بعد', hint: 'شغّل التحقق لإثبات سلامة السلسلة' };
  const IntegIcon = integ.icon;

  const renderItem = ({ item, index }: { item: AuditLogRow; index: number }) => {
    const look = auditLook(item.operation_type);
    const sev = SEVERITY_META[look.severity];
    const Icon = look.icon;
    const last = index === visible.length - 1;
    return (
      <FadeIn delay={Math.min(index, 8) * 30}>
        <View style={{ flexDirection: ROW, alignItems: 'stretch', paddingHorizontal: 18 }}>
          <View style={{ alignItems: 'center', width: 38 }}>
            <View style={{ width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, backgroundColor: tint(look.color, 0.16), borderColor: tint(look.color, 0.5) }}>
              <Icon color={look.color} size={16} />
            </View>
            {!last ? <View style={{ flex: 1, width: 2, marginTop: 4, borderRadius: 1, backgroundColor: tint(look.color, 0.22) }} /> : null}
          </View>
          <View style={{ flex: 1, paddingStart: 10, paddingBottom: 12 }}>
            <Card onPress={() => setDetail(item)} label={'تفاصيل ' + operationLabel(item.operation_type)} style={{ padding: 12, borderRadius: 18 }}>
              <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Text style={[Type.h3, { color: Colors.textPrimary, flexShrink: 1, textAlign: 'right' }]} numberOfLines={1}>{operationLabel(item.operation_type)}</Text>
                <Pill label={sev.label} color={sev.color} />
              </View>
              <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right' }]} numberOfLines={1}>
                {entityLabel(item.entity_type)}{item.entity_id ? ' — ' + item.entity_id : ''}
              </Text>
              <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
                <View style={{ flexDirection: ROW, alignItems: 'center', gap: 4, flexShrink: 1 }}>
                  <UserRound color={Colors.textMuted} size={12} />
                  <Text style={[Type.caption, { color: Colors.textMuted }]} numberOfLines={1}>{item.username || 'النظام'}</Text>
                </View>
                <View style={{ flexDirection: ROW, alignItems: 'center', gap: 4 }}>
                  <Clock color={Colors.textMuted} size={12} />
                  <Text style={[Type.caption, { color: Colors.textMuted }]}>{new Date(item.created_at).toLocaleString('ar-YE')}</Text>
                </View>
              </View>
              <View style={{ flexDirection: ROW, alignItems: 'center', gap: 6, marginTop: 6 }}>
                <Lock color={Palette.cyan} size={11} />
                <Text style={[Type.caption, { color: Palette.cyan }]}>موقّع بـ HMAC • تسلسل {item.sequence_no}</Text>
              </View>
            </Card>
          </View>
        </View>
      </FadeIn>
    );
  };

  const apply = () => { setOffset(0); void load(true); };

  const header = (
    <View style={{ gap: 12, paddingBottom: 14 }}>
      <View style={{ paddingHorizontal: 18 }}>
        <Card accent={integ.color} style={{ paddingStart: 20 }}>
          <View style={{ flexDirection: ROW, alignItems: 'center', gap: 12 }}>
            <View style={{ width: 46, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(integ.color, 0.16), borderWidth: 1, borderColor: tint(integ.color, 0.45) }}>
              <IntegIcon color={integ.color} size={24} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[Type.h2, { color: Colors.textPrimary, textAlign: 'right' }]}>{integ.label}</Text>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>{integ.hint}</Text>
              <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>سجلات متسلسلة محمية بتوقيعات HMAC-SHA256</Text>
            </View>
          </View>
          <View style={{ marginTop: 12 }}>
            <Btn label={verifying ? 'جارٍ التحقق...' : 'التحقق من سلامة سلسلة السجلات'} icon={ShieldCheck} onPress={verify} loading={verifying} />
          </View>
          <View style={{ flexDirection: ROW, gap: 10, marginTop: 10 }}>
            <Btn variant="ghost" icon={FileCheck2} label="تقرير التحقق" onPress={() => router.push('/audit-report' as never)} style={{ flex: 1, height: 44 }} />
            <Btn variant="ghost" icon={RefreshCcw} label="حالة المزامنة" onPress={() => router.push('/audit-sync' as never)} style={{ flex: 1, height: 44 }} />
          </View>
        </Card>
      </View>
      <SearchField value={query} onChangeText={setQuery} placeholder="ابحث بالمستخدم أو العملية أو المعرف..." />
      <View style={{ flexDirection: ROW, alignItems: 'center', gap: 10, paddingHorizontal: 18 }}>
        <Btn variant="ghost" icon={SlidersHorizontal} label={showFilters ? 'إخفاء فلاتر التاريخ' : 'فلاتر التاريخ'} onPress={() => setShowFilters((v) => !v)} style={{ flex: 1, height: 42 }} />
        <Btn label="تطبيق" onPress={apply} loading={loading && rows.length > 0} style={{ height: 42, paddingHorizontal: 26 }} />
      </View>
      {showFilters ? (
        <View style={{ flexDirection: ROW, gap: 10, paddingHorizontal: 18 }}>
          <View style={{ flex: 1 }}><Field label="من تاريخ (سنة-شهر-يوم)" value={fromText} onChangeText={setFromText} placeholder="2025-01-31" style={{ textAlign: 'center' }} /></View>
          <View style={{ flex: 1 }}><Field label="إلى تاريخ (سنة-شهر-يوم)" value={toText} onChangeText={setToText} placeholder="2025-12-31" style={{ textAlign: 'center' }} /></View>
        </View>
      ) : null}
      <FilterChips options={chips} value={severity} onChange={setSeverity} />
    </View>
  );

  return (
    <Screen>
      <PageHeader title="سجل التدقيق" subtitle="مراقبة أمنية للعمليات المحمية" icon={ShieldCheck} color={Palette.green}
        actions={<IconBtn icon={RefreshCw} label="تحديث السجل" color={Palette.cyan} onPress={apply} />} />
      {loading && rows.length === 0 ? (
        <><View style={{ height: 6 }} /><ListSkeleton count={3} /></>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.operation_id}
          renderItem={renderItem}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 40, flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={8}
          windowSize={7}
          ListEmptyComponent={<EmptyState icon={ShieldCheck} color={Palette.green} title="لا توجد عمليات تدقيق مطابقة" hint="لا توجد بيانات متاحة حالياً ضمن هذا الفلتر." />}
          ListFooterComponent={more && rows.length > 0 ? (
            <View style={{ paddingHorizontal: 18, paddingTop: 4 }}>
              <Btn variant="ghost" label={loading ? 'جارٍ التحميل...' : 'تحميل المزيد'} onPress={() => void load(false)} loading={loading} />
            </View>
          ) : undefined}
        />
      )}

      <Sheet visible={!!detail} onClose={() => setDetail(null)} title="تفاصيل عملية التدقيق" subtitle={detail ? operationLabel(detail.operation_type) : undefined}>
        {detail ? (
          <View style={{ gap: 12 }}>
            <Card>
              {[
                ['رقم العملية', detail.operation_id],
                ['المستخدم', detail.username || 'النظام'],
                ['العملية', operationLabel(detail.operation_type)],
                ['نوع السجل', entityLabel(detail.entity_type)],
                ['معرف السجل', detail.entity_id || 'غير متوفر'],
                ['التاريخ', new Date(detail.created_at).toLocaleString('ar-YE')],
                ['تسلسل السجل', String(detail.sequence_no)],
                ['إصدار الحماية', String(detail.hmac_version)],
              ].map(([k, v]) => (
                <View key={k} style={{ flexDirection: ROW, justifyContent: 'space-between', gap: 12, paddingVertical: 4 }}>
                  <Text style={[Type.caption, { color: Colors.textMuted }]}>{k}</Text>
                  <Text style={[Type.body, { color: Colors.textPrimary, flexShrink: 1, textAlign: 'left' }]} selectable>{v}</Text>
                </View>
              ))}
            </Card>
            {detail.previous_values || detail.new_values ? (
              <Card>
                <CompareRow label="محتوى السجل" from={detail.previous_values ? readable(detail.previous_values).slice(0, 700) : null} to={detail.new_values ? readable(detail.new_values).slice(0, 700) : null} />
              </Card>
            ) : null}
            {detail.correction_reason ? (
              <Card accent={Palette.gold}>
                <Text style={[Type.caption, { color: Palette.gold, textAlign: 'right' }]}>سبب التصحيح</Text>
                <Text style={[Type.bodyLg, { color: Colors.textPrimary, textAlign: 'right' }]}>{detail.correction_reason}</Text>
              </Card>
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
