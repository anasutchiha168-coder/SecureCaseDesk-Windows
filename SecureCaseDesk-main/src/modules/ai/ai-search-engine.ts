// SECURECASEDESK_PHASE11_S2
// محرك البحث: يعمل بالكامل على الجهاز وعلى صفوف سبق للطبقة المخوِّلة تمريرها (لا يلمس قاعدة البيانات).
// لا يُرسل شيء منه إلى أي شبكة. ما لا يُمرَّر إليه لا يمكن أن يظهر في النتائج.

import { containsForm, matchForms, snippetFor, toHaystack } from './ai-search-text';
import type { DateRange, SearchEntity, SearchPlan } from './ai-search-plan';

export interface SearchCaseRow {
  id: string; case_number: string; title: string; complainant: string | null; suspects: string | null;
  case_type: string; registration_date: number; incident_location: string | null;
  incident_details: string | null; status: string;
}
export interface SearchMemoRow {
  id: string; memo_number: string; memo_type_id: string; memo_date: number; recipient_organization: string;
  subject: string; body: string | null; linked_case_id: string | null; status: string;
}

export interface SearchData {
  cases: readonly SearchCaseRow[] | null; // null = غير مسموح/غير مطلوب
  memos: readonly SearchMemoRow[] | null;
  memoTypes: ReadonlyMap<string, string>;
}

export interface SearchHit {
  kind: SearchEntity;
  id: string;
  title: string;
  subtitle: string;
  snippet: string | null;
  score: number;
  date: number;
  matched: string[];
  details: { label: string; value: string }[];
}

export interface SearchOutcome {
  hits: SearchHit[];
  totalMatched: number;
  truncated: boolean;
  scanned: { cases: number; memos: number };
}

export const MAX_HITS = 50;
const SYNONYM_FACTOR = 0.6;

interface Field { label: string; weight: number; hay: string; raw: string | null; snippetable: boolean }

function minRequired(n: number): number {
  if (n <= 2) return n;
  return Math.ceil(n / 2);
}

function inRange(date: number, range: DateRange | null): boolean {
  if (!range) return true;
  return typeof date === 'number' && date >= range.from && date < range.to;
}

interface Scored { score: number; matched: string[]; snippet: string | null; hitForms: string[] }

function scoreFields(fields: Field[], groups: string[][]): Scored | null {
  if (groups.length === 0) return { score: 0, matched: [], snippet: null, hitForms: [] };
  let total = 0; let matchedGroups = 0;
  const matched = new Set<string>();
  const hitForms: string[] = [];
  let snippetField: Field | null = null;

  for (const group of groups) {
    let best = 0; let bestField: Field | null = null; let bestForms: string[] = [];
    group.forEach((variant, vi) => {
      const forms = matchForms(variant);
      for (const f of fields) {
        if (!f.hay) continue;
        if (forms.some((form) => containsForm(f.hay, form))) {
          const w = f.weight * (vi === 0 ? 1 : SYNONYM_FACTOR);
          if (w > best) { best = w; bestField = f; bestForms = forms; }
        }
      }
    });
    if (best > 0 && bestField) {
      total += best; matchedGroups++;
      matched.add((bestField as Field).label);
      hitForms.push(...bestForms.filter((x) => !x.includes(' ')), ...bestForms.flatMap((x) => (x.includes(' ') ? x.split(' ') : [])));
      const bf = bestField as Field;
      if (bf.snippetable && (!snippetField || bf.weight < snippetField.weight)) snippetField = bf;
    }
  }
  if (matchedGroups < minRequired(groups.length)) return null;
  if (matchedGroups === groups.length) total += 5;
  const snippet = snippetField ? snippetFor((snippetField as Field).raw, hitForms) : null;
  return { score: total, matched: [...matched], snippet, hitForms };
}

