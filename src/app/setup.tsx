import { useState, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView } from 'react-native';
import { useRouter } from 'expo-router';
import { ShieldCheck, User, Lock } from 'lucide-react-native';
import { Colors, Spacing, Radius, Fonts, FontSizes, Shadows } from '@/constants/theme';
import { initDatabase, getDb } from '@/database/db';
import * as Crypto from 'expo-crypto';
import { useAuth } from '@/context/AuthContext';

export default function SetupScreen() {
  const router = useRouter();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<{ focus: () => void } | null>(null);

  const handleSetup = async () => {
    if (!username || !password) { Alert.alert('خطأ', 'يرجى إدخال اسم المستخدم وكلمة المرور'); return; }
    setLoading(true);
    try {
      await initDatabase();
      const db = await getDb();
      const existingUser = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM users');
      if (existingUser && existingUser.count > 0) { router.replace('/'); return; }
      const passwordHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, password);
      const userId = Crypto.randomUUID();
      await db.runAsync('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)', [userId, username, passwordHash, 'Admin', Date.now()]);
      const res = await login(username, password);
      if (!res.success) { Alert.alert('خطأ', res.error || 'تم إنشاء الحساب لكن تعذر تسجيل الدخول.'); return; }
      router.replace('/(tabs)');
    } catch (error) { console.error(error); Alert.alert('خطأ', 'حدث خطأ أثناء إعداد النظام.'); } finally { setLoading(false); }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
    <View style={styles.container}>
      <View style={styles.header}>
        <ShieldCheck color={Colors.primaryLight} size={64} strokeWidth={1.5} />
        <Text style={styles.title}>الإعداد الأولي</Text>
        <Text style={styles.subtitle}>يرجى إنشاء حساب المدير الرئيسي للنظام</Text>
      </View>
      <View style={styles.form}>
        <Text style={styles.label}>اسم المستخدم (Admin)</Text>
        <View style={styles.inputWrapper}>
          <User color={Colors.textSecondary} size={20} style={{ marginLeft: Spacing.sm }} />
          <TextInput style={styles.input} value={username} onChangeText={setUsername} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => passwordRef.current?.focus()} placeholder="أدخل اسم المستخدم" placeholderTextColor={Colors.textMuted} textAlign="right" autoCapitalize="none" />
        </View>
        <Text style={styles.label}>كلمة المرور</Text>
        <View style={styles.inputWrapper}>
          <Lock color={Colors.textSecondary} size={20} style={{ marginLeft: Spacing.sm }} />
          <TextInput ref={(r) => { passwordRef.current = r; }} style={styles.input} value={password} onChangeText={setPassword} placeholder="أدخل كلمة مرور قوية" placeholderTextColor={Colors.textMuted} secureTextEntry textAlign="right" />
        </View>
        <TouchableOpacity style={styles.button} onPress={handleSetup} disabled={loading}>
          {loading ? <ActivityIndicator color={Colors.textOnPrimary} /> : <Text style={styles.buttonText}>إنشاء الحساب والبدء</Text>}
        </TouchableOpacity>
      </View>
    </View>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background, padding: Spacing.xl, justifyContent: 'center' },
  header: { alignItems: 'center', marginBottom: Spacing.xxl }, title: { fontFamily: Fonts.bold, fontSize: FontSizes.xxl, color: Colors.textPrimary, marginTop: Spacing.lg },
  subtitle: { fontFamily: Fonts.regular, fontSize: FontSizes.md, color: Colors.textSecondary, marginTop: Spacing.sm, textAlign: 'center' },
  form: { backgroundColor: Colors.card, padding: Spacing.xl, borderRadius: Radius.xl, borderWidth: 1, borderColor: Colors.border, ...Shadows.card },
  label: { fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, color: Colors.textPrimary, marginBottom: Spacing.sm, textAlign: 'right' },
  inputWrapper: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.secondary, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md, marginBottom: Spacing.lg, height: 52 },
  input: { flex: 1, height: '100%', fontFamily: Fonts.regular, fontSize: FontSizes.md, color: Colors.textPrimary, paddingHorizontal: Spacing.sm },
  button: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: Spacing.lg, alignItems: 'center', marginTop: Spacing.sm, ...Shadows.primary },
  buttonText: { fontFamily: Fonts.bold, fontSize: FontSizes.lg, color: Colors.textOnPrimary },
});

// SECURECASEDESK_KEYBOARD_FIX
