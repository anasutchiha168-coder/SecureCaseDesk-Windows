// SECURECASEDESK_DETAINEES_V22_S9 - شاشة استيراد ملف معلومية السجناء (xlsx): اختيار الملف ← تجربة جافة ← تأكيد ← كتابة.
import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { FileSpreadsheet, ArrowLeft, FolderOpen, Check, AlertTriangle } from 'lucide-react-native';
import { Colors, Palette, Type } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import type { Session } from '@/security/guard';
import { Screen, PageHeader, IconBtn, Card, Btn, SectionTitle } from '@/components/ui/Kit';
import { EmptyState } from '@/components/ui/States';
import { planImport, type ImportPlan, type RunResult } from '@/modules/detainees/excel-import';
import { readXlsxBytes } from '@/modules/detainees/xlsx-zip';
import { importDetaineesPlan } from '@/services/detainees-actions.service';

type Stage = 'idle' | 'reading' | 'ready' | 'running' | 'done';

function StatRow({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <View style={{ flexDirection: ROW, justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 }}>
      <Text style={[Type.body, { color: Colors.textMuted }]}>{label}</Text>
      <Text style={[Type.bodyLg, { color: color ?? Colors.textPrimary }]}>{String(value)}</Text>
    </View>
  );
}

function errorText(e: unknown): string {
  const msg = String((e as Error)?.message ?? '');
  if (msg.includes('XLSX_INVALID') || msg.includes('XLSX_NO_SHEET')) return 'الملف ليس ملف إكسل صالحاً (xlsx)';
  if (msg.includes('FORBIDDEN')) return 'ليست لديك صلاحية الاستيراد';
  if (msg.includes('IMPORT_ALREADY_DONE')) return 'تم استيراد ملف سابقاً في هذا الجهاز، ولا يُسمح بتكرار الاستيراد';
  if (msg.includes('IMPORT_REFERENCE_COLLISION')) return 'بعض الأرقام المرجعية موجودة مسبقاً في قاعدة البيانات، لم يُكتب شيء';
  if (msg.includes('IMPORT_EMPTY')) return 'لا توجد سجلات صالحة للاستيراد في الملف';
  return 'تعذر إكمال العملية ولم تُكتب أي بيانات';
}

