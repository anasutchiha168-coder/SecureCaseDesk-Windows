// SECURECASEDESK_DETAINEES_V22_S1_IMPORT
// استيراد معلومية السجناء (Excel) إلى الأشخاص + فترات الاحتجاز + الحركات.
// المرحلة 1 planImport: دالة نقية بلا قاعدة بيانات (تجربة جافة + تقرير).
// المرحلة 2 runImport : كتابة كاملة في معاملة واحدة (كل شيء أو لا شيء).
// قواعد: لا دمج أشخاص بتشابه الأسماء، ولا تخمين لقيمة غير معروفة (تُحفظ كما هي مع تنبيه).
import { can } from '../../security/permissions';
import type { CoreDb } from './detainees-core';
import { STATUS_HELD, STATUS_RELEASED, MOVE_ADMISSION, MOVE_RELEASE, REASON_RELEASE, authorityLabel } from './detainees-constants';

export const IMPORT_SOURCE = 'excel_import';
export const IMPORT_REASON = 'استيراد من ملف معلومية السجناء (Excel)';

export interface RawRow {
  excelRow: number; serial: string | null; name: string | null; age: string | null;
  idType: string | null; idNumber: string | null; phone: string | null;
  governorate: string | null; district: string | null; subDistrict: string | null;
  residence: string | null; occupation: string | null; offense: string | null;
  caseRole: string | null; reportNo: string | null; depositAuthority: string | null;
  admission: string | null; legalStatus: string | null; referralDate: string | null;
  place: string | null; release: string | null; exitType: string | null;
  exitProcedure: string | null; exitSource: string | null; fate: string | null; notes: string | null;
}

export type ExitKind = 'released' | 'transferred' | 'handed_over';

export interface PlannedRecord {
  excelRow: number; legacySerial: string | null; reference: string;
  fullName: string;
  person: {
    idType: string | null; idNumber: string | null; phone: string | null; governorate: string | null;
    district: string | null; subDistrict: string | null; residence: string | null; occupation: string | null; notes: string | null;
  };
  category: string; authority: string; offense: string;
  admissionTs: number; releaseTs: number | null; held: boolean;
  age: number | null; caseRole: string | null; reportNo: string | null; legalStatus: string | null; placeOfDetention: string | null;
  referralTs: number | null; exitKind: ExitKind | null; exitProcedure: string | null; exitSource: string | null;
  notes: string | null; flags: string[];
}

export interface PlanSummary {
  total: number; imported: number; held: number; released: number;
  skipped: { excelRow: number; name: string | null; reason: string }[];
  byCategory: Record<string, number>; byLegalStatus: Record<string, number>;
  byExitKind: Record<string, number>; exitUnclassified: number;
  duplicateNames: number; overlaps: number; unknownLegalStatus: string[];
}

export interface ImportPlan { records: PlannedRecord[]; summary: PlanSummary }

// ---------- أدوات ----------
export function norm(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ').trim();
}

// 09:00 UTC = 12:00 ظهراً بتوقيت اليمن، فيبقى اليوم نفسه في أي منطقة زمنية معقولة.
export function dateToTs(iso: string | null): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0);
}

const text = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s ? s : null;
};
const textNoZero = (v: string | null | undefined): string | null => {
  const s = text(v);
  return s === null || s === '0' ? null : s;
};

// ---------- جدول التحويل (قابل للتعديل) ----------
const CATEGORY_DIRECT: readonly (readonly [string, string])[] = [
  ['البحث الجنائي', 'قيد التحقيق الأولي'],
  ['الجزائية', 'النيابة الجزائية'],
  ['الابتدائية', 'النيابة الابتدائية'],
  ['إدارة الامن', 'إدارات أمن المديريات'],
  ['استخبارات الشرطة', 'استخبارات الشرطة'],
  ['بحث منطقة ظهر أبو طير', 'منطقة ظهر أبو الطير'],
];
const CATEGORY_MAP = new Map(CATEGORY_DIRECT.map(([k, v]) => [norm(k), v]));
export const CATEGORY_NONE = 'غير محدد';

export function mapCategory(deposit: string | null): string {
  const n = norm(deposit);
  if (!n) return CATEGORY_NONE;
  const direct = CATEGORY_MAP.get(n);
  if (direct) return direct;
  if (n.startsWith('نيابه')) return 'نيابات المديريات';
  return (deposit ?? '').trim(); // جهة جديدة: تُنشأ بنفس اسمها بلا تخمين
}

