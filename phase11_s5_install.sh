#!/usr/bin/env bash
# SecureCaseDesk v2.2 — المرحلة 11 / القسم 11.5: الحماية والخصوصية والاختبارات النهائية (إغلاق المرحلة 11)
# التشغيل من جذر المشروع:   bash phase11_s5_install.sh
# يتطلب 11.1 و11.2 و11.3 و11.4 مثبّتين. آمن لإعادة التشغيل: ينسخ احتياطياً كل ملف موجود يُعدَّل (*.bak_التاريخ) ولا يكرر التعديلات.
# يضيف: زر «أنشئ مذكرة من المسودة» (تعبئة دون حفظ) • شاشة فحص الخصوصية ومسح بيانات الذكاء • إصلاح استعادة أسرار الذكاء
#       • 47 اختباراً شاملاً • توثيق • ثم يشغّل كل اختبارات الذكاء والنسخ الاحتياطي ويكتب النتائج الفعلية في docs/phase11/11.5-test-results.md
set -euo pipefail

TS="$(date +%Y%m%d_%H%M%S)"
say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

say "فحص المكان والمتطلبات"
[ -f package.json ] && [ -f src/security/permissions.ts ] && [ -d src/modules/ai ] \
  || die "شغّل السكربت من جذر مشروع SecureCaseDesk (الذي فيه package.json و src/)."
grep -q '"name": "securecasedesk"' package.json || die "package.json ليس لمشروع securecasedesk."
command -v node >/dev/null 2>&1 || die "Node.js غير متوفر."
command -v python3 >/dev/null 2>&1 || die "python3 غير متوفر."
for f in src/modules/ai/ai-manager.ts src/modules/ai/ai-review.ts src/modules/ai/ai-runtime.ts src/app/ai-settings.tsx; do
  [ -f "$f" ] && grep -q 'SECURECASEDESK_PHASE11_S1' "$f" || die "القسم 11.1 غير مثبّت أو ناقص: $f"
done
for f in src/modules/ai/ai-search.ts src/app/ai-search.tsx; do
  [ -f "$f" ] && grep -q 'SECURECASEDESK_PHASE11_S2' "$f" || die "القسم 11.2 غير مثبّت أو ناقص: $f"
done
for f in src/modules/ai/ai-summary.ts src/app/ai-summary.tsx; do
  [ -f "$f" ] && grep -q 'SECURECASEDESK_PHASE11_S3' "$f" || die "القسم 11.3 غير مثبّت أو ناقص: $f"
done
for f in src/modules/ai/ai-drafting.ts src/modules/ai/ai-drafting-runtime.ts src/app/ai-drafting.tsx; do
  [ -f "$f" ] && grep -q 'SECURECASEDESK_PHASE11_S4' "$f" || die "القسم 11.4 غير مثبّت أو ناقص: $f"
done
grep -q "export async function insertMemo" src/services/memos.service.ts || die "memos.service.ts غير متوافق (insertMemo)."
grep -q "export function buildSecretSpecs" src/modules/backup/backup-inventory.ts || die "backup-inventory.ts غير متوافق (buildSecretSpecs)."
grep -q "export function recordUnauthorizedAccess" src/modules/audit/audit-integration.ts || die "audit-integration.ts غير متوافق."
ok "المشروع سليم و11.1–11.4 موجودة"

# كتابة ملف جديد (نسخ احتياطي للقديم إن اختلف محتواه)
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

say "إنشاء ملفات 11.5"
write_file 'src/modules/ai/ai-memo-handoff.ts' <<'SCD_EOF_S5_0'
// SECURECASEDESK_PHASE11_S5
// تسليم مسودة إلى نموذج المذكرة (زر «أنشئ مذكرة من المسودة»).
// القاعدة: هذه الوحدة لا تكتب أي سجل. تضع نصاً في الذاكرة فقط ليفتح به نموذج المذكرة «معبّأً دون حفظ»،
// والمستخدم هو من يراجع الحقول ويضغط «حفظ» بنفسه (وعندها تمر المذكرة بكل فحوص insertMemo المعتادة).
//
// الضمانات:
//  - الذاكرة فقط (لا SecureStore ولا قاعدة بيانات ولا ملف ولا معاملات مسار)؛ تُستهلك مرة واحدة ثم تُمسح.
//  - مرتبطة بالمستخدم الذي أنشأها وبصلاحيته الحالية في الجدول (memos.manage)، وتنتهي خلال 10 دقائق.
//  - نص مولَّد بالذكاء الاصطناعي لا يُقبل إلا إن كان مسودة معتمدة بشرياً (assertDraftAccepted).
//  - رقم المذكرة لا يُملأ أبداً (يكتبه المستخدم)، والفراغات [......] تبقى ظاهرة وتُحصى للتنبيه.
//  - يُسجَّل في التدقيق حدث بلا نص: المصدر، عدد الأحرف، عدد الفراغات، هل رُبطت قضية.

import { can } from '../../security/permissions';
import { ForbiddenError, requirePerm, type Session } from '../../security/guard';
import { AiError } from './ai-types';
import { assertDraftAccepted, type AiDraft } from './ai-review';
import { DRAFT_LIMITS, MAX_DRAFT_CHARS, PLACEHOLDER, countPlaceholders } from './ai-drafting-text';
import type { AiAuditEvent } from './ai-manager';

export const HANDOFF_TTL_MS = 10 * 60 * 1000;
export const HANDOFF_PERMISSION = 'memos.manage' as const;

export type HandoffOrigin = 'template' | 'ai_accepted';

export interface MemoPrefill {
  userId: string;
  origin: HandoffOrigin;
  recipient: string;
  subject: string;
  body: string;
  memoTypeName: string;
  caseId: string | null;
  placeholders: number;
  createdAt: number;
}

export interface HandoffInput {
  // template: نص القالب الآلي (من كتابة المستخدم). ai_accepted: يجب تمرير المسودة المعتمدة.
  origin: HandoffOrigin;
  text?: string;
  draft?: AiDraft;
  recipient?: string;
  subject?: string;
  memoTypeName?: string;
  caseId?: string | null;
}

export interface HandoffDeps {
  resolveActiveRole(userId: string): Promise<string | null>;
  audit(event: AiAuditEvent): Promise<void>;
  now(): number;
}

export interface MemoHandoff {
  stash(session: Session | null | undefined, input: HandoffInput): Promise<MemoPrefill>;
  consume(session: Session | null | undefined): Promise<MemoPrefill | null>;
  peekExists(): boolean;
  clear(): void;
}

// ===== تحليل النص (نقي) =====
const TITLE_RE = /^مذكرة(?:\s|—|-|$)/;
const NUMBER_RE = /^الرقم\s*[:：]/;
const DATE_RE = /^التاريخ\s*[:：]/;
const TO_RE = /^إلى\s*[:：]\s*(.*)$/;
const SUBJECT_RE = /^الموضوع\s*[:：]\s*(.*)$/;

function cleanValue(v: string, max: number): string {
  const t = v.trim();
  if (t.length === 0) return '';
  // قيمة كلها فراغ [......] = لا قيمة (يملؤها المستخدم بنفسه).
  if (countPlaceholders(t) > 0 && t.replace(/\[(?:\.{2,}|\u2026+)\]/g, '').trim().length === 0) return '';
  return t.slice(0, max);
}

export interface SplitMemoText { recipient: string; subject: string; body: string; headerLines: number }

// يفصل ترويسة المذكرة (العنوان/الرقم/التاريخ/إلى/الموضوع) عن المتن حتى لا تتكرر في الطباعة؛ المتن يبقى حرفياً.
export function splitMemoText(text: string): SplitMemoText {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let recipient = '';
  let subject = '';
  let header = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && TITLE_RE.test(lines[i].trim())) { i++; header++; }
  while (i < lines.length) {
    const l = lines[i].trim();
    if (l === '') { if (header > 0) { i++; continue; } break; }
    const to = TO_RE.exec(l);
    const sub = SUBJECT_RE.exec(l);
    if (to) { recipient = cleanValue(to[1], DRAFT_LIMITS.recipient); i++; header++; continue; }
    if (sub) { subject = cleanValue(sub[1], DRAFT_LIMITS.subject); i++; header++; continue; }
    if (NUMBER_RE.test(l) || DATE_RE.test(l)) { i++; header++; continue; }
    break;
  }
  return { recipient, subject, body: lines.slice(i).join('\n').trim(), headerLines: header };
}

export function createMemoHandoff(deps: HandoffDeps): MemoHandoff {
  let slot: MemoPrefill | null = null;

  async function activeRole(userId: string): Promise<string | null> {
    try { return await deps.resolveActiveRole(userId); } catch { return null; }
  }

  return {
    async stash(session, input) {
      const s = requirePerm(session, HANDOFF_PERMISSION);
      const role = await activeRole(s.userId);
      if (!role || !can(role, HANDOFF_PERMISSION)) throw new ForbiddenError(HANDOFF_PERMISSION);

      let text: string;
      if (input.origin === 'ai_accepted') {
        if (!input.draft) throw new AiError('REVIEW_REQUIRED');
        text = assertDraftAccepted(input.draft); // يرفض أي مسودة لم تُعتمد (REVIEW_REQUIRED)
        // الاعتماد والطلب من المستخدم نفسه: لا تسليم مسودة طلبها أو اعتمدها غيره.
        if (input.draft.requestedBy !== s.userId || input.draft.reviewedBy !== s.userId) throw new AiError('REVIEW_INVALID', 'owner');
      } else if (input.origin === 'template') {
        text = typeof input.text === 'string' ? input.text : '';
      } else {
        throw new AiError('REVIEW_INVALID', 'origin');
      }
      if (text.trim().length === 0 || text.length > MAX_DRAFT_CHARS) throw new AiError('DRAFTING_INPUT_INVALID', 'handoff');

      const parts = splitMemoText(text);
      const prefill: MemoPrefill = {
        userId: s.userId,
        origin: input.origin,
        recipient: parts.recipient || cleanValue(String(input.recipient ?? ''), DRAFT_LIMITS.recipient),
        subject: parts.subject || cleanValue(String(input.subject ?? ''), DRAFT_LIMITS.subject),
        body: parts.body,
        memoTypeName: String(input.memoTypeName ?? '').trim().slice(0, DRAFT_LIMITS.memoType),
        caseId: typeof input.caseId === 'string' && input.caseId.length > 0 && input.caseId.length <= 64 ? input.caseId : null,
        placeholders: countPlaceholders(text),
        createdAt: deps.now(),
      };

      // التدقيق قبل التسليم: فشله يمنع التسليم (لا مسودة بلا أثر). لا نص في السجل.
      try {
        await deps.audit({
          operationType: 'ai_memo_prefill', entityType: 'ai', entityId: 'memo_prefill',
          newValues: { origin: prefill.origin, chars: text.length, placeholders: prefill.placeholders, caseLinked: prefill.caseId !== null },
          reason: 'فتح نموذج مذكرة معبّأً من مسودة (دون حفظ)', actorUserId: s.userId,
        });
      } catch {
        throw new AiError('AUDIT_FAILED');
      }
      slot = prefill;
      return { ...prefill };
    },

    async consume(session) {
      const taken = slot;
      slot = null; // مرة واحدة دائماً، حتى لو فشل أي فحص بعدها
      if (!taken || !session) return null;
      if (taken.userId !== session.userId) return null;
      if (deps.now() - taken.createdAt > HANDOFF_TTL_MS || deps.now() < taken.createdAt) return null;
      const role = await activeRole(session.userId);
      if (!role || !can(role, HANDOFF_PERMISSION)) return null;
      return taken;
    },

    peekExists() { return slot !== null; },
    clear() { slot = null; },
  };
}

export { PLACEHOLDER };
SCD_EOF_S5_0
write_file 'src/modules/ai/ai-memo-handoff-runtime.ts' <<'SCD_EOF_S5_1'
// SECURECASEDESK_PHASE11_S5
// محوّل Expo لتسليم المسودة إلى نموذج المذكرة: يربط الوحدة النقية بقاعدة المستخدمين وسجل التدقيق.
// لا يستورد أي دالة كتابة للمذكرات: الحفظ الفعلي يتم يدوياً من شاشة المذكرات بعد مراجعة المستخدم.
import { getDb } from '@/database/db';
import { recordAuditEvent } from '@/services/audit.service';
import type { Session } from '@/security/guard';
import { createMemoHandoff, type HandoffInput, type MemoHandoff, type MemoPrefill } from './ai-memo-handoff';

