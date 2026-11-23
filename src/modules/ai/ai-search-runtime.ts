// SECURECASEDESK_PHASE11_S2
// محوّل Expo للبحث الذكي: يربط المنسّق بقاعدة البيانات عبر خدمات القضايا والمذكرات الموجودة
// (وهي تفرض requirePerm بنفسها)، وبمنسّق الذكاء الاصطناعي. ⚠️ لم يُختبر على جهاز Android حقيقي بعد.

import { getDb } from '@/database/db';
import { listCases } from '@/services/cases.service';
import { listMemoTypes, listMemos } from '@/services/memos.service';
import { getAiManager } from './ai-runtime';
import { createAiSearch, type AiSearch } from './ai-search';

let instance: AiSearch | null = null;

export function getAiSearch(): AiSearch {
  if (instance) return instance;
  instance = createAiSearch({
    manager: getAiManager(),
    async resolveActiveRole(userId) {
      const db = await getDb();
      const row = await db.getFirstAsync<{ role: string; is_active: number }>(
        'SELECT role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ?', [userId]
      );
      return row && Number(row.is_active) === 1 ? String(row.role) : null;
    },
    loadCases: (s) => listCases(s),
    loadMemos: (s) => listMemos(s),
    loadMemoTypes: (s) => listMemoTypes(s),
    now: () => Date.now(),
  });
  return instance;
}
