#!/usr/bin/env python3
# SecureCaseDesk v2.2 — إصلاح L1 + G1 + G2 قبل أول APK مرشح (RC)
# التشغيل من جذر المشروع:  python3 fix_l1_g1_g2.py
# - يعدّل كل شيء في الذاكرة أولاً؛ أي مرساة غير مطابقة = إيقاف قبل كتابة أي ملف.
# - كل ملف موجود يُنسخ احتياطياً باسم .bak_<وقت> قبل التعديل.
import os, re, sys, shutil, subprocess, datetime

TS = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
MARK = 'SECURECASEDESK_FIX_L1_G1_G2'
def die(m): print('\n✘ ' + m); sys.exit(1)

if not (os.path.isfile('package.json') and os.path.isfile('src/database/db.ts')):
    die('شغّل الأمر من جذر مشروع SecureCaseDesk.')
if '"name": "securecasedesk"' not in open('package.json', encoding='utf8').read():
    die('package.json ليس لمشروع securecasedesk.')
if os.path.isfile('src/security/case-scope.ts'):
    die('الإصلاح مُطبَّق سابقاً (src/security/case-scope.ts موجود).')

OUT = {}   # path -> نص جديد
def load(p):
    if p in OUT: return OUT[p]
    if not os.path.isfile(p): die('ملف مفقود: ' + p)
    return open(p, encoding='utf8').read()
def sub(p, old, new, count=1):
    t = load(p); n = t.count(old)
    if n != count: die('مرساة غير مطابقة (%d بدل %d) في %s:\n%s' % (n, count, p, old[:140]))
    OUT[p] = t.replace(old, new)
def put(p, text): OUT[p] = text

# ════════════════════════════════════════════════════════════════
# L1 — تقييد المحقق بقسمه (القضايا + كل مسار يكشف بياناتها)
# ════════════════════════════════════════════════════════════════
put('src/security/case-scope.ts', r'''// SECURECASEDESK_FIX_L1_G1_G2
// نطاق رؤية القضايا حسب القسم. القسم والدور يُقرآن من جدول users نفسه لا من الجلسة (الجلسة تأتي من الواجهة).
// الفشل مغلق: مستخدم مجهول/معطّل/دور غير معروف/محقق بلا قسم = لا يرى أي قضية.
import type { Session } from './guard';
import { normalizeRole } from './permissions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ScopeDb { getFirstAsync(sql: string, params?: any): Promise<any> }

export type CaseScope =
  | { kind: 'all' }
  | { kind: 'department'; departmentId: string }
  | { kind: 'none' };

// الأدوار المقيَّدة بقسمها. لتقييد مستخدم الاطلاع أيضاً أضف 'viewer' هنا فقط.
export const DEPARTMENT_RESTRICTED_ROLES: readonly string[] = ['investigator'];

const NONE: CaseScope = { kind: 'none' };
const ALL: CaseScope = { kind: 'all' };

export async function resolveCaseScope(db: ScopeDb, session: Session | null | undefined): Promise<CaseScope> {
  if (!session || !session.userId) return NONE;
  const row = (await db.getFirstAsync(
    'SELECT role, COALESCE(is_active, 1) AS is_active, department_id FROM users WHERE id = ?', [session.userId]
  )) as { role: string; is_active: number; department_id: string | null } | null;
  if (!row || Number(row.is_active) !== 1) return NONE;
  const role = normalizeRole(row.role);
  if (!role) return NONE;
  if (!DEPARTMENT_RESTRICTED_ROLES.includes(role)) return ALL;
  const dep = String(row.department_id ?? '').trim();
  return dep ? { kind: 'department', departmentId: dep } : NONE;
}

export function caseDepartmentAllowed(scope: CaseScope, departmentId: string | null | undefined): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'none') return false;
  return !!departmentId && departmentId === scope.departmentId;
}

// شرط WHERE على عمود قسم (أسماء الأعمدة ثوابت في الشيفرة، لا مدخلات مستخدم).
export function caseScopeSql(scope: CaseScope, column: string): { sql: string; args: unknown[] } {
  if (scope.kind === 'all') return { sql: '1 = 1', args: [] };
  if (scope.kind === 'none') return { sql: '1 = 0', args: [] };
  return { sql: column + ' = ?', args: [scope.departmentId] };
}

// المذكرة المرتبطة بقضية قسم آخر محجوبة. المذكرة غير المرتبطة بقضية ليس لها قسم فتبقى كما كانت (لمن يملك memos.view).
export function memoScopeSql(scope: CaseScope, linkedCaseColumn: string): { sql: string; args: unknown[] } {
  if (scope.kind === 'all') return { sql: '1 = 1', args: [] };
  if (scope.kind === 'none') return { sql: '1 = 0', args: [] };
  return {
    sql: '(' + linkedCaseColumn + ' IS NULL OR ' + linkedCaseColumn + ' IN (SELECT id FROM cases WHERE department_id = ?))',
    args: [scope.departmentId],
  };
}
''')

