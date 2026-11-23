import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { StatusBar, I18nManager, View, ActivityIndicator, Text, DevSettings } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates'; // SECURECASEDESK_FIX_L1_G1_G2
import { Cairo_300Light, Cairo_400Regular, Cairo_500Medium, Cairo_600SemiBold, Cairo_700Bold, Cairo_800ExtraBold, useFonts } from '@expo-google-fonts/cairo';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '@/modules/backup/startup-recovery'; // SECURECASEDESK_PHASE10_S8
import { AuthProvider } from '@/context/AuthContext';
import { AppLockScreen } from '@/components/security/AppLockScreen'; // SECURECASEDESK_BIOMETRIC
import { AuditRuntime } from '@/modules/audit/AuditRuntime'; // SECTION3
import { Colors } from '@/constants/theme';

// forceRTL لا يسري إلا بعد إعادة تشغيل الجافاسكربت. نلتقط الحالة قبل تغييرها.
const RTL_PENDING_AT_START = !I18nManager.isRTL;
const RTL_RELOAD_FLAG = 'scd_rtl_reload_attempted';
if (RTL_PENDING_AT_START) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Cairo_300Light, Cairo_400Regular, Cairo_500Medium, Cairo_600SemiBold, Cairo_700Bold, Cairo_800ExtraBold,
  });
  const [rtlRestartNeeded, setRtlRestartNeeded] = useState(false);

  useEffect(() => {
    if (!RTL_PENDING_AT_START) {
      SecureStore.deleteItemAsync(RTL_RELOAD_FLAG).catch(() => {});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // علامة تمنع حلقة إعادة تحميل لا تنتهي إن لم يسرِ forceRTL.
        if (await SecureStore.getItemAsync(RTL_RELOAD_FLAG)) { if (!cancelled) setRtlRestartNeeded(true); return; }
        await SecureStore.setItemAsync(RTL_RELOAD_FLAG, '1');
      } catch { if (!cancelled) setRtlRestartNeeded(true); return; }
      try { await Updates.reloadAsync(); return; } catch { /* ننتقل للبديل */ }
      try { DevSettings.reload(); } catch { /* ننتقل للإشعار */ }
      setTimeout(() => { if (!cancelled) setRtlRestartNeeded(true); }, 1500);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.background, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  if (rtlRestartNeeded) {
    // لا نترك الواجهة تعمل باتجاه خاطئ بصمت: يلزم إغلاق التطبيق وفتحه مرة واحدة.
    return (
      <View style={{ flex: 1, backgroundColor: Colors.background, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <Text style={{ color: '#fff', fontFamily: 'Cairo_700Bold', fontSize: 18, textAlign: 'center', marginBottom: 8 }}>
          يلزم إعادة تشغيل التطبيق
        </Text>
        <Text style={{ color: '#9AA4B2', fontFamily: 'Cairo_400Regular', fontSize: 14, textAlign: 'center' }}>
          لتفعيل اتجاه الواجهة من اليمين إلى اليسار، أغلق التطبيق تماماً ثم افتحه من جديد.
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar barStyle="light-content" />
        <AuditRuntime />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background }, animation: 'fade_from_bottom', animationDuration: 260, gestureEnabled: true }}>
          <Stack.Screen name="index" options={{ animation: 'fade', animationDuration: 320 }} />
          <Stack.Screen name="setup" options={{ animation: 'fade', animationDuration: 320 }} />
          <Stack.Screen name="(tabs)" options={{ animation: 'fade', animationDuration: 320 }} />
        </Stack>
        <AppLockScreen />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

// SECURECASEDESK_SMOOTH_UI