export default function DetaineesImportScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'detainees.manage');
  const session = useMemo<Session | null>(() => (user ? { userId: user.id, role: user.role } : null), [user?.id, user?.role]);

  const [stage, setStage] = useState<Stage>('idle');
  const [fileName, setFileName] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState('');

  const pick = async () => {
    setError('');
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
      if (res.canceled || !res.assets || res.assets.length === 0) return;
      const a = res.assets[0];
      setFileName(a.name ?? '');
      setStage('reading');
      await new Promise((r) => setTimeout(r, 60)); // يترك الواجهة ترسم حالة «جارٍ القراءة»
      const bytes = await new File(a.uri).bytes();
      const rows = readXlsxBytes(bytes);
      const p = planImport(rows);
      setPlan(p);
      setStage('ready');
    } catch (e) {
      console.error('[DetaineesImport] read error:', e);
      setError(errorText(e));
      setStage('idle');
    }
  };

  const run = async () => {
    if (!plan || !session) return;
    setStage('running');
    setError('');
    try {
      const r = await importDetaineesPlan(session, plan);
      setResult(r);
      setStage('done');
    } catch (e) {
      console.error('[DetaineesImport] run error:', e);
      setError(errorText(e));
      setStage('ready');
    }
  };

  const confirm = () => {
    if (!plan) return;
    Alert.alert(
      'تأكيد الاستيراد',
      'سيُكتب ' + plan.summary.imported + ' سجلاً (أشخاص وفترات احتجاز وحركات) في عملية واحدة، ولا يمكن تكرارها لاحقاً. يُنصح بأخذ نسخة احتياطية أولاً. هل تريد المتابعة؟',
      [{ text: 'إلغاء', style: 'cancel' }, { text: 'استيراد', onPress: () => { void run(); } }]
    );
  };

  const reset = () => { setPlan(null); setResult(null); setError(''); setFileName(''); setStage('idle'); };
  const s = plan?.summary;

  return (
    <Screen>
      <PageHeader title="استيراد معلومية السجناء" subtitle="من ملف إكسل بصيغة xlsx" icon={FileSpreadsheet} color={Palette.gold}
        actions={<IconBtn icon={ArrowLeft} label="رجوع" onPress={() => router.back()} />} />
      {!allowed ? (
        <EmptyState title="غير مصرح" hint="الاستيراد متاح لمن يملك صلاحية إدارة المحتجزين فقط." />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 56, gap: 12 }}>
          {error ? (
            <Card accent={Palette.red}>
              <View style={{ flexDirection: ROW, alignItems: 'center', gap: 8 }}>
                <AlertTriangle color={Palette.red} size={18} />
                <Text style={[Type.body, { color: Palette.red, flex: 1, textAlign: 'right' }]}>{error}</Text>
              </View>
            </Card>
          ) : null}

          {stage === 'idle' ? (
            <>
              <Card>
                <Text style={[Type.body, { color: Colors.textPrimary, textAlign: 'right' }]}>
                  اختر ملف معلومية البحث الجنائي. تُقرأ الورقة الأولى فقط، وتظهر لك نتيجة فحص أولي قبل كتابة أي شيء. لا يُدمج شخصان بتشابه الأسماء، وتُسجَّل التنبيهات في ملاحظات السجل.
                </Text>
              </Card>
              <Btn label="اختيار ملف" icon={FolderOpen} onPress={() => { void pick(); }} />
            </>
          ) : null}

          {stage === 'reading' || stage === 'running' ? (
            <Card>
              <View style={{ alignItems: 'center', gap: 12, paddingVertical: 12 }}>
                <ActivityIndicator size="large" color={Palette.cyan} />
                <Text style={[Type.bodyLg, { color: Colors.textPrimary, textAlign: 'center' }]}>
                  {stage === 'reading' ? 'جارٍ قراءة الملف وفحصه...' : 'جارٍ الاستيراد، قد يستغرق دقائق. لا تغلق التطبيق.'}
                </Text>
                {fileName ? <Text style={[Type.caption, { color: Colors.textMuted }]}>{fileName}</Text> : null}
              </View>
            </Card>
          ) : null}

          {stage === 'ready' && s ? (
            <>
              <SectionTitle title="نتيجة الفحص الأولي" top={0} hint={fileName} />
              <Card>
                <StatRow label="صفوف الملف" value={s.total} />
                <StatRow label="سيُستورد" value={s.imported} color={Palette.green} />
                <StatRow label="لا يزالون محتجزين" value={s.held} />
                <StatRow label="مفرج عنهم أو منقولون" value={s.released} />
                <StatRow label="صفوف متخطاة" value={s.skipped.length} color={s.skipped.length ? Palette.gold : undefined} />
                <StatRow label="أسماء متطابقة (لم تُدمج)" value={s.duplicateNames} color={s.duplicateNames ? Palette.gold : undefined} />
                <StatRow label="تداخل زمني" value={s.overlaps} color={s.overlaps ? Palette.gold : undefined} />
                <StatRow label="أنواع خروج غير مصنفة" value={s.exitUnclassified} />
              </Card>
              {Object.keys(s.byCategory).length ? (
                <Card>
                  <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right', marginBottom: 6 }]}>حسب الفئة</Text>
                  {Object.entries(s.byCategory).map(([k, v]) => <StatRow key={k} label={k} value={v} />)}
                </Card>
              ) : null}
              {s.skipped.length ? (
                <Card accent={Palette.gold}>
                  <Text style={[Type.h3, { color: Colors.textPrimary, textAlign: 'right', marginBottom: 6 }]}>صفوف متخطاة (أول 10)</Text>
                  {s.skipped.slice(0, 10).map((x) => (
                    <Text key={x.excelRow} style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>
                      صف {x.excelRow}: {x.reason}
                    </Text>
                  ))}
                </Card>
              ) : null}
              <Btn label="تأكيد الاستيراد" icon={Check} onPress={confirm} disabled={s.imported === 0} />
              <Btn label="اختيار ملف آخر" variant="ghost" onPress={reset} />
            </>
          ) : null}

          {stage === 'done' && result ? (
            <>
              <Card accent={Palette.green}>
                <Text style={[Type.h2, { color: Palette.green, textAlign: 'right', marginBottom: 8 }]}>تم الاستيراد بنجاح</Text>
                <StatRow label="أشخاص" value={result.persons} />
                <StatRow label="فترات احتجاز" value={result.periods} />
                <StatRow label="حركات" value={result.movements} />
                {result.categoriesCreated.length ? <StatRow label="فئات أُنشئت" value={result.categoriesCreated.join('، ')} /> : null}
              </Card>
              <Btn label="العودة إلى المحتجزين" onPress={() => router.back()} />
            </>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}