# ---- cases.service ----
P = 'src/services/cases.service.ts'
sub(P, "import { requirePerm, type Session } from '@/security/guard';",
    "import { requirePerm, ForbiddenError, type Session } from '@/security/guard';\nimport { resolveCaseScope, caseScopeSql } from '@/security/case-scope'; // " + MARK)
t = load(P)
a = t.index('export async function listCases('); b = t.index('export async function insertCase(')
OUT[P] = t[:a] + r'''export async function listCases(
  session: Session | null | undefined,
  query: string = ''
): Promise<CaseItem[]> {
  const s = requirePerm(session, 'cases.view'); // قبل أي لمس لقاعدة البيانات
  const db = await getDb();
  const scope = await resolveCaseScope(db, s); // L1: المحقق يرى قضايا قسمه فقط
  const f = caseScopeSql(scope, 'department_id');
  const q = query.trim();
  if (q) {
    const like = '%' + q + '%';
    return db.getAllAsync<CaseItem>(
      'SELECT * FROM cases WHERE ' + f.sql + ' AND (case_number LIKE ? OR title LIKE ?) ORDER BY created_at DESC',
      [...f.args, like, like]
    );
  }
  return db.getAllAsync<CaseItem>('SELECT * FROM cases WHERE ' + f.sql + ' ORDER BY created_at DESC', f.args);
}

// لقائمة ربط المذكرات بالقضايا: يتطلب صلاحية عرض القضايا ويلتزم بنطاق القسم
export async function listCaseOptions(
  session: Session | null | undefined
): Promise<CaseOption[]> {
  const s = requirePerm(session, 'cases.view');
  const db = await getDb();
  const scope = await resolveCaseScope(db, s);
  const f = caseScopeSql(scope, 'department_id');
  return db.getAllAsync<CaseOption>(
    'SELECT id, case_number, title FROM cases WHERE ' + f.sql + ' ORDER BY created_at DESC', f.args
  );
}

''' + t[b:]
sub(P, "  const s = requirePerm(session, 'cases.manage');\n  const db = await getDb();\n  const id = Crypto.randomUUID();",
"""  const s = requirePerm(session, 'cases.manage');
  const db = await getDb();
  // L1: المحقق لا يسجّل قضية إلا في قسمه، ومن لا قسم له لا يسجّل شيئاً
  const scope = await resolveCaseScope(db, s);
  if (scope.kind === 'none') throw new ForbiddenError('cases.department');
  let departmentId = input.departmentId;
  if (scope.kind === 'department') {
    if (departmentId && departmentId !== scope.departmentId) throw new ForbiddenError('cases.department');
    departmentId = scope.departmentId;
  }
  const id = Crypto.randomUUID();""")
sub(P, "        input.caseType,\n        input.departmentId,\n        null,", "        input.caseType,\n        departmentId,\n        null,")
sub(P, """  requirePerm(session, 'cases.view');
  const db = await getDb();
  return db.getAllAsync<DepartmentOption>(
    'SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name ASC'
  );""", """  const s = requirePerm(session, 'cases.view');
  const db = await getDb();
  const scope = await resolveCaseScope(db, s);
  const f = caseScopeSql(scope, 'id'); // المحقق يرى قسمه وحده في النموذج
  return db.getAllAsync<DepartmentOption>(
    'SELECT id, name FROM departments WHERE is_active = 1 AND ' + f.sql + ' ORDER BY name ASC', f.args
  );""")

# ---- memos.service ----
P = 'src/services/memos.service.ts'
sub(P, "import { requirePerm, type Session } from '@/security/guard';",
    "import { requirePerm, ForbiddenError, type Session } from '@/security/guard';\nimport { resolveCaseScope, memoScopeSql, caseDepartmentAllowed } from '@/security/case-scope'; // " + MARK)
sub(P, """  requirePerm(session, 'memos.view');
  const db = await getDb();
  return db.getAllAsync<MemoItem>('SELECT * FROM memos ORDER BY created_at DESC');""",
"""  const s = requirePerm(session, 'memos.view');
  const db = await getDb();
  const scope = await resolveCaseScope(db, s); // L1: لا مذكرات مرتبطة بقضايا أقسام أخرى
  const f = memoScopeSql(scope, 'm.linked_case_id');
  return db.getAllAsync<MemoItem>('SELECT m.* FROM memos m WHERE ' + f.sql + ' ORDER BY m.created_at DESC', f.args);""")