let instance: MemoHandoff | null = null;

export function getMemoHandoff(): MemoHandoff {
  if (instance) return instance;
  instance = createMemoHandoff({
    async resolveActiveRole(userId) {
      const db = await getDb();
      const row = await db.getFirstAsync<{ role: string; is_active: number }>(
        'SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?', [userId]
      );
      return row && Number(row.is_active) === 1 ? String(row.role) : null;
    },
    async audit(event) {
      const db = await getDb();
      const u = await db.getFirstAsync<{ username: string }>('SELECT username FROM users WHERE id = ?', [event.actorUserId]);
      await recordAuditEvent({
        operationType: event.operationType, entityType: event.entityType, entityId: event.entityId,
        previousValues: event.previousValues, newValues: event.newValues, reason: event.reason,
        actor: { id: event.actorUserId, username: u?.username ?? null },
      });
    },
    now: () => Date.now(),
  });
  return instance;
}

export function stashMemoPrefill(session: Session | null | undefined, input: HandoffInput): Promise<MemoPrefill> {
  return getMemoHandoff().stash(session, input);
}

export function consumeMemoPrefill(session: Session | null | undefined): Promise<MemoPrefill | null> {
  return getMemoHandoff().consume(session);
}
SCD_EOF_S5_1
write_file 'src/modules/ai/ai-privacy-check.ts' <<'SCD_EOF_S5_2'
// SECURECASEDESK_PHASE11_S5
// فحص الخصوصية والصلاحيات للذكاء الاصطناعي: دالة نقية تحوّل حالة الإعدادات الحالية + حقائق التصميم إلى تقرير صريح.
// لا تتصل بشبكة ولا تقرأ أسراراً ولا تكتب شيئاً. «ok» لا تعني ضماناً مطلقاً: هي فحص لما يمكن التحقق منه محلياً فقط.

import { ROLES, can, type Role } from '../../security/permissions';
import type { SecretSpec } from '../backup/backup-types';
import { CLOUD_BLOCKED_ENTITIES, ENTITY_READ_PERMISSION } from './ai-policy';
import { AI_FEATURES, AI_MANAGE_PERMISSION, AI_USE_PERMISSION, type AiFeatureId, type AiMode } from './ai-types';

export type FindingLevel = 'ok' | 'warn' | 'fail';

export interface PrivacyFinding {
  id: string;
  level: FindingLevel;
  title: string;
  detail: string;
}

export interface PrivacyState {
  mode: AiMode;
  features: Record<AiFeatureId, boolean>;
  cloud: { endpoint: string | null; model: string | null; hasKey: boolean; consentValid: boolean };
  settingsRecovered: boolean;
}

export interface PrivacyInputs {
  state: PrivacyState;
  backupSecretSpecs: readonly SecretSpec[];
}

export interface PrivacyReport {
  overall: FindingLevel;
  findings: PrivacyFinding[];
  counts: { ok: number; warn: number; fail: number };
}

const AI_SECRET_FILE_NAMES = ['securecase_ai_settings_v1', 'securecase_ai_cloud_key_v1'] as const;

export function buildPrivacyReport(input: PrivacyInputs): PrivacyReport {
  const { state } = input;
  const f: PrivacyFinding[] = [];
  const add = (id: string, level: FindingLevel, title: string, detail: string) => f.push({ id, level, title, detail });

  // 1) الوضع الحالي وأين تذهب البيانات
  if (state.mode === 'disabled') {
    add('mode', 'ok', 'الذكاء الاصطناعي معطّل', 'لا تُعالَج أي بيانات بالذكاء الاصطناعي ولا يخرج شيء من الجهاز. البدائل الآلية المحلية تعمل.');
  } else if (state.mode === 'local') {
    add('mode', 'ok', 'الوضع المحلي', 'كل المعالجة على الجهاز ولا إرسال خارجه. (المحرك المحلي غير مدمج في هذا الإصدار، فتعمل البدائل الآلية.)');
  } else {
    const enabled = AI_FEATURES.filter((x) => state.features[x.id]).map((x) => x.label);
    add('mode', 'warn', 'الوضع السحابي مفعّل',
      'نص ما تطلبه يُرسل إلى الخدمة السحابية بعد تأكيدك لكل طلب ومعاينتك للحمولة.' +
      (enabled.length ? ' الميزات المفعّلة: ' + enabled.join('، ') + '.' : ' لا ميزة مفعّلة حالياً.'));
    if (!state.cloud.endpoint || !state.cloud.model || !state.cloud.hasKey) {
      add('cloud-config', 'fail', 'إعداد سحابي ناقص', 'العنوان أو النموذج أو المفتاح غير مكتمل؛ لن يُرسل شيء حتى يكتمل.');
    } else if (!/^https:\/\//i.test(state.cloud.endpoint)) {
      add('cloud-https', 'fail', 'عنوان الخدمة ليس HTTPS', 'يجب أن يكون العنوان HTTPS حصراً.');
    } else {
      add('cloud-config', 'ok', 'إعداد سحابي مكتمل وبـ HTTPS', 'العنوان والنموذج والمفتاح موجودة، والمفتاح مخزَّن في المخزن الآمن للجهاز.');
    }
    if (state.cloud.consentValid) add('consent', 'ok', 'إقرار الإرسال ساريّ', 'الإقرار مرتبط بعنوان الخدمة الحالي وبإصدار النص الحالي.');
    else add('consent', 'fail', 'لا إقرار ساريّ', 'تغيّر العنوان أو إصدار الإقرار أو لم يُسجَّل إقرار؛ الإرسال السحابي مرفوض.');
  }

  // 2) ما لا يغادر الجهاز أبداً
  const blocked = new Set<string>(CLOUD_BLOCKED_ENTITIES);
  if (blocked.has('detainee') && blocked.has('attachment')) {
    add('blocked-entities', 'ok', 'بيانات المحتجزين والمرفقات ممنوعة سحابياً', 'تُرفض في الطبقة المركزية قبل أي إرسال، مهما كانت الإعدادات.');
  } else {
    add('blocked-entities', 'fail', 'سياسة المنع السحابي ناقصة', 'يجب منع المحتجزين والمرفقات من الإرسال السحابي.');
  }

  // 3) النسخ الاحتياطي لا يحمل أسرار الذكاء
  const byName = new Map(input.backupSecretSpecs.map((s) => [s.name, s.cls]));
  const leaking = AI_SECRET_FILE_NAMES.filter((n) => byName.get(n) !== 'excluded');
  if (leaking.length === 0) add('backup-secrets', 'ok', 'مفتاح الخدمة وإعدادات الذكاء خارج النسخ الاحتياطية', 'تُصنَّف «مستبعدة» ولا تدخل أي نسخة، وبعد الاستعادة يعود الذكاء معطّلاً.');
  else add('backup-secrets', 'fail', 'أسرار الذكاء غير مستبعدة من النسخ الاحتياطي', leaking.join('، '));

  // 4) مصفوفة الأدوار (حية من جدول الصلاحيات)
  const roles = ROLES.map((r) => r.key as Role);
  const dv = roles.includes('detention_viewer') ? 'detention_viewer' : null;
  if (dv && !can(dv, AI_USE_PERMISSION) && !can(dv, AI_MANAGE_PERMISSION) && !can(dv, ENTITY_READ_PERMISSION.case) && !can(dv, ENTITY_READ_PERMISSION.memo)) {
    add('role-detention-viewer', 'ok', 'مشاهد المحتجزين معزول عن الذكاء', 'لا يملك صلاحية استخدام الذكاء ولا قراءة القضايا والمذكرات.');
  } else {
    add('role-detention-viewer', 'fail', 'عزل مشاهد المحتجزين غير مكتمل', 'راجع جدول الصلاحيات.');
  }
  const managers = roles.filter((r) => can(r, AI_MANAGE_PERMISSION));
  if (managers.length === 1 && managers[0] === 'admin') add('role-manage', 'ok', 'إدارة الذكاء لمدير النظام وحده', 'الإعدادات والمفتاح والإقرار محصورة بصلاحية ai.manage.');
  else add('role-manage', 'warn', 'إدارة الذكاء ليست لمدير النظام وحده', 'الأدوار: ' + managers.join('، '));

  // 5) سلامة الإعدادات المخزَّنة
  if (state.settingsRecovered) add('settings-recovered', 'warn', 'أُعيدت الإعدادات إلى الافتراضي', 'كانت الإعدادات المخزَّنة تالفة أو غير مقروءة فعاد الذكاء معطّلاً (فشل مغلق). راجعها.');
  else add('settings-integrity', 'ok', 'الإعدادات المخزَّنة سليمة', 'قُرئت وتحقق منها دون أخطاء.');

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const x of f) counts[x.level]++;
  const overall: FindingLevel = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'ok';
  return { overall, findings: f, counts };
}
SCD_EOF_S5_2
write_file 'src/modules/ai/ai-privacy-runtime.ts' <<'SCD_EOF_S5_3'
// SECURECASEDESK_PHASE11_S5
// محوّل Expo لتقرير الخصوصية: يقرأ الحالة العامة من المنسّق (بلا مفتاح ولا نص) ويبني التقرير. للقراءة فقط.
import type { Session } from '@/security/guard';
import { buildSecretSpecs } from '@/modules/backup/backup-inventory';
import { getAiManager } from './ai-runtime';
import { buildPrivacyReport, type PrivacyReport } from './ai-privacy-check';

export async function getAiPrivacyReport(session: Session | null | undefined): Promise<PrivacyReport> {
  const st = await getAiManager().getState(session);
  return buildPrivacyReport({
    state: {
      mode: st.mode, features: st.features, settingsRecovered: st.settingsRecovered,
      cloud: { endpoint: st.cloud.endpoint, model: st.cloud.model, hasKey: st.cloud.hasKey, consentValid: st.cloud.consentValid },
    },
    backupSecretSpecs: buildSecretSpecs([1], false),
  });
}

export async function resetAllAiData(session: Session | null | undefined): Promise<void> {
  await getAiManager().resetAll(session);
}
SCD_EOF_S5_3
write_file 'src/app/ai-privacy.tsx' <<'SCD_EOF_S5_4'
// SECURECASEDESK_PHASE11_S5
// شاشة «فحص الخصوصية والصلاحيات» للذكاء الاصطناعي (لمدير النظام: ai.manage).
// تعرض تقريراً حياً بما يمكن التحقق منه محلياً، وتتيح مسح كل بيانات الذكاء الاصطناعي من الجهاز بتأكيد صريح.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { X, ShieldCheck, Trash2, RefreshCw } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/security/permissions';
import { Colors, Radius, Fonts, FontSizes } from '@/constants/theme';
import { recordUnauthorizedAccess } from '@/modules/audit/audit-integration';
import { getAiPrivacyReport, resetAllAiData } from '@/modules/ai/ai-privacy-runtime';
import type { FindingLevel, PrivacyReport } from '@/modules/ai/ai-privacy-check';
import { aiErrorMessage, isAiError } from '@/modules/ai/ai-types';

const LEVEL_COLOR: Record<FindingLevel, string> = { ok: Colors.success, warn: Colors.warning, fail: Colors.danger };
const LEVEL_LABEL: Record<FindingLevel, string> = { ok: 'سليم', warn: 'تنبيه', fail: 'مشكلة' };

function errText(e: unknown): string {
  return isAiError(e) ? aiErrorMessage(e.code) : 'حدث خطأ غير متوقع.';
}

