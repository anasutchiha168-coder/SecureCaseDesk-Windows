// اختبارات المرحلة 9 / القسم 1 — نظام المرفقات. تشغَّل بـ: npm run test:attachments
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { NodeDb, MemoryStorage, nodeCrypto, uuid, PDF, PNG, JPG } from './helpers/node-env';
import { initAttachmentsSchema } from '../src/modules/attachments/attachments-schema';
import { initAuditSchema } from '../src/database/audit-schema';
import {
  addAttachment, listAttachments, readAttachment, deleteAttachment, verifyAttachment,
  runAttachmentMaintenance, countAttachments, type AttachmentDeps,
} from '../src/modules/attachments/attachments-repo';
import { encryptAttachment, decryptAttachment, HEADER_LENGTH } from '../src/modules/attachments/attachments-crypto';
import { validateAttachment, sanitizeFileName } from '../src/modules/attachments/attachments-validation';
import { AttachmentError, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_ENTITY } from '../src/modules/attachments/attachments-types';
import { onForbidden, ForbiddenError, type Session } from '../src/security/guard';

const code = (c: string) => (e: unknown) => e instanceof AttachmentError && e.code === c;
const forbidden = (e: unknown) => e instanceof ForbiddenError;

let db: NodeDb;
let storage: MemoryStorage;
let keyStore: { key: Uint8Array | null };
let deps: AttachmentDeps;
let sessions: Record<string, Session>;
const ids = { admin: 'u-admin', inv: 'u-inv', viewer: 'u-view', det: 'u-det', off: 'u-off' };

function makeDeps(): AttachmentDeps {
  return {
    db, storage, crypto: nodeCrypto, uuid, now: () => Date.now(),
    async getMasterKey(allowCreate) {
      if (keyStore.key) return keyStore.key;
      if (!allowCreate) throw new Error('ATTACHMENT_KEY_MISSING');
      keyStore.key = new Uint8Array(randomBytes(32));
      return keyStore.key;
    },
  };
}