sub(P, "  if (input.linkedCaseId) requirePerm(s, 'cases.view');\n  const db = await getDb();",
"""  if (input.linkedCaseId) requirePerm(s, 'cases.view');
  const db = await getDb();
  if (input.linkedCaseId) {
    const scope = await resolveCaseScope(db, s);
    const c = await db.getFirstAsync<{ department_id: string | null }>(
      'SELECT department_id FROM cases WHERE id = ?', [input.linkedCaseId]
    );
    if (!c || !caseDepartmentAllowed(scope, c.department_id)) throw new ForbiddenError('cases.department');
  }""")
sub(P, "  requirePerm(session, 'memos.manage');\n  if (!MEMO_STATUSES.includes(newStatus))", "  const s = requirePerm(session, 'memos.manage');\n  if (!MEMO_STATUSES.includes(newStatus))")
sub(P, "  const db = await getDb();\n  const now = Date.now();\n  const res = await db.runAsync(\n    'UPDATE memos SET status",
"""  const db = await getDb();
  const memo = await db.getFirstAsync<{ linked_case_id: string | null }>(
    'SELECT linked_case_id FROM memos WHERE id = ?', [memoId]
  );
  if (!memo) throw new MemoServiceError('NOT_FOUND');
  if (memo.linked_case_id) {
    const scope = await resolveCaseScope(db, s);
    const c = await db.getFirstAsync<{ department_id: string | null }>(
      'SELECT department_id FROM cases WHERE id = ?', [memo.linked_case_id]
    );
    if (!c || !caseDepartmentAllowed(scope, c.department_id)) throw new MemoServiceError('NOT_FOUND');
  }
  const now = Date.now();
  const res = await db.runAsync(
    'UPDATE memos SET status""")

# ---- stats.service ----
P = 'src/services/stats.service.ts'
sub(P, "import { requirePerm, type Session } from '@/security/guard';",
    "import { requirePerm, type Session } from '@/security/guard';\nimport { resolveCaseScope, caseScopeSql, memoScopeSql } from '@/security/case-scope'; // " + MARK)
t = load(P)
a = t.index("  if (can(s.role, 'cases.view')) {"); b = t.index("  if (can(s.role, 'detainees.view')) {")
OUT[P] = t[:a] + r'''  const scope = await resolveCaseScope(db, s); // L1: أعداد القضايا والمذكرات ضمن نطاق القسم
  if (can(s.role, 'cases.view')) {
    const cf = caseScopeSql(scope, 'department_id');
    const open = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM cases WHERE ' + cf.sql + ' AND status NOT IN (?, ?)',
      [...cf.args, 'مغلقة', 'مؤرشفة']
    );
    const inv = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM cases WHERE ' + cf.sql + ' AND status = ?',
      [...cf.args, 'قيد التحقيق']
    );
    result.cases = { open: open?.count ?? 0, underInvestigation: inv?.count ?? 0 };
  }

  if (can(s.role, 'memos.view')) {
    const mf = memoScopeSql(scope, 'linked_case_id');
    const memos = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM memos WHERE ' + mf.sql + ' AND status != ?',
      [...mf.args, 'مؤرشفة']
    );
    result.memos = { active: memos?.count ?? 0 };
  }

''' + t[b:]

# ---- reports-data ----
P = 'src/modules/reports/reports-data.ts'
sub(P, "import { requirePerm, ForbiddenError, type Session } from '../../security/guard';",
    "import { requirePerm, ForbiddenError, type Session } from '../../security/guard';\nimport { resolveCaseScope, caseScopeSql, memoScopeSql, caseDepartmentAllowed, type CaseScope } from '../../security/case-scope'; // " + MARK)
sub(P, "async function buildCaseFile(deps: ReportDeps, f: ReportFilters, can2: (p: Parameters<typeof can>[1]) => boolean)",
       "async function buildCaseFile(deps: ReportDeps, f: ReportFilters, can2: (p: Parameters<typeof can>[1]) => boolean, scope: CaseScope)")
sub(P, "  if (!c) throw new ReportError('NOT_FOUND');\n\n  const sections: ReportSection[] = [\n    { type: 'kv', heading: 'بيانات القضية'",
       "  if (!c || !caseDepartmentAllowed(scope, c.department_id as string | null)) throw new ReportError('NOT_FOUND');\n\n  const sections: ReportSection[] = [\n    { type: 'kv', heading: 'بيانات القضية'")
