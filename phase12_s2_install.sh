#!/usr/bin/env bash
# SecureCaseDesk v2.2 — المرحلة 12 / القسم 12.2: اختبارات الأمان والتكامل + شاشة «فحص الأمان على الجهاز» + قائمة اختبار الجهاز الحقيقي
# التشغيل من جذر المشروع:   bash phase12_s2_install.sh
# يتطلب 12.1 مثبّتاً. آمن لإعادة التشغيل: ينسخ احتياطياً كل ملف موجود يُعدَّل (*.bak_التاريخ) ولا يكرر التعديلات.
# يضيف: 3 ملفات اختبار (صلاحيات / سلامة وHMAC ومشغّلات / تقييم فحص التشفير) • شاشة فحص الأمان (للمدير) + زر في الإعدادات • قائمة D01–D20
# ثم يشغّل test:security و test:all و tsc ويكتب النتائج الفعلية في docs/phase12/12.2-test-results.md
set -euo pipefail

TS="$(date +%Y%m%d_%H%M%S)"
say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

say "فحص المكان والمتطلبات"
[ -f package.json ] && [ -f src/database/db.ts ] && [ -f src/security/permissions.ts ] \
  || die "شغّل السكربت من جذر مشروع SecureCaseDesk."
grep -q '"name": "securecasedesk"' package.json || die "package.json ليس لمشروع securecasedesk."
command -v node >/dev/null 2>&1 || die "Node.js غير متوفر."
[ -f scripts/preflight-build.mjs ] && grep -q 'SECURECASEDESK_PHASE12_S1' scripts/preflight-build.mjs || die "القسم 12.1 غير مثبّت: شغّل phase12_s1_install.sh أولاً."
for f in src/security/audit-verifier-core.ts src/security/audit-crypto.ts src/security/guard.ts "src/app/(tabs)/settings.tsx" tests/helpers/node-env.ts src/modules/audit/audit-integration.ts; do
  [ -f "$f" ] || die "ملف مطلوب مفقود: $f"
done
grep -q "export async function closeDb" src/database/db.ts || die "db.ts لا يحوي closeDb (المرحلة 10 غير مكتملة؟)."
grep -q "export async function inspectDatabaseEncryption" src/database/db.ts || die "db.ts لا يحوي inspectDatabaseEncryption."
grep -q "export function runAuditIntegritySelfTest" src/security/audit-verifier-core.ts || die "audit-verifier-core.ts غير متوافق."
ok "المشروع سليم و12.1 موجود"

write_file() {
  local target="$1" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  mkdir -p "$(dirname "$target")"
  if [ -f "$target" ]; then
    if cmp -s "$tmp" "$target"; then ok "بلا تغيير: $target"; rm -f "$tmp"; return; fi
    cp "$target" "$target.bak_$TS"
    warn "نُسخ احتياطياً: $target.bak_$TS"
  fi
  mv "$tmp" "$target"
  ok "كُتب: $target"
}

say "إنشاء ملفات 12.2"
write_file 'src/modules/diagnostics/security-check.ts' <<'SCD_EOF_P12S2_0'
// SECURECASEDESK_PHASE12_S2
// تقييم صرف (بلا expo ولا قاعدة بيانات) لحقائق تشفير قاعدة البيانات المجمَّعة على الجهاز.
// قابل للاختبار في Node. القاعدة: «لم يُفحص» ليس «نجح» — أي حقيقة مجهولة تُعرض تحذيراً لا نجاحاً.

export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface Check {
  id: string;
  title: string;
  level: CheckLevel;
  detail: string;
}

export interface EncryptionFacts {
  cipherVersion: string | null;      // نتيجة PRAGMA cipher_version (فارغة = SQLCipher غير موجود)
  headerReadable: boolean;           // هل قُرئت أول 16 بايت من ملف القاعدة
  sqliteHeaderDetected: boolean;     // هل ظهرت ترويسة "SQLite format 3" الصريحة (يجب ألا تظهر)
  fileSize: number;
  schemaAccessible: boolean;         // قراءة sqlite_master بالمفتاح الصحيح
  wrongKeyRejected: boolean | null;  // null = لم يُفحص
  reopenOk: boolean | null;          // null = لم يُفحص
}

export interface CheckSummary {
  overall: CheckLevel;
  pass: number;
  warn: number;
  fail: number;
}

export function evaluateEncryptionFacts(f: EncryptionFacts): Check[] {
  const out: Check[] = [];

  out.push(f.cipherVersion
    ? { id: 'cipher', title: 'SQLCipher مفعّل في البناء', level: 'pass', detail: 'الإصدار: ' + f.cipherVersion }
    : { id: 'cipher', title: 'SQLCipher مفعّل في البناء', level: 'fail', detail: 'PRAGMA cipher_version لا تعيد قيمة: البناء يستخدم SQLite عادياً غير مشفّر.' });

  if (!f.headerReadable) {
    out.push({ id: 'header', title: 'ملف القاعدة غير مقروء كنص صريح', level: 'warn',
      detail: 'تعذّرت قراءة الترويسة (حجم الملف ' + f.fileSize + ' بايت)؛ لا يمكن الجزم.' });
  } else if (f.sqliteHeaderDetected) {
    out.push({ id: 'header', title: 'ملف القاعدة غير مقروء كنص صريح', level: 'fail',
      detail: 'ظهرت الترويسة الصريحة "SQLite format 3": الملف غير مشفّر.' });
  } else {
    out.push({ id: 'header', title: 'ملف القاعدة غير مقروء كنص صريح', level: 'pass',
      detail: 'لا توجد ترويسة SQLite صريحة (الحجم ' + f.fileSize + ' بايت).' });
  }

  out.push(f.schemaAccessible
    ? { id: 'schema', title: 'القراءة بالمفتاح الصحيح تنجح', level: 'pass', detail: 'تمت قراءة بنية القاعدة.' }
    : { id: 'schema', title: 'القراءة بالمفتاح الصحيح تنجح', level: 'fail', detail: 'تعذّرت قراءة بنية القاعدة بالمفتاح الحالي.' });

  if (f.wrongKeyRejected === null) {
    out.push({ id: 'wrongkey', title: 'مفتاح خاطئ يُرفض', level: 'warn', detail: 'لم يُنفَّذ هذا الفحص بعد.' });
  } else if (f.wrongKeyRejected) {
    out.push({ id: 'wrongkey', title: 'مفتاح خاطئ يُرفض', level: 'pass', detail: 'فشلت قراءة القاعدة بمفتاح خاطئ كما يجب.' });
  } else {
    out.push({ id: 'wrongkey', title: 'مفتاح خاطئ يُرفض', level: 'fail', detail: 'القاعدة قُرئت بمفتاح خاطئ: التشفير غير فعّال.' });
  }

  if (f.reopenOk === null) {
    out.push({ id: 'reopen', title: 'إعادة فتح القاعدة المشفّرة', level: 'warn', detail: 'لم يُنفَّذ هذا الفحص بعد.' });
  } else if (f.reopenOk) {
    out.push({ id: 'reopen', title: 'إعادة فتح القاعدة المشفّرة', level: 'pass', detail: 'أُغلقت القاعدة وأُعيد فتحها بالمفتاح المخزَّن وقُرئت بنجاح.' });
  } else {
    out.push({ id: 'reopen', title: 'إعادة فتح القاعدة المشفّرة', level: 'fail', detail: 'فشلت إعادة الفتح بالمفتاح المخزَّن.' });
  }

  return out;
}

