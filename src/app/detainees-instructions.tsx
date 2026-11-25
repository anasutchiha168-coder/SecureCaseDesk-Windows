// SECURECASEDESK_DETAINEES_V22_S9 - شاشة التعليمات والمواد القانونية (من ورقة «تعليمات وقوانين» في ملف Excel).
import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { BookOpen, ArrowLeft } from 'lucide-react-native';
import { Colors, Palette, Type } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Screen, PageHeader, IconBtn, Card, SearchField, FilterChips, type ChipOpt } from '@/components/ui/Kit';
import { EmptyState } from '@/components/ui/States';
import { LEGAL_ARTICLES, DATA_GUIDELINES, type InstructionItem } from '@/modules/detainees/detainees-instructions';

type Tab = 'articles' | 'guidelines';

const nz = (s: string) => s.replace(/[\u064B-\u065F\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');

export default function DetaineesInstructionsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'detainees.view');
  const [tab, setTab] = useState<Tab>('articles');
  const [q, setQ] = useState('');

  const chips: ChipOpt<Tab>[] = [
    { key: 'articles', label: 'المواد القانونية', count: LEGAL_ARTICLES.length },
    { key: 'guidelines', label: 'تعليمات إدخال البيانات', count: DATA_GUIDELINES.length },
  ];

  const items = useMemo<InstructionItem[]>(() => {
    const src = tab === 'articles' ? LEGAL_ARTICLES : DATA_GUIDELINES;
    const needle = nz(q.trim());
    return needle ? src.filter((i) => nz(i.text).includes(needle)) : [...src];
  }, [tab, q]);

  return (
    <Screen>
      <PageHeader title="التعليمات والمواد القانونية" subtitle="أحكام الحبس والإيداع وتعليمات تسجيل المحتجزين"
        icon={BookOpen} color={Palette.gold}
        actions={<IconBtn icon={ArrowLeft} label="رجوع" onPress={() => router.back()} />} />
      {!allowed ? (
        <EmptyState title="غير مصرح" hint="ليست لديك صلاحية عرض هذه الشاشة." />
      ) : (
        <>
          <SearchField value={q} onChangeText={setQ} placeholder="ابحث في النصوص..." />
          <View style={{ height: 10 }} />
          <FilterChips options={chips} value={tab} onChange={setTab} />
          <View style={{ height: 12 }} />
          <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 48, gap: 10 }}>
            {items.length === 0 ? <EmptyState compact title="لا نتائج" hint="لا يوجد نص يطابق البحث." /> : null}
            {items.map((i) => (
              <Card key={tab + i.no} accent={tab === 'articles' ? Palette.gold : Palette.cyan}>
                <Text style={[Type.caption, { color: tab === 'articles' ? Palette.gold : Palette.cyan, textAlign: 'right' }]}>
                  {tab === 'articles' ? 'مادة رقم ' : 'تعليمة رقم '}{i.no}
                </Text>
                <Text style={[Type.body, { color: Colors.textPrimary, textAlign: 'right', marginTop: 6 }]}>{i.text}</Text>
              </Card>
            ))}
          </ScrollView>
        </>
      )}
    </Screen>
  );
}