sub(P, "async function buildCasesList(deps: ReportDeps, f: ReportFilters) {", "async function buildCasesList(deps: ReportDeps, f: ReportFilters, scope: CaseScope) {")
sub(P, "  if (to !== null) { where.push('c.registration_date <= ?'); args.push(to); }",
       "  if (to !== null) { where.push('c.registration_date <= ?'); args.push(to); }\n  { const sc = caseScopeSql(scope, 'c.department_id'); where.push(sc.sql); args.push(...sc.args); }")
sub(P, "async function buildMemosList(deps: ReportDeps, f: ReportFilters) {", "async function buildMemosList(deps: ReportDeps, f: ReportFilters, scope: CaseScope) {")
sub(P, "  if (to !== null) { where.push('m.memo_date <= ?'); args.push(to); }",
       "  if (to !== null) { where.push('m.memo_date <= ?'); args.push(to); }\n  { const sc = memoScopeSql(scope, 'm.linked_case_id'); where.push(sc.sql); args.push(...sc.args); }")
sub(P, "async function buildAdminSummary(deps: ReportDeps, f: ReportFilters, can2: (p: Parameters<typeof can>[1]) => boolean) {",
       "async function buildAdminSummary(deps: ReportDeps, f: ReportFilters, can2: (p: Parameters<typeof can>[1]) => boolean, scope: CaseScope) {")
sub(P, "      'SELECT c.status, d.name AS department_name FROM cases c LEFT JOIN departments d ON d.id = c.department_id');",
       "      'SELECT c.status, d.name AS department_name FROM cases c LEFT JOIN departments d ON d.id = c.department_id WHERE ' + caseScopeSql(scope, 'c.department_id').sql,\n      caseScopeSql(scope, 'c.department_id').args);")
sub(P, "('SELECT t.name AS type_name FROM memos m LEFT JOIN memo_types t ON t.id = m.memo_type_id');",
       "('SELECT t.name AS type_name FROM memos m LEFT JOIN memo_types t ON t.id = m.memo_type_id WHERE ' + memoScopeSql(scope, 'm.linked_case_id').sql,\n      memoScopeSql(scope, 'm.linked_case_id').args);")
sub(P, "  const can2 = (p: Parameters<typeof can>[1]) => can(roleRow?.role, p);\n",
       "  const can2 = (p: Parameters<typeof can>[1]) => can(roleRow?.role, p);\n  const scope = await resolveCaseScope(deps.db, s); // L1\n")
sub(P, "buildCaseFile(deps, filters, can2);", "buildCaseFile(deps, filters, can2, scope);")
sub(P, "buildCasesList(deps, filters);", "buildCasesList(deps, filters, scope);")
sub(P, "buildMemosList(deps, filters);", "buildMemosList(deps, filters, scope);")
sub(P, "buildAdminSummary(deps, filters, can2);", "buildAdminSummary(deps, filters, can2, scope);")

# ---- attachments-repo ----
P = 'src/modules/attachments/attachments-repo.ts'
sub(P, "import { requirePerm, ForbiddenError, type Session } from '../../security/guard';",
    "import { requirePerm, ForbiddenError, type Session } from '../../security/guard';\nimport { resolveCaseScope, caseDepartmentAllowed } from '../../security/case-scope'; // " + MARK)
sub(P, "async function safeAudit(", r'''// L1: مرفقات قضية (أو مذكرة مرتبطة بقضية) قسم آخر غير مرئية للمحقق؛ تُعامل كأنها غير موجودة.
async function assertEntityInScope(deps: AttachmentDeps, s: Session, entityType: AttachmentEntityType, entityId: string): Promise<void> {
  if (entityType === 'detainee') return;
  const scope = await resolveCaseScope(deps.db, s);
  if (scope.kind === 'all') return;
  let caseId: string | null = entityId;
  if (entityType === 'memo') {
    const m = await deps.db.getFirstAsync<{ linked_case_id: string | null }>('SELECT linked_case_id FROM memos WHERE id = ?', [entityId]);
    if (!m) throw new AttachmentError('ENTITY_NOT_FOUND');
    caseId = m.linked_case_id;
    if (!caseId) {
      if (scope.kind === 'none') throw new AttachmentError('ENTITY_NOT_FOUND');
      return;
    }
  }
  const c = await deps.db.getFirstAsync<{ department_id: string | null }>('SELECT department_id FROM cases WHERE id = ?', [caseId]);
  if (!c || !caseDepartmentAllowed(scope, c.department_id)) throw new AttachmentError('ENTITY_NOT_FOUND');
}

async function safeAudit(''')
sub(P, "  if (!exists) throw new AttachmentError('ENTITY_NOT_FOUND');\n", "  if (!exists) throw new AttachmentError('ENTITY_NOT_FOUND');\n  await assertEntityInScope(deps, s, entityType, entityId);\n")
sub(P, "  await authorize(deps, session, VIEW_PERM[entityType]);\n  return deps.db.getAllAsync<AttachmentInfo>(",
       "  const sv = await authorize(deps, session, VIEW_PERM[entityType]);\n  await assertEntityInScope(deps, sv, entityType, entityId);\n  return deps.db.getAllAsync<AttachmentInfo>(")
