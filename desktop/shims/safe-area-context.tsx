// Shim لوحدة 'react-native-safe-area-context' على Windows (القسم 3 — إصلاح 2).
// كل شيء يمرّ كما هو من الحزمة الحقيقية، ونلفّ SafeAreaProvider فقط بجذر <View dir="rtl"> كي يقلب react-native-web
// الاتجاه في الشجرة كلها. SafeAreaProvider هو أعلى عنصر في src/app/_layout.tsx (وفي ExpoRoot نفسه)، فوجوده مضمون
// حتى لو لم يمرّ التسجيل عبر AppRegistry.registerComponent. يُستخدم فقط عند platform=web وSCD_TARGET=windows.
import * as React from 'react';
import { View } from 'react-native';
import * as Real from 'react-native-safe-area-context';
import { createRtlRoot } from './rtl-root';

export * from 'react-native-safe-area-context';

const RtlRoot = createRtlRoot(React as any, View);

export function SafeAreaProvider(props: any) {
  return React.createElement(RtlRoot, null, React.createElement((Real as any).SafeAreaProvider, props));
}
