// SECURECASEDESK_UI_V3_REPORTS — رسوم بيانية خفيفة (أعمدة + حلقة) من بيانات حقيقية فقط.
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