sub(P, "  await authorize(deps, session, VIEW_PERM[entityType]);\n  const r = await deps.db.getFirstAsync<{ c: number }>(",
       "  const sv = await authorize(deps, session, VIEW_PERM[entityType]);\n  await assertEntityInScope(deps, sv, entityType, entityId);\n  const r = await deps.db.getFirstAsync<{ c: number }>(")
sub(P, "  const s = await authorize(deps, session, VIEW_PERM[row.entity_type]);\n  const bytes = await decryptVerified(deps, s, row);",
       "  const s = await authorize(deps, session, VIEW_PERM[row.entity_type]);\n  await assertEntityInScope(deps, s, row.entity_type, row.entity_id);\n  const bytes = await decryptVerified(deps, s, row);")
sub(P, "  const s = await authorize(deps, session, VIEW_PERM[row.entity_type]);\n  try {",
       "  const s = await authorize(deps, session, VIEW_PERM[row.entity_type]);\n  await assertEntityInScope(deps, s, row.entity_type, row.entity_id);\n  try {")

# ════════════════════════════════════════════════════════════════
# G1 — محارف تجاوز الاتجاه (RLO/LRE/RLE/PDF/LRO + LRI/RLI/FSI/PDI)
# تُحذف U+202A–202E و U+2066–2069 فقط. LRM/RLM/ZWJ/ZWNJ تبقى لأن العربية والفارسية تحتاجها.
# ════════════════════════════════════════════════════════════════
P = 'src/modules/reports/reports-format.ts'
sub(P, "export function escapeHtml(s: unknown): string {\n  return String(s ?? '')", r'''// SECURECASEDESK_FIX_L1_G1_G2 — تزييف اتجاه النص (مثل اسم ملف أو متهم يبدو مختلفاً عمّا هو عليه) يُمنع عند التصدير.
export const BIDI_OVERRIDE_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
export function stripBidiControls(s: string): string {
  return s.replace(BIDI_OVERRIDE_CONTROLS, '');
}

export function escapeHtml(s: unknown): string {
  return stripBidiControls(String(s ?? ''))''')
sub(P, "export function escapeXml(s: unknown): string {\n  return String(s ?? '')", "export function escapeXml(s: unknown): string {\n  return stripBidiControls(String(s ?? ''))")

# ════════════════════════════════════════════════════════════════
# G2 — إعادة التحميل بعد أول forceRTL (مع حماية من الحلقة ومسار احتياطي صريح)
# ════════════════════════════════════════════════════════════════
P = 'src/app/_layout.tsx'
sub(P, "import { StatusBar, I18nManager, View, ActivityIndicator } from 'react-native';",
       "import { useEffect, useState } from 'react';\nimport { StatusBar, I18nManager, View, ActivityIndicator, Text, DevSettings } from 'react-native';\nimport * as SecureStore from 'expo-secure-store';\nimport * as Updates from 'expo-updates'; // " + MARK)
sub(P, "if (!I18nManager.isRTL) {\n  I18nManager.allowRTL(true);\n  I18nManager.forceRTL(true);\n}",
r'''// forceRTL لا يسري إلا بعد إعادة تشغيل الجافاسكربت. نلتقط الحالة قبل تغييرها.
const RTL_PENDING_AT_START = !I18nManager.isRTL;
const RTL_RELOAD_FLAG = 'scd_rtl_reload_attempted';
if (RTL_PENDING_AT_START) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
}''')
sub(P, "    Cairo_400Regular, Cairo_500Medium, Cairo_600SemiBold, Cairo_700Bold, Cairo_800ExtraBold,\n  });\n\n  if (!fontsLoaded) {",
r'''    Cairo_400Regular, Cairo_500Medium, Cairo_600SemiBold, Cairo_700Bold, Cairo_800ExtraBold,
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

  if (!fontsLoaded) {''')
sub(P, "  return (\n    <SafeAreaProvider>",
r'''  if (rtlRestartNeeded) {
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
    <SafeAreaProvider>''')