const LEGAL_MAP = new Map<string, string>([
  [norm('رهن التحقيق'), 'على ذمة النيابة'],
  [norm('رهن المحاكمة'), 'على ذمة المحكمة'],
  [norm('محكوم'), 'محكوم'],
]);
const LEGAL_KNOWN = new Set(['رهن جمع الاستدلالات', 'على ذمة النيابة', 'على ذمة المحكمة', 'محكوم'].map(norm));

const KNOWN_ID_TYPES = new Set(['شخصية', 'جواز سفر', 'مدرسية / جامعية', 'بطاقة عائلية', 'بطاقة نقابية/مهنية/وظيفية',
  'رخصة قيادة', 'عسكرية جيش', 'عسكرية شرطة', 'أخرى', 'بدون', 'غيرمبين'].map(norm));

export function classifyExit(raw: string | null): ExitKind | null {
  const n = norm(raw);
  if (!n) return null;
  if (/تسليم/.test(n)) return 'handed_over';
  if (/نقل/.test(n)) return 'transferred';
  if (/اطلاق|افراج|اخلاء/.test(n)) return 'released';
  return null;
}

const EXIT_KEYWORD: Record<ExitKind, string> = { released: 'افراج', transferred: 'نقل', handed_over: 'تسليم' };
export function resolveExitType(kind: ExitKind | null, exitTypes: readonly string[]): string | null {
  if (!kind) return null;
  const kw = EXIT_KEYWORD[kind];
  return exitTypes.find((t) => norm(t).includes(kw)) ?? null;
}

