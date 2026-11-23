// SECURECASEDESK_PHASE11_S2
// منسّق البحث الذكي (كل الاعتماديات مُحقنة: يُختبر في Node بالكامل).
//
// مبادئ:
//  - الصلاحية أولاً: ai.use + الدور الحالي من جدول المستخدمين + cases.view/memos.view لكل نوع سجل.
//    لا يرى المستخدم عبر البحث إلا ما تعرضه له شاشاته أصلاً؛ مشاهد المحتجزين مرفوض.
//  - البحث المحلي (كلمات + تواريخ) يعمل دائماً ولا يحتاج أي ذكاء اصطناعي.
//  - الذكاء الاصطناعي يُحسّن فهم السؤال فقط (مرادفات/فترة/نوع). يستلم نص السؤال المنقّى وحده؛
//    لا سجلات ولا محتجزين ولا مرفقات ولا نتائج تغادر الجهاز أبداً.
//  - أي فشل في الذكاء الاصطناعي (غير مفعّل، لا تأكيد، شبكة، ردّ تالف) = تراجع صامت إلى البحث المحلي مع ملاحظة.
//  - لا يُحفظ سجل بحث، ولا يُسجَّل نص السؤال في التدقيق (البوابة تسجّل وصف الطلب فقط).

import { can } from '../../security/permissions';
import { ForbiddenError, requirePerm, type Session } from '../../security/guard';
import { AI_USE_PERMISSION, AiError, aiErrorMessage, isAiError, type AiEntityKind } from './ai-types';
import type { AiManager } from './ai-manager';
import {
  MAX_QUERY_CHARS, buildAiSearchRequest, isPlanEmpty, mergePlans, parseAiPlanText, parseLocalPlan,
  sanitizeQueryForAi, type SearchEntity,
} from './ai-search-plan';
import {
  runSearch, type SearchCaseRow, type SearchMemoRow, type SearchOutcome,
} from './ai-search-engine';

export type SearchEngineKind = 'local' | 'ai_local' | 'ai_cloud';

export interface AiSearchDeps {
  manager: Pick<AiManager, 'getState' | 'authorizeUse'>;
  resolveActiveRole(userId: string): Promise<string | null>;
  // المحمّلات يجب أن تفرض الصلاحية بنفسها (listCases/listMemos تفعل requirePerm).
  loadCases(session: Session): Promise<SearchCaseRow[]>;
  loadMemos(session: Session): Promise<SearchMemoRow[]>;
  loadMemoTypes(session: Session): Promise<{ id: string; name: string }[]>;
  now(): number;
}

export interface SearchStatus {
  engine: SearchEngineKind;       // ما سيُستعمل إن أُكّد/توفّر
  aiUsable: boolean;
  cloudConfirmationNeeded: boolean;
  message: string;
  searchable: { case: boolean; memo: boolean };
}

export interface SearchRunResult {
  outcome: SearchOutcome;
  engine: SearchEngineKind;       // ما استُعمل فعلاً
  aiNote: string | null;
  summary: { entities: SearchEntity[]; rangeLabel: string | null; groups: string[][] };
}

export interface AiSearch {
  getStatus(session: Session | null | undefined): Promise<SearchStatus>;
  search(session: Session | null | undefined, query: string, opts?: { confirmCloud?: boolean }): Promise<SearchRunResult>;
}

// الرموز التي لا تستحق ملاحظة (الحالة معروفة من شاشة الحالة).
const SILENT_CODES = new Set(['AI_DISABLED', 'FEATURE_DISABLED']);