# ════════════════════════════════════════════════════════════════
# الاختبارات: إزالة علامات todo + تحديث مخططات الاختبار القديمة + اختبار L1 جديد
# ════════════════════════════════════════════════════════════════
sub('tests/arabic-documents.test.ts', ", { todo: 'فجوة معروفة G1: escapeXml/escapeHtml لا تحذفها' }", "")
sub('tests/rtl-static.test.ts', ", { todo: 'فجوة معروفة G2: لا يوجد reload بعد forceRTL — البند D21' }", "")

# مخططات users في الاختبارات القديمة بلا department_id؛ نضيف العمود بعد إدخال المستخدمين (بلا مساس بالإدخالات الموضعية).
for tp, extra in (
    ('attachments', "ALTER TABLE cases ADD COLUMN department_id TEXT; UPDATE cases SET department_id = 'dep1'; ALTER TABLE memos ADD COLUMN linked_case_id TEXT; UPDATE users SET department_id = 'dep1' WHERE id = 'u-inv';"),
    ('reports-export', "UPDATE users SET department_id = 'd1' WHERE id = 'u-inv';"),
    ('reports', "UPDATE users SET department_id = 'd2' WHERE id = 'u-inv';"),
):
    p = 'tests/' + tp + '.test.ts'
    t = load(p)
    m = re.search(r"INSERT INTO users VALUES[^;]*;", t)
    if not m or 'ADD COLUMN department_id' in t: die('تعذر تحديد مخطط users في ' + p)
    # الترتيب: ALTER users بعد إدخال المستخدمين، ثم باقي الإضافات بعد إدخال القضايا (في attachments)
    OUT[p] = t.replace(m.group(0), m.group(0) + '\n    ALTER TABLE users ADD COLUMN department_id TEXT;', 1)
    if tp == 'attachments':
        m2 = re.search(r"INSERT INTO memos VALUES[^;]*;", OUT[p])
        if not m2: die('مرساة memos غير موجودة في ' + p)
        OUT[p] = OUT[p].replace(m2.group(0), m2.group(0) + '\n    ' + extra, 1)
    else:
        OUT[p] = OUT[p].replace('ALTER TABLE users ADD COLUMN department_id TEXT;', 'ALTER TABLE users ADD COLUMN department_id TEXT;\n    ' + extra, 1)

