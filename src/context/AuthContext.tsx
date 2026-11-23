// SECURECASEDESK_PHASE9_S2
import React, { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
import { AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { getDb } from '@/database/db';
import { setAuditActor, recordAuditEvent } from '@/services/audit.service';
import { purgeDecryptedCache } from '@/services/attachments.service';
import { decideBiometricLogin, shouldLockAfterBackground, BIOMETRIC_LOCK_TIMEOUT_MS } from '@/security/biometric-policy';
import {
  getBiometricCapability, promptBiometric, isBiometricPromptActive, getEnrolledUserId, setEnrolledUserId, clearEnrolledUserId,
} from '@/security/biometric'; // SECURECASEDESK_BIOMETRIC

export interface AuthUser {
  id: string;
  username: string;
  role: string;
  created_at: string;
  department_id?: string | null;
  is_active?: number;
  last_login?: number | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  // SECURECASEDESK_BIOMETRIC
  isLocked: boolean;
  unlockWithBiometric: () => Promise<{ success: boolean; error?: string; cancelled?: boolean }>;
  getBiometricState: () => Promise<{ available: boolean; reason: string | null; enrolledUserId: string | null }>;
  loginWithBiometric: () => Promise<{ success: boolean; error?: string; cancelled?: boolean }>;
  enableBiometric: () => Promise<{ success: boolean; error?: string }>;
  disableBiometric: () => Promise<void>;
  checkSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const SESSION_USER_ID_KEY = 'securecase_session_uid';

// تشخيص مؤقت: يُظهر مرحلة الفشل ونص الخطأ الحقيقي في شاشة الدخول.
// بعد معرفة السبب وإصلاحه اجعل القيمة false.
export const SHOW_LOGIN_DIAGNOSTICS = true;
export function describeError(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = e && e.code ? String(e.code) + ' - ' : '';
  const msg = e && e.message ? String(e.message) : String(err);
  return (code + msg).slice(0, 180);
}

// محاولات الدخول الفاشلة لا تمسّ أي جدول، لذا لا يلتقطها أي trigger تلقائي؛
// تُسجَّل هنا صراحة. لا تُلقي أبداً: فشل التسجيل لا يجوز أن يمنع ظهور رسالة الخطأ للمستخدم.
async function recordFailedLogin(
  attemptedUsername: string,
  userId: string | null,
  reason: string
): Promise<void> {
  try {
    await recordAuditEvent({
      operationType: 'failed_login',
      entityType: 'session',
      entityId: userId,
      reason,
      actor: { id: userId, username: attemptedUsername || null },
    });
  } catch (e) {
    console.error('[AuthContext] تعذر تسجيل محاولة الدخول الفاشلة:', e);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLocked, setIsLocked] = useState<boolean>(false); // SECURECASEDESK_BIOMETRIC: قفل التطبيق
  const userRef = useRef<AuthUser | null>(null);
  useEffect(() => { userRef.current = user; }, [user]);

  const checkSession = useCallback(async () => {
    try {
      const storedId = await SecureStore.getItemAsync(SESSION_USER_ID_KEY);
      if (!storedId) {
        setUser(null);
        return;
      }
      const db = await getDb();
      const row = await db.getFirstAsync<AuthUser>(
        'SELECT id, username, role, created_at, department_id, is_active, last_login FROM users WHERE id = ?',
        [storedId]
      );
      if (row && Number(row.is_active ?? 1) === 1) {
        setUser(row);
        await setAuditActor({ id: row.id, username: row.username });
        // فتح التطبيق من جديد بعد إغلاقه: إن كانت البصمة مفعّلة لهذا الحساب يبدأ التطبيق مقفلاً.
        if ((await getEnrolledUserId()) === row.id) setIsLocked(true);
      } else {
        await SecureStore.deleteItemAsync(SESSION_USER_ID_KEY);
        setUser(null);
        await setAuditActor(null);
      }
    } catch (err) {
      console.error('[AuthContext] checkSession error:', err);
      setUser(null);
      await setAuditActor(null).catch(() => {});
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // إكمال الدخول بعد نجاح التحقق (كلمة المرور أو البصمة): آخر دخول، الجلسة، سياق التدقيق، حدث الدخول.
  const finishLogin = useCallback(async (
    db: Awaited<ReturnType<typeof getDb>>,
    row: AuthUser & { password_hash?: string },
    method: 'password' | 'biometric',
    onStage: (s: string) => void = () => {}
  ) => {
    const loginAt = Date.now();

    onStage('update_last_login');
    await db.runAsync(
      'UPDATE users SET last_login = ? WHERE id = ?',
      [loginAt, row.id]
    );

    const { password_hash, ...safeUser } = row;
    setUser({ ...safeUser, last_login: loginAt });
    setIsLocked(false);
    onStage('save_session');
    await SecureStore.setItemAsync(SESSION_USER_ID_KEY, safeUser.id);
    onStage('audit_actor');

    // يُضبط سياق المنفّذ أولاً حتى تُنسب عملية "تسجيل الدخول" نفسها إليه،
    // ويُسجَّل الدخول كحدث تدقيق صريح (لا يلتقطه أي trigger لأنه ليس تعديل سجل).
    await setAuditActor({ id: safeUser.id, username: safeUser.username });
    await recordAuditEvent({
      operationType: 'login',
      entityType: 'session',
      entityId: safeUser.id,
      reason: method === 'biometric' ? 'دخول بالبصمة' : null,
      actor: { id: safeUser.id, username: safeUser.username },
    }).catch((e) => console.error('[AuthContext] تعذر تسجيل حدث الدخول في سجل التدقيق:', e));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    let stage = 'open_db';
    try {
      const db = await getDb();
      stage = 'hash';
      const passwordHash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        password
      );
      stage = 'lookup_user';
      const row = await db.getFirstAsync<AuthUser & { password_hash: string }>(
        'SELECT id, username, password_hash, role, created_at, department_id, is_active, last_login FROM users WHERE username = ?',
        [username.trim()]
      );

      if (!row) {
        await recordFailedLogin(username.trim(), null, 'اسم مستخدم غير موجود');
        return { success: false, error: 'اسم المستخدم غير موجود' };
      }

      if (Number(row.is_active ?? 1) !== 1) {
        await recordFailedLogin(row.username, row.id, 'الحساب معطّل');
        return { success: false, error: 'هذا الحساب معطّل، يرجى مراجعة مدير النظام' };
      }

      if (row.password_hash !== passwordHash) {
        await recordFailedLogin(row.username, row.id, 'كلمة مرور غير صحيحة');
        return { success: false, error: 'كلمة المرور غير صحيحة' };
      }

      await finishLogin(db, row, 'password', (st) => { stage = st; });
      return { success: true };
    } catch (err) {
      console.error('[AuthContext] login error at stage ' + stage + ':', err);
      const base = 'حدث خطأ أثناء تسجيل الدخول';
      return {
        success: false,
        error: SHOW_LOGIN_DIAGNOSTICS ? base + ' [' + stage + '] ' + describeError(err) : base,
      };
    }
  }, [finishLogin]);

  const logout = useCallback(async () => {
    try {
      if (user) {
        await recordAuditEvent({
          operationType: 'logout',
          entityType: 'session',
          entityId: user.id,
          actor: { id: user.id, username: user.username },
        }).catch((e) => console.error('[AuthContext] تعذر تسجيل حدث الخروج في سجل التدقيق:', e));
      }
      await SecureStore.deleteItemAsync(SESSION_USER_ID_KEY);
    } catch (err) {
      console.error('[AuthContext] logout error:', err);
    } finally {
      purgeDecryptedCache(); // حذف أي نسخ مفكوكة من المرفقات ومفتاحها من الذاكرة
      setIsLocked(false);
      setUser(null);
      await setAuditActor(null).catch(() => {});
    }
  }, [user]);

  // ───────────── SECURECASEDESK_BIOMETRIC ─────────────
  const getBiometricState = useCallback(async () => {
    const cap = await getBiometricCapability();
    const enrolledUserId = cap.available ? await getEnrolledUserId() : null;
    return { available: cap.available, reason: cap.reason, enrolledUserId };
  }, []);

  const loginWithBiometric = useCallback(async () => {
    try {
      const cap = await getBiometricCapability();
      if (!cap.available) return { success: false, error: cap.reason ?? 'البصمة غير متاحة' };

      const uid = await getEnrolledUserId();
      if (!uid) return { success: false, error: 'لم تُفعَّل البصمة بعد. سجّل الدخول بكلمة المرور ثم فعّلها من الإعدادات' };

      const res = await promptBiometric('تحقق ببصمتك لتسجيل الدخول');
      if (!res.success) {
        if (res.cancelled) return { success: false, cancelled: true };
        await recordFailedLogin('', uid, 'بصمة: فشل التحقق');
        return { success: false, error: 'لم تتطابق البصمة، حاول مرة أخرى أو استخدم كلمة المرور' };
      }

      const db = await getDb();
      const row = await db.getFirstAsync<AuthUser>(
        'SELECT id, username, role, created_at, department_id, is_active, last_login FROM users WHERE id = ?',
        [uid]
      );
      const decision = decideBiometricLogin(row);
      if (!decision.ok) {
        await recordFailedLogin(row?.username ?? '', row?.id ?? uid, decision.auditReason);
        if (!row) await clearEnrolledUserId();
        return { success: false, error: decision.reason };
      }
      await finishLogin(db, row as AuthUser, 'biometric');
      return { success: true };
    } catch (err) {
      console.error('[AuthContext] biometric login error:', err);
      return { success: false, error: SHOW_LOGIN_DIAGNOSTICS ? 'تعذر الدخول بالبصمة: ' + describeError(err) : 'تعذر الدخول بالبصمة' };
    }
  }, [finishLogin]);

  const enableBiometric = useCallback(async () => {
    if (!user) return { success: false, error: 'يجب تسجيل الدخول أولاً' };
    try {
      const cap = await getBiometricCapability();
      if (!cap.available) return { success: false, error: cap.reason ?? 'البصمة غير متاحة' };
      // نطلب بصمة فعلية قبل التفعيل حتى لا يربط أحدٌ يحمل جهازاً مفتوحاً بصمته دون علم صاحب الحساب.
      const res = await promptBiometric('أكّد ببصمتك لتفعيل الدخول بالبصمة');
      if (!res.success) return { success: false, error: res.cancelled ? 'أُلغي التفعيل' : 'لم تتطابق البصمة' };
      await setEnrolledUserId(user.id);
      await recordAuditEvent({
        operationType: 'biometric_enable', entityType: 'session', entityId: user.id,
        actor: { id: user.id, username: user.username },
      }).catch((e) => console.error('[AuthContext] تعذر تسجيل تفعيل البصمة:', e));
      return { success: true };
    } catch (err) {
      console.error('[AuthContext] enableBiometric error:', err);
      return { success: false, error: 'تعذر تفعيل البصمة' };
    }
  }, [user]);

  const disableBiometric = useCallback(async () => {
    await clearEnrolledUserId();
    if (user) {
      await recordAuditEvent({
        operationType: 'biometric_disable', entityType: 'session', entityId: user.id,
        actor: { id: user.id, username: user.username },
      }).catch((e) => console.error('[AuthContext] تعذر تسجيل إيقاف البصمة:', e));
    }
  }, [user]);

  // قفل تلقائي: إذا خرج المستخدم من التطبيق دقيقة أو أكثر ثم عاد، يُقفل ويطلب البصمة.
  useEffect(() => {
    let backgroundedAt: number | null = null;
    const sub = AppState.addEventListener('change', async (state) => {
      if (state === 'background') {
        if (!isBiometricPromptActive()) backgroundedAt = Date.now();
        return;
      }
      if (state !== 'active') return;
      const at = backgroundedAt;
      backgroundedAt = null;
      if (!shouldLockAfterBackground(at, Date.now(), BIOMETRIC_LOCK_TIMEOUT_MS)) return;
      const u = userRef.current;
      if (!u) return;
      if ((await getEnrolledUserId()) === u.id) {
        purgeDecryptedCache(); // لا تبقى مرفقات مفكوكة في الذاكرة أثناء القفل
        setIsLocked(true);
      }
    });
    return () => sub.remove();
  }, []);

  const unlockWithBiometric = useCallback(async () => {
    const u = userRef.current;
    if (!u) return { success: false, error: 'لا توجد جلسة' };
    try {
      const res = await promptBiometric('تحقق ببصمتك لفتح التطبيق');
      if (!res.success) {
        if (res.cancelled) return { success: false, cancelled: true };
        await recordFailedLogin(u.username, u.id, 'بصمة: فشل فتح قفل التطبيق');
        return { success: false, error: 'لم تتطابق البصمة، حاول مرة أخرى' };
      }
      // نتأكد أن الحساب ما زال نشطاً قبل الفتح.
      const db = await getDb();
      const row = await db.getFirstAsync<AuthUser>(
        'SELECT id, username, role, created_at, department_id, is_active, last_login FROM users WHERE id = ?', [u.id]
      );
      if (!decideBiometricLogin(row).ok) {
        await logout();
        return { success: false, error: 'هذا الحساب لم يعد متاحاً' };
      }
      setIsLocked(false);
      await recordAuditEvent({
        operationType: 'biometric_unlock', entityType: 'session', entityId: u.id,
        actor: { id: u.id, username: u.username },
      }).catch((e) => console.error('[AuthContext] تعذر تسجيل فتح القفل:', e));
      return { success: true };
    } catch (err) {
      console.error('[AuthContext] unlock error:', err);
      return { success: false, error: 'تعذر فتح القفل' };
    }
  }, [logout]);

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, isLoading, login, logout, checkSession, isLocked, unlockWithBiometric, getBiometricState, loginWithBiometric, enableBiometric, disableBiometric }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
