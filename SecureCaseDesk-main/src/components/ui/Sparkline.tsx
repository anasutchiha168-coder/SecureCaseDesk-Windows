// SECURECASEDESK_UI_V2 — رسم مصغّر (خط + تعبئة) من بيانات حقيقية فقط.
import React, { useId } from 'react';
import Svg, { Defs, LinearGradient, Stop, Path, Circle } from 'react-native-svg';

export const Sparkline = React.memo(function Sparkline({ data, color, width = 120, height = 36 }: { data: number[]; color: string; width?: number; height?: number }) {
  const gid = 'sp' + useId().replace(/[^A-Za-z0-9]/g, '');
  const n = data.length;
  if (n < 2) return null;
  const max = Math.max(...data, 1), pad = 4;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (n - 1);
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);
  let d = 'M ' + x(0) + ' ' + y(data[0]);
  for (let i = 1; i < n; i++) {
    const cx = (x(i - 1) + x(i)) / 2;
    d += ' C ' + cx + ' ' + y(data[i - 1]) + ', ' + cx + ' ' + y(data[i]) + ', ' + x(i) + ' ' + y(data[i]);
  }
  const area = d + ' L ' + x(n - 1) + ' ' + height + ' L ' + x(0) + ' ' + height + ' Z';
  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={0.35} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={area} fill={'url(#' + gid + ')'} />
      <Path d={d} stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" />
      <Circle cx={x(n - 1)} cy={y(data[n - 1])} r={3} fill={color} />
    </Svg>
  );
});