put('tests/case-scope.test.ts', r'''// SECURECASEDESK_FIX_L1_G1_G2 — اختبارات L1: تقييد المحقق بقسمه. تشغَّل بـ: npm run test:case-scope
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NodeDb } from './helpers/node-env';
import { buildReport, type ReportDeps } from '../src/modules/reports/reports-data';
import { ReportError } from '../src/modules/reports/reports-types';
import { resolveCaseScope, caseScopeSql, memoScopeSql, caseDepartmentAllowed } from '../src/security/case-scope';
import type { Session } from '../src/security/guard';
import { listAttachments, countAttachments, type AttachmentDeps } from '../src/modules/attachments/attachments-repo';
import { AttachmentError } from '../src/modules/attachments/attachments-types';
import { initAttachmentsSchema } from '../src/modules/attachments/attachments-schema';
import { initAuditSchema } from '../src/database/audit-schema';
import { MemoryStorage, nodeCrypto, uuid } from './helpers/node-env';

const NOW = new Date(2026, 10, 21, 12, 0, 0).getTime();
const S = (userId: string, role: string): Session => ({ userId, role: role as Session['role'] });
let db: NodeDb; let deps: ReportDeps;
const text = (d: unknown) => JSON.stringify(d);

beforeEach(async () => {
  db = new NodeDb(); deps = { db, now: () => NOW };
  await db.execAsync(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, is_active INTEGER NOT NULL DEFAULT 1, department_id TEXT);
    CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE cases (id TEXT PRIMARY KEY, case_number TEXT, title TEXT, complainant TEXT, suspects TEXT, case_type TEXT, department_id TEXT, officer_id TEXT,
      registration_date INTEGER, incident_location TEXT, incident_details TEXT, status TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE memo_types (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE memos (id TEXT PRIMARY KEY, memo_number TEXT, memo_type_id TEXT, memo_date INTEGER, recipient_organization TEXT, subject TEXT, body TEXT,
      linked_case_id TEXT, status TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE detainee_categories (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE detainees (id TEXT PRIMARY KEY, reference_number TEXT, full_name TEXT, category_id TEXT, admission_date INTEGER, release_date INTEGER,
      alleged_offense TEXT, offense_details TEXT, detaining_authority TEXT, officer_id TEXT, status TEXT, notes TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
    INSERT INTO users VALUES ('u-admin','admin','admin',1,NULL),('u-inv1','inv1','investigator',1,'d1'),('u-inv2','inv2','investigator',1,'d2'),
      ('u-nodep','nodep','investigator',1,NULL),('u-off','off','investigator',0,'d1'),('u-view','view','viewer',1,'d1'),('u-det','det','detention_viewer',1,NULL);
    INSERT INTO departments VALUES ('d1','قسم أ'),('d2','قسم ب');
    INSERT INTO cases VALUES
      ('c1','2026/1','قضية قسم أ','x','y','سرقة','d1',NULL,${NOW},'-','-','جديدة','u-admin',${NOW},${NOW}),
      ('c2','2026/2','قضية قسم ب','x','y','احتيال','d2',NULL,${NOW},'-','-','قيد التحقيق','u-admin',${NOW},${NOW}),
      ('c3','2026/3','قضية بلا قسم','x','y','اعتداء',NULL,NULL,${NOW},'-','-','جديدة','u-admin',${NOW},${NOW});
    INSERT INTO memo_types VALUES ('t1','نوع');
    INSERT INTO memos VALUES
      ('m1','م-1','t1',${NOW},'ج','مذكرة قضية أ','-','c1','مسودة','u-admin',${NOW},${NOW}),
      ('m2','م-2','t1',${NOW},'ج','مذكرة قضية ب','-','c2','مسودة','u-admin',${NOW},${NOW}),
      ('m3','م-3','t1',${NOW},'ج','مذكرة حرة','-',NULL,'مسودة','u-admin',${NOW},${NOW});
  `);
  await initAttachmentsSchema(db as never);
  await initAuditSchema(db as never);
});

describe('resolveCaseScope', () => {
  test('المدير والمطّلع: كل القضايا', async () => {
    assert.deepEqual(await resolveCaseScope(db, S('u-admin', 'admin')), { kind: 'all' });
    assert.deepEqual(await resolveCaseScope(db, S('u-view', 'viewer')), { kind: 'all' });
  });
  test('المحقق: قسمه فقط', async () => {
    assert.deepEqual(await resolveCaseScope(db, S('u-inv1', 'investigator')), { kind: 'department', departmentId: 'd1' });
  });
  test('فشل مغلق: محقق بلا قسم، حساب معطّل، مستخدم غير موجود، جلسة فارغة', async () => {
    for (const s of [S('u-nodep', 'investigator'), S('u-off', 'investigator'), S('ghost', 'investigator'), null, undefined]) {
      assert.deepEqual(await resolveCaseScope(db, s as never), { kind: 'none' });
    }
  });
  test('الدور من قاعدة البيانات لا من الجلسة: محقق يدّعي أنه admin يبقى مقيَّداً', async () => {
    assert.deepEqual(await resolveCaseScope(db, S('u-inv1', 'admin')), { kind: 'department', departmentId: 'd1' });
  });
  test('مقاطع SQL', () => {
    assert.equal(caseScopeSql({ kind: 'none' }, 'x').sql, '1 = 0');
    assert.deepEqual(caseScopeSql({ kind: 'department', departmentId: 'd1' }, 'c.department_id'), { sql: 'c.department_id = ?', args: ['d1'] });
    assert.equal(memoScopeSql({ kind: 'none' }, 'x').sql, '1 = 0');
    assert.equal(caseDepartmentAllowed({ kind: 'department', departmentId: 'd1' }, null), false);
    assert.equal(caseDepartmentAllowed({ kind: 'all' }, null), true);
  });
});

describe('التقارير تلتزم بنطاق القسم', () => {
  test('سجل القضايا: المحقق يرى قضية قسمه فقط (لا قضية قسم آخر ولا القضية بلا قسم)', async () => {
    const t = text(await buildReport(deps, S('u-inv1', 'investigator'), 'cases_list'));
    assert.ok(t.includes('2026/1')); assert.ok(!t.includes('2026/2')); assert.ok(!t.includes('2026/3'));
  });
  test('المدير يرى الثلاث', async () => {
    const t = text(await buildReport(deps, S('u-admin', 'admin'), 'cases_list'));
    for (const n of ['2026/1', '2026/2', '2026/3']) assert.ok(t.includes(n), n);
  });
  test('محقق بلا قسم لا يرى شيئاً', async () => {
    const t = text(await buildReport(deps, S('u-nodep', 'investigator'), 'cases_list'));
    for (const n of ['2026/1', '2026/2', '2026/3']) assert.ok(!t.includes(n), n);
  });
  test('ملف قضية قسم آخر: NOT_FOUND (لا كشف لوجودها)', async () => {
    await assert.rejects(buildReport(deps, S('u-inv1', 'investigator'), 'case_file', { caseId: 'c2' }),
      (e: unknown) => e instanceof ReportError && e.code === 'NOT_FOUND');
    assert.ok(text(await buildReport(deps, S('u-inv1', 'investigator'), 'case_file', { caseId: 'c1' })).includes('قضية قسم أ'));
  });
  test('سجل المذكرات: المرتبطة بقضية قسم آخر محجوبة، والحرة باقية', async () => {
    const t = text(await buildReport(deps, S('u-inv1', 'investigator'), 'memos_list'));
    assert.ok(t.includes('مذكرة قضية أ')); assert.ok(!t.includes('مذكرة قضية ب')); assert.ok(t.includes('مذكرة حرة'));
  });
  test('التقرير الإداري: أعداد المحقق ضمن قسمه', async () => {
    const t = text(await buildReport(deps, S('u-inv1', 'investigator'), 'admin_summary'));
    assert.match(t, /إجمالي القضايا[^]*?"value":"1"/);
    const a = text(await buildReport(deps, S('u-admin', 'admin'), 'admin_summary'));
    assert.match(a, /إجمالي القضايا[^]*?"value":"3"/);
  });
});


describe('المرفقات تلتزم بنطاق القسم', () => {
  const adeps = (): AttachmentDeps => ({ db, storage: new MemoryStorage(), crypto: nodeCrypto, uuid, now: () => NOW,
    async getMasterKey() { throw new Error('unused'); } });
  const notFound = (e: unknown) => e instanceof AttachmentError && e.code === 'ENTITY_NOT_FOUND';
  const inv1 = S('u-inv1', 'investigator');
  test('قضية قسم آخر: القائمة والعدّ مرفوضان كأنها غير موجودة', async () => {
    await assert.rejects(listAttachments(adeps(), inv1, 'case', 'c2'), notFound);
    await assert.rejects(countAttachments(adeps(), inv1, 'case', 'c2'), notFound);
    assert.deepEqual(await listAttachments(adeps(), inv1, 'case', 'c1'), []);
  });
  test('مذكرة مرتبطة بقضية قسم آخر مرفوضة؛ المذكرة الحرة مسموحة', async () => {
    await assert.rejects(listAttachments(adeps(), inv1, 'memo', 'm2'), notFound);
    assert.deepEqual(await listAttachments(adeps(), inv1, 'memo', 'm3'), []);
    await assert.rejects(listAttachments(adeps(), S('u-nodep', 'investigator'), 'memo', 'm3'), notFound);
  });
  test('المدير يصل للكل', async () => {
    assert.deepEqual(await listAttachments(adeps(), S('u-admin', 'admin'), 'case', 'c2'), []);
    assert.deepEqual(await listAttachments(adeps(), S('u-admin', 'admin'), 'memo', 'm2'), []);
  });
});
''')