// ---------- المرحلة 1: التخطيط (بلا قاعدة بيانات) ----------
export function planImport(rows: readonly RawRow[], opts: { now?: number } = {}): ImportPlan {
  const now = opts.now ?? Date.now();
  const limit = now + 86_400_000;
  const skipped: PlanSummary['skipped'] = [];
  const recs: PlannedRecord[] = [];
  const unknownLegal = new Set<string>();

  for (const r of rows) {
    const name = text(r.name);
    const skip = (reason: string) => skipped.push({ excelRow: r.excelRow, name, reason });
    if (!name) { skip('بلا اسم'); continue; }
    const adm = dateToTs(r.admission);
    if (adm === null) { skip('تاريخ الإيداع ناقص أو غير صالح'); continue; }
    const rel = dateToTs(r.release);
    if (r.release && rel === null) { skip('تاريخ الخروج غير صالح'); continue; }
    if (adm > limit || (rel !== null && rel > limit)) { skip('تاريخ في المستقبل'); continue; }
    if (rel !== null && rel < adm) { skip('الخروج قبل الإيداع'); continue; }
    const fate = norm(r.fate);
    if (fate === norm('سجين') && rel !== null) { skip('مصيره «سجين» ولكن له تاريخ خروج'); continue; }
    if (fate === norm('خروج') && rel === null) { skip('مصيره «خروج» ولكن بلا تاريخ خروج'); continue; }

    const flags: string[] = [];
    const personNotes: string[] = [];
    const periodNotes: string[] = [];

    // الهوية
    let idType: string | null = null;
    const rawType = text(r.idType);
    if (rawType) {
      if (KNOWN_ID_TYPES.has(norm(rawType))) idType = rawType;
      else { idType = 'أخرى'; personNotes.push('نوع الهوية الأصلي: ' + rawType); }
    }

    // وضع السجين
    let legal: string | null = null;
    const rawLegal = text(r.legalStatus);
    if (rawLegal) {
      legal = LEGAL_MAP.get(norm(rawLegal)) ?? rawLegal;
      if (!LEGAL_KNOWN.has(norm(legal))) { unknownLegal.add(rawLegal); flags.push('وضع سجين غير معروف: ' + rawLegal); }
    }

    // الخروج
    const kind = classifyExit(r.exitType);
    const rawExitType = text(r.exitType);
    const procedure = text(r.exitProcedure) ?? rawExitType;
    if (rawExitType && text(r.exitProcedure) && norm(rawExitType) !== norm(r.exitProcedure)) {
      periodNotes.push('نوع الخروج الأصلي: ' + rawExitType);
    }
    if (rel !== null && rawExitType && !kind) flags.push('نوع خروج لم يُصنَّف تلقائياً (النص محفوظ في إجراءات الخروج)');

    if (text(r.notes)) periodNotes.push(text(r.notes) as string);

    const ageNum = text(r.age) && /^\d{1,3}$/.test(text(r.age) as string) ? Number(text(r.age)) : null;
    if (text(r.age) && ageNum === null) periodNotes.push('العمر الأصلي: ' + text(r.age));

    const offense = text(r.offense) ?? 'غير مبين';
    if (!text(r.offense)) flags.push('التهمة فارغة في الملف');

    recs.push({
      excelRow: r.excelRow, legacySerial: text(r.serial), reference: '', fullName: name,
      person: {
        idType, idNumber: textNoZero(r.idNumber), phone: textNoZero(r.phone), governorate: text(r.governorate),
        district: text(r.district), subDistrict: text(r.subDistrict), residence: text(r.residence), occupation: text(r.occupation),
        notes: personNotes.length ? personNotes.join(' | ') : null,
      },
      category: mapCategory(text(r.depositAuthority)), authority: text(r.depositAuthority) ?? '', offense,
      admissionTs: adm, releaseTs: rel, held: rel === null, age: ageNum,
      caseRole: text(r.caseRole), reportNo: textNoZero(r.reportNo), legalStatus: legal, placeOfDetention: text(r.place),
      referralTs: dateToTs(r.referralDate), exitKind: rel !== null ? kind : null,
      exitProcedure: rel !== null ? procedure : null, exitSource: rel !== null ? text(r.exitSource) : null,
      notes: periodNotes.length ? periodNotes.join(' | ') : null, flags,
    });
  }

  // الأرقام المرجعية: م الأصلي، وعند تكراره يُضاف /2 و/3 بترتيب تاريخ الإيداع.
  const bySerial = new Map<string, PlannedRecord[]>();
  for (const x of recs) {
    const key = x.legacySerial ?? 'XL-' + x.excelRow;
    const g = bySerial.get(key) ?? []; g.push(x); bySerial.set(key, g);
  }
  for (const [key, g] of bySerial) {
    g.sort((a, b) => a.admissionTs - b.admissionTs || a.excelRow - b.excelRow);
    g.forEach((x, i) => { x.reference = i === 0 ? key : key + '/' + (i + 1); });
  }

  // الأسماء المتطابقة: لا دمج، تنبيه فقط، مع كشف التداخل الزمني.
  const byName = new Map<string, PlannedRecord[]>();
  for (const x of recs) { const k = norm(x.fullName); const g = byName.get(k) ?? []; g.push(x); byName.set(k, g); }
  let duplicateNames = 0; let overlaps = 0;
  for (const g of byName.values()) {
    if (g.length < 2) continue;
    duplicateNames++;
    g.sort((a, b) => a.admissionTs - b.admissionTs);
    for (const x of g) {
      const others = g.filter((o) => o !== x).map((o) => o.reference).join('، ');
      x.flags.push('اسم مطابق لسجلات أخرى (' + others + ') — لم يُدمج، يُراجَع يدوياً');
    }
    for (let i = 0; i + 1 < g.length; i++) {
      const a = g[i]; const b = g[i + 1];
      if (a.releaseTs === null || a.releaseTs > b.admissionTs) {
        overlaps++;
        a.flags.push('تداخل زمني مع ' + b.reference); b.flags.push('تداخل زمني مع ' + a.reference);
      }
    }
  }
  for (const x of recs) if (x.flags.length) x.notes = (x.notes ? x.notes + ' | ' : '') + 'تنبيه استيراد: ' + x.flags.join('؛ ');

  const tally = (f: (x: PlannedRecord) => string | null) => {
    const o: Record<string, number> = {};
    for (const x of recs) { const k = f(x); if (k) o[k] = (o[k] ?? 0) + 1; }
    return o;
  };
  const held = recs.filter((x) => x.held).length;
  return {
    records: recs,
    summary: {
      total: rows.length, imported: recs.length, held, released: recs.length - held, skipped,
      byCategory: tally((x) => x.category), byLegalStatus: tally((x) => x.legalStatus),
      byExitKind: tally((x) => x.exitKind), exitUnclassified: recs.filter((x) => !x.held && !x.exitKind && x.exitProcedure).length,
      duplicateNames, overlaps, unknownLegalStatus: [...unknownLegal],
    },
  };
}