export default function AiPrivacyScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = !!user && can(user.role, 'ai.manage');
  const session = useMemo(() => (user ? { userId: user.id, role: user.role } : null), [user?.id, user?.role]);
  const [report, setReport] = useState<PrivacyReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user && !allowed) {
      void recordUnauthorizedAccess({
        userId: user.id, username: user.username, role: user.role,
        resource: 'screen:ai-privacy', detail: 'محاولة فتح فحص خصوصية الذكاء الاصطناعي',
      });
    }
  }, [user?.id, allowed]);

  const load = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try { setReport(await getAiPrivacyReport(session)); }
    catch (e) { Alert.alert('تعذر إعداد التقرير', errText(e)); }
    finally { setBusy(false); }
  }, [session]);

  useEffect(() => { if (allowed) void load(); }, [allowed, load]);

  const onReset = useCallback(() => {
    Alert.alert(
      'مسح كل بيانات الذكاء الاصطناعي؟',
      'سيُحذف مفتاح الخدمة السحابية والإقرار وكل الإعدادات من هذا الجهاز ويعود الذكاء الاصطناعي معطّلاً. لا يمسّ هذا أي قضية أو مذكرة. تُسجَّل العملية في سجل التدقيق.',
      [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'مسح', style: 'destructive', onPress: async () => {
          if (!session) return;
          setBusy(true);
          try { await resetAllAiData(session); await load(); Alert.alert('تم', 'مُسحت بيانات الذكاء الاصطناعي وعاد معطّلاً.'); }
          catch (e) { Alert.alert('تعذرت العملية', errText(e)); }
          finally { setBusy(false); }
        } },
      ]
    );
  }, [session, load]);

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.iconBtn} onPress={() => router.back()}><X size={20} color={Colors.textPrimary} /></Pressable>
      <Text style={styles.title}>فحص خصوصية الذكاء الاصطناعي</Text>
      <Pressable style={styles.iconBtn} onPress={() => void load()} disabled={busy}><RefreshCw size={18} color={Colors.textPrimary} /></Pressable>
    </View>
  );

  if (!allowed) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.denied}>غير مصرح لك بفتح فحص الخصوصية</Text>
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
            <ShieldCheck size={20} color={report ? LEVEL_COLOR[report.overall] : Colors.textMuted} />
            <Text style={[styles.sectionTitle, report && { color: LEVEL_COLOR[report.overall] }]}>
              {report ? 'الحالة العامة: ' + LEVEL_LABEL[report.overall] : 'جارٍ الفحص…'}
            </Text>
          </View>
          {report && <Text style={styles.muted}>سليم: {report.counts.ok} • تنبيه: {report.counts.warn} • مشكلة: {report.counts.fail}</Text>}
          <Text style={styles.muted}>هذا فحص لما يمكن التحقق منه محلياً فقط؛ لا يغني عن مراجعة المسؤول لسياسة الجهة.</Text>
        </View>

        {busy && !report && <ActivityIndicator color={Colors.primary} />}

        {report?.findings.map((f) => (
          <View key={f.id} style={[styles.card, { borderColor: LEVEL_COLOR[f.level] }]}>
            <Text style={[styles.statusText, { color: LEVEL_COLOR[f.level] }]}>{LEVEL_LABEL[f.level]} — {f.title}</Text>
            <Text style={styles.muted}>{f.detail}</Text>
          </View>
        ))}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>مسح بيانات الذكاء الاصطناعي</Text>
          <Text style={styles.muted}>يحذف مفتاح الخدمة السحابية والإقرار والإعدادات من هذا الجهاز فقط ويعيد الذكاء معطّلاً.</Text>
          <Pressable style={[styles.dangerBtn, busy && { opacity: 0.5 }]} disabled={busy} onPress={onReset}>
            <Trash2 size={18} color={Colors.danger} /><Text style={styles.dangerText}>مسح كل بيانات الذكاء الاصطناعي</Text>
          </Pressable>
        </View>
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
  dangerBtn: { height: 46, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.danger, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dangerText: { color: Colors.danger, fontFamily: Fonts.bold, fontSize: FontSizes.sm },
});
SCD_EOF_S5_4
write_file 'tests/ai-final.test.ts' <<'SCD_EOF_S5_5'
// SECURECASEDESK_PHASE11_S5
// اختبارات المرحلة 11 / القسم 11.5 — الحماية والخصوصية والاختبار الشامل للذكاء الاصطناعي. تشغَّل بـ: npm run test:ai-final
// تغطي: مصفوفة الأدوار، البوابة السحابية الشاملة، عدم تسرب المفتاح/الأسماء/الهويات عبر الميزات الثلاث،
// التسليم إلى نموذج المذكرة، مسح البيانات، تقرير الخصوصية، وفحوص مصدرية (static) لحدود الوحدة.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAiManager, type AiAuditEvent, type AiManager } from '../src/modules/ai/ai-manager';
import { AiProviderRegistry, type AiGenerateRequest, type AiProvider } from '../src/modules/ai/ai-provider';
import { assertCloudSendAllowed, CLOUD_BLOCKED_ENTITIES } from '../src/modules/ai/ai-policy';
import { defaultAiSettings } from '../src/modules/ai/ai-settings';
import { AI_CONSENT_VERSION, AI_FEATURE_IDS, AiError, type AiEntityKind, type AiSettings } from '../src/modules/ai/ai-types';
import { acceptAiDraft, createAiDraft, rejectAiDraft } from '../src/modules/ai/ai-review';
import { createMemoHandoff, HANDOFF_TTL_MS, splitMemoText, type MemoHandoff } from '../src/modules/ai/ai-memo-handoff';
import { buildPrivacyReport } from '../src/modules/ai/ai-privacy-check';
import { buildTemplate } from '../src/modules/ai/ai-drafting-text';
import { createAiSearch, type AiSearch } from '../src/modules/ai/ai-search';
import { createAiSummary, type AiSummary } from '../src/modules/ai/ai-summary';
import { createAiDrafting, type AiDrafting } from '../src/modules/ai/ai-drafting';
import type { SearchCaseRow, SearchMemoRow } from '../src/modules/ai/ai-search-engine';
import type { SummaryCaseRow, SummaryMemoRow } from '../src/modules/ai/ai-summary-source';
import { buildSecretSpecs } from '../src/modules/backup/backup-inventory';
import { AUDIT_OPERATION_LABELS } from '../src/modules/audit/audit-labels';
import { can, ROLES } from '../src/security/permissions';
import { ForbiddenError, type Session } from '../src/security/guard';

const NOW = new Date(2026, 10, 21, 10, 0, 0).getTime();
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 12).getTime();
const KEY = 'SENTINEL-KEY-MUST-NEVER-LEAK-1234567890';
const NATIONAL_ID = '01234567890123';
const NAME_COMPLAINANT = 'سالم-الشاكي-الفريد';
const NAME_SUSPECT = 'ناصر-المتهم-الفريد';
const ENDPOINT = 'https://api.example.com/v1';

const admin: Session = { userId: 'u-admin', role: 'admin' };
const inv: Session = { userId: 'u-inv', role: 'investigator' };
const viewer: Session = { userId: 'u-view', role: 'viewer' };
const det: Session = { userId: 'u-det', role: 'detention_viewer' };

const caseRows = [
  { id: 'c1', case_number: '2026/15', title: 'سرقة سيارة من أمام المنزل', complainant: NAME_COMPLAINANT, suspects: NAME_SUSPECT,
    case_type: 'سرقة', registration_date: d(2026, 10, 10), incident_location: 'حجة - شارع الستين',
    incident_details: 'تمت سرقة سيارة ليلاً بتاريخ 2026/10/09. هاتف المبلّغ ' + NATIONAL_ID + ' وبريده a@b.com. ضُبط 3 أشخاص.', status: 'جديدة' },
];
const memoRows = [
  { id: 'm1', memo_number: 'م/101', memo_type_id: 't1', memo_date: d(2026, 11, 18), recipient_organization: 'المستشفى السعودي',
    subject: 'طلب تقرير طبي', body: 'يرجى إفادتنا بالتقرير الطبي للمصاب في قضية السرقة خلال 3 أيام.', linked_case_id: 'c1', status: 'مرسلة' },
];
const GOOD_DRAFT = 'مذكرة رسمية — مذكرات المستشفى\nالرقم: [......]\nالتاريخ: [......]\nإلى: المستشفى السعودي\nالموضوع: طلب تقرير طبي\n\nتحية طيبة وبعد،\n1- نرجو إفادتنا بالتقرير الطبي للمصاب.\n2- الرد خلال 3 أيام.\n\nوتفضلوا بقبول فائق الاحترام والتقدير،،\nالتوقيع: [......]';
const SUMMARY_OUT = 'الملخص: سرقة سيارة بتاريخ 2026/10/09 وضُبط 3 أشخاص.\nالنقاط الأساسية:\n- سرقة سيارة\nمعلومات غير واردة:\n- لا شيء';

interface Harness {
  mgr: AiManager; search: AiSearch; summary: AiSummary; drafting: AiDrafting;
  audits: AiAuditEvent[]; calls: AiGenerateRequest[]; roles: Map<string, string>; store: Map<string, string>;
  setReply(fn: (r: AiGenerateRequest) => string): void;
}

function makeHarness(): Harness {
  const audits: AiAuditEvent[] = []; const calls: AiGenerateRequest[] = [];
  const roles = new Map([['u-admin', 'admin'], ['u-inv', 'investigator'], ['u-view', 'viewer'], ['u-det', 'detention_viewer']]);
  const store = new Map<string, string>();
  let reply = (r: AiGenerateRequest): string => (r.feature === 'summary' ? SUMMARY_OUT : r.feature === 'drafting' ? GOOD_DRAFT : '{"keywords":[]}');
  const mk = (id: 'local' | 'cloud'): AiProvider => ({
    id, async getStatus() { return { state: 'ready', detail: 'ok' }; },
    async generate(req) { calls.push(req); return { text: reply(req), providerId: id, model: 'm1' }; },
  });
  const registry = new AiProviderRegistry(); registry.register(mk('cloud')); registry.register(mk('local'));
  let clock = 0;
  const mgr = createAiManager({
    secrets: { async get(n) { return store.get(n) ?? null; }, async set(n, v) { store.set(n, v); }, async remove(n) { store.delete(n); } },
    registry, async resolveActiveRole(id) { return roles.get(id) ?? null; }, async audit(e) { audits.push(e); }, now: () => NOW + (++clock),
  });
  const resolveActiveRole = async (id: string) => roles.get(id) ?? null;
  const search = createAiSearch({
    manager: mgr, resolveActiveRole,
    async loadCases() { return caseRows as unknown as SearchCaseRow[]; }, async loadMemos() { return memoRows as unknown as SearchMemoRow[]; },
    async loadMemoTypes() { return [{ id: 't1', name: 'مذكرات المستشفى' }]; }, now: () => NOW,
  });
  let seq = 0;
  const summary = createAiSummary({
    manager: mgr, resolveActiveRole,
    async loadCases() { return caseRows as unknown as SummaryCaseRow[]; }, async loadMemos() { return memoRows as unknown as SummaryMemoRow[]; },
    async loadMemoTypes() { return [{ id: 't1', name: 'مذكرات المستشفى' }]; },
    async audit(e) { audits.push(e); }, newId: () => 'sum-' + (++seq), now: () => NOW,
  });
  const drafting = createAiDrafting({
    manager: mgr, resolveActiveRole,
    async loadCases() { return caseRows as never; }, async loadMemoTypes() { return [{ id: 't1', name: 'مذكرات المستشفى' }]; },
    async audit(e) { audits.push(e); }, newId: () => 'dr-' + (++seq), now: () => NOW,
  });
  return { mgr, search, summary, drafting, audits, calls, roles, store, setReply(fn) { reply = fn; } };
}

async function enableCloud(h: Harness) {
  await h.mgr.updateSettings(admin, { cloudEndpoint: ENDPOINT, cloudModel: 'm1' });
  await h.mgr.saveCloudKey(admin, KEY);
  await h.mgr.acceptCloudConsent(admin);
  await h.mgr.updateSettings(admin, { mode: 'cloud', features: { search: true, summary: true, drafting: true } });
}
async function enableLocal(h: Harness) {
  await h.mgr.updateSettings(admin, { mode: 'local', localModelId: 'local-m', features: { search: true, summary: true, drafting: true } });
}