# ════════════════════════════════════════════════════════════════
# التثبيت ثم package.json ثم الكتابة (لا يُكتب شيء قبل نجاح كل المراحل السابقة)
# ════════════════════════════════════════════════════════════════
pkg = open('package.json', encoding='utf8').read()
if '"expo-updates"' not in pkg:
    if os.environ.get('SCD_SKIP_INSTALL') == '1':
        print('  ⚠ تجاوز تثبيت expo-updates (SCD_SKIP_INSTALL=1)')
    else:
        print('▶ تثبيت expo-updates بالإصدار المتوافق مع SDK (يلزم اتصال بالإنترنت)…')
        try:
            subprocess.run(['npx', 'expo', 'install', 'expo-updates'], check=True, timeout=900)
        except Exception as e:
            die('فشل تثبيت expo-updates: %s\nلم يُكتب أي ملف. أعد المحاولة مع اتصال بالإنترنت.' % e)

pkg = load('package.json') if 'package.json' in OUT else open('package.json', encoding='utf8').read()
if 'test:case-scope' not in pkg:
    anchor = '    "test:rtl":'
    if pkg.count(anchor) != 1: die('مرساة test:rtl غير موجودة في package.json')
    OUT['package.json'] = pkg.replace(anchor, '    "test:case-scope": "tsx --tsconfig tests/tsconfig.json --test tests/case-scope.test.ts",\n' + anchor)

for path, text in OUT.items():
    d = os.path.dirname(path)
    if d: os.makedirs(d, exist_ok=True)
    if os.path.isfile(path):
        if open(path, encoding='utf8').read() == text: continue
        shutil.copy(path, path + '.bak_' + TS)
    open(path, 'w', encoding='utf8', newline='\n').write(text)
    print('  ✔ ' + path)

print('\n✔ اكتمل. الآن شغّل:\n  npx tsc --noEmit\n  npm run test:case-scope\n  npm run test:all')
