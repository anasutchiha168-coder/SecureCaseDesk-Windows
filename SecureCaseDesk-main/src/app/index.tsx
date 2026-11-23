import { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Eye, EyeOff, ShieldCheck, Lock, User, Fingerprint } from 'lucide-react-native';
import { Colors, Spacing, Radius, Fonts, FontSizes, Shadows } from '@/constants/theme';
import { Identity } from '@/constants/identity';
import { initDatabase, getDb } from '@/database/db';
import { useAuth, SHOW_LOGIN_DIAGNOSTICS, describeError } from '@/context/AuthContext';

export default function LoginScreen() {
  const router = useRouter();
  const { login, loginWithBiometric, getBiometricState, isAuthenticated, isLoading: authLoading } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const passwordRef = useRef<{ focus: () => void } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [bioReady, setBioReady] = useState(false); // SECURECASEDESK_BIOMETRIC: بصمة متاحة ومفعّلة لحساب على هذا الجهاز

  useEffect(() => {
    if (!authLoading && isAuthenticated) router.replace('/(tabs)');
  }, [isAuthenticated, authLoading]);

  useEffect(() => { checkSetup(); }, []);

  const checkSetup = async () => {
    try {
      await initDatabase();
      const db = await getDb();
      const result = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM users');
      if (!result || result.count === 0) router.replace('/setup');
    } catch (e) {
      console.error(e);
      setError(SHOW_LOGIN_DIAGNOSTICS ? 'تعذر تهيئة قاعدة البيانات: ' + describeError(e) : 'تعذر تهيئة قاعدة البيانات');
    } finally { setLoading(false); }
  };

  useEffect(() => {
    let alive = true;
    getBiometricState().then((st) => { if (alive) setBioReady(st.available && !!st.enrolledUserId); }).catch(() => {});
    return () => { alive = false; };
  }, [getBiometricState]);

  const handleBiometric = async () => {
    setError(''); setLoading(true);
    const r = await loginWithBiometric();
    if (r.success) router.replace('/(tabs)');
    else if (!r.cancelled) setError(r.error || 'تعذر الدخول بالبصمة');
    setLoading(false);
  };

  const handleLogin = async () => {
    if (!username || !password) { setError('يرجى إدخال اسم المستخدم وكلمة المرور'); return; }
    setError(''); setLoading(true);
    const result = await login(username, password);
    if (result.success) router.replace('/(tabs)'); else setError(result.error || 'خطأ');
    setLoading(false);
  };

  if (loading || authLoading) return <View style={{flex:1, backgroundColor: Colors.background, justifyContent:'center'}}><ActivityIndicator color={Colors.primary} /></View>;

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <View style={styles.logoCircle}><ShieldCheck color={Colors.primaryLight} size={48} strokeWidth={1.8} /></View>
            <Text style={styles.ministry}>{Identity.ministry}</Text>
            <Text style={styles.department}>{Identity.department}</Text>
            <Text style={styles.governorate}>{Identity.governorate}</Text>
            <View style={styles.divider} />
            <Text style={styles.appName}>{Identity.appName}</Text>
            <Text style={styles.version}>{Identity.appVersion}</Text>
          </View>
          <View style={styles.card}>
            <Text style={styles.welcome}>تسجيل الدخول</Text>
            <Text style={styles.subtitle}>{Identity.loginSubtitle}</Text>
            {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View> : null}
            <Text style={styles.label}>اسم المستخدم</Text>
            <View style={styles.inputWrapper}>
              <User color={Colors.textSecondary} size={20} style={{ marginLeft: Spacing.sm }} />
              <TextInput style={styles.input} value={username} onChangeText={setUsername} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => passwordRef.current?.focus()} placeholder="أدخل اسم المستخدم" placeholderTextColor={Colors.textMuted} autoCapitalize="none" textAlign="right" />
            </View>
            <Text style={styles.label}>كلمة المرور</Text>
            <View style={styles.inputWrapper}>
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>{showPassword ? <Eye color={Colors.textSecondary} size={20} /> : <EyeOff color={Colors.textSecondary} size={20} />}</TouchableOpacity>
              <Lock color={Colors.textSecondary} size={20} style={{ marginLeft: Spacing.sm }} />
              <TextInput ref={(r) => { passwordRef.current = r; }} style={styles.input} value={password} onChangeText={setPassword} placeholder="أدخل كلمة المرور" placeholderTextColor={Colors.textMuted} secureTextEntry={!showPassword} textAlign="right" />
            </View>
            <TouchableOpacity style={styles.loginBtn} onPress={handleLogin} activeOpacity={0.85}><Text style={styles.loginBtnText}>دخول آمن</Text></TouchableOpacity>
            {bioReady ? (
              <TouchableOpacity style={styles.bioBtn} onPress={handleBiometric} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="الدخول بالبصمة">
                <Fingerprint color={Colors.primaryLight} size={22} />
                <Text style={styles.bioBtnText}>الدخول بالبصمة</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background }, scroll: { flexGrow: 1, justifyContent: 'center', padding: Spacing.xl },
  header: { alignItems: 'center', marginBottom: Spacing.xxl }, logoCircle: { width: 96, height: 96, borderRadius: Radius.full, backgroundColor: Colors.card, borderWidth: 2, borderColor: Colors.primary, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.lg, ...Shadows.primary },
  ministry: { fontFamily: Fonts.bold, fontSize: FontSizes.lg, color: Colors.textPrimary, textAlign: 'center' }, department: { fontFamily: Fonts.semiBold, fontSize: FontSizes.md, color: Colors.textSecondary, marginTop: Spacing.xs, textAlign: 'center' },
  governorate: { fontFamily: Fonts.medium, fontSize: FontSizes.sm, color: Colors.textMuted, marginTop: 2, textAlign: 'center' }, divider: { width: 60, height: 2, backgroundColor: Colors.primary, marginVertical: Spacing.md, borderRadius: 1 },
  appName: { fontFamily: Fonts.extraBold, fontSize: FontSizes.xxl, color: Colors.primaryLight, letterSpacing: 1 }, version: { fontFamily: Fonts.medium, fontSize: FontSizes.xs, color: Colors.textMuted, marginTop: 2 },
  card: { backgroundColor: Colors.card, borderRadius: Radius.xl, padding: Spacing.xl, borderWidth: 1, borderColor: Colors.border, ...Shadows.card },
  welcome: { fontFamily: Fonts.bold, fontSize: FontSizes.xxl, color: Colors.textPrimary, textAlign: 'center' }, subtitle: { fontFamily: Fonts.regular, fontSize: FontSizes.sm, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xs, marginBottom: Spacing.xl },
  errorBox: { backgroundColor: 'rgba(239, 68, 68, 0.15)', borderWidth: 1, borderColor: Colors.danger, borderRadius: Radius.sm, padding: Spacing.md, marginBottom: Spacing.md }, errorText: { fontFamily: Fonts.medium, fontSize: FontSizes.sm, color: Colors.danger, textAlign: 'center' },
  label: { fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, color: Colors.textPrimary, marginBottom: Spacing.sm, textAlign: 'right' }, inputWrapper: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.secondary, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md, marginBottom: Spacing.lg, height: 52 },
  input: { flex: 1, height: '100%', fontFamily: Fonts.regular, fontSize: FontSizes.md, color: Colors.textPrimary, paddingHorizontal: Spacing.sm }, loginBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: Spacing.lg, alignItems: 'center', marginTop: Spacing.sm, ...Shadows.primary },
  bioBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.primary, paddingVertical: Spacing.md, marginTop: Spacing.md },
  bioBtnText: { fontFamily: Fonts.semiBold, fontSize: FontSizes.md, color: Colors.primaryLight },
  loginBtnText: { fontFamily: Fonts.bold, fontSize: FontSizes.lg, color: Colors.textOnPrimary },
});

// SECURECASEDESK_KEYBOARD_FIX