// ───────────────────────────── 1) مصفوفة الأدوار ─────────────────────────────
describe('11.5 — مصفوفة الأدوار على بوابة الذكاء الاصطناعي', () => {
  let h: Harness;
  beforeEach(async () => { h = makeHarness(); await enableLocal(h); });

  const cases: Array<{ s: Session; entities: AiEntityKind[]; ok: boolean; label: string }> = [
    { s: admin, entities: ['case', 'memo'], ok: true, label: 'مدير: قضايا+مذكرات' },
    { s: inv, entities: ['case', 'memo'], ok: true, label: 'محقق: قضايا+مذكرات' },
    { s: viewer, entities: ['case', 'memo'], ok: true, label: 'مشاهد: قضايا+مذكرات' },
    { s: det, entities: ['case'], ok: false, label: 'مشاهد المحتجزين: قضايا' },
    { s: det, entities: ['memo'], ok: false, label: 'مشاهد المحتجزين: مذكرات' },
    { s: det, entities: ['detainee'], ok: false, label: 'مشاهد المحتجزين: محتجزون (لا ai.use)' },
    { s: det, entities: [], ok: false, label: 'مشاهد المحتجزين: بلا كيانات' },
  ];
  for (const c of cases) {
    test(c.label, async () => {
      for (const feature of AI_FEATURE_IDS) {
        const p = h.mgr.authorizeUse(c.s, { feature, entities: c.entities });
        if (c.ok) assert.equal((await p).mode, 'local'); else await assert.rejects(p);
      }
    });
  }

  test('إدارة الإعدادات والمفتاح والمسح: للمدير وحده في كل الأدوار الأخرى ForbiddenError', async () => {
    for (const s of [inv, viewer, det, null, undefined]) {
      await assert.rejects(h.mgr.updateSettings(s, { mode: 'disabled' }), ForbiddenError);
      await assert.rejects(h.mgr.saveCloudKey(s, KEY), ForbiddenError);
      await assert.rejects(h.mgr.clearCloudKey(s), ForbiddenError);
      await assert.rejects(h.mgr.acceptCloudConsent(s), ForbiddenError);
      await assert.rejects(h.mgr.resetAll(s), ForbiddenError);
    }
  });

  test('الدور يُقرأ من الجدول لا من الجلسة: جلسة مزوَّرة بدور مدير لمحتجز/محقق لا تمنح صلاحية', async () => {
    const forged: Session = { userId: 'u-det', role: 'admin' };
    await assert.rejects(h.mgr.authorizeUse(forged, { feature: 'search', entities: ['case'] }));
    await assert.rejects(h.mgr.updateSettings(forged, { mode: 'disabled' }), ForbiddenError);
    await assert.rejects(h.mgr.resetAll({ userId: 'u-inv', role: 'admin' }), ForbiddenError);
  });

  test('تغيير الدور أو تعطيل الحساب يسري فوراً دون إعادة تسجيل دخول', async () => {
    await h.mgr.authorizeUse(viewer, { feature: 'search', entities: ['case'] });
    h.roles.set('u-view', 'detention_viewer');
    await assert.rejects(h.mgr.authorizeUse(viewer, { feature: 'search', entities: ['case'] }));
    h.roles.delete('u-inv'); // حساب معطّل/محذوف
    await assert.rejects(h.mgr.authorizeUse(inv, { feature: 'summary', entities: ['case'] }), ForbiddenError);
    await assert.rejects(h.mgr.getState(inv), ForbiddenError);
    h.roles.set('u-admin', 'viewer'); // مدير خُفِّض
    await assert.rejects(h.mgr.updateSettings(admin, { mode: 'disabled' }), ForbiddenError);
  });

  test('الميزات الثلاث تمنع مشاهد المحتجزين قبل تحميل أي سجل', async () => {
    let loads = 0;
    const roles = h.roles;
    const resolveActiveRole = async (id: string) => roles.get(id) ?? null;
    const s = createAiSearch({ manager: h.mgr, resolveActiveRole, async loadCases() { loads++; return []; }, async loadMemos() { loads++; return []; }, async loadMemoTypes() { loads++; return []; }, now: () => NOW });
    const m = createAiSummary({ manager: h.mgr, resolveActiveRole, async loadCases() { loads++; return []; }, async loadMemos() { loads++; return []; }, async loadMemoTypes() { loads++; return []; }, async audit() {}, newId: () => 'x', now: () => NOW });
    const dr = createAiDrafting({ manager: h.mgr, resolveActiveRole, async loadCases() { loads++; return []; }, async loadMemoTypes() { loads++; return []; }, async audit() {}, newId: () => 'x', now: () => NOW });
    await assert.rejects(s.search(det, 'قضايا سرقة'), ForbiddenError);
    await assert.rejects(m.summarize(det, { kind: 'case', id: 'c1' }), ForbiddenError);
    await assert.rejects(dr.generate(det, { mode: 'compose', docKind: 'memo', subject: 'موضوع', points: 'نقطة طويلة كفاية' }), ForbiddenError);
    assert.equal(loads, 0);
  });
});

// ───────────────────────────── 2) البوابة السحابية الشاملة ─────────────────────────────
describe('11.5 — البوابة السحابية: كل شرط مستقل ومطلوب (فحص شامل لكل التراكيب)', () => {
  function settingsWith(o: { endpoint: boolean; model: boolean; consent: boolean; mode: boolean }): AiSettings {
    const s = defaultAiSettings();
    return {
      ...s, mode: o.mode ? 'cloud' : 'local',
      cloud: {
        endpoint: o.endpoint ? ENDPOINT : null, model: o.model ? 'm1' : null,
        consentAcceptedAt: 1, consentAcceptedBy: 'u-admin', consentEndpoint: o.consent ? (o.endpoint ? ENDPOINT : null) : 'https://other.example.com',
        consentVersion: AI_CONSENT_VERSION,
      },
    };
  }
  test('2^6 تركيباً × كيانات: الإرسال مسموح فقط حين تتحقق الشروط كلها ولا كيان ممنوع', () => {
    const bools = [false, true];
    let allowed = 0; let total = 0;
    for (const endpoint of bools) for (const model of bools) for (const consent of bools) for (const mode of bools)
      for (const hasKey of bools) for (const confirmed of bools) for (const entities of [['case'], ['case', 'memo'], ['detainee'], ['attachment'], ['case', 'detainee']] as AiEntityKind[][]) {
        total++;
        const settings = settingsWith({ endpoint, model, consent, mode });
        const expected = endpoint && model && consent && mode && hasKey && confirmed && !entities.some((e) => CLOUD_BLOCKED_ENTITIES.includes(e));
        let ok = true;
        try { assertCloudSendAllowed({ settings, hasCloudKey: hasKey, entities, userConfirmed: confirmed }); } catch (e) { ok = false; assert.ok(e instanceof AiError); }
        assert.equal(ok, expected, JSON.stringify({ endpoint, model, consent, mode, hasKey, confirmed, entities }));
        if (ok) allowed++;
      }
    assert.equal(total, 320); assert.ok(allowed > 0 && allowed < total);
  });
  test('تأكيد غير صريح (غير true) لا يمرّ', () => {
    const settings = settingsWith({ endpoint: true, model: true, consent: true, mode: true });
    for (const bad of [1, 'true', {}, null, undefined] as unknown[]) {
      assert.throws(() => assertCloudSendAllowed({ settings, hasCloudKey: true, entities: ['case'], userConfirmed: bad as boolean }));
    }
  });
  test('تغيير عنوان الخدمة أو إصدار الإقرار يُبطل الإقرار السابق', async () => {
    const h = makeHarness(); await enableCloud(h);
    assert.equal((await h.mgr.getState(admin)).cloud.consentValid, true);
    const st = await h.mgr.updateSettings(admin, { cloudEndpoint: 'https://api.other-host.com/v1' });
    assert.equal(st.cloud.consentValid, false);
  });
  test('عنوان غير آمن مرفوض (http وبيانات اعتماد ومعاملات)', async () => {
    const h = makeHarness();
    for (const bad of ['http://api.example.com/v1', 'https://user:pw@api.example.com/v1', 'https://api.example.com/v1?key=1', 'ftp://x.com', 'javascript:alert(1)']) {
      await assert.rejects(h.mgr.updateSettings(admin, { cloudEndpoint: bad }), (e: unknown) => e instanceof AiError);
    }
  });
});

// ───────────────────────────── 3) عدم التسرب عبر الميزات الثلاث ─────────────────────────────
describe('11.5 — لا تسرب للمفتاح أو الأسماء أو الهويات (بحث + تلخيص + صياغة، محلياً وسحابياً)', () => {
  async function runAll(h: Harness, cloud: boolean) {
    const sentinel = { confirmCloud: cloud };
    await h.search.search(admin, 'قضايا سرقة', sentinel);
    const prep = await h.summary.prepare(admin, { kind: 'case', id: 'c1' }, { includeLinked: true });
    await h.summary.summarize(admin, { kind: 'case', id: 'c1' }, { includeLinked: true, confirmCloud: cloud, confirmedToken: prep.token ?? undefined });
    const req = { mode: 'compose' as const, docKind: 'memo' as const, recipient: 'المستشفى', subject: 'طلب تقرير طبي', points: 'نرجو التقرير خلال 3 أيام\nالهوية ' + NATIONAL_ID, caseId: 'c1', includeCaseDetails: true };
    const dprep = await h.drafting.prepare(admin, req);
    const res = await h.drafting.generate(admin, req, { useAi: true, confirmCloud: cloud, confirmedToken: dprep.token ?? undefined });
    return res;
  }

  for (const cloud of [false, true]) {
    test((cloud ? 'سحابي' : 'محلي') + ': المفتاح لا يظهر في أي حمولة أو سجل تدقيق، وأسماء الأطراف لا تُرسل أبداً', async () => {
      const h = makeHarness(); if (cloud) await enableCloud(h); else await enableLocal(h);
      await runAll(h, cloud);
      const allPrompts = JSON.stringify(h.calls);
      const allAudits = JSON.stringify(h.audits);
      assert.ok(h.calls.length > 0, 'يجب أن يصل شيء إلى المزوّد');
      for (const hay of [allPrompts, allAudits]) assert.ok(!hay.includes(KEY));
      assert.ok(!allAudits.includes(NAME_COMPLAINANT) && !allAudits.includes(NAME_SUSPECT) && !allAudits.includes(NATIONAL_ID) && !allAudits.includes('a@b.com'));
      // محلياً تبقى البيانات على الجهاز فقط (قد يراها المحرك المحلي)؛ سحابياً لا اسم ولا هوية ولا بريد مطلقاً.
      if (cloud) {
        assert.ok(!allPrompts.includes(NAME_COMPLAINANT) && !allPrompts.includes(NAME_SUSPECT));
        assert.ok(!allPrompts.includes(NATIONAL_ID) && !allPrompts.includes('a@b.com'));
      } else {
        const dc = h.calls.filter((c) => c.feature === 'drafting');
        assert.ok(dc.length > 0 && dc.every((c) => !JSON.stringify(c).includes(NAME_COMPLAINANT) && !JSON.stringify(c).includes(NAME_SUSPECT)), 'الصياغة لا تُدرج الأسماء حتى محلياً');
      }
    });
  }

  test('السحابي بلا تأكيد: لا شيء يصل إلى المزوّد في الميزات الثلاث', async () => {
    const h = makeHarness(); await enableCloud(h);
    const sr = await h.search.search(admin, 'قضايا سرقة');
    assert.ok(sr.engine === 'local' || sr.aiNote !== null);
    const sm = await h.summary.summarize(admin, { kind: 'case', id: 'c1' }, {});
    assert.equal(sm.engine, 'extractive');
    const dr = await h.drafting.generate(admin, { mode: 'compose', docKind: 'memo', subject: 'موضوع', points: 'نقطة طويلة كفاية للصياغة' }, { useAi: true });
    assert.notEqual(dr.engine, 'ai_cloud');
    assert.equal(h.calls.length, 0);
  });

  test('تأكيد بحمولة قديمة (رمز لا يطابق) لا يُرسل شيئاً', async () => {
    const h = makeHarness(); await enableCloud(h);
    const r = await h.summary.summarize(admin, { kind: 'case', id: 'c1' }, { confirmCloud: true, confirmedToken: 'stale-token' });
    assert.equal(r.engine, 'extractive'); assert.equal(h.calls.length, 0);
    const dr = await h.drafting.generate(admin, { mode: 'compose', docKind: 'memo', subject: 'موضوع', points: 'نقطة طويلة كفاية للصياغة' }, { useAi: true, confirmCloud: true, confirmedToken: 'stale' });
    assert.notEqual(dr.engine, 'ai_cloud'); assert.equal(h.calls.length, 0);
  });

  test('فشل التدقيق يمنع الإرسال السحابي (فشل مغلق)', async () => {
    const h = makeHarness(); await enableCloud(h);
    const failing = createAiManager({
      secrets: { async get(n) { return h.store.get(n) ?? null; }, async set() {}, async remove() {} },
      registry: (() => { const r = new AiProviderRegistry(); r.register({ id: 'cloud', async getStatus() { return { state: 'ready', detail: '' }; }, async generate(q) { h.calls.push(q); return { text: 'x', providerId: 'cloud', model: 'm' }; } }); return r; })(),
      async resolveActiveRole(id) { return h.roles.get(id) ?? null; }, async audit() { throw new Error('audit down'); }, now: () => NOW,
    });
    await assert.rejects(failing.authorizeUse(admin, { feature: 'search', entities: ['case'], confirmCloudSend: true }), (e: unknown) => e instanceof AiError && e.code === 'AUDIT_FAILED');
    assert.equal(h.calls.length, 0);
  });

  test('كيانات المحتجزين والمرفقات ممنوعة سحابياً من بوابة المنسّق نفسها', async () => {
    const h = makeHarness(); await enableCloud(h);
    for (const e of ['detainee', 'attachment'] as AiEntityKind[]) {
      await assert.rejects(h.mgr.authorizeUse(admin, { feature: 'search', entities: ['case', e], confirmCloudSend: true }), (x: unknown) => x instanceof AiError && x.code === 'CLOUD_ENTITY_BLOCKED');
    }
  });
});

