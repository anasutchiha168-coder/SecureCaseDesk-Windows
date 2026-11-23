// SECURECASEDESK_UI_V2 — هيكل تحميل بنبض خفيف (opacity فقط، native driver).
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, type ViewStyle, type StyleProp } from 'react-native';
import { Palette } from '@/constants/theme';

export function Skeleton({ width = '100%', height = 16, radius = 10, style }: { width?: number | `${number}%`; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const o = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(o, { toValue: 0.9, duration: 800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(o, { toValue: 0.45, duration: 800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [o]);
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: Palette.surfaceHi, opacity: o }, style]} />;
}

export function SkeletonStatCard() {
  return (
    <View style={{ width: '48.5%', backgroundColor: Palette.surface, borderRadius: 22, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: Palette.glassBorder }}>
      <Skeleton width={40} height={40} radius={13} />
      <Skeleton width={70} height={30} style={{ marginTop: 14 }} />
      <Skeleton width="60%" height={12} style={{ marginTop: 10 }} />
      <Skeleton width="100%" height={30} style={{ marginTop: 14 }} />
    </View>
  );
}
