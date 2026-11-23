// SECURECASEDESK_BIOMETRIC — شاشة قفل تغطي التطبيق كاملاً حتى التحقق بالبصمة.
import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Fingerprint, Lock } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { Colors, Spacing, Radius, Fonts, FontSizes } from '@/constants/theme';

export function AppLockScreen() {
  const { isLocked, user, unlockWithBiometric, logout } = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const autoPrompted = useRef(false);

  const tryUnlock = async () => {
    if (busy) return;
    setError(''); setBusy(true);
    const r = await unlockWithBiometric();
    if (!r.success && !r.cancelled) setError(r.error || 'تعذر فتح القفل');
    setBusy(false);
  };

  // عند ظهور القفل تُعرض نافذة البصمة تلقائياً مرة واحدة.
  useEffect(() => {
    if (isLocked && user) {
      if (!autoPrompted.current) { autoPrompted.current = true; tryUnlock(); }
    } else {
      autoPrompted.current = false;
      setError('');
    }
  }, [isLocked, user]);

  if (!isLocked || !user) return null;

  return (
    <View style={styles.overlay} accessibilityViewIsModal importantForAccessibility="yes">
      <View style={styles.circle}><Lock color={Colors.primaryLight} size={40} strokeWidth={1.8} /></View>
      <Text style={styles.title}>التطبيق مقفل</Text>
      <Text style={styles.sub}>مرحباً {user.username}، تحقق ببصمتك للمتابعة</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity style={styles.btn} onPress={tryUnlock} disabled={busy} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="فتح بالبصمة">
        {busy ? <ActivityIndicator color={Colors.textOnPrimary} /> : <Fingerprint color={Colors.textOnPrimary} size={22} />}
        <Text style={styles.btnText}>فتح بالبصمة</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => { logout(); }} style={styles.link} accessibilityRole="button">
        <Text style={styles.linkText}>تسجيل الخروج واستخدام كلمة المرور</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 9999, elevation: 9999, backgroundColor: Colors.background, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  circle: { width: 88, height: 88, borderRadius: Radius.full, backgroundColor: Colors.card, borderWidth: 2, borderColor: Colors.primary, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.lg },
  title: { fontFamily: Fonts.bold, fontSize: FontSizes.xxl, color: Colors.textPrimary, textAlign: 'center' },
  sub: { fontFamily: Fonts.regular, fontSize: FontSizes.sm, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xs, marginBottom: Spacing.xl },
  error: { fontFamily: Fonts.medium, fontSize: FontSizes.sm, color: Colors.danger, textAlign: 'center', marginBottom: Spacing.md },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: Spacing.md, paddingHorizontal: Spacing.xxl, minWidth: 220 },
  btnText: { fontFamily: Fonts.bold, fontSize: FontSizes.md, color: Colors.textOnPrimary },
  link: { marginTop: Spacing.xl, padding: Spacing.sm },
  linkText: { fontFamily: Fonts.medium, fontSize: FontSizes.sm, color: Colors.textMuted },
});
