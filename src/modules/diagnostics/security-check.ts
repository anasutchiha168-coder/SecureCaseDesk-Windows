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