export function summarizeChecks(checks: readonly Check[]): CheckSummary {
  const count = (l: CheckLevel) => checks.filter((c) => c.level === l).length;
  const fail = count('fail');
  const warn = count('warn');
  return { overall: fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'pass', pass: count('pass'), warn, fail };
}
SCD_EOF_P12S2_0
write_file 'src/modules/diagnostics/security-check-runtime.ts' <<'SCD_EOF_P12S2_1'
// SECURECASEDESK_PHASE12_S2
// جمع حقائق تشفير القاعدة على الجهاز الفعلي (للقراءة فقط؛ لا يكتب سجلات ولا يعرض المفتاح).
import * as SQLite from 'expo-sqlite';
import { closeDb, getDb, inspectDatabaseEncryption } from '@/database/db';
import { runAuditIntegritySelfTest } from '@/security/audit-verifier-core';
import type { EncryptionFacts } from './security-check';

const DB_NAME = 'securecase.db';

// يفتح اتصالاً جديداً بمفتاح خاطئ عمداً؛ النجاح في القراءة = فشل أمني.
export async function probeWrongKeyRejected(): Promise<boolean> {
  let probe: SQLite.SQLiteDatabase | null = null;
  try {
    probe = await SQLite.openDatabaseAsync(DB_NAME, { useNewConnection: true });
    await probe.execAsync("PRAGMA key = 'scd-diagnostic-wrong-key-0000';");
    await probe.getFirstAsync('SELECT COUNT(*) AS c FROM sqlite_master;');
    return false; // قُرئت بمفتاح خاطئ
  } catch {
    return true; // رُفضت كما يجب
  } finally {
    if (probe) { try { await probe.closeAsync(); } catch { /* تجاهل */ } }
  }
}

// يغلق الاتصال الرئيسي ويعيد فتحه بالمفتاح المخزَّن ثم يقرأ جدولاً. لا يُستدعى تلقائياً (بزر صريح).
export async function probeReopen(): Promise<boolean> {
  try {
    await closeDb();
    const db = await getDb();
    const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM users;');
    return row !== null;
  } catch {
    return false;
  }
}

export async function collectEncryptionFacts(opts: { withReopen: boolean }): Promise<EncryptionFacts> {
  let base: Awaited<ReturnType<typeof inspectDatabaseEncryption>> | null = null;
  try { base = await inspectDatabaseEncryption(); } catch { base = null; }
  const wrongKeyRejected = base ? await probeWrongKeyRejected() : null;
  const reopenOk = opts.withReopen ? await probeReopen() : null;
  return {
    cipherVersion: base?.cipherVersion ?? null,
    headerReadable: base?.headerReadable ?? false,
    sqliteHeaderDetected: base?.sqliteHeaderDetected ?? false,
    fileSize: base?.fileSize ?? 0,
    schemaAccessible: base?.schemaAccessible ?? false,
    wrongKeyRejected,
    reopenOk,
  };
}

