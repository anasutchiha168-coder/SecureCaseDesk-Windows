// SECURECASEDESK_UI_V2 — حركات خفيفة (Animated الأصلي بـ native driver حيث أمكن).
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, type StyleProp, type ViewStyle, type TextStyle, type PressableProps } from 'react-native';

export function FadeIn({ delay = 0, children, style }: { delay?: number; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.timing(v, { toValue: 1, duration: 520, delay, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [v, delay]);
  return (
    <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

interface PSProps extends Omit<PressableProps, 'style'> { style?: StyleProp<ViewStyle>; children: React.ReactNode }
export function PressableScale({ style, children, ...rest }: PSProps) {
  const s = useRef(new Animated.Value(1)).current;
  const to = (x: number) => Animated.spring(s, { toValue: x, useNativeDriver: true, speed: 28, bounciness: 0 }).start();
  return (
    <Pressable {...rest} onPressIn={(e) => { to(0.975); rest.onPressIn?.(e); }} onPressOut={(e) => { to(1); rest.onPressOut?.(e); }}>
      <Animated.View style={[style, { transform: [{ scale: s }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

// عدّاد تصاعدي للأرقام. يحدّث النص عبر مستمع (لا يعيد رسم الشجرة كلها).
export function AnimatedNumber({ value, style, duration = 700 }: { value: number; style?: StyleProp<TextStyle>; duration?: number }) {
  const v = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = v.addListener(({ value: x }) => setShown(Math.round(x)));
    const a = Animated.timing(v, { toValue: value, duration, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    a.start();
    return () => { a.stop(); v.removeListener(id); };
  }, [value, duration, v]);
  return <Text style={style}>{shown}</Text>;
}

// SECURECASEDESK_SMOOTH_UI
