// SECURECASEDESK_UI_V2 — خلفية متدرجة بـ react-native-svg (لا اعتماديات جديدة).
import React, { useId } from 'react';
import { StyleSheet, View, type ViewStyle, type StyleProp } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Stop, Rect } from 'react-native-svg';

interface Props {
  colors: [string, string, ...string[]];
  glow?: { color: string; opacity?: number; cx?: string; cy?: string; r?: string };
  style?: StyleProp<ViewStyle>;
}

export const GradientFill = React.memo(function GradientFill({ colors, glow, style }: Props) {
  const raw = useId().replace(/[^A-Za-z0-9]/g, '');
  const lg = 'lg' + raw, rg = 'rg' + raw;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={lg} x1="0" y1="0" x2="1" y2="1">
            {colors.map((c, i) => <Stop key={i} offset={String(i / (colors.length - 1))} stopColor={c} />)}
          </LinearGradient>
          {glow ? (
            <RadialGradient id={rg} cx={glow.cx ?? '85%'} cy={glow.cy ?? '0%'} r={glow.r ?? '70%'}>
              <Stop offset="0" stopColor={glow.color} stopOpacity={glow.opacity ?? 0.35} />
              <Stop offset="1" stopColor={glow.color} stopOpacity={0} />
            </RadialGradient>
          ) : null}
        </Defs>
        <Rect width="100%" height="100%" fill={'url(#' + lg + ')'} />
        {glow ? <Rect width="100%" height="100%" fill={'url(#' + rg + ')'} /> : null}
      </Svg>
    </View>
  );
});