export function runAuditSelfTestSafe(): { ok: boolean; detail: string } {
  try {
    const r = runAuditIntegritySelfTest();
    return { ok: r.ok, detail: r.ok ? 'اكتشف التعديل والحذف وإعادة الترتيب وبتر الذيل' : JSON.stringify(r) };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}
SCD_EOF_P12S2_1
write_file 'src/app/security-check.tsx' <<'SCD_EOF_P12S2_2'
// SECURECASEDESK_PHASE12_S2
// شاشة «فحص الأمان على الجهاز» (لمدير النظام: audit.verify). تقرير حي للقراءة فقط، يُلتقط بلقطة شاشة كدليل في اختبار الجهاز الحقيقي.
// لا تعرض المفتاح ولا أي بيانات قضايا. الفحوص: SQLCipher، ترويسة الملف، مفتاح خاطئ، إعادة فتح (بزر)، اختبار سلسلة HMAC الذاتي.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { X, ShieldCheck, RefreshCw, RotateCcw } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Colors, Radius, Fonts, FontSizes } from '@/constants/theme';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration';
import { evaluateEncryptionFacts, summarizeChecks, type Check, type CheckLevel } from '@/modules/diagnostics/security-check';
import { collectEncryptionFacts, runAuditSelfTestSafe } from '@/modules/diagnostics/security-check-runtime';

const LEVEL_COLOR: Record<CheckLevel, string> = { pass: Colors.success, warn: Colors.warning, fail: Colors.danger };
const LEVEL_LABEL: Record<CheckLevel, string> = { pass: 'نجح', warn: 'لم يُفحص/تنبيه', fail: 'فشل' };

export default function SecurityCheckScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'audit.verify');
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState('');

  useEffect(() => {
    if (user && !allowed) {
      void recordUnauthorizedAccess({
        userId: user.id, username: user.username, role: user.role,
        resource: 'screen:security-check', detail: 'محاولة فتح فحص الأمان على الجهاز',
      });
    }
  }, [user?.id, allowed]);

  const run = useCallback(async (withReopen: boolean) => {
    setBusy(true);
    try {
      const facts = await collectEncryptionFacts({ withReopen });
      const list = evaluateEncryptionFacts(facts);
      const audit = runAuditSelfTestSafe();
      list.push({ id: 'hmac', title: 'اختبار سلسلة HMAC الذاتي', level: audit.ok ? 'pass' : 'fail', detail: audit.detail });
      setChecks(list);
      setStamp(new Date().toISOString());
    } catch {
      Alert.alert('تعذّر الفحص', 'حدث خطأ غير متوقع أثناء الفحص.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { if (allowed) void run(false); }, [allowed, run]);

  const onReopen = useCallback(() => {
    Alert.alert(
      'فحص إعادة فتح القاعدة',
      'سيُغلق اتصال القاعدة ويُعاد فتحه بالمفتاح المخزَّن. لا يغيّر أي بيانات. تأكد أنه لا توجد عملية حفظ جارية.',
      [{ text: 'إلغاء', style: 'cancel' }, { text: 'تنفيذ', onPress: () => void run(true) }]
    );
  }, [run]);

  const summary = useMemo(() => (checks ? summarizeChecks(checks) : null), [checks]);

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()}><X size={20} color={Colors.textPrimary} /></Pressable>
      <Text style={styles.title}>فحص الأمان على الجهاز</Text>
      <Pressable style={styles.iconBtn} onPress={() => void run(false)} disabled={busy}><RefreshCw size={18} color={Colors.textPrimary} /></Pressable>
    </View>
  );

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.denied}>غير مصرح لك بفتح هذه الشاشة</Text>
          <Text style={styles.muted}>تم تسجيل هذه المحاولة في سجل التدقيق</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.card}>
          <View style={styles.row}>
            <ShieldCheck size={20} color={summary ? LEVEL_COLOR[summary.overall] : Colors.textMuted} />
            <Text style={[styles.sectionTitle, summary && { color: LEVEL_COLOR[summary.overall] }]}>
              {summary ? 'الحالة العامة: ' + LEVEL_LABEL[summary.overall] : 'جارٍ الفحص…'}
            </Text>
          </View>
          {summary && <Text style={styles.muted}>نجح: {summary.pass} • تنبيه: {summary.warn} • فشل: {summary.fail}</Text>}
          <Text style={styles.muted}>الجهاز: {Platform.OS} {String(Platform.Version)} • الوقت: {stamp || '—'}</Text>
          <Text style={styles.muted}>هذا الفحص دليل مساعد؛ لا يغني عن بقية اختبارات الجهاز الحقيقي الموثقة.</Text>
        </View>

        {busy && !checks && <ActivityIndicator color={Colors.primary} />}

        {checks?.map((c) => (
          <View key={c.id} style={[styles.card, { borderColor: LEVEL_COLOR[c.level] }]}>
            <Text style={[styles.statusText, { color: LEVEL_COLOR[c.level] }]}>{LEVEL_LABEL[c.level]} — {c.title}</Text>
            <Text style={styles.muted}>{c.detail}</Text>
          </View>
        ))}

        <Pressable style={[styles.actionBtn, busy && { opacity: 0.5 }]} disabled={busy} onPress={onReopen}>
          <RotateCcw size={18} color={Colors.primary} /><Text style={styles.actionText}>تنفيذ فحص إعادة فتح القاعدة</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  iconBtn: { width: 40, height: 40, borderRadius: Radius.md, backgroundColor: Colors.card, alignItems: 'center', justifyContent: 'center' },
  title: { color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.lg },
  scroll: { paddingHorizontal: 16, paddingBottom: 40, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  denied: { color: Colors.danger, fontFamily: Fonts.bold, fontSize: FontSizes.md },
  muted: { color: Colors.textMuted, fontFamily: Fonts.regular, fontSize: FontSizes.sm, textAlign: 'right' },
  card: { backgroundColor: Colors.card, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, padding: 16, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { color: Colors.textPrimary, fontFamily: Fonts.bold, fontSize: FontSizes.md, textAlign: 'right' },
  statusText: { fontFamily: Fonts.semiBold, fontSize: FontSizes.sm, textAlign: 'right' },
  actionBtn: { height: 46, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  actionText: { color: Colors.primary, fontFamily: Fonts.bold, fontSize: FontSizes.sm },
});
SCD_EOF_P12S2_2
write_file 'tests/security-permissions.test.ts' <<'SCD_EOF_P12S2_3'
// SECURECASEDESK_PHASE12_S2
// اختبارات الصلاحيات: الأدوار الأربعة، عزل مشاهد المحتجزين، الرفض عند الفشل (fail-closed)، وطبقة البيانات (assertUserCan).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeDb } from './helpers/node-env';
import {
  ROLES, can, canAccessTab, firstAllowedTab, normalizeRole, assertUserCan,
  type Permission, type Role,
} from '../src/security/permissions';
import { ForbiddenError, onForbidden, requirePerm } from '../src/security/guard';

const ALL_PERMS: Permission[] = [
  'dashboard.view', 'cases.view', 'cases.manage', 'memos.view', 'memos.manage',
  'detainees.view', 'detainees.manage', 'detainees.correct', 'users.manage', 'attachments.admin',
  'audit.view', 'audit.verify', 'audit.sync', 'backup.manage', 'ai.use', 'ai.manage',
];
const allowedFor = (role: Role) => ALL_PERMS.filter((p) => can(role, p));

test('الأدوار الأربعة معرّفة', () => {
  assert.deepEqual(ROLES.map((r) => r.key).sort(), ['admin', 'detention_viewer', 'investigator', 'viewer']);
});

test('مدير النظام يملك كل الصلاحيات', () => {
  assert.deepEqual(allowedFor('admin'), ALL_PERMS);
});

test('المحقق: يدير القضايا والمذكرات ولا يدير المستخدمين أو النسخ أو التصحيحات أو التدقيق', () => {
  for (const p of ['cases.manage', 'memos.manage', 'detainees.view', 'ai.use'] as Permission[]) assert.equal(can('investigator', p), true, p);
  for (const p of ['users.manage', 'backup.manage', 'detainees.correct', 'detainees.manage', 'audit.view', 'audit.verify', 'attachments.admin', 'ai.manage'] as Permission[]) {
    assert.equal(can('investigator', p), false, p);
  }
});

test('مستخدم الاطلاع: قراءة فقط', () => {
  assert.deepEqual(allowedFor('viewer'), ['dashboard.view', 'cases.view', 'memos.view', 'detainees.view', 'ai.use']);
  for (const p of ALL_PERMS.filter((x) => x.endsWith('.manage') || x === 'detainees.correct')) assert.equal(can('viewer', p), false, p);
});

test('مشاهد المحتجزين معزول تماماً: لوحة المحتجزين فقط', () => {
  assert.deepEqual(allowedFor('detention_viewer'), ['dashboard.view', 'detainees.view']);
  for (const p of ['cases.view', 'cases.manage', 'memos.view', 'memos.manage', 'audit.view', 'backup.manage', 'ai.use', 'users.manage'] as Permission[]) {
    assert.equal(can('detention_viewer', p), false, p);
  }
  for (const tab of ['cases', 'memos', 'users', 'audit']) assert.equal(canAccessTab('detention_viewer', tab), false, tab);
  assert.equal(canAccessTab('detention_viewer', 'detainees'), true);
  assert.equal(firstAllowedTab('detention_viewer'), 'index');
});

test('رفض افتراضي: دور غير معروف أو فارغ لا يملك شيئاً', () => {
  for (const r of [null, undefined, '', 'root', 'ADMINISTRATOR', 'admin;DROP']) {
    for (const p of ALL_PERMS) assert.equal(can(r as never, p), false, `${String(r)}:${p}`);
  }
  assert.equal(normalizeRole('Detention-Viewer'), 'detention_viewer');
  assert.equal(normalizeRole(' admin '), 'admin');
  assert.equal(normalizeRole('hacker'), null);
});

test('الحارس requirePerm يفشل مغلقاً ويُبلغ المستمعين', () => {
  const events: { permission: string; userId: string | null }[] = [];
  const off = onForbidden((e) => events.push({ permission: e.permission, userId: e.userId }));
  assert.throws(() => requirePerm(null, 'cases.view'), ForbiddenError);
  assert.throws(() => requirePerm({ userId: '', role: 'admin' }, 'cases.view'), ForbiddenError);
  assert.throws(() => requirePerm({ userId: 'u1', role: 'unknown' as never }, 'cases.view'), ForbiddenError);
  assert.throws(() => requirePerm({ userId: 'u2', role: 'detention_viewer' }, 'memos.view'), ForbiddenError);
  assert.equal(requirePerm({ userId: 'u3', role: 'admin' }, 'users.manage').userId, 'u3');
  off();
  assert.equal(events.length, 4);
  assert.equal(events[3].userId, 'u2');
  // بعد إلغاء الاشتراك لا تصل أحداث جديدة
  assert.throws(() => requirePerm(null, 'cases.view'));
  assert.equal(events.length, 4);
});

test('مستمع يرمي خطأ لا يغيّر قرار الرفض', () => {
  const off = onForbidden(() => { throw new Error('listener boom'); });
  assert.throws(() => requirePerm(null, 'cases.view'), ForbiddenError);
  off();
});

test('طبقة البيانات assertUserCan: تقرأ الدور من الجدول وتتجاهل الحالة الظاهرة', async () => {
  const db = new NodeDb();
  await db.execAsync(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, is_active INTEGER);`);
  await db.runAsync('INSERT INTO users VALUES (?,?,?)', ['a', 'admin', 1]);
  await db.runAsync('INSERT INTO users VALUES (?,?,?)', ['dv', 'detention_viewer', 1]);
  await db.runAsync('INSERT INTO users VALUES (?,?,?)', ['off', 'admin', 0]);
  await db.runAsync('INSERT INTO users VALUES (?,?,?)', ['nul', 'admin', null]); // NULL يُعامل كنشط (COALESCE)
  await db.runAsync('INSERT INTO users VALUES (?,?,?)', ['bad', 'superuser', 1]);
  const d = db as never;

  await assertUserCan(d, 'a', 'users.manage');
  await assertUserCan(d, 'nul', 'cases.view');
  await assertUserCan(d, 'dv', 'detainees.view');
  await assert.rejects(assertUserCan(d, 'dv', 'cases.view'), /FORBIDDEN/);
  await assert.rejects(assertUserCan(d, 'dv', 'memos.view'), /FORBIDDEN/);
  await assert.rejects(assertUserCan(d, 'off', 'cases.view'), /FORBIDDEN/);      // حساب معطّل
  await assert.rejects(assertUserCan(d, 'bad', 'cases.view'), /FORBIDDEN/);      // دور غير معروف
  await assert.rejects(assertUserCan(d, 'ghost', 'cases.view'), /FORBIDDEN/);    // مستخدم غير موجود

  // تغيير الدور في القاعدة يسري فوراً على فحص طبقة البيانات
  await db.runAsync('UPDATE users SET role = ? WHERE id = ?', ['detention_viewer', 'a']);
  await assert.rejects(assertUserCan(d, 'a', 'users.manage'), /FORBIDDEN/);
});
SCD_EOF_P12S2_3
write_file 'tests/security-integrity.test.ts' <<'SCD_EOF_P12S2_4'
// SECURECASEDESK_PHASE12_S2
// اختبارات السلامة: (1) حماية سجلات الحركات والتصحيحات بالمشغّلات الفعلية المقتطعة من src/database/db.ts،
// (2) سلسلة HMAC للتدقيق: كشف التعديل والحذف وإعادة الترتيب والرابط المكسور وبتر الذيل وتبديل المفتاح.
// ملاحظة صادقة: تعمل على node:sqlite (ليس SQLCipher). تشفير القاعدة نفسه لا يُثبت إلا على الجهاز (شاشة فحص الأمان).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChainVerifier, runAuditIntegritySelfTest, type CheckpointInput } from '../src/security/audit-verifier-core';
import { GENESIS_HASH, buildCheckpoint, calculateRowHmac, versionLabel, type AuditLogRow } from '../src/security/audit-crypto';

// ───────── (1) مشغّلات الحماية الفعلية ─────────
const dbSource = readFileSync(join(process.cwd(), 'src', 'database', 'db.ts'), 'utf8');
function grab(re: RegExp, label: string): string {
  const m = re.exec(dbSource);
  assert.ok(m, `لم يُعثر على ${label} في db.ts (تغيّر شكل الكود؟)`);
  return m![0];
}
const MOVEMENTS_TABLE = grab(/CREATE TABLE IF NOT EXISTS detainee_movements \([\s\S]*?\n\s*\);/, 'جدول الحركات');
const CORRECTIONS_TABLE = grab(/CREATE TABLE IF NOT EXISTS correction_history \([\s\S]*?\n\s*\);/, 'جدول التصحيحات');
const TRIGGERS = ['trg_movements_no_update', 'trg_movements_no_delete', 'trg_corrections_no_update', 'trg_corrections_no_delete']
  .map((n) => grab(new RegExp(`CREATE TRIGGER IF NOT EXISTS ${n}[\\s\\S]*?END;`), 'مشغّل ' + n));

function freshHistoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(MOVEMENTS_TABLE);
  db.exec(CORRECTIONS_TABLE);
  for (const t of TRIGGERS) db.exec(t);
  db.prepare(`INSERT INTO detainee_movements (id, movement_number, detainee_id, movement_type, movement_date, executed_by, created_at)
              VALUES ('m1','MV-1','d1','إيداع',1000,'u1',1000)`).run();
  db.prepare(`INSERT INTO correction_history (id, detainee_id, field_name, previous_value, new_value, reason, executed_by, created_at)
              VALUES ('c1','d1','name','قديم','جديد','خطأ إملائي','u1',1000)`).run();
  return db;
}

test('الحركات: التعديل مرفوض والقيم السابقة محفوظة', () => {
  const db = freshHistoryDb();
  assert.throws(() => db.exec(`UPDATE detainee_movements SET reason = 'x' WHERE id = 'm1'`), /لا يقبل التعديل/);
  assert.throws(() => db.exec(`UPDATE detainee_movements SET movement_type = 'إفراج'`), /لا يقبل التعديل/);
  const row = db.prepare(`SELECT movement_type, reason FROM detainee_movements WHERE id='m1'`).get() as { movement_type: string; reason: string | null };
  assert.equal(row.movement_type, 'إيداع');
  assert.equal(row.reason, null);
});

test('الحركات: الحذف مرفوض (مفرداً وجماعياً)', () => {
  const db = freshHistoryDb();
  assert.throws(() => db.exec(`DELETE FROM detainee_movements WHERE id = 'm1'`), /لا يقبل الحذف/);
  assert.throws(() => db.exec(`DELETE FROM detainee_movements`), /لا يقبل الحذف/);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM detainee_movements').get() as { c: number }).c, 1);
});

test('الحركات: الإضافة مسموحة (سجل إلحاقي فقط) ونوع الحركة مقيّد', () => {
  const db = freshHistoryDb();
  db.prepare(`INSERT INTO detainee_movements (id, movement_number, detainee_id, movement_type, movement_date, executed_by, created_at)
              VALUES ('m2','MV-2','d1','إفراج',2000,'u1',2000)`).run();
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM detainee_movements').get() as { c: number }).c, 2);
  assert.throws(() => db.prepare(`INSERT INTO detainee_movements (id, movement_number, detainee_id, movement_type, movement_date, executed_by, created_at)
              VALUES ('m3','MV-3','d1','نوع_مخترع',3000,'u1',3000)`).run());
});

test('التصحيحات: التعديل والحذف مرفوضان والقيمتان القديمة والجديدة محفوظتان', () => {
  const db = freshHistoryDb();
  assert.throws(() => db.exec(`UPDATE correction_history SET new_value = 'تلاعب' WHERE id = 'c1'`), /غير قابل للتعديل/);
  assert.throws(() => db.exec(`DELETE FROM correction_history WHERE id = 'c1'`), /غير قابل للحذف/);
  const row = db.prepare(`SELECT previous_value, new_value FROM correction_history WHERE id='c1'`).get() as { previous_value: string; new_value: string };
  assert.deepEqual({ ...row }, { previous_value: 'قديم', new_value: 'جديد' });
});

test('التصحيحات: سبب التصحيح إلزامي', () => {
  const db = freshHistoryDb();
  assert.throws(() => db.prepare(`INSERT INTO correction_history (id, detainee_id, field_name, previous_value, new_value, reason, executed_by, created_at)
              VALUES ('c2','d1','name','a','b',NULL,'u1',1)`).run());
});

// ───────── (2) سلسلة HMAC ─────────
const K = new Uint8Array(32).fill(0x41);
const CK = new Uint8Array(32).fill(0x42);

function mk(seq: number, prev: string, over: Partial<AuditLogRow> = {}): AuditLogRow {
  const base = {
    sequence_no: seq, operation_id: 'OP' + seq, source_event_id: 'EV' + seq,
    user_id: 'U1', username: 'admin', operation_type: 'create', entity_type: 'case', entity_id: 'C' + seq,
    previous_values: null, new_values: '{"n":' + seq + '}', correction_reason: null,
    created_at: 5000 + seq, previous_hash: prev, hmac_version: versionLabel(1), ...over,
  };
  return { ...base, record_hash: calculateRowHmac(K, base) };
}
function chain(n: number): AuditLogRow[] {
  const rows: AuditLogRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) { const r = mk(i, prev); rows.push(r); prev = r.record_hash; }
  return rows;
}
function verify(rows: AuditLogRow[], opts: { cps?: CheckpointInput[]; key?: Uint8Array } = {}) {
  const v = new ChainVerifier({ resolveKey: () => opts.key ?? K, checkpoints: opts.cps ?? [], checkpointKey: CK, externalState: 'ignored' });
  v.feed(rows);
  return v.finish();
}
const codes = (r: ReturnType<typeof verify>) => r.findings.map((f) => f.code);

test('الاختبار الذاتي المدمج للتدقيق ينجح بكل مكوّناته', () => {
  const r = runAuditIntegritySelfTest();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('سلسلة سليمة من 10 سجلات ← VALID', () => {
  const r = verify(chain(10));
  assert.equal(r.ok, true);
  assert.equal(r.status, 'VALID');
  assert.equal(r.count, 10);
  assert.equal(r.findings.length, 0);
});

test('تعديل حقل في سجل ← INVALID_HMAC', () => {
  const rows = chain(5);
  rows[2] = { ...rows[2], new_values: '{"n":999}' };
  const r = verify(rows);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'COMPROMISED');
  assert.ok(codes(r).includes('INVALID_HMAC'), codes(r).join());
});

test('حذف سجل من الوسط ← يُكتشف', () => {
  const rows = chain(5);
  const r = verify([rows[0], rows[1], rows[3], rows[4]]);
  assert.equal(r.ok, false);
  assert.ok(codes(r).some((c) => c === 'SEQUENCE_GAP' || c === 'BROKEN_LINK'), codes(r).join());
});

test('إعادة ترتيب سجلين ← يُكتشف', () => {
  const rows = chain(5);
  const r = verify([rows[0], rows[2], rows[1], rows[3], rows[4]]);
  assert.equal(r.ok, false);
  assert.ok(codes(r).some((c) => c === 'OUT_OF_ORDER' || c === 'SEQUENCE_GAP' || c === 'BROKEN_LINK'), codes(r).join());
});

test('رابط سابق مكسور (previous_hash مزوَّر مع HMAC صحيح للسجل نفسه) ← BROKEN_LINK', () => {
  const rows = chain(4);
  rows[2] = mk(3, 'f'.repeat(64)); // HMAC صحيح لكن لا يرتبط بالسجل السابق
  rows[3] = mk(4, rows[2].record_hash);
  const r = verify(rows);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('BROKEN_LINK'), codes(r).join());
});

test('التحقق بمفتاح خاطئ ← الفشل (لا يمر التزوير)', () => {
  const r = verify(chain(3), { key: new Uint8Array(32).fill(0x99) });
  assert.equal(r.ok, false);
});

test('بتر ذيل السلسلة يُكتشف عبر نقطة التحقق الموقّعة', () => {
  const rows = chain(6);
  const cp: CheckpointInput = {
    source: 'external',
    record: buildCheckpoint(CK, { sequence_no: 6, record_hash: rows[5].record_hash, key_version: 1 }, 1),
  };
  assert.equal(verify(rows, { cps: [cp] }).ok, true);
  const truncated = verify(rows.slice(0, 4), { cps: [cp] });
  assert.equal(truncated.ok, false);
});
SCD_EOF_P12S2_4
write_file 'tests/security-check.test.ts' <<'SCD_EOF_P12S2_5'
// SECURECASEDESK_PHASE12_S2
// اختبار منطق تقييم فحص تشفير القاعدة (الذي تعرضه شاشة «فحص الأمان على الجهاز»).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEncryptionFacts, summarizeChecks, type EncryptionFacts } from '../src/modules/diagnostics/security-check';

const good: EncryptionFacts = {
  cipherVersion: '4.17.0', headerReadable: true, sqliteHeaderDetected: false, fileSize: 262144,
  schemaAccessible: true, wrongKeyRejected: true, reopenOk: true,
};
const level = (f: EncryptionFacts, id: string) => evaluateEncryptionFacts(f).find((c) => c.id === id)!.level;

test('كل الحقائق سليمة ← النتيجة العامة نجاح', () => {
  const s = summarizeChecks(evaluateEncryptionFacts(good));
  assert.deepEqual(s, { overall: 'pass', pass: 5, warn: 0, fail: 0 });
});

test('غياب SQLCipher ← فشل', () => {
  assert.equal(level({ ...good, cipherVersion: null }, 'cipher'), 'fail');
  assert.equal(summarizeChecks(evaluateEncryptionFacts({ ...good, cipherVersion: null })).overall, 'fail');
});

test('ظهور ترويسة SQLite الصريحة ← فشل (ملف غير مشفّر)', () => {
  assert.equal(level({ ...good, sqliteHeaderDetected: true }, 'header'), 'fail');
});

test('تعذّر قراءة الترويسة ← تنبيه لا نجاح', () => {
  assert.equal(level({ ...good, headerReadable: false }, 'header'), 'warn');
});

test('قراءة القاعدة بمفتاح خاطئ ← فشل', () => {
  assert.equal(level({ ...good, wrongKeyRejected: false }, 'wrongkey'), 'fail');
});

test('الفحوص غير المنفّذة تظهر تنبيهاً وليست نجاحاً', () => {
  const f = { ...good, wrongKeyRejected: null, reopenOk: null };
  assert.equal(level(f, 'wrongkey'), 'warn');
  assert.equal(level(f, 'reopen'), 'warn');
  assert.equal(summarizeChecks(evaluateEncryptionFacts(f)).overall, 'warn');
});

test('فشل إعادة الفتح أو القراءة بالمفتاح الصحيح ← فشل', () => {
  assert.equal(level({ ...good, reopenOk: false }, 'reopen'), 'fail');
  assert.equal(level({ ...good, schemaAccessible: false }, 'schema'), 'fail');
});

test('الفشل يغلب التنبيه في الحالة العامة', () => {
  const s = summarizeChecks(evaluateEncryptionFacts({ ...good, cipherVersion: null, wrongKeyRejected: null }));
  assert.equal(s.overall, 'fail');
});
SCD_EOF_P12S2_5
write_file 'docs/phase12/12.2-security-and-device-tests.md' <<'SCD_EOF_P12S2_6'
# المرحلة 12 / القسم 12.2 — اختبارات الأمان والتكامل وقائمة اختبار الجهاز الحقيقي

> قاعدة الصدق (القسم 22 من المواصفات): لا يُعلَّم أي اختبار «نجح» دون تنفيذه فعلياً. كل الخانات أدناه تبدأ «لم يُنفَّذ». اختبارات الخادم المركزي تبقى «معلّقة حتى المرحلة 13».

## أولاً: ما أُضيف في 12.2
| الملف | الغرض |
|---|---|
| `tests/security-permissions.test.ts` | مصفوفة الأدوار الأربعة، عزل مشاهد المحتجزين، الرفض الافتراضي، الحارس `requirePerm`، وطبقة البيانات `assertUserCan` (حساب معطّل/دور مجهول/مستخدم غير موجود/تغيير الدور) |
| `tests/security-integrity.test.ts` | مشغّلات حماية الحركات والتصحيحات (المقتطعة من `db.ts` الفعلي) + سلسلة HMAC: تعديل/حذف/إعادة ترتيب/رابط مكسور/مفتاح خاطئ/بتر الذيل |
| `tests/security-check.test.ts` | منطق تقييم فحص تشفير القاعدة |
| `src/modules/diagnostics/*` + `src/app/security-check.tsx` | شاشة «فحص الأمان على الجهاز» (للمدير): SQLCipher، ترويسة الملف، مفتاح خاطئ، إعادة الفتح، اختبار HMAC الذاتي |
| زر في `settings.tsx` | «فحص الأمان على الجهاز» (يظهر لمن يملك `audit.verify` أي المدير فقط) |

### حدود هذه الاختبارات (مهم)
- اختبارات Node تعمل على `node:sqlite` **وليس SQLCipher**؛ فهي تثبت منطق الصلاحيات والمشغّلات وسلسلة HMAC فقط. **تشفير القاعدة لا يُثبت إلا على الجهاز** بشاشة «فحص الأمان على الجهاز».
- حماية المشغّلات تمنع عمليات SQL العادية فقط، وليست حماية من تعديل ملف القاعدة الخام (انظر `SECURITY.md` البند 3).
- لا يوجد اختبار آلي لشاشات الواجهة (RTL والخطوط والتنقل)؛ هذه تُختبر يدوياً أدناه وفي 12.3.

## ثانياً: التشغيل
```bash
npm run typecheck
npm run test:security          # اختبارات 12.2 الثلاثة
npm run test:all               # كل اختبارات المشروع
```

## ثالثاً: قائمة اختبار الجهاز الحقيقي (على APK مثبّت، لا Expo Go)
جهّز قبل البدء: حساب مدير + حساب محقق + حساب «اطلاع» + حساب «مشاهد محتجزين» (أنشئها من شاشة المستخدمين). كل بند: نفّذه، سجّل النتيجة الفعلية (نجح/فشل + ملاحظة)، وألصق لقطة شاشة عند الأهمية.

| الرمز | البند (القسم 22.1) | الخطوات | النتيجة المتوقعة | النتيجة الفعلية |
|---|---|---|---|---|
| D01 | تثبيت وتشغيل APK | ثبّت الـ APK وافتحه | يفتح دون انهيار | لم يُنفَّذ |
| D02 | إعداد أول مدير | أول تشغيل على جهاز نظيف | شاشة الإعداد، إنشاء المدير، الدخول | لم يُنفَّذ |
| D03 | تسجيل الدخول والخروج | خروج ثم دخول؛ كلمة مرور خاطئة | الخاطئة تُرفض، والخروج يعيد لشاشة الدخول (متابعة خلل «الخروج من الإعدادات» القديم) | لم يُنفَّذ |
| D04 | SQLCipher على البناء الحقيقي | إعدادات ← «فحص الأمان على الجهاز» | كل البنود «نجح» (ما عدا إعادة الفتح قبل تنفيذها) وإصدار SQLCipher ظاهر | لم يُنفَّذ |
| D05 | إعادة فتح القاعدة المشفّرة | الزر «تنفيذ فحص إعادة فتح القاعدة» | بند إعادة الفتح «نجح» ثم التطبيق يعمل طبيعياً | لم يُنفَّذ |
| D06 | الاستمرارية بعد إعادة التشغيل | أنشئ قضية ← أغلق التطبيق بالكامل (اسحبه من المهام) ← افتحه | القضية موجودة والجلسة تعمل حسب سياسة الجلسة | لم يُنفَّذ |
| D07 | القضايا | إنشاء/تعديل/بحث/أرشفة | تعمل وتُسجَّل في سجل التعديلات | لم يُنفَّذ |
| D08 | الأقسام | إنشاء وإدارة قسم | تعمل | لم يُنفَّذ |
| D09 | المذكرات العشر | أنشئ مذكرة من كل نوع | عشرة أنواع تُحفظ وتُعرض | لم يُنفَّذ |
| D10 | تسجيل محتجز | تسجيل ثم تفاصيل | يُحفظ مع حركة «إيداع» | لم يُنفَّذ |
| D11 | الحركات: إيداع/نقل/إفراج | نفّذ الثلاث | تظهر بالتسلسل ومدة الاحتجاز تُحسب | لم يُنفَّذ |
| D12 | التصحيح التاريخي | مدير: صحّح الاسم/التهمة بسبب | سجل «تصحيح» مع القيمة السابقة والجديدة | لم يُنفَّذ |
| D13 | منع حذف/تعديل التاريخ | لا توجد واجهة لحذف حركة/تصحيح | لا زر حذف/تعديل متاح (والمشغّلات تحمي على مستوى SQL) | لم يُنفَّذ |
| D14 | دور المحقق | ادخل بحساب المحقق | قضايا ومذكرات نعم؛ المستخدمون/التدقيق/النسخ لا تظهر | لم يُنفَّذ |
| D15 | دور الاطلاع | ادخل بحساب الاطلاع | لا أزرار إضافة/تعديل | لم يُنفَّذ |
| D16 | عزل مشاهد المحتجزين | ادخل بحسابه | المحتجزون فقط؛ لا قضايا ولا مذكرات ولا مرفقاتها ولا ذكاء اصطناعي | لم يُنفَّذ |
| D17 | منع الوصول غير المصرّح | بحساب غير مدير حاول فتح شاشة فحص الأمان (إن أمكن عبر رابط) | رفض + سجل «وصول غير مصرح» في التدقيق | لم يُنفَّذ |
| D18 | سلامة سلسلة التدقيق | شاشة التدقيق ← تحقق | الحالة سليمة (VALID) | لم يُنفَّذ |
| D19 | تشفير المرفقات وSHA-256 | أرفق ملفاً ثم افتحه/تحقق | يُفتح سليماً وبصمة SHA-256 مطابقة | لم يُنفَّذ |
| D20 | الإقلاع بلا إنترنت | وضع الطيران ثم كل ما سبق | كل شيء يعمل بلا شبكة ولا رسائل «مزامنة» وهمية | لم يُنفَّذ |

الاختبارات التالية تُنفَّذ في **12.3** (النسخ الاحتياطي والاستعادة، المستندات العربية DOCX/PDF/الطباعة، RTL والخطوط) وتُوثَّق نتائجها في **12.4**:
نسخ احتياطي/استعادة/نسخة ما قبل الاستعادة • هجرة قاعدة قديمة (حين تتوفر) • DOCX • PDF • الطباعة • RTL • منع فقدان البيانات.

## رابعاً: اختبارات معلّقة حتى المرحلة 13 (لا تُعلَّم قبل وجود الخادم)
الخادم والمزامنة بين جهازين، Argon2id من جهة الخادم، RBAC من جهة الخادم، الصلاحيات عبر API، الـ Idempotency، تعارض التعديل المتزامن، انقطاع الإنترنت أثناء المزامنة، مزامنة المرفقات المشفّرة، تعطيل الحساب وإبطال الجلسة، سجل التدقيق من جهة الخادم، APK النهائي المتكامل.
SCD_EOF_P12S2_6

say "ربط الشاشة بالإعدادات وإضافة سكربت الاختبار"
cp "src/app/(tabs)/settings.tsx" "src/app/(tabs)/settings.tsx.bak_$TS"; cp package.json "package.json.bak_$TS"
node - <<'SCD_NODE_P12S2'
const fs = require('fs');
const f = 'src/app/(tabs)/settings.tsx';
let s = fs.readFileSync(f, 'utf8');
if (s.includes('SECURECASEDESK_PHASE12_S2')) {
  console.log('  ✔ settings.tsx: الزر مضاف مسبقاً');
} else {
  const anchor = s.indexOf("router.push('/reports' as never)");
  if (anchor < 0) { console.error('  ✘ لم أجد زر التقارير في settings.tsx لتحديد موضع الإدراج'); process.exit(2); }
  const startMarker = "{can(user?.role, 'dashboard.view') && (";
  const at = s.lastIndexOf(startMarker, anchor);
  if (at < 0) { console.error('  ✘ لم أجد بداية كتلة زر التقارير'); process.exit(2); }
  const lineStart = s.lastIndexOf('\n', at) + 1;
  const indent = s.slice(lineStart, at);
  const block =
`${indent}{can(user?.role, 'audit.verify') && ( // SECURECASEDESK_PHASE12_S2
${indent}  <Pressable
${indent}    onPress={() => router.push('/security-check' as never)}
${indent}    style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: 12, borderWidth: 1, borderColor: Colors.primary, backgroundColor: Colors.card, marginBottom: 12 }, pressed && { opacity: 0.85 }]}
${indent}  >
${indent}    <ShieldCheck color={Colors.primary} size={20} />
${indent}    <Text style={{ color: Colors.primary, fontFamily: 'Cairo_700Bold', fontSize: 15 }}>فحص الأمان على الجهاز</Text>
${indent}  </Pressable>
${indent})}

`;
  s = s.slice(0, lineStart) + block + s.slice(lineStart);
  if (!/import\s*\{[^}]*\bShieldCheck\b[^}]*\}\s*from\s*'lucide-react-native'/.test(s)) {
    s = s.replace(/import\s*\{([^}]*)\}\s*from\s*'lucide-react-native'/, (m, g) => `import {${g.trimEnd()}, ShieldCheck } from 'lucide-react-native'`);
  }
  fs.writeFileSync(f, s);
  console.log('  ✔ settings.tsx: أُضيف زر «فحص الأمان على الجهاز» (للمدير)');
}
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const want = 'tsx --tsconfig tests/tsconfig.json --test tests/security-permissions.test.ts tests/security-integrity.test.ts tests/security-check.test.ts';
pkg.scripts = pkg.scripts || {};
if (pkg.scripts['test:security'] !== want) {
  pkg.scripts['test:security'] = want;
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log('  ✔ package.json: test:security');
} else console.log('  ✔ package.json: بلا تغيير');
SCD_NODE_P12S2

say "تشغيل الفحوص الفعلية"
RES="docs/phase12/12.2-test-results.md"
{
  echo "# نتائج 12.2 الفعلية (مُولَّدة آلياً)"
  echo
  echo "- التاريخ: $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC)"
  echo "- Node: $(node -v)"
  echo "- هذه نتائج اختبارات Node على node:sqlite (ليست SQLCipher). اختبارات الجهاز الحقيقي D01–D20 تُسجَّل يدوياً في 12.2-security-and-device-tests.md"
  echo
} > "$RES"

SEC="لم يُنفَّذ (node_modules غير موجودة — نفّذ npm ci)"; ALL="$SEC"; TSC="$SEC"; SECRC=0; ALLRC=0; TCRC=0
summ() { grep -E '^# (tests|pass|fail|cancelled|skipped) ' "$1" | tr '\n' ' '; }
set +e
if [ -d node_modules ]; then
  npm run -s test:security > "/tmp/scd_sec_$TS.log" 2>&1; SECRC=$?
  SEC="$([ $SECRC -eq 0 ] && echo 'نجح' || echo "فشل (رمز $SECRC)") — $(summ /tmp/scd_sec_$TS.log)"
  npm run -s test:all > "/tmp/scd_all_$TS.log" 2>&1; ALLRC=$?
  ALL="$([ $ALLRC -eq 0 ] && echo 'نجح' || echo "فشل (رمز $ALLRC)") — $(summ /tmp/scd_all_$TS.log)"
  npx tsc --noEmit > "/tmp/scd_tsc_$TS.log" 2>&1; TCRC=$?
  TSC="$([ $TCRC -eq 0 ] && echo 'نجح (0 أخطاء)' || echo "فشل (رمز $TCRC)")"
  { echo '## npm run test:security'; echo '```'; grep -E '^(ok|not ok) ' "/tmp/scd_sec_$TS.log"; summ "/tmp/scd_sec_$TS.log"; echo; echo '```';
    echo; echo '## npm run test:all (الخلاصة)'; echo '```'; grep -E '^not ok ' "/tmp/scd_all_$TS.log" || echo '(لا اختبارات فاشلة)'; summ "/tmp/scd_all_$TS.log"; echo; echo '```';
    echo; echo '## npx tsc --noEmit'; echo '```'; tail -n 40 "/tmp/scd_tsc_$TS.log"; echo '```'; } >> "$RES"
fi
set -e
{ echo; echo "## الخلاصة"; echo "- test:security: $SEC"; echo "- test:all: $ALL"; echo "- tsc: $TSC"; echo "- اختبارات الجهاز D01–D20: لم تُنفَّذ بعد (يدوية)"; } >> "$RES"
ok "كُتبت النتائج في $RES"

say "الخلاصة"
echo "  test:security: $SEC"
echo "  test:all:      $ALL"
echo "  tsc:           $TSC"
cat <<'SCD_NEXT_P12S2'

الخطوات التالية:
  1) إن فشل شيء أعلاه: انسخ سطور not ok / أخطاء tsc من docs/phase12/12.2-test-results.md وأرسلها لي.
  2) git add -A && git commit -m "Phase 12.2" && git push   ثم أعد بناء APK (Workflow أو eas build).
  3) على الجهاز: إعدادات ← «فحص الأمان على الجهاز» (حساب مدير) وصوّر النتيجة، ثم نفّذ D01–D20 وسجّل النتائج.
  4) بعدها ننتقل إلى 12.3 (النسخ الاحتياطي، DOCX/PDF/الطباعة، RTL).
SCD_NEXT_P12S2
