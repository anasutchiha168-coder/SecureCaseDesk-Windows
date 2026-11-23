// SECURECASEDESK_UI_V2 — بطاقة إحصائية: أيقونة + رقم متصاعد + نسبة تغير حقيقية + رسم مصغّر + حالة صفر.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react-native';
import { Colors, Palette, Type, tint, Glow } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { GradientFill } from './Gradient';
import { PressableScale, AnimatedNumber } from './Motion';
import { Sparkline } from './Sparkline';

interface Props {
  label: string; value: number; icon: React.ElementType; color: string;
  series?: number[] | null; changePct?: number | null; zeroHint?: string; onPress?: () => void;
}

export const StatCard = React.memo(function StatCard({ label, value, icon: Icon, color, series, changePct, zeroHint, onPress }: Props) {
  const hasSeries = !!series && series.some((x) => x > 0);
  const up = (changePct ?? 0) > 0, down = (changePct ?? 0) < 0;
  const ChIcon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  const chColor = up ? Palette.green : down ? Palette.red : Colors.textMuted;
  return (
    <PressableScale onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={label + ': ' + value}
      style={[s.card, Glow(color)]}>
      <GradientFill colors={[Palette.surfaceHi, Palette.surface]} glow={{ color, opacity: 0.22, cx: '90%', cy: '0%', r: '75%' }} />
      <View style={{ flexDirection: ROW, alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={[s.iconBadge, { backgroundColor: tint(color, 0.16), borderColor: tint(color, 0.4) }]}>
          <Icon color={color} size={20} />
        </View>
        {changePct != null ? (
          <View style={[s.change, { backgroundColor: tint(chColor, 0.12) }]}>
            <ChIcon color={chColor} size={12} />
            <Text style={[Type.caption, { color: chColor, fontFamily: 'Cairo_700Bold' }]}>{Math.abs(changePct)}%</Text>
          </View>
        ) : null}
      </View>
      <AnimatedNumber value={value} style={[Type.stat, { color: Colors.textPrimary, textAlign: 'right', marginTop: 10 }]} />
      <Text style={[Type.body, { color: Colors.textSecondary, textAlign: 'right', marginTop: -4 }]} numberOfLines={1}>{label}</Text>
      <View style={s.chart}>
        {hasSeries ? <Sparkline data={series as number[]} color={color} /> : (
          <Text style={[Type.caption, { color: Colors.textMuted, textAlign: 'right' }]} numberOfLines={1}>
            {value === 0 ? (zeroHint ?? 'لا توجد بيانات حالياً') : 'لا نشاط في آخر 14 يوماً'}
          </Text>
        )}
      </View>
    </PressableScale>
  );
});

const s = StyleSheet.create({
  card: { width: '100%', borderRadius: 22, padding: 16, overflow: 'hidden', borderWidth: 1, borderColor: Palette.glassBorder, backgroundColor: Palette.surface },
  iconBadge: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  change: { flexDirection: ROW, alignItems: 'center', gap: 2, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  chart: { marginTop: 10, minHeight: 36, justifyContent: 'center' },
});