// ---------- المرحلة 2: الكتابة ----------
export interface RunOptions {
  exitTypes: readonly string[];
  now?: number;
  newId?: () => string;
  allowRerun?: boolean;
}
export interface RunResult { persons: number; periods: number; movements: number; categoriesCreated: string[] }

function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return h() + h() + '-' + h() + '-4' + h().slice(1) + '-a' + h().slice(1) + '-' + h() + h() + h();
}

export async function runImport(db: CoreDb, userId: string, plan: ImportPlan, opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? Date.now();
  const nid = opts.newId ?? defaultId;
  const result: RunResult = { persons: 0, periods: 0, movements: 0, categoriesCreated: [] };

  await db.withTransactionAsync(async () => {
    const u = await db.getFirstAsync<{ role: string | null }>('SELECT role FROM users WHERE id = ?', [userId]);
    if (!u || !can(u.role, 'detainees.manage')) throw new Error('FORBIDDEN:detainees.manage');
    if (plan.records.length === 0) throw new Error('IMPORT_EMPTY');

    if (!opts.allowRerun) {
      const prev = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM detainee_movements WHERE source = ?', [IMPORT_SOURCE]);
      if ((prev?.c ?? 0) > 0) throw new Error('IMPORT_ALREADY_DONE');
    }
    const existing = new Set((await db.getAllAsync<{ reference_number: string }>('SELECT reference_number FROM detainees')).map((r) => r.reference_number));
    const clash = plan.records.filter((r) => existing.has(r.reference)).map((r) => r.reference);
    if (clash.length) throw new Error('IMPORT_REFERENCE_COLLISION:' + clash.slice(0, 10).join(','));

    const cats = new Map<string, string>();
    for (const c of await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM detainee_categories')) cats.set(c.name, c.id);
    for (const name of new Set(plan.records.map((r) => r.category))) {
      if (cats.has(name)) continue;
      const id = nid();
      await db.runAsync('INSERT INTO detainee_categories (id, name, created_at) VALUES (?, ?, ?)', [id, name, now]);
      cats.set(name, id); result.categoriesCreated.push(name);
    }

    const stamp = now.toString(36);
    let seq = 0;
    for (const r of plan.records) {
      const personId = nid(); const detId = nid(); const catId = cats.get(r.category) as string;
      const p = r.person;
      await db.runAsync(
        `INSERT INTO persons (id, full_name, id_type, id_number, phone, governorate, district, sub_district,
           current_residence, occupation, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [personId, r.fullName, p.idType, p.idNumber, p.phone, p.governorate, p.district, p.subDistrict,
          p.residence, p.occupation, p.notes, userId, now, now]);
      await db.runAsync(
        `INSERT INTO detainees (id, person_id, period_no, reference_number, full_name, category_id, admission_date, release_date,
           alleged_offense, detaining_authority, status, age_at_admission, case_role, report_number, legal_status,
           prosecution_referral_date, exit_type, exit_procedure, exit_directive_source, legacy_serial, place_of_detention, notes,
           created_by, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [detId, personId, r.reference, r.fullName, catId, r.admissionTs, r.releaseTs, r.offense, r.authority,
          r.held ? STATUS_HELD : STATUS_RELEASED, r.age, r.caseRole, r.reportNo, r.legalStatus, r.referralTs,
          resolveExitType(r.exitKind, opts.exitTypes), r.exitProcedure, r.exitSource, r.legacySerial, r.placeOfDetention, r.notes,
          userId, now, now]);
      const label = authorityLabel(r.category, r.authority) || null;
      const move = async (type: string, date: number, prev: string | null, next: string | null, reason: string) => {
        await db.runAsync(
          `INSERT INTO detainee_movements (id, movement_number, detainee_id, movement_type, movement_date,
             previous_authority, new_authority, executed_by, reason, source, related_movement_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          [nid(), 'XL-' + stamp + '-' + (++seq), detId, type, date, prev, next, userId, reason, IMPORT_SOURCE, now]);
        result.movements++;
      };
      await move(MOVE_ADMISSION, r.admissionTs, null, label, IMPORT_REASON);
      if (r.releaseTs !== null) await move(MOVE_RELEASE, r.releaseTs, label, null, r.exitProcedure ?? REASON_RELEASE);
      result.persons++; result.periods++;
    }
  });
  return result;
}
