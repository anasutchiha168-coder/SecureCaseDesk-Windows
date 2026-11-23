// SECURECASEDESK_UI_V2 — حالات فارغة وخطأ موحّدة.
import React from 'react';
import { View, Text } from 'react-native';
import { Inbox, AlertOctagon } from 'lucide-react-native';
import { Colors, Palette, Type, tint } from '@/constants/theme';
import { PressableScale } from './Motion';

function Action({ label, onPress, color }: { label: string; onPress: () => void; color: string }) {
  return (
    <PressableScale onPress={onPress} accessibilityRole="button" style={{ marginTop: 14, paddingHorizontal: 22, paddingVertical: 10, borderRadius: 14, backgroundColor: tint(color, 0.16), borderWidth: 1, borderColor: tint(color, 0.5) }}>
      <Text style={[Type.h3, { color }]}>{label}</Text>
    </PressableScale>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, hint, actionLabel, onAction, color = Palette.blue, compact }: {
  icon?: React.ElementType; title: string; hint?: string; actionLabel?: string; onAction?: () => void; color?: string; compact?: boolean;
}) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: compact ? 14 : 32, paddingHorizontal: 20 }}>
      <View style={{ width: compact ? 44 : 64, height: compact ? 44 : 64, borderRadius: 22, backgroundColor: tint(color, 0.12), alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: tint(color, 0.3) }}>
        <Icon color={color} size={compact ? 20 : 28} />
      </View>
      <Text style={[Type.h3, { color: Colors.textPrimary, marginTop: 12, textAlign: 'center' }]}>{title}</Text>
      {hint ? <Text style={[Type.caption, { color: Colors.textMuted, marginTop: 2, textAlign: 'center' }]}>{hint}</Text> : null}
      {actionLabel && onAction ? <Action label={actionLabel} onPress={onAction} color={color} /> : null}
    </View>
  );
}

export function ErrorState({ message = 'حدث خطأ أثناء تحميل البيانات.', onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <View style={{ alignItems: 'center', padding: 24, borderRadius: 22, backgroundColor: tint(Palette.red, 0.07), borderWidth: 1, borderColor: tint(Palette.red, 0.35) }}>
      <AlertOctagon color={Palette.red} size={30} />
      <Text style={[Type.h3, { color: Colors.textPrimary, marginTop: 10, textAlign: 'center' }]}>{message}</Text>
      <Text style={[Type.caption, { color: Colors.textMuted, marginTop: 2, textAlign: 'center' }]}>بياناتك المحفوظة محلياً لم تتأثر. يمكنك المتابعة دون اتصال.</Text>
      {onRetry ? <Action label="إعادة المحاولة" onPress={onRetry} color={Palette.red} /> : null}
    </View>
  );
}
