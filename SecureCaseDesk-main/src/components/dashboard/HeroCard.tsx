// SECURECASEDESK_UI_V2 — بطاقة الترحيب: درع وقفل بتدرج وحلقات (SVG)، بلا صور خارجية.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Path, Rect, Defs, LinearGradient, Stop } from 'react-native-svg';
import { Lock, Database, FileCheck2 } from 'lucide-react-native';
import { Colors, Palette, Type, tint } from '@/constants/theme';
import { ROW } from '@/constants/rtl';
import { GradientFill } from '@/components/ui/Gradient';

function ShieldArt() {
  return (
    <Svg width={116} height={116} viewBox="0 0 116 116">
      <Defs>
        <LinearGradient id="shA" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={Palette.cyan} stopOpacity={0.95} />
          <Stop offset="1" stopColor={Palette.blue} stopOpacity={0.95} />
        </LinearGradient>
      </Defs>
      <Circle cx={58} cy={58} r={54} stroke={tint(Palette.cyan, 0.18)} strokeWidth={1} fill="none" />
      <Circle cx={58} cy={58} r={42} stroke={tint(Palette.blue, 0.3)} strokeWidth={1} strokeDasharray="3 5" fill="none" />
      <Path d="M58 18 L88 30 V56 C88 76 74 90 58 98 C42 90 28 76 28 56 V30 Z" fill="url(#shA)" fillOpacity={0.18} stroke="url(#shA)" strokeWidth={2} />
      <Rect x={47} y={52} width={22} height={18} rx={4} fill="url(#shA)" />
      <Path d="M51 52 V47 C51 42 54 39 58 39 C62 39 65 42 65 47 V52" stroke="url(#shA)" strokeWidth={3} fill="none" strokeLinecap="round" />
      <Circle cx={58} cy={61} r={2.5} fill={Palette.bg0} />
    </Svg>
  );
}

function Chip({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <View style={s.chip}><Icon color={Palette.cyan} size={13} /><Text style={[Type.caption, { color: Colors.textSecondary }]}>{text}</Text></View>
  );
}

export const HeroCard = React.memo(function HeroCard({ name }: { name: string }) {
  return (
    <View style={s.card}>
      <GradientFill colors={['#13224A', '#0D1633', '#0A1128']} glow={{ color: Palette.blue, opacity: 0.4, cx: '12%', cy: '30%', r: '65%' }} />
      <View style={{ flexDirection: ROW, alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={[Type.caption, { color: Palette.cyan, textAlign: 'right' }]}>مرحباً بك في النظام</Text>
          <Text style={[Type.h1, { color: Colors.textPrimary, textAlign: 'right' }]} numberOfLines={1}>{name}</Text>
          <Text style={[Type.body, { color: Colors.textSecondary, textAlign: 'right', marginTop: 2 }]}>إدارة آمنة • بيانات محمية • تقارير دقيقة</Text>
          <View style={s.chips}>
            <Chip icon={Lock} text="قاعدة مشفّرة" />
            <Chip icon={FileCheck2} text="سجل تدقيق محمي" />
            <Chip icon={Database} text="تخزين محلي" />
          </View>
        </View>
        <ShieldArt />
      </View>
    </View>
  );
});

const s = StyleSheet.create({
  card: { borderRadius: 26, padding: 18, overflow: 'hidden', borderWidth: 1, borderColor: Palette.glassBorder },
  chips: { flexDirection: ROW, flexWrap: 'wrap', gap: 6, marginTop: 12 },
  chip: { flexDirection: ROW, alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: 'rgba(34,211,238,0.08)', borderWidth: 1, borderColor: 'rgba(34,211,238,0.22)' },
});
