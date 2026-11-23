// SECURECASEDESK_PHASE10_S8
// استيراد هذا الملف (أثر جانبي) يسجّل خطاف التعافي: أول getDb() في العملية ينتظر إكمال/رجوع أي عملية
// استبدال انقطعت، قبل فتح القاعدة. فشل التعافي (ROLLBACK_FAILED) يمنع فتح القاعدة عمداً.
import { setPreOpenHook } from '@/database/db';
import { recoverInterruptedRestore } from './backup-rollback-runtime';

setPreOpenHook(async () => { await recoverInterruptedRestore(); });
