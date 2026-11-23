// SECURECASEDESK_UI_V3 — خط زمني موحد (سجل التدقيق، الحركة التاريخية، سجل التعديلات) ومقارنة قبل/بعد.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ArrowDown } from 'lucide-react-native';
import { Colors, Palette, Type, tint } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { Pill } from './Kit';

export interface TimelineItem {
  key: string;
  icon: React.ElementType;
  color: string;
  title: string;
  subtitle?: string;
  time?: string;
  badge?: { label: string; color: string };
  extra?: React.ReactNode;
}

export const Timeline = React.memo(function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <View>
      {items.map((it, i) => {
        const Icon = it.icon;
        const last = i === items.length - 1;
        return (
          <View key={it.key} style={{ flexDirection: ROW, alignItems: 'stretch' }}>
            <View style={{ alignItems: 'center', width: 38 }}>
              <View style={[s.dot, { backgroundColor: tint(it.color, 0.16), borderColor: tint(it.color, 0.5) }]}>
                <Icon color={it.color} size={16} />
              </View>
              {!last ? <View style={[s.line, { backgroundColor: tint(it.color, 0.25) }]} /> : null}
            </View>
            <View style={{ flex: 1, paddingHorizontal: 10, paddingBottom: last ? 0 : 16 }}>
              <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Text style={[Type.h3, { color: Colors.textPrimary, flexShrink: 1, textAlign: 'right' }]} numberOfLines={2}>{it.title}</Text>
                {it.badge ? <Pill label={it.badge.label} color={it.badge.color} /> : null}
              </View>
              {it.subtitle ? <Text style={[Type.caption, { color: Colors.textSecondary, textAlign: 'right' }]}>{it.subtitle}</Text> : null}
              {it.time ? <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]}>{it.time}</Text> : null}
              {it.extra}
            </View>
          </View>
        );
      })}
    </View>
  );
});

// مقارنة بصرية: القيمة السابقة تبقى ظاهرة بالكامل (لا يوحي التصميم بحذفها) ثم القيمة الجديدة.
export const CompareRow = React.memo(function CompareRow({ label, from, to }: { label: string; from: string | null; to: string | null }) {
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right', marginBottom: 4 }]}>{label}</Text>
      <View style={[s.cmp, { borderColor: tint(Palette.gold, 0.35), backgroundColor: tint(Palette.gold, 0.07) }]}>
        <Text style={[Type.caption, { color: Palette.gold, textAlign: 'right' }]}>القيمة السابقة (محفوظة في السجل)</Text>
        <Text style={[Type.body, { color: Colors.textPrimary, textAlign: 'right' }]}>{from ?? '—'}</Text>
      </View>
      <View style={{ alignItems: 'center', marginVertical: 2 }}><ArrowDown color={Palette.cyan} size={16} /></View>
      <View style={[s.cmp, { borderColor: tint(Palette.green, 0.4), backgroundColor: tint(Palette.green, 0.08) }]}>
        <Text style={[Type.caption, { color: Palette.green, textAlign: 'right' }]}>القيمة الجديدة</Text>
        <Text style={[Type.body, { color: Colors.textPrimary, textAlign: 'right' }]}>{to ?? '—'}</Text>
      </View>
    </View>
  );
});

const s = StyleSheet.create({
  dot: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  line: { flex: 1, width: 2, marginTop: 4, borderRadius: 1 },
  cmp: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
});