beforeEach(async () => {
  db = new NodeDb(); storage = new MemoryStorage(); keyStore = { key: null };
  await db.execAsync(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE cases (id TEXT PRIMARY KEY, case_number TEXT);
    CREATE TABLE memos (id TEXT PRIMARY KEY, memo_number TEXT);
    CREATE TABLE detainees (id TEXT PRIMARY KEY, full_name TEXT);
    INSERT INTO users VALUES ('u-admin','admin','admin',1),('u-inv','inv','investigator',1),
      ('u-view','viewer','viewer',1),('u-det','det','detention_viewer',1),('u-off','off','admin',0);
    ALTER TABLE users ADD COLUMN department_id TEXT;
    INSERT INTO cases VALUES ('c1','2026/1'),('c2','2026/2');
    INSERT INTO memos VALUES ('m1','M-1');
    ALTER TABLE cases ADD COLUMN department_id TEXT; UPDATE cases SET department_id = 'dep1'; ALTER TABLE memos ADD COLUMN linked_case_id TEXT; UPDATE users SET department_id = 'dep1' WHERE id = 'u-inv';
    INSERT INTO detainees VALUES ('d1','محتجز تجريبي');
  `);
  await initAttachmentsSchema(db as never);
  await initAuditSchema(db as never);
  deps = makeDeps();
  sessions = {
    admin: { userId: ids.admin, role: 'admin' }, inv: { userId: ids.inv, role: 'investigator' },
    viewer: { userId: ids.viewer, role: 'viewer' }, det: { userId: ids.det, role: 'detention_viewer' },
    off: { userId: ids.off, role: 'admin' },
  };
});

describe('التحقق من الملفات', () => {
  test('يقبل PDF وJPG وJPEG وPNG الصحيحة', () => {
    assert.equal(validateAttachment({ name: 'a.pdf', bytes: PDF() }).mime, 'application/pdf');
    assert.equal(validateAttachment({ name: 'a.JPG', bytes: JPG() }).extension, 'jpg');
    assert.equal(validateAttachment({ name: 'a.jpeg', bytes: JPG(), declaredMime: 'image/jpg' }).mime, 'image/jpeg');
    assert.equal(validateAttachment({ name: 'صورة.png', bytes: PNG(), declaredMime: 'image/png' }).name, 'صورة.png');
  });
  test('يرفض الامتدادات غير المسموحة', () => {
    for (const n of ['a.exe', 'a.docx', 'a.html', 'a.svg', 'a', 'a.pdf.exe', '.pdf'])
      assert.throws(() => validateAttachment({ name: n, bytes: PDF() }), code('UNSUPPORTED_TYPE'), n); // '.pdf' يُجرَّد من النقطة الأولى فيصبح بلا امتداد
  });
  test('يرفض الملف الفارغ والكبير', () => {
    assert.throws(() => validateAttachment({ name: 'a.pdf', bytes: new Uint8Array(0) }), code('EMPTY_FILE'));
    const big = PDF(); const huge = new Uint8Array(MAX_ATTACHMENT_BYTES + 1); huge.set(big);
    assert.throws(() => validateAttachment({ name: 'a.pdf', bytes: huge }), code('FILE_TOO_LARGE'));
    const exact = new Uint8Array(MAX_ATTACHMENT_BYTES); exact.set(big);
    assert.equal(validateAttachment({ name: 'a.pdf', bytes: exact }).size, MAX_ATTACHMENT_BYTES);
  });
  test('يرفض عدم تطابق المحتوى مع الامتداد (توقيع الملف)', () => {
    assert.throws(() => validateAttachment({ name: 'a.pdf', bytes: PNG() }), code('CONTENT_MISMATCH'));
    assert.throws(() => validateAttachment({ name: 'a.png', bytes: new TextEncoder().encode('MZ\x90 exe') }), code('CONTENT_MISMATCH'));
    assert.throws(() => validateAttachment({ name: 'a.jpg', bytes: PDF() }), code('CONTENT_MISMATCH'));
  });
  test('يرفض MIME معلن مخالف ويقبل octet-stream', () => {
    assert.throws(() => validateAttachment({ name: 'a.pdf', bytes: PDF(), declaredMime: 'image/png' }), code('MIME_MISMATCH'));
    assert.equal(validateAttachment({ name: 'a.pdf', bytes: PDF(), declaredMime: 'application/octet-stream' }).kind, 'pdf');
  });
  test('تنظيف الاسم: مسارات وأحرف اتجاه (RLO) وطول', () => {
    assert.equal(sanitizeFileName('../../etc/passwd.pdf'), '....etcpasswd.pdf'.replace(/^\.+/, ''));
    assert.equal(sanitizeFileName('invoice\u202Efdp.exe'), 'invoicefdp.exe');
    assert.throws(() => validateAttachment({ name: 'invoice\u202Etxt.exe', bytes: PDF() }), code('UNSUPPORTED_TYPE'));
    const long = 'ب'.repeat(300) + '.pdf';
    const out = sanitizeFileName(long);
    assert.ok(out.length <= 120 && out.endsWith('.pdf'));
    assert.throws(() => sanitizeFileName('\u0000\u202E  '), code('INVALID_NAME'));
  });
});

describe('التشفير', () => {
  const master = new Uint8Array(randomBytes(32));
  test('تشفير وفك تشفير يعيد الأصل بالضبط', () => {
    const plain = new Uint8Array(randomBytes(100_000));
    const { blob } = encryptAttachment(nodeCrypto, master, 'id-1', plain);
    assert.deepEqual(decryptAttachment(nodeCrypto, master, 'id-1', blob), plain);
  });
  test('النص المشفر لا يحوي النص الأصلي ويختلف في كل مرة', () => {
    const plain = PDF('بيانات-سرية-جداً-SECRET-MARKER');
    const a = encryptAttachment(nodeCrypto, master, 'id-1', plain);
    const b = encryptAttachment(nodeCrypto, master, 'id-1', plain);
    assert.ok(!Buffer.from(a.blob).includes('SECRET-MARKER'));
    assert.ok(!Buffer.from(a.blob).includes('%PDF'));
    assert.notDeepEqual(a.blob, b.blob);
  });
  test('أي تعديل بايت واحد في الملف المشفر يُكتشف', () => {
    const { blob } = encryptAttachment(nodeCrypto, master, 'id-1', PDF());
    for (const pos of [0, 4, 6, HEADER_LENGTH, blob.length - 1]) {
      const t = blob.slice(); t[pos] ^= 1;
      assert.throws(() => decryptAttachment(nodeCrypto, master, 'id-1', t), code('DECRYPT_FAILED'), 'pos ' + pos);
    }
    assert.throws(() => decryptAttachment(nodeCrypto, master, 'id-1', blob.slice(0, blob.length - 3)), code('DECRYPT_FAILED'));
  });
  test('مفتاح خاطئ أو معرّف مرفق آخر يفشل (ربط الملف بسجله)', () => {
    const { blob } = encryptAttachment(nodeCrypto, master, 'id-1', PDF());
    assert.throws(() => decryptAttachment(nodeCrypto, new Uint8Array(randomBytes(32)), 'id-1', blob), code('DECRYPT_FAILED'));
    assert.throws(() => decryptAttachment(nodeCrypto, master, 'id-2', blob), code('DECRYPT_FAILED'));
  });
});

describe('الإضافة والقراءة والاستمرارية', () => {
  test('إضافة ثم قراءة تعيد البايتات نفسها، والملف المخزَّن مشفّر', async () => {
    const bytes = PDF('محتوى-قضية');
    const info = await addAttachment(deps, sessions.inv, 'case', 'c1', { name: 'تقرير.pdf', bytes });
    assert.equal(info.original_name, 'تقرير.pdf');
    assert.equal(info.sha256_plain, nodeCrypto.sha256Hex(bytes));
    const stored = storage.files.get(info.id + '.enc')!;
    assert.ok(!Buffer.from(stored).includes('محتوى-قضية'));
    const read = await readAttachment(deps, sessions.viewer, info.id);
    assert.deepEqual(read.bytes, bytes);
  });
  test('البيانات تبقى بعد "إعادة التشغيل" (كائن اعتماديات جديد، نفس القاعدة والتخزين والمفتاح)', async () => {
    const bytes = new Uint8Array([...JPG(), ...randomBytes(5000)]);
    const info = await addAttachment(deps, sessions.admin, 'memo', 'm1', { name: 'a.jpg', bytes });
    const restarted = makeDeps();
    assert.deepEqual((await readAttachment(restarted, sessions.admin, info.id)).bytes, bytes);
    assert.equal((await listAttachments(restarted, sessions.admin, 'memo', 'm1')).length, 1);
  });
  test('اسم التخزين عشوائي ولا يكشف الاسم الأصلي', async () => {
    await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'سري-جداً.pdf', bytes: PDF() });
    for (const n of await storage.list()) assert.match(n, /^[0-9a-f-]{36}\.enc$/);
  });
  test('رفض سجل مرتبط غير موجود (على مستوى الخدمة وعلى مستوى القاعدة)', async () => {
    await assert.rejects(addAttachment(deps, sessions.admin, 'case', 'nope', { name: 'a.pdf', bytes: PDF() }), code('ENTITY_NOT_FOUND'));
    await assert.rejects(db.runAsync(
      `INSERT INTO attachments (id,entity_type,entity_id,original_name,extension,mime_type,size_bytes,sha256_plain,sha256_cipher,storage_name,created_by,created_at)
       VALUES ('x','case','nope','a.pdf','pdf','application/pdf',5,?,?,'x.enc','u-admin',1)`, ['a'.repeat(64), 'b'.repeat(64)]), /غير موجود/);
    assert.equal(storage.files.size, 0);
  });
  test('منع التكرار لنفس السجل والسماح به لسجل آخر', async () => {
    const bytes = PDF('same');
    await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes });
    await assert.rejects(addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'b.pdf', bytes }), code('DUPLICATE'));
    await addAttachment(deps, sessions.admin, 'case', 'c2', { name: 'a.pdf', bytes });
    assert.equal(storage.files.size, 2);
  });
  test('الحد الأقصى لعدد المرفقات للسجل', async () => {
    for (let i = 0; i < MAX_ATTACHMENTS_PER_ENTITY; i++)
      await addAttachment(deps, sessions.admin, 'case', 'c1', { name: `f${i}.pdf`, bytes: PDF('n' + i) });
    await assert.rejects(addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'z.pdf', bytes: PDF('zz') }), code('LIMIT_REACHED'));
    assert.equal(await countAttachments(deps, sessions.admin, 'case', 'c1'), MAX_ATTACHMENTS_PER_ENTITY);
  });
  test('فشل الكتابة على القرص لا يترك سجلاً ولا ملفاً', async () => {
    storage.failWrites = true;
    await assert.rejects(addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF() }), code('STORAGE_FAILED'));
    assert.equal((await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) c FROM attachments'))!.c, 0);
    assert.equal(storage.files.size, 0);
  });
  test('فشل إدراج السجل بعد كتابة الملف ينظف الملف (لا ملفات يتيمة)', async () => {
    await db.execAsync(`CREATE TRIGGER boom BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'boom'); END;`);
    await assert.rejects(addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF() }), /boom/);
    assert.equal(storage.files.size, 0);
  });
  test('ملف مرفوض لا يُخزَّن', async () => {
    await assert.rejects(addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PNG() }), code('CONTENT_MISMATCH'));
    assert.equal(storage.files.size, 0);
  });
});

describe('الصلاحيات (على مستوى طبقة البيانات)', () => {
  test('المحقق: إضافة لقضية ومذكرة، لا لمحتجز', async () => {
    await addAttachment(deps, sessions.inv, 'case', 'c1', { name: 'a.pdf', bytes: PDF('1') });
    await addAttachment(deps, sessions.inv, 'memo', 'm1', { name: 'a.pdf', bytes: PDF('2') });
    await assert.rejects(addAttachment(deps, sessions.inv, 'detainee', 'd1', { name: 'a.pdf', bytes: PDF('3') }), forbidden);
  });
  test('مستخدم الاطلاع: عرض فقط، لا إضافة ولا حذف', async () => {
    const info = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF() });
    assert.equal((await listAttachments(deps, sessions.viewer, 'case', 'c1')).length, 1);
    await readAttachment(deps, sessions.viewer, info.id);
    await assert.rejects(addAttachment(deps, sessions.viewer, 'case', 'c1', { name: 'b.pdf', bytes: PDF('b') }), forbidden);
    await assert.rejects(deleteAttachment(deps, sessions.viewer, info.id, 'سبب كافٍ للحذف'), forbidden);
  });
  test('مشاهد المحتجزين: لا وصول لمرفقات القضايا والمذكرات إطلاقاً، ويعرض مرفقات المحتجزين فقط', async () => {
    const c = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF('c') });
    const m = await addAttachment(deps, sessions.admin, 'memo', 'm1', { name: 'a.pdf', bytes: PDF('m') });
    const d = await addAttachment(deps, sessions.admin, 'detainee', 'd1', { name: 'a.pdf', bytes: PDF('d') });
    await assert.rejects(listAttachments(deps, sessions.det, 'case', 'c1'), forbidden);
    await assert.rejects(listAttachments(deps, sessions.det, 'memo', 'm1'), forbidden);
    await assert.rejects(readAttachment(deps, sessions.det, c.id), forbidden);
    await assert.rejects(readAttachment(deps, sessions.det, m.id), forbidden);
    await assert.rejects(verifyAttachment(deps, sessions.det, c.id), forbidden);
    await assert.rejects(countAttachments(deps, sessions.det, 'case', 'c1'), forbidden);
    assert.equal((await listAttachments(deps, sessions.det, 'detainee', 'd1')).length, 1);
    assert.deepEqual((await readAttachment(deps, sessions.det, d.id)).bytes, PDF('d'));
    await assert.rejects(addAttachment(deps, sessions.det, 'detainee', 'd1', { name: 'b.pdf', bytes: PDF('z') }), forbidden);
    await assert.rejects(deleteAttachment(deps, sessions.det, d.id, 'سبب كافٍ للحذف'), forbidden);
  });
  test('حساب معطّل أو جلسة ناقصة أو دور مجهول أو نوع سجل مزوّر = رفض', async () => {
    await assert.rejects(addAttachment(deps, sessions.off, 'case', 'c1', { name: 'a.pdf', bytes: PDF() }), forbidden);
    await assert.rejects(listAttachments(deps, null, 'case', 'c1'), forbidden);
    await assert.rejects(listAttachments(deps, { userId: 'u-admin', role: 'root' as never }, 'case', 'c1'), forbidden);
    await assert.rejects(listAttachments(deps, sessions.admin, 'users' as never, 'c1'), code('ENTITY_NOT_FOUND'));
    // دور في الجلسة مزوّر لكن الدور الفعلي في القاعدة أدنى
    await assert.rejects(addAttachment(deps, { userId: ids.viewer, role: 'admin' }, 'case', 'c1', { name: 'a.pdf', bytes: PDF() }), forbidden);
  });
  test('محاولات الرفض تُبلَّغ لمستمع التدقيق (onForbidden)', async () => {
    const seen: string[] = [];
    const off = onForbidden((e) => seen.push(`${e.userId}:${e.permission}`));
    await assert.rejects(listAttachments(deps, sessions.det, 'case', 'c1'), forbidden);
    off();
    assert.deepEqual(seen, ['u-det:cases.view']);
  });
});

describe('سلامة الملفات واكتشاف العبث', () => {
  test('تعديل الملف المشفر على القرص يُكتشف عند القراءة والتحقق', async () => {
    const info = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF() });
    const blob = storage.files.get(info.id + '.enc')!; blob[blob.length - 1] ^= 1;
    await assert.rejects(readAttachment(deps, sessions.admin, info.id), code('INTEGRITY_FAILED'));
    assert.deepEqual(await verifyAttachment(deps, sessions.admin, info.id), { id: info.id, ok: false, problem: 'INTEGRITY_FAILED' });
  });
  test('استبدال ملف مرفق بملف مشفر صالح لمرفق آخر يُكتشف', async () => {
    const a = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF('A') });
    const b = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'b.pdf', bytes: PDF('B') });
    storage.files.set(a.id + '.enc', storage.files.get(b.id + '.enc')!.slice());
    await assert.rejects(readAttachment(deps, sessions.admin, a.id), code('INTEGRITY_FAILED'));
  });
  test('ملف مفقود يعطي رسالة واضحة', async () => {
    const info = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF() });
    storage.files.delete(info.id + '.enc');
    await assert.rejects(readAttachment(deps, sessions.admin, info.id), code('FILE_MISSING'));
  });
  test('فقدان المفتاح الرئيسي: القراءة تفشل، والإضافة لا تنشئ مفتاحاً جديداً بصمت', async () => {
    await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF() });
    const id = (await listAttachments(deps, sessions.admin, 'case', 'c1'))[0].id;
    keyStore.key = null;
    await assert.rejects(readAttachment(deps, sessions.admin, id), code('KEY_MISSING'));
    await assert.rejects(addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'b.pdf', bytes: PDF('b') }), code('KEY_MISSING'));
    assert.equal(keyStore.key, null);
    assert.equal(storage.files.size, 1);
  });
  test('الصيانة: تكشف المفقود والتالف وتزيل الملفات اليتيمة', async () => {
    const a = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF('A') });
    const b = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'b.pdf', bytes: PDF('B') });
    const c = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'c.pdf', bytes: PDF('C') });
    storage.files.delete(a.id + '.enc'); storage.files.get(b.id + '.enc')![30] ^= 1;
    storage.files.set(uuid() + '.enc', new Uint8Array([1, 2, 3]));
    const r = await runAttachmentMaintenance(deps, sessions.admin);
    assert.deepEqual({ ...r }, { checked: 3, healthy: 1, missing: [a.id], corrupted: [b.id], orphansRemoved: 1 });
    assert.ok(storage.files.has(c.id + '.enc'));
    await assert.rejects(runAttachmentMaintenance(deps, sessions.inv), forbidden);
  });
});

describe('الحذف المنطقي وحماية السجل', () => {
  test('الحذف للمدير فقط بسبب، ويُبقي السجل ويزيل الملف المشفر', async () => {
    const info = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF() });
    await assert.rejects(deleteAttachment(deps, sessions.inv, info.id, 'سبب كافٍ للحذف'), forbidden);
    await assert.rejects(deleteAttachment(deps, sessions.admin, info.id, '  '), code('REASON_REQUIRED'));
    await deleteAttachment(deps, sessions.admin, info.id, 'رُفع بالخطأ على القضية');
    const row = await db.getFirstAsync<any>('SELECT * FROM attachments WHERE id = ?', [info.id]);
    assert.equal(row.status, 'deleted'); assert.equal(row.deleted_by, ids.admin); assert.equal(row.reason, 'رُفع بالخطأ على القضية');
    assert.equal(storage.files.size, 0);
    assert.equal((await listAttachments(deps, sessions.admin, 'case', 'c1')).length, 0);
    await assert.rejects(readAttachment(deps, sessions.admin, info.id), code('ALREADY_DELETED'));
    await assert.rejects(deleteAttachment(deps, sessions.admin, info.id, 'سبب كافٍ مرة أخرى'), code('ALREADY_DELETED'));
  });
  test('بعد حذف مرفق يمكن إعادة رفع الملف نفسه', async () => {
    const bytes = PDF('again');
    const a = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes });
    await deleteAttachment(deps, sessions.admin, a.id, 'سبب كافٍ للحذف');
    await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes });
  });
  test('لا حذف فعلياً ولا تعديل مباشر للسجل حتى بـ SQL مباشر', async () => {
    const info = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF() });
    await assert.rejects(db.runAsync('DELETE FROM attachments WHERE id = ?', [info.id]), /لا يقبل الحذف/);
    for (const col of ["original_name='x.pdf'", "sha256_plain='" + 'c'.repeat(64) + "'", "entity_id='c2'", "size_bytes=1", "created_by='u-inv'", "storage_name='z.enc'"])
      await assert.rejects(db.runAsync(`UPDATE attachments SET ${col} WHERE id = ?`, [info.id]), /غير قابلة للتعديل/, col);
    await assert.rejects(db.runAsync(`UPDATE attachments SET status='deleted' WHERE id = ?`, [info.id]), /CHECK|constraint/i);
    await db.runAsync(`UPDATE attachments SET status='deleted', deleted_by='u-admin', deleted_at=1, reason='سبب كافٍ' WHERE id = ?`, [info.id]);
    await assert.rejects(db.runAsync(`UPDATE attachments SET reason='تعديل لاحق للسبب' WHERE id = ?`, [info.id]), /غير قابلة للتعديل/);
    // لا إعادة إحياء
    await assert.rejects(db.runAsync(`UPDATE attachments SET status='active', deleted_by=NULL, deleted_at=NULL, reason=NULL WHERE id = ?`, [info.id]), /غير قابلة للتعديل/);
  });
  test('قيود الأنواع في القاعدة', async () => {
    const ins = (extra: string) => db.runAsync(
      `INSERT INTO attachments (id,entity_type,entity_id,original_name,extension,mime_type,size_bytes,sha256_plain,sha256_cipher,storage_name,created_by,created_at)
       VALUES ${extra}`);
    const h = "'" + 'a'.repeat(64) + "'";
    await assert.rejects(ins(`('1','case','c1','a.exe','exe','application/pdf',5,${h},${h},'1.enc','u-admin',1)`), /CHECK|constraint/i);
    await assert.rejects(ins(`('2','user','c1','a.pdf','pdf','application/pdf',5,${h},${h},'2.enc','u-admin',1)`), /CHECK|constraint|غير موجود/i);
    await assert.rejects(ins(`('2b','case','c1','a.pdf','pdf','text/html',5,${h},${h},'2b.enc','u-admin',1)`), /CHECK|constraint/i);
    await assert.rejects(ins(`('2c','case','c1','a.pdf','pdf','application/pdf',5,'short',${h},'2c.enc','u-admin',1)`), /CHECK|constraint/i);
    await assert.rejects(ins(`('3','case','c1','a.pdf','pdf','application/pdf',99999999,${h},${h},'3.enc','u-admin',1)`), /CHECK|constraint/i);
    await assert.rejects(ins(`('4','case','c1','a.pdf','pdf','application/pdf',5,${h},${h},'4.enc','ghost',1)`), /FOREIGN|constraint/i);
  });
});

describe('سجل التدقيق', () => {
  const queue = () => db.getAllAsync<any>(`SELECT * FROM audit_event_queue WHERE entity_type = 'attachments' ORDER BY queue_seq`);
  test('الإضافة تُلتقط تلقائياً بمنفِّذها وبصمتها دون أي مفتاح أو محتوى', async () => {
    await db.runAsync(`INSERT INTO audit_context (id, actor_user_id, actor_username, updated_at) VALUES (1,'u-inv','inv',1)`);
    const info = await addAttachment(deps, sessions.inv, 'case', 'c1', { name: 'سري.pdf', bytes: PDF('TOPSECRET') });
    const q = await queue();
    assert.equal(q.length, 1);
    assert.equal(q[0].operation_type, 'create'); assert.equal(q[0].actor_user_id, 'u-inv'); assert.equal(q[0].entity_id, info.id);
    const nv = JSON.parse(q[0].new_values);
    assert.equal(nv.original_name, 'سري.pdf'); assert.equal(nv.sha256_plain, info.sha256_plain);
    assert.ok(!q[0].new_values.includes('TOPSECRET'));
    assert.ok(!('storage_name' in nv) && !JSON.stringify(nv).includes(Buffer.from(keyStore.key!).toString('hex')));
  });
  test('الحذف يُلتقط مع السبب (correction_reason) والحالة السابقة والجديدة', async () => {
    const info = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF() });
    await deleteAttachment(deps, sessions.admin, info.id, 'تحميل خاطئ للملف');
    const q = await queue(); const u = q[q.length - 1];
    assert.equal(u.operation_type, 'update'); assert.equal(u.correction_reason, 'تحميل خاطئ للملف');
    assert.equal(JSON.parse(u.previous_values).status, 'active'); assert.equal(JSON.parse(u.new_values).status, 'deleted');
  });
  test('مشغلات التدقيق الثلاثة موجودة لجدول attachments (تغطية كاملة)', async () => {
    const t = await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'audit\\_attachments\\_%' ESCAPE '\\'`);
    assert.deepEqual(t.map((x) => x.name).sort(), ['audit_attachments_delete', 'audit_attachments_insert', 'audit_attachments_update']);
  });
  test('خطاف التدقيق: فتح مرفق وفشل السلامة يُسجَّلان', async () => {
    const events: string[] = [];
    const d2 = { ...deps, audit: async (_s: Session, e: { operationType: string }) => { events.push(e.operationType); } };
    const info = await addAttachment(d2, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF() });
    await readAttachment(d2, sessions.admin, info.id);
    storage.files.get(info.id + '.enc')![40] ^= 1;
    await assert.rejects(readAttachment(d2, sessions.admin, info.id), code('INTEGRITY_FAILED'));
    assert.deepEqual(events, ['attachment_view', 'attachment_integrity_failure']);
  });
  test('فشل التدقيق الإضافي لا يمنع القراءة المصرح بها', async () => {
    const d2 = { ...deps, audit: async () => { throw new Error('audit down'); } };
    const info = await addAttachment(d2, sessions.admin, 'case', 'c1', { name: 'a.pdf', bytes: PDF() });
    assert.deepEqual((await readAttachment(d2, sessions.admin, info.id)).bytes, PDF());
  });
});

describe('الحجم الأقصى', () => {
  test('ملف 15 ميغابايت يُشفَّر ويُفك ويُتحقق منه كاملاً', async () => {
    const bytes = new Uint8Array(MAX_ATTACHMENT_BYTES); bytes.set(PDF()); bytes.set(randomBytes(1000), 5000);
    const t0 = Date.now();
    const info = await addAttachment(deps, sessions.admin, 'case', 'c1', { name: 'big.pdf', bytes });
    const r = await readAttachment(deps, sessions.admin, info.id);
    assert.deepEqual(r.bytes, bytes);
    console.log(`    (15MB تشفير+فك في Node: ${Date.now() - t0}ms — ليس مقياساً لأداء Hermes)`);
  });
});