export function createAiSearch(deps: AiSearchDeps): AiSearch {
  async function trustedSession(session: Session | null | undefined): Promise<{ s: Session; entities: SearchEntity[] }> {
    const s = requirePerm(session, AI_USE_PERMISSION);
    // الدور من الجدول لا من الجلسة: تغيير الدور أو تعطيل الحساب يسري فوراً.
    const dbRole = await deps.resolveActiveRole(s.userId);
    if (!dbRole || !can(dbRole, AI_USE_PERMISSION)) throw new ForbiddenError(AI_USE_PERMISSION);
    const trusted: Session = { userId: s.userId, role: dbRole as Session['role'] };
    const entities: SearchEntity[] = [];
    if (can(dbRole, 'cases.view')) entities.push('case');
    if (can(dbRole, 'memos.view')) entities.push('memo');
    if (entities.length === 0) throw new AiError('ENTITY_NOT_PERMITTED', 'search');
    return { s: trusted, entities };
  }

  return {
    async getStatus(session) {
      const { s, entities } = await trustedSession(session);
      const searchable = { case: entities.includes('case'), memo: entities.includes('memo') };
      let st;
      try { st = await deps.manager.getState(s); } catch {
        return { engine: 'local', aiUsable: false, cloudConfirmationNeeded: false, searchable,
          message: 'تعذر قراءة حالة الذكاء الاصطناعي. يعمل البحث المحلي بالكلمات والتواريخ.' };
      }
      if (st.mode === 'disabled') {
        return { engine: 'local', aiUsable: false, cloudConfirmationNeeded: false, searchable,
          message: 'الذكاء الاصطناعي معطّل. يعمل البحث المحلي بالكلمات والتواريخ.' };
      }
      if (!st.features.search) {
        return { engine: 'local', aiUsable: false, cloudConfirmationNeeded: false, searchable,
          message: 'ميزة البحث الذكي غير مفعّلة من الإعدادات. يعمل البحث المحلي.' };
      }
      if (!st.availability.available) {
        return { engine: 'local', aiUsable: false, cloudConfirmationNeeded: false, searchable,
          message: st.availability.message + ' يعمل البحث المحلي.' };
      }
      const cloud = st.mode === 'cloud';
      return {
        engine: cloud ? 'ai_cloud' : 'ai_local', aiUsable: true, cloudConfirmationNeeded: cloud, searchable,
        message: cloud
          ? 'البحث الذكي جاهز (سحابي). يُرسل نص السؤال المنقّى فقط بعد تأكيدك، ولا تُرسل أي سجلات.'
          : 'البحث الذكي جاهز (محلي).',
      };
    },

    async search(session, query, opts) {
      const { s, entities: permitted } = await trustedSession(session);

      const q = typeof query === 'string' ? query.replace(/\s+/g, ' ').trim() : '';
      if (q.length < 2 || q.length > MAX_QUERY_CHARS) throw new AiError('SEARCH_QUERY_INVALID');

      const now = deps.now();
      const local = parseLocalPlan(q, now);
      if (isPlanEmpty(local)) throw new AiError('SEARCH_QUERY_INVALID');

      // ---- تحسين اختياري بالذكاء الاصطناعي ----
      let plan = local;
      let engine: SearchEngineKind = 'local';
      let aiNote: string | null = null;
      try {
        const grant = await deps.manager.authorizeUse(s, {
          feature: 'search',
          entities: permitted as readonly AiEntityKind[],
          confirmCloudSend: opts?.confirmCloud === true,
        });
        try {
          const clean = sanitizeQueryForAi(q);
          const req = buildAiSearchRequest(clean.text);
          const res = await grant.provider.generate({ feature: 'search', system: req.system, prompt: req.prompt, maxOutputTokens: 300 });
          const suggestion = parseAiPlanText(res.text);
          if (suggestion) {
            plan = mergePlans(local, suggestion, now);
            engine = grant.mode === 'cloud' ? 'ai_cloud' : 'ai_local';
          } else {
            aiNote = 'ردّ الذكاء الاصطناعي غير مفهوم؛ نُفِّذ البحث المحلي.';
          }
        } catch (e) {
          aiNote = isAiError(e) ? aiErrorMessage(e.code) + ' نُفِّذ البحث المحلي.' : 'تعذر استعمال الذكاء الاصطناعي؛ نُفِّذ البحث المحلي.';
        }
      } catch (e) {
        if (e instanceof ForbiddenError) throw e;
        if (isAiError(e)) {
          if (!SILENT_CODES.has(e.code)) aiNote = aiErrorMessage(e.code) + ' نُفِّذ البحث المحلي.';
        } else {
          aiNote = 'تعذر استعمال الذكاء الاصطناعي؛ نُفِّذ البحث المحلي.';
        }
      }

      // ---- التحميل والبحث (الصلاحية تُفرض داخل المحمّلات أيضاً) ----
      const cases = permitted.includes('case') ? await deps.loadCases(s) : null;
      const memos = permitted.includes('memo') ? await deps.loadMemos(s) : null;
      const types = memos ? await deps.loadMemoTypes(s) : [];
      const memoTypes = new Map<string, string>(types.map((t) => [t.id, t.name]));

      // الذكاء الاصطناعي يضيّق ولا يوسّع: التقاطع مع المسموح.
      const effective: SearchEntity[] = plan.entities
        ? permitted.filter((e) => plan.entities!.includes(e))
        : [...permitted];
      // طلب نوع غير مسموح (مثلاً مذكرات لدور لا يراها) يعطي نتيجة فارغة، لا بديلاً من نوع آخر.
      const finalEntities = effective;
      const outcome = runSearch({ ...plan, entities: finalEntities }, { cases, memos, memoTypes });

      return {
        outcome, engine, aiNote,
        summary: { entities: finalEntities, rangeLabel: plan.range?.label ?? null, groups: plan.groups },
      };
    },
  };
}