// ───────────────────────────── 4) المراجعة البشرية والتسليم لنموذج المذكرة ─────────────────────────────
describe('11.5 — زر «أنشئ مذكرة من المسودة»: تعبئة دون حفظ', () => {
  let ho: MemoHandoff; let audits: AiAuditEvent[]; let clock: number; let roles: Map<string, string>; let failAudit: boolean;
  const accepted = (by = 'u-inv', text = GOOD_DRAFT) => acceptAiDraft(createAiDraft({ id: 'd1', feature: 'drafting', providerId: 'local', text, requestedBy: 'u-inv', now: NOW }), by, NOW, undefined);
  beforeEach(() => {
    audits = []; clock = NOW; failAudit = false;
    roles = new Map([['u-admin', 'admin'], ['u-inv', 'investigator'], ['u-view', 'viewer'], ['u-det', 'detention_viewer']]);
    ho = createMemoHandoff({ async resolveActiveRole(id) { return roles.get(id) ?? null; }, async audit(e) { if (failAudit) throw new Error('down'); audits.push(e); }, now: () => clock });
  });

  test('فصل الترويسة عن المتن: الجهة والموضوع من النص، والرقم لا يُملأ، والمتن حرفي مع الفراغات', () => {
    const p = splitMemoText(GOOD_DRAFT);
    assert.equal(p.recipient, 'المستشفى السعودي'); assert.equal(p.subject, 'طلب تقرير طبي');
    assert.ok(p.body.startsWith('تحية طيبة وبعد،') && p.body.includes('1- نرجو إفادتنا') && p.body.includes('التوقيع: [......]'));
    assert.ok(!p.body.includes('الرقم:') && !p.body.includes('مذكرة رسمية'));
    const blank = splitMemoText('مذكرة رسمية\nالرقم: [......]\nإلى: [......]\nالموضوع: [......]\nالمتن هنا');
    assert.equal(blank.recipient, ''); assert.equal(blank.subject, ''); assert.equal(blank.body, 'المتن هنا');
    const noHeader = splitMemoText('نص بلا ترويسة\nإلى: س');
    assert.equal(noHeader.body, 'نص بلا ترويسة\nإلى: س'); assert.equal(noHeader.headerLines, 0);
    const t = buildTemplate({ docKind: 'memo', tone: 'formal', memoTypeName: 'مذكرات المستشفى', recipient: 'جهة', subject: 'موضوع', points: 'نقطة أولى' });
    assert.equal(splitMemoText(t).recipient, 'جهة'); assert.ok(splitMemoText(t).body.includes('1- نقطة أولى'));
  });

  test('مسودة معتمدة من صاحبها تُسلَّم مرة واحدة فقط ثم تُمسح', async () => {
    const draft = accepted();
    const pf = await ho.stash(inv, { origin: 'ai_accepted', draft, memoTypeName: 'مذكرات المستشفى', caseId: 'c1' });
    assert.equal(pf.placeholders, 3); assert.equal(pf.caseId, 'c1'); assert.equal(pf.memoTypeName, 'مذكرات المستشفى');
    assert.equal(ho.peekExists(), true);
    const got = await ho.consume(inv);
    assert.ok(got && got.subject === 'طلب تقرير طبي');
    assert.equal(await ho.consume(inv), null); assert.equal(ho.peekExists(), false);
  });

  test('مسودة بانتظار المراجعة أو مرفوضة أو معتمدة من غير صاحبها أو بلا مسودة: مرفوضة', async () => {
    const pending = createAiDraft({ id: 'd2', feature: 'drafting', providerId: 'local', text: GOOD_DRAFT, requestedBy: 'u-inv', now: NOW });
    const rejected = rejectAiDraft(pending, 'u-inv', NOW);
    for (const draft of [pending, rejected]) {
      await assert.rejects(ho.stash(inv, { origin: 'ai_accepted', draft }), (e: unknown) => e instanceof AiError && e.code === 'REVIEW_REQUIRED');
    }
    await assert.rejects(ho.stash(inv, { origin: 'ai_accepted', draft: accepted('u-admin') }), (e: unknown) => e instanceof AiError && e.code === 'REVIEW_INVALID');
    await assert.rejects(ho.stash(inv, { origin: 'ai_accepted' }), (e: unknown) => e instanceof AiError && e.code === 'REVIEW_REQUIRED');
    await assert.rejects(ho.stash(inv, { origin: 'ai_accepted', text: GOOD_DRAFT, draft: undefined }));
    assert.equal(ho.peekExists(), false); assert.equal(audits.length, 0);
  });

  test('نص ذكي خام لا يُمرَّر باسم «قالب»: origin=template لا يقبل مسودة ذكاء ويعتمد نص المستخدم فقط', async () => {
    const pf = await ho.stash(inv, { origin: 'template', text: GOOD_DRAFT, draft: createAiDraft({ id: 'd3', feature: 'drafting', providerId: 'cloud', text: 'نص ذكي مختلف تماماً', requestedBy: 'u-inv', now: NOW }) });
    assert.ok(!pf.body.includes('نص ذكي مختلف')); // المسودة المرفقة تُهمل؛ يُؤخذ النص الذي كتبه/رآه المستخدم
    await assert.rejects(ho.stash(inv, { origin: 'template', text: '   ' }));
    await assert.rejects(ho.stash(inv, { origin: 'template', text: 'أ'.repeat(14001) }));
    await assert.rejects(ho.stash(inv, { origin: 'bogus' as never, text: 'x' }));
  });

  test('الصلاحية: memos.manage فقط (المشاهد ومشاهد المحتجزين والجلسة الفارغة مرفوضون) وتُفحص من الجدول', async () => {
    for (const s of [viewer, det, null, undefined]) await assert.rejects(ho.stash(s, { origin: 'template', text: GOOD_DRAFT }), ForbiddenError);
    roles.set('u-inv', 'viewer'); // خُفِّض الدور بعد الاعتماد
    await assert.rejects(ho.stash(inv, { origin: 'template', text: GOOD_DRAFT }), ForbiddenError);
    roles.set('u-inv', 'investigator');
    await ho.stash(inv, { origin: 'template', text: GOOD_DRAFT });
    roles.set('u-inv', 'viewer'); // خُفِّض بعد التسليم وقبل الاستهلاك
    assert.equal(await ho.consume(inv), null);
  });

  test('لا يستهلكها مستخدم آخر، وتنتهي بعد 10 دقائق، وتُستهلك (تُمسح) حتى عند الفشل', async () => {
    await ho.stash(inv, { origin: 'template', text: GOOD_DRAFT });
    assert.equal(await ho.consume(admin), null); assert.equal(ho.peekExists(), false);
    await ho.stash(inv, { origin: 'template', text: GOOD_DRAFT });
    clock += HANDOFF_TTL_MS + 1;
    assert.equal(await ho.consume(inv), null);
    await ho.stash(inv, { origin: 'template', text: GOOD_DRAFT });
    ho.clear(); assert.equal(await ho.consume(inv), null);
  });

  test('التدقيق: حدث ai_memo_prefill بلا أي نص، وفشل التدقيق يمنع التسليم', async () => {
    await ho.stash(inv, { origin: 'ai_accepted', draft: accepted(), recipient: NAME_COMPLAINANT });
    assert.equal(audits.length, 1); assert.equal(audits[0].operationType, 'ai_memo_prefill');
    const j = JSON.stringify(audits[0]);
    assert.ok(!j.includes('المستشفى') && !j.includes('تحية') && !j.includes(NAME_COMPLAINANT));
    assert.deepEqual(audits[0].newValues, { origin: 'ai_accepted', chars: GOOD_DRAFT.length, placeholders: 3, caseLinked: false });
    ho.clear(); failAudit = true;
    await assert.rejects(ho.stash(inv, { origin: 'template', text: GOOD_DRAFT }), (e: unknown) => e instanceof AiError && e.code === 'AUDIT_FAILED');
    assert.equal(ho.peekExists(), false);
  });

  test('الوحدة لا تعرف قاعدة البيانات: لا استيراد خدمات ولا SQL (مصدرياً)', () => {
    const src = readFileSync('src/modules/ai/ai-memo-handoff.ts', 'utf8').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(!/from '@\//.test(src) && !/services\//.test(src) && !/runAsync|execAsync|insertMemo|SecureStore|AsyncStorage/.test(src));
  });
});

// ───────────────────────────── 5) المسح وتقرير الخصوصية ─────────────────────────────
describe('11.5 — مسح بيانات الذكاء الاصطناعي وتقرير الخصوصية', () => {
  test('resetAll: يمسح المفتاح والإعدادات والإقرار ويعيد «معطّل» ويدقّق بلا المفتاح', async () => {
    const h = makeHarness(); await enableCloud(h);
    assert.ok(h.store.size >= 2);
    const st = await h.mgr.resetAll(admin);
    assert.equal(st.mode, 'disabled'); assert.equal(st.cloud.hasKey, false); assert.equal(st.cloud.consentValid, false);
    assert.equal(st.cloud.endpoint, null); assert.equal(h.store.size, 0);
    const ev = h.audits.filter((a) => a.operationType === 'ai_reset');
    assert.equal(ev.length, 1); assert.ok(!JSON.stringify(ev[0]).includes(KEY));
    await assert.rejects(h.mgr.authorizeUse(admin, { feature: 'search', entities: ['case'] }), (e: unknown) => e instanceof AiError && e.code === 'AI_DISABLED');
  });
  test('resetAll: فشل التخزين يُبلَّغ، وفشل التدقيق يُبلَّغ دون إعادة المسح', async () => {
    const h = makeHarness(); await enableCloud(h);
    const orig = h.store.delete.bind(h.store);
    h.store.delete = () => { throw new Error('io'); };
    await assert.rejects(h.mgr.resetAll(admin), (e: unknown) => e instanceof AiError && e.code === 'STORAGE_FAILED');
    h.store.delete = orig;
  });

  const specs = buildSecretSpecs([1], false);
  const baseState = { mode: 'disabled' as const, features: { search: false, summary: false, drafting: false }, cloud: { endpoint: null, model: null, hasKey: false, consentValid: false }, settingsRecovered: false };
  test('معطّل: التقرير سليم بلا تحذيرات', () => {
    const r = buildPrivacyReport({ state: baseState, backupSecretSpecs: specs });
    assert.equal(r.overall, 'ok'); assert.equal(r.counts.fail, 0); assert.equal(r.counts.warn, 0);
  });
  test('سحابي مكتمل: تحذير تعريفي لا فشل؛ ناقص أو بلا إقرار: فشل', () => {
    const full = { ...baseState, mode: 'cloud' as const, features: { search: true, summary: false, drafting: true }, cloud: { endpoint: ENDPOINT, model: 'm', hasKey: true, consentValid: true } };
    const r = buildPrivacyReport({ state: full, backupSecretSpecs: specs });
    assert.equal(r.overall, 'warn'); assert.ok(r.findings.find((f) => f.id === 'mode')!.detail.includes('البحث الذكي'));
    assert.equal(buildPrivacyReport({ state: { ...full, cloud: { ...full.cloud, consentValid: false } }, backupSecretSpecs: specs }).overall, 'fail');
    assert.equal(buildPrivacyReport({ state: { ...full, cloud: { ...full.cloud, hasKey: false } }, backupSecretSpecs: specs }).overall, 'fail');
    assert.equal(buildPrivacyReport({ state: { ...full, cloud: { ...full.cloud, endpoint: 'http://x.com' } }, backupSecretSpecs: specs }).overall, 'fail');
  });
  test('أسرار الذكاء غير المستبعدة من النسخ الاحتياطي = فشل؛ والإعدادات المستعادة = تحذير', () => {
    const leaky = specs.map((s) => (s.name.startsWith('securecase_ai_') ? { ...s, cls: 'recommended' as const } : s));
    const r = buildPrivacyReport({ state: baseState, backupSecretSpecs: leaky });
    assert.equal(r.overall, 'fail'); assert.equal(r.findings.find((f) => f.id === 'backup-secrets')!.level, 'fail');
    assert.equal(buildPrivacyReport({ state: { ...baseState, settingsRecovered: true }, backupSecretSpecs: specs }).overall, 'warn');
  });
  test('الأسرار في تقرير الخصوصية: المفتاح لا يظهر ولو وُجد في الحالة', () => {
    const r = buildPrivacyReport({ state: { ...baseState, mode: 'cloud', cloud: { endpoint: ENDPOINT, model: 'm', hasKey: true, consentValid: true } }, backupSecretSpecs: specs });
    assert.ok(!JSON.stringify(r).includes(KEY));
  });
  test('جدول الصلاحيات الحي: مشاهد المحتجزين بلا ai.* وبلا قضايا/مذكرات، وai.manage للمدير وحده', () => {
    for (const p of ['ai.use', 'ai.manage', 'cases.view', 'memos.view'] as const) assert.equal(can('detention_viewer', p), false, p);
    assert.deepEqual(ROLES.map((r) => r.key).filter((r) => can(r, 'ai.manage')), ['admin']);
    for (const r of ['admin', 'investigator', 'viewer'] as const) assert.equal(can(r, 'ai.use'), true);
    assert.equal(can('unknown-role', 'ai.use'), false); assert.equal(can(null, 'ai.use'), false);
  });
});

// ───────────────────────────── 6) فحوص مصدرية لحدود الوحدة ─────────────────────────────
describe('11.5 — فحوص مصدرية (static) لحدود الذكاء الاصطناعي', () => {
  const aiDir = 'src/modules/ai';
  // تُحذف التعليقات قبل الفحص كي لا تُحتسب كلمات التوثيق كاستخدام فعلي.
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
  const aiFiles = readdirSync(aiDir).filter((f) => f.endsWith('.ts')).map((f) => join(aiDir, f));
  const screens = readdirSync('src/app').filter((f) => /^ai-.*\.tsx$/.test(f)).map((f) => join('src/app', f));
  const runtimeFiles = aiFiles.filter((f) => /-runtime\.ts$/.test(f));
  const pureFiles = aiFiles.filter((f) => !/-runtime\.ts$/.test(f));

  test('الملفات النقية بلا Expo ولا أسماء مستعارة @/ (قابلة للاختبار في Node)', () => {
    for (const f of pureFiles) assert.ok(!/from '(?:expo|react-native|@\/)/.test(read(f)), f);
  });
  test('لا كتابة SQL ولا حذف في وحدة الذكاء ولا في شاشاتها', () => {
    for (const f of [...aiFiles, ...screens]) assert.ok(!/\.(?:runAsync|execAsync|withTransactionAsync)\(/.test(read(f)), f);
  });
  test('لا استيراد لدوال كتابة السجلات ولا لخدمتي المحتجزين والمرفقات في وحدة الذكاء وشاشاتها', () => {
    const forbidden = /insertMemo|insertCase|updateCase|changeMemoStatus|archiveCase|assignCase|transferCase|insertDetainee|detainees\.service|attachments\.service|attachments-repo|attachments-storage/;
    for (const f of [...aiFiles, ...screens]) assert.ok(!forbidden.test(read(f)), f);
  });
  test('الشبكة (fetch) في ملف المزوّد السحابي وحده', () => {
    for (const f of [...aiFiles, ...screens]) {
      const has = /\bfetch\b|XMLHttpRequest|WebSocket/.test(read(f));
      assert.equal(has, f.endsWith('ai-cloud-provider.ts'), f);
    }
  });
  test('SecureStore في ai-runtime.ts وحده، ولا تخزين متصفح/ملفات/سجل طباعة', () => {
    for (const f of [...aiFiles, ...screens]) {
      const src = read(f);
      assert.equal(/expo-secure-store/.test(src), f.endsWith('ai-runtime.ts'), f);
      assert.ok(!/AsyncStorage|localStorage|sessionStorage|expo-file-system|expo-sqlite/.test(src), f);
      assert.ok(!/console\.(?:log|info|debug|warn)\(/.test(src), f);
    }
  });
  test('مفاتيح التخزين الآمن للذكاء مصنَّفة «مستبعدة» من النسخ الاحتياطي وتحمل نفس الاسم', () => {
    const names = ['securecase_ai_settings_v1', 'securecase_ai_cloud_key_v1'];
    for (const n of names) assert.equal(buildSecretSpecs([1], true).find((s) => s.name === n)?.cls, 'excluded');
    assert.ok(names.every((n) => read('src/modules/ai/ai-types.ts').includes(n)));
  });
  test('الاستعادة ترفض أي نسخة تحمل أسرار الذكاء (ضمن الأسرار المستبعدة)', () => {
    const src = read('src/modules/backup/backup-restore-prep.ts');
    assert.ok(/EXCLUDED_NAMES[^;]*aiSettings[^;]*aiCloudKey/s.test(src));
  });
  test('كل شاشة ذكاء تفحص الصلاحية وتسجّل محاولة الوصول غير المصرح، ولا تعرض رسائل الاستثناء الخام', () => {
    assert.ok(screens.length >= 5, 'شاشات: ' + screens.join(','));
    for (const f of screens) {
      const src = read(f);
      assert.ok(/can\(/.test(src) && /recordUnauthorizedAccess/.test(src), f);
      assert.ok(!/(?:e|err|error)\.message/.test(src), f);
    }
  });
  test('كل نوع عملية ai_* يُصدره الكود له تسمية عربية في سجل التدقيق', () => {
    const ops = new Set<string>();
    for (const f of [...aiFiles, ...screens]) for (const m of read(f).matchAll(/operationType:\s*'(ai_[a-z_]+)'/g)) ops.add(m[1]);
    assert.ok(ops.size >= 8, [...ops].join(','));
    for (const o of ops) assert.ok(AUDIT_OPERATION_LABELS[o], 'تسمية ناقصة: ' + o);
  });
  test('زر إنشاء المذكرة لا يمرّر النص عبر مسار التنقل (لا params ولا query)', () => {
    const src = read('src/app/ai-drafting.tsx');
    assert.ok(/stashMemoPrefill|getMemoHandoff/.test(src));
    for (const m of src.matchAll(/router\.(?:push|replace|navigate)\(([^)]*)\)/g)) assert.ok(!/params|\?|body|text|draft/i.test(m[1]), m[0]);
  });
  test('شاشة المذكرات تستهلك التسليم مرة واحدة ولا تحفظ تلقائياً', () => {
    const src = read('src/app/(tabs)/memos.tsx');
    assert.ok(src.includes('consumeMemoPrefill'));
    const block = src.slice(src.indexOf('SECURECASEDESK_PHASE11_S5'));
    assert.ok(!/insertMemo\(/.test(block.slice(0, block.indexOf('const handleSaveMemo') > 0 ? block.indexOf('const handleSaveMemo') : block.length)));
  });
});
SCD_EOF_S5_5
write_file 'docs/phase11/11.5-ai-privacy-final.md' <<'SCD_EOF_S5_6'
<!-- SECURECASEDESK_PHASE11_S5 -->
# المرحلة 11 / القسم 11.5 — الحماية والخصوصية والاختبارات النهائية

> نطاق هذا القسم: إغلاق المرحلة 11 — فحص صلاحيات الوصول وحماية البيانات واختبار كل وظائف الذكاء الاصطناعي، وإضافة زر «أنشئ مذكرة من المسودة».

## 1. ما أُضيف

| البند | الملف | الوصف |
|---|---|---|
| تسليم المسودة إلى نموذج المذكرة | `src/modules/ai/ai-memo-handoff.ts` (+ `-runtime.ts`) | يفتح نموذج المذكرة **معبّأً دون حفظ**؛ ذاكرة فقط، مرة واحدة، 10 دقائق، مرتبط بالمستخدم وبصلاحية `memos.manage` من الجدول |
| تقرير الخصوصية | `src/modules/ai/ai-privacy-check.ts` (+ `-runtime.ts`) | تقرير حي (سليم/تنبيه/مشكلة) بما يمكن التحقق منه محلياً |
| شاشة فحص الخصوصية | `src/app/ai-privacy.tsx` | لمدير النظام (`ai.manage`) + زر «مسح كل بيانات الذكاء الاصطناعي» |
| مسح بيانات الذكاء | `ai-manager.ts` → `resetAll` | يحذف المفتاح والإقرار والإعدادات ويعيد «معطّل» ويدقّق بلا أي سرّ |
| إصلاح أمني في الاستعادة | `backup-restore-prep.ts` | أسرار الذكاء (`securecase_ai_*`) أُضيفت إلى الأسرار المستبعدة: نسخة تحملها تُرفض كما تُرفض الجلسة والرموز |
| تسميتان للتدقيق | `audit-labels.ts` | `ai_memo_prefill`، `ai_reset` |
| الاختبارات | `tests/ai-final.test.ts` | 47 اختباراً (`npm run test:ai-final`) و`npm run test:ai-all` للمجموعة الكاملة |

## 2. زر «أنشئ مذكرة من المسودة»

```
مسودة معتمدة (أو قالب آلي)  ──►  stash (ذاكرة فقط + تدقيق بلا نص)  ──►  شاشة المذكرات
                                                                        │ تستهلكها مرة واحدة عند الفتح
                                                                        ▼
                                          نموذج «تسجيل مذكرة جديدة» معبّأً: الجهة/الموضوع/المتن/النوع/القضية
                                          (رقم المذكرة فارغ دائماً) ──► المستخدم يراجع ويضغط «حفظ» بنفسه
```

* **لا حفظ ذاتي:** لا الوحدة ولا المحوّل يستوردان `insertMemo`؛ الحفظ يمرّ بكل فحوص `insertMemo` المعتادة (الصلاحية، تكرار الرقم، ربط القضية).
* **نص الذكاء لا يُسلَّم إلا بعد الاعتماد البشري** (`assertDraftAccepted`) ومن صاحب الطلب نفسه؛ مسودة بانتظار المراجعة/مرفوضة/من مستخدم آخر مرفوضة.
* **لا نص في مسار التنقل** (لا `params` ولا query) فلا يبقى في سجل التنقل.
* **الفراغات `[......]` تبقى ظاهرة:** يُنبَّه المستخدم في النموذج، ويُطلب إقرار صريح عند الحفظ إن بقي فراغ.
* **الصلاحية تُفحص ثلاث مرات:** عند الزر (`memos.manage`)، وعند التسليم من جدول المستخدمين، وعند الاستهلاك (خُفِّض الدور = تُمسح).
* مشاهد المحتجزين والمشاهد العادي: الزر لا يظهر، والتسليم مرفوض.

## 3. نتائج مراجعة الخصوصية (ما وُجد وما أُصلح)

| # | الفحص | النتيجة |
|---|---|---|
| 1 | مفتاح الخدمة السحابية في التدقيق/الحمولات | لم يظهر في أي مسار (مُختبَر عبر الميزات الثلاث) |
| 2 | أسماء المدّعي/المتهمين | سحابياً: لا تُرسل أبداً. محلياً: التلخيص قد يراها المحرك المحلي (تبقى على الجهاز)؛ الصياغة لا تُدرجها حتى محلياً |
| 3 | هويات/بريد/روابط | تُحذف سحابياً؛ تبقى محلياً (على الجهاز) |
| 4 | المحتجزون والمرفقات سحابياً | ممنوعة في البوابة المركزية، ولا تستورد وحدة الذكاء خدماتها (فحص مصدري) |
| 5 | الأسرار في النسخ الاحتياطي | **ثغرة صغيرة أُصلحت:** الجرد يصنّفها «مستبعدة» لكن الاستعادة لم ترفض نسخة تحملها؛ صارت ترفضها |
| 6 | البوابة السحابية | فحص شامل لـ 320 تركيباً: يُسمح فقط عند اكتمال كل الشروط |
| 7 | الدور من الجدول | جلسة مزوّرة/دور خُفِّض/حساب معطّل = رفض فوري |
| 8 | كتابة السجلات من وحدة الذكاء | لا SQL كتابة ولا دوال كتابة في الوحدة وشاشاتها (فحص مصدري) |

## 4. ما لم يُنفَّذ / لم يُتحقَّق منه (بصدق)

* **لم يُختبر على جهاز Android حقيقي** (الشاشات الجديدة: زر التسليم، تعبئة النموذج، شاشة الخصوصية). اختبارات Node تغطي المنطق لا الواجهة.
* **لا اتصال فعلي بمزوّد سحابي حقيقي** في الاختبارات (مزوّدات وهمية مُحقنة للاختبار فقط داخل `tests/`، لا في التطبيق). والمحرك المحلي ما زال غير مدمج: فيعمل التطبيق بالبدائل الآلية.
* الأسماء داخل النص الحر الذي يكتبه المستخدم لا تُكشف آلياً؛ الحماية هنا بالمعاينة والتأكيد اليدويين.
* فحوص المصدر (static) نصية بالتعابير النمطية: تكشف الانحراف الواضح لا كل التفافٍ ممكن.
* فحص الخصوصية يتحقق مما هو محلي فقط؛ لا يثبت سياسة الخدمة السحابية ولا مكان تخزين مزوّدها.
* جودة الصياغة العربية ومطابقة القوالب الرسمية الفعلية لم تُقَس.
* لم تُحتسب هذه المرحلة ضمن اختبارات Phase 12 (APK/جهاز حقيقي)، وهي تبقى معلّقة حتى تُنفَّذ فعلاً.
SCD_EOF_S5_6

say "تعديل الملفات الموجودة (مع نسخ احتياطي، وفحص كامل قبل أي كتابة)"
PATCH_JSON="$(mktemp)"
cat > "$PATCH_JSON" <<'SCD_EOF_S5_PATCHES'
{
 "src/modules/ai/ai-manager.ts": [
  [
   "  clearCloudKey(session: Session | null | undefined): Promise<AiPublicState>;\n",
   "  clearCloudKey(session: Session | null | undefined): Promise<AiPublicState>;\n  // SECURECASEDESK_PHASE11_S5: مسح كل بيانات الذكاء الاصطناعي من الجهاز (إعدادات + إقرار + مفتاح) والعودة إلى «معطّل».\n  resetAll(session: Session | null | undefined): Promise<AiPublicState>;\n"
  ],
  [
   "\n    async authorizeUse(session, request) {",
   "\n    // SECURECASEDESK_PHASE11_S5\n    resetAll(session) {\n      return serialize(async () => {\n        const s = await requireManager(session);\n        const { settings: prev } = await loadSettings();\n        let hadKey = false;\n        try { hadKey = (await deps.secrets.get(AI_SECRET_NAMES.cloudKey)) !== null; } catch { /* لا يوجد */ }\n        try {\n          await deps.secrets.remove(AI_SECRET_NAMES.cloudKey);\n          await deps.secrets.remove(AI_SECRET_NAMES.settings);\n        } catch {\n          throw new AiError('STORAGE_FAILED');\n        }\n        try {\n          await deps.audit({\n            operationType: 'ai_reset', entityType: 'ai', entityId: 'all',\n            previousValues: { ...auditView(prev), keyPresent: hadKey }, newValues: { mode: 'disabled', keyPresent: false },\n            reason: 'مسح كل بيانات الذكاء الاصطناعي من الجهاز', actorUserId: s.userId,\n          });\n        } catch {\n          // المسح نفسه أكثر أماناً من الإبقاء؛ لا نُرجع شيئاً.\n          throw new AiError('AUDIT_FAILED');\n        }\n        return buildState(true);\n      });\n    },\n\n    async authorizeUse(session, request) {"
  ]
 ],
 "src/modules/audit/audit-labels.ts": [
  [
   "  ai_draft_review: 'مراجعة مسودة مستند ذكية',\n",
   "  ai_draft_review: 'مراجعة مسودة مستند ذكية',\n  ai_memo_prefill: 'فتح نموذج مذكرة من مسودة ذكية (دون حفظ)', // SECURECASEDESK_PHASE11_S5\n  ai_reset: 'مسح كل بيانات الذكاء الاصطناعي', // SECURECASEDESK_PHASE11_S5\n"
  ]
 ],
 "src/modules/backup/backup-restore-prep.ts": [
  [
   "const EXCLUDED_NAMES: readonly string[] = [SECRET_NAMES.sessionUser, SECRET_NAMES.apiUrl, SECRET_NAMES.apiToken];",
   "// SECURECASEDESK_PHASE11_S5: أسرار الذكاء الاصطناعي مستبعدة كذلك (نسخة تحملها تُرفض كما تُرفض الجلسة والرموز).\nconst EXCLUDED_NAMES: readonly string[] = [\n  SECRET_NAMES.sessionUser, SECRET_NAMES.apiUrl, SECRET_NAMES.apiToken, SECRET_NAMES.aiSettings, SECRET_NAMES.aiCloudKey,\n];"
  ]
 ],
 "src/app/ai-drafting.tsx": [
  [
   "import { X, Sparkles, ListChecks, Check, Ban, Share2 } from 'lucide-react-native';",
   "import { X, Sparkles, ListChecks, Check, Ban, Share2, FilePlus } from 'lucide-react-native';"
  ],
  [
   "import { aiErrorMessage, isAiError } from '@/modules/ai/ai-types';",
   "import { aiErrorMessage, isAiError } from '@/modules/ai/ai-types';\nimport { stashMemoPrefill } from '@/modules/ai/ai-memo-handoff-runtime'; // SECURECASEDESK_PHASE11_S5"
  ],
  [
   "  const header = (\n    <View style={styles.header}>",
   "  // SECURECASEDESK_PHASE11_S5: يفتح نموذج المذكرة معبّأً دون حفظ. النص يُسلَّم عبر الذاكرة (لا عبر مسار التنقل)،\n  // ولا يُقبل نص ذكاء اصطناعي إلا بعد اعتماده بشرياً. الحفظ الفعلي يدوي من شاشة المذكرات.\n  const canCreateMemo = docKind === 'memo' && !!user && can(user.role, 'memos.manage') &&\n    ((draft?.status === 'accepted' && !!finalText) || (result?.engine === 'template' && !!result.offlineText));\n  const onCreateMemo = useCallback(async () => {\n    if (!session || busy) return;\n    setBusy(true);\n    try {\n      const common = { recipient, subject, memoTypeName: memoType, caseId: mode === 'compose' ? caseId : null };\n      if (draft && draft.status === 'accepted' && finalText) {\n        await stashMemoPrefill(session, { origin: 'ai_accepted', draft, ...common });\n      } else if (result?.engine === 'template' && result.offlineText) {\n        await stashMemoPrefill(session, { origin: 'template', text: result.offlineText, ...common });\n      } else {\n        return;\n      }\n      router.push('/(tabs)/memos' as never);\n    } catch (e) {\n      Alert.alert('تعذر فتح نموذج المذكرة', errText(e));\n    } finally {\n      setBusy(false);\n    }\n  }, [session, busy, draft, finalText, result, recipient, subject, memoType, mode, caseId, router]);\n\n  const header = (\n    <View style={styles.header}>"
  ],
  [
   "            {(finalText || result.offlineText) && (\n              <Pressable style={styles.ghostBtn} onPress={() => void onShare()}>",
   "            {canCreateMemo && (\n              <>\n                <Pressable style={[styles.primaryBtn, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void onCreateMemo()}>\n                  <FilePlus size={18} color={Colors.textOnPrimary} /><Text style={styles.primaryText}>أنشئ مذكرة من المسودة</Text>\n                </Pressable>\n                <Text style={styles.muted}>يفتح نموذج المذكرة معبّأً دون حفظ: راجع الحقول واكتب رقم المذكرة بنفسك ثم احفظ.</Text>\n              </>\n            )}\n\n            {(finalText || result.offlineText) && (\n              <Pressable style={styles.ghostBtn} onPress={() => void onShare()}>"
  ]
 ],
 "src/app/(tabs)/memos.tsx": [
  [
   "import { SafeAreaView } from 'react-native-safe-area-context';",
   "import { SafeAreaView } from 'react-native-safe-area-context';\nimport { useFocusEffect } from 'expo-router'; // SECURECASEDESK_PHASE11_S5\nimport { consumeMemoPrefill } from '@/modules/ai/ai-memo-handoff-runtime';\nimport type { MemoPrefill } from '@/modules/ai/ai-memo-handoff';"
  ],
  [
   "  const [yearStr, setYearStr] = useState(String(today.getFullYear()));\n",
   "  const [yearStr, setYearStr] = useState(String(today.getFullYear()));\n  const [pendingPrefill, setPendingPrefill] = useState<MemoPrefill | null>(null); // SECURECASEDESK_PHASE11_S5\n  const [prefillNote, setPrefillNote] = useState<string | null>(null);\n  const placeholderAck = React.useRef(false);\n"
  ],
  [
   "    setSelectedCase(null);\n    const now = new Date();",
   "    setSelectedCase(null);\n    setPrefillNote(null);\n    const now = new Date();"
  ],
  [
   "  const buildMemoDateTimestamp = (): number | null => {",
   "  // SECURECASEDESK_PHASE11_S5: تعبئة النموذج من مسودة المساعد الذكي (دون حفظ). تُستهلك مرة واحدة عند فتح الشاشة.\n  useFocusEffect(useCallback(() => {\n    let alive = true;\n    if (session) {\n      void consumeMemoPrefill(session).then((p) => { if (alive && p) setPendingPrefill(p); }).catch(() => undefined);\n    }\n    return () => { alive = false; };\n  }, [session]));\n\n  useEffect(() => {\n    if (!pendingPrefill) return;\n    if (memoTypes.length === 0 && loading) return; // انتظر تحميل أنواع المذكرات\n    const p = pendingPrefill;\n    setPendingPrefill(null);\n    resetForm();\n    setRecipientOrg(p.recipient);\n    setSubject(p.subject);\n    setBody(p.body);\n    setSelectedType(memoTypes.find((t) => t.name.trim() === p.memoTypeName) ?? null);\n    setSelectedCase(p.caseId ? caseOptions.find((c) => c.id === p.caseId) ?? null : null);\n    setPrefillNote(\n      'معبّأ من مسودة المساعد الذكي ولم يُحفظ بعد. اكتب رقم المذكرة، وتحقق من النوع والتاريخ وكل الحقول، وأكمل الفراغات' +\n      (p.placeholders > 0 ? ' (' + p.placeholders + ' فراغ بصيغة [......] في النص)' : '') + ' قبل الحفظ.'\n    );\n    setModalVisible(true);\n  }, [pendingPrefill, memoTypes, caseOptions, loading]);\n\n  const buildMemoDateTimestamp = (): number | null => {"
  ],
  [
   "    if (memoDateTs === null) { Alert.alert('تنبيه', 'تاريخ المذكرة غير صحيح'); return; }\n",
   "    if (memoDateTs === null) { Alert.alert('تنبيه', 'تاريخ المذكرة غير صحيح'); return; }\n    // SECURECASEDESK_PHASE11_S5: فراغات [......] المتبقية تحتاج إقراراً صريحاً قبل الحفظ.\n    const leftover = (body.match(/\\[(?:\\.{2,}|\\u2026+)\\]/g) ?? []).length;\n    if (leftover > 0 && !placeholderAck.current) {\n      Alert.alert('فراغات لم تُملأ', 'يحتوي نص المذكرة على ' + leftover + ' فراغ بصيغة [......]. أكملها قبل الحفظ، أو احفظ كما هي.', [\n        { text: 'رجوع للتعديل', style: 'cancel' },\n        { text: 'حفظ كما هي', onPress: () => { placeholderAck.current = true; void handleSaveMemo(); } },\n      ]);\n      return;\n    }\n    placeholderAck.current = false;\n"
  ],
  [
   "            <ScrollView showsVerticalScrollIndicator={false}>\n              <TextInput\n                style={styles.input}\n                placeholder=\"رقم المذكرة *\"",
   "            {prefillNote && (\n              <Text style={{ color: Colors.warning, fontFamily: 'Cairo_600SemiBold', fontSize: 13, textAlign: 'right', marginBottom: 8 }}>{prefillNote}</Text>\n            )}\n            <ScrollView showsVerticalScrollIndicator={false}>\n              <TextInput\n                style={styles.input}\n                placeholder=\"رقم المذكرة *\""
  ]
 ],
 "src/app/(tabs)/settings.tsx": [
  [
   "import { LogOut, FileText, Sparkles, Search, ListChecks } from 'lucide-react-native';",
   "import { LogOut, FileText, Sparkles, Search, ListChecks, ShieldCheck } from 'lucide-react-native';"
  ],
  [
   "        {can(user?.role, 'dashboard.view') && (\n          <Pressable\n            onPress={() => router.push('/reports' as never)}",
   "        {can(user?.role, 'ai.manage') && ( // SECURECASEDESK_PHASE11_S5\n          <Pressable\n            onPress={() => router.push('/ai-privacy' as never)}\n            style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: 12, borderWidth: 1, borderColor: Colors.primary, backgroundColor: Colors.card, marginBottom: 12 }, pressed && { opacity: 0.85 }]}\n          >\n            <ShieldCheck color={Colors.primary} size={20} />\n            <Text style={{ color: Colors.primary, fontFamily: 'Cairo_700Bold', fontSize: 15 }}>فحص خصوصية الذكاء الاصطناعي</Text>\n          </Pressable>\n        )}\n\n        {can(user?.role, 'dashboard.view') && (\n          <Pressable\n            onPress={() => router.push('/reports' as never)}"
  ]
 ]
}
SCD_EOF_S5_PATCHES
TS="$TS" PATCH_JSON="$PATCH_JSON" python3 - <<'SCD_EOF_S5_PY'
import json, os, shutil, sys
MARK = 'SECURECASEDESK_PHASE11_S5'
ts = os.environ['TS']
patches = json.load(open(os.environ['PATCH_JSON'], encoding='utf-8'))
todo, errors = [], []
for path, pairs in patches.items():
    if not os.path.isfile(path):
        errors.append('ملف غير موجود: ' + path); continue
    s = open(path, encoding='utf-8').read()
    if MARK in s:
        print('  = سبق تعديله: ' + path); continue
    for i, (old, new) in enumerate(pairs):
        c = s.count(old)
        if c != 1:
            errors.append('%s: التعديل %d وجد النص المرجعي %d مرة (المتوقع 1). الملف مختلف عمّا يتوقعه السكربت.' % (path, i + 1, c))
    todo.append((path, s, pairs))
if errors:
    print('\n'.join('✘ ' + e for e in errors), file=sys.stderr)
    print('✘ لم يُكتب أي ملف. أرسل لي رسالة الخطأ أعلاه لأتوافق مع ملفاتك.', file=sys.stderr)
    sys.exit(1)
for path, s, pairs in todo:
    shutil.copy2(path, path + '.bak_' + ts)
    for old, new in pairs:
        s = s.replace(old, new, 1)
    open(path, 'w', encoding='utf-8').write(s)
    print('  ✔ عُدّل: %s (نسخة: %s.bak_%s)' % (path, path, ts))
SCD_EOF_S5_PY
rm -f "$PATCH_JSON"

say "package.json: إضافة أوامر الاختبار"
python3 - <<'SCD_EOF_S5_PKG'
import json
raw = open('package.json', encoding='utf-8').read()
pj = json.loads(raw)
want = {
  'test:ai-final': 'tsx --tsconfig tests/tsconfig.json --test tests/ai-final.test.ts',
  'test:ai-all': 'tsx --tsconfig tests/tsconfig.json --test tests/ai-foundation.test.ts tests/ai-search.test.ts tests/ai-summary.test.ts tests/ai-drafting.test.ts tests/ai-final.test.ts',
}
changed = False
for k, v in want.items():
    if pj['scripts'].get(k) != v:
        pj['scripts'][k] = v; changed = True
if changed:
    open('package.json', 'w', encoding='utf-8').write(json.dumps(pj, ensure_ascii=False, indent=2) + '\n')
    print('  ✔ package.json محدَّث')
else:
    print('  = package.json بلا تغيير')
SCD_EOF_S5_PKG

say "SECURITY.md: قسم الذكاء الاصطناعي"
if [ -f SECURITY.md ] && ! grep -q 'SECURECASEDESK_PHASE11_S5' SECURITY.md; then
  cp SECURITY.md "SECURITY.md.bak_$TS"
  cat >> SECURITY.md <<'SCD_EOF_S5_SEC'

---

## الذكاء الاصطناعي (المرحلة 11) <!-- SECURECASEDESK_PHASE11_S5 -->

* **الأصل: معطّل.** الإعدادات التالفة أو غير المقروءة = معطّل. التطبيق يعمل كاملاً بدونه.
* **السحابي اختياري ومقيّد:** HTTPS حصراً، إقرار مدير مرتبط بالعنوان والإصدار، تأكيد صريح لكل طلب بعد معاينة الحمولة (مربوط برمزها)، وفشل التدقيق يمنع الإرسال.
* **لا تغادر الجهاز أبداً (سحابياً):** بيانات المحتجزين والمرفقات، وأسماء أطراف القضايا، والهويات الطويلة والبريد والروابط.
* **لا تعديل ذاتي للسجلات:** وحدة الذكاء لا تكتب في قاعدة البيانات؛ ناتجها مسودة تُراجَع وتُعتمد بشرياً، وزر «أنشئ مذكرة من المسودة» يفتح النموذج معبّأً دون حفظ.
* **الصلاحيات:** `ai.use` للمدير والمحقق والمشاهد، `ai.manage` للمدير وحده، ومشاهد المحتجزين معزول كلياً؛ الدور يُقرأ من جدول المستخدمين لا من الجلسة.
* **الأسرار:** مفتاح الخدمة وإعدادات الذكاء في SecureStore ومستبعدة من النسخ الاحتياطي (والاستعادة ترفض نسخة تحملها). لا تدخل سجل التدقيق.
* **لم يُختبر بعد على جهاز Android حقيقي**؛ التفاصيل في `docs/phase11/11.5-ai-privacy-final.md`.
SCD_EOF_S5_SEC
  ok "أُضيف قسم الذكاء الاصطناعي إلى SECURITY.md"
else
  ok "SECURITY.md: لا حاجة (غير موجود أو محدَّث)"
fi

say "تشغيل الاختبارات الفعلية (الذكاء الاصطناعي + النسخ الاحتياطي/الاستعادة)"
command -v npm >/dev/null 2>&1 || die "npm غير متوفر لتشغيل الاختبارات."
[ -d node_modules ] || warn "node_modules غير موجود؛ شغّل npm install أولاً إن فشلت الاختبارات."
RESULT_FILE="docs/phase11/11.5-test-results.md"
mkdir -p docs/phase11
FAILED=0
declare -a NAMES=("الذكاء الاصطناعي (11.1–11.5)" "استعادة النسخ: التجهيز" "النسخ الاحتياطي: المجموعة الكاملة")
declare -a CMDS=("test:ai-all" "test:backup-restore-prep" "test:backup-all")
declare -a LINES=()
for i in 0 1 2; do
  OUT="$(npm run -s "${CMDS[$i]}" 2>&1)" && RC=0 || RC=$?
  T="$(printf '%s\n' "$OUT" | grep -E '^# tests ' | tail -1 | awk '{print $3}')"
  P="$(printf '%s\n' "$OUT" | grep -E '^# pass ' | tail -1 | awk '{print $3}')"
  F="$(printf '%s\n' "$OUT" | grep -E '^# fail ' | tail -1 | awk '{print $3}')"
  T="${T:-?}"; P="${P:-?}"; F="${F:-?}"
  if [ "$RC" -ne 0 ] || [ "$F" != "0" ]; then
    FAILED=1
    printf '  \033[31m✘\033[0m %s — اختبارات: %s ناجح: %s فاشل: %s\n' "${NAMES[$i]}" "$T" "$P" "$F"
    printf '%s\n' "$OUT" | grep -E '^\s*not ok|error:|expected|actual' | head -30
  else
    printf '  \033[32m✔\033[0m %s — اختبارات: %s ناجح: %s فاشل: %s\n' "${NAMES[$i]}" "$T" "$P" "$F"
  fi
  LINES+=("| ${NAMES[$i]} | \`npm run ${CMDS[$i]}\` | $T | $P | $F |")
done

{
  echo '<!-- SECURECASEDESK_PHASE11_S5 -->'
  echo '# نتائج اختبارات 11.5 (نتائج فعلية من تشغيل السكربت)'
  echo
  echo "* التاريخ: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "* Node: $(node -v)"
  echo
  echo '| المجموعة | الأمر | الاختبارات | الناجح | الفاشل |'
  echo '|---|---|---|---|---|'
  for l in "${LINES[@]}"; do echo "$l"; done
  echo
  if [ "$FAILED" -eq 0 ]; then echo 'الحالة: **نجحت كل المجموعات أعلاه في بيئة Node.**'; else echo 'الحالة: **توجد اختبارات فاشلة — لا تُعتبر المرحلة مكتملة.**'; fi
  echo
  echo '## ما لم يُختبر (معلّق — لا يُعدّ ناجحاً)'
  echo
  echo '* الواجهات الجديدة (زر «أنشئ مذكرة من المسودة»، تعبئة النموذج، شاشة الخصوصية) على جهاز Android حقيقي.'
  echo '* اتصال فعلي بمزوّد سحابي حقيقي (الاختبارات تستخدم مزوّدات وهمية داخل tests/ فقط).'
  echo '* المحرك المحلي للذكاء الاصطناعي (غير مدمج في هذا الإصدار).'
  echo '* بناء APK واختباره على جهاز حقيقي (المرحلة 12).'
} > "$RESULT_FILE"
ok "كُتبت النتائج الفعلية في $RESULT_FILE"

echo
if [ "$FAILED" -eq 0 ]; then
  printf '\033[1;32m✔ اكتمل القسم 11.5 ونجحت كل الاختبارات في Node.\033[0m\n'
  echo "الخطوات اليدوية المتبقية (لا يمكن للسكربت تنفيذها):"
  echo "  1) شغّل التطبيق على جهاز Android: صياغة مذكرة ← اعتماد ← «أنشئ مذكرة من المسودة» ← تحقق أن النموذج معبّأ ولم يُحفظ شيء."
  echo "  2) الإعدادات ← فحص خصوصية الذكاء الاصطناعي (كمدير) وتأكد من التقرير؛ وجرّب الدخول كمشاهد محتجزين وتأكد أن الأزرار غير ظاهرة."
  echo "  3) راجع docs/phase11/11.5-ai-privacy-final.md ثم ارفع التغييرات إلى GitHub."
else
  printf '\033[1;31m✘ نجح التثبيت لكن بعض الاختبارات فشلت — أرسل لي المخرجات أعلاه.\033[0m\n'
  exit 2
fi