function trunc(s: string | null | undefined, n: number): string {
  const t = (s ?? '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export function runSearch(plan: SearchPlan, data: SearchData): SearchOutcome {
  const wantCase = data.cases !== null && (plan.entities === null || plan.entities.includes('case'));
  const wantMemo = data.memos !== null && (plan.entities === null || plan.entities.includes('memo'));
  const hits: SearchHit[] = [];
  let scannedCases = 0; let scannedMemos = 0;

  const caseById = new Map<string, SearchCaseRow>();
  if (data.cases) for (const c of data.cases) caseById.set(c.id, c);

  if (wantCase && data.cases) {
    for (const c of data.cases) {
      scannedCases++;
      if (!inRange(c.registration_date, plan.range)) continue;
      const fields: Field[] = [
        { label: 'رقم القضية', weight: 10, hay: toHaystack(c.case_number), raw: c.case_number, snippetable: false },
        { label: 'العنوان', weight: 6, hay: toHaystack(c.title), raw: c.title, snippetable: false },
        { label: 'نوع القضية', weight: 4, hay: toHaystack(c.case_type), raw: c.case_type, snippetable: false },
        { label: 'المتهمون', weight: 4, hay: toHaystack(c.suspects), raw: c.suspects, snippetable: true },
        { label: 'المدّعي', weight: 4, hay: toHaystack(c.complainant), raw: c.complainant, snippetable: true },
        { label: 'مكان الحادث', weight: 3, hay: toHaystack(c.incident_location), raw: c.incident_location, snippetable: true },
        { label: 'تفاصيل الحادث', weight: 2, hay: toHaystack(c.incident_details), raw: c.incident_details, snippetable: true },
        { label: 'الحالة', weight: 2, hay: toHaystack(c.status), raw: c.status, snippetable: false },
      ];
      const sc = scoreFields(fields, plan.groups);
      if (!sc) continue;
      hits.push({
        kind: 'case', id: c.id, title: c.title, subtitle: 'قضية رقم ' + c.case_number + ' • ' + c.status,
        snippet: sc.snippet, score: sc.score, date: c.registration_date, matched: sc.matched,
        details: [
          { label: 'نوع القضية', value: c.case_type },
          { label: 'الحالة', value: c.status },
          ...(c.complainant ? [{ label: 'المدّعي', value: trunc(c.complainant, 120) }] : []),
          ...(c.suspects ? [{ label: 'المتهمون', value: trunc(c.suspects, 160) }] : []),
          ...(c.incident_location ? [{ label: 'مكان الحادث', value: trunc(c.incident_location, 120) }] : []),
          ...(c.incident_details ? [{ label: 'التفاصيل', value: trunc(c.incident_details, 300) }] : []),
        ],
      });
    }
  }

  if (wantMemo && data.memos) {
    for (const m of data.memos) {
      scannedMemos++;
      if (!inRange(m.memo_date, plan.range)) continue;
      const typeName = data.memoTypes.get(m.memo_type_id) ?? '';
      // بيانات القضية المرتبطة لا تُستعمل إلا إن كانت القضايا نفسها مسموحة (data.cases != null).
      const linked = m.linked_case_id ? caseById.get(m.linked_case_id) : undefined;
      const fields: Field[] = [
        { label: 'رقم المذكرة', weight: 10, hay: toHaystack(m.memo_number), raw: m.memo_number, snippetable: false },
        { label: 'الموضوع', weight: 6, hay: toHaystack(m.subject), raw: m.subject, snippetable: false },
        { label: 'نوع المذكرة', weight: 4, hay: toHaystack(typeName), raw: typeName, snippetable: false },
        { label: 'الجهة الموجّهة إليها', weight: 4, hay: toHaystack(m.recipient_organization), raw: m.recipient_organization, snippetable: true },
        { label: 'القضية المرتبطة', weight: 3, hay: linked ? toHaystack(linked.case_number + ' ' + linked.title) : '', raw: null, snippetable: false },
        { label: 'نص المذكرة', weight: 2, hay: toHaystack(m.body), raw: m.body, snippetable: true },
        { label: 'الحالة', weight: 2, hay: toHaystack(m.status), raw: m.status, snippetable: false },
      ];
      const sc = scoreFields(fields, plan.groups);
      if (!sc) continue;
      hits.push({
        kind: 'memo', id: m.id, title: m.subject, subtitle: 'مذكرة رقم ' + m.memo_number + ' • ' + m.status,
        snippet: sc.snippet, score: sc.score, date: m.memo_date, matched: sc.matched,
        details: [
          ...(typeName ? [{ label: 'نوع المذكرة', value: typeName }] : []),
          { label: 'الجهة', value: trunc(m.recipient_organization, 160) },
          { label: 'الحالة', value: m.status },
          ...(linked ? [{ label: 'القضية المرتبطة', value: linked.case_number + ' — ' + trunc(linked.title, 80) }] : []),
          ...(m.body ? [{ label: 'النص', value: trunc(m.body, 300) }] : []),
        ],
      });
    }
  }

  hits.sort((a, b) => (b.score - a.score) || (b.date - a.date));
  const totalMatched = hits.length;
  return {
    hits: hits.slice(0, MAX_HITS), totalMatched, truncated: totalMatched > MAX_HITS,
    scanned: { cases: scannedCases, memos: scannedMemos },
  };
}
