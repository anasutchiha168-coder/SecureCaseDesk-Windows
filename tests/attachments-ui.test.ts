// اختبارات المرحلة 9 / القسم 2 — منطق ربط المرفقات بالواجهات. تشغَّل بـ: npm run test:attachments-ui
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentUiPermissions, formatFileSize, toArabicDigits, precheckPickedFile, validateDeleteReason,
  friendlyAttachmentError, fileTypeLabel, isImageMime, integrityMessage,
} from '../src/modules/attachments/attachments-ui-logic';
import { AttachmentError, MAX_ATTACHMENT_BYTES } from '../src/modules/attachments/attachments-types';
import { ForbiddenError } from '../src/security/guard';

describe('صلاحيات واجهة المرفقات', () => {
  test('المدير: عرض وإضافة وحذف لكل الكيانات', () => {
    for (const t of ['case', 'memo', 'detainee'] as const) {
      assert.deepEqual(attachmentUiPermissions('admin', t), { canView: true, canAdd: true, canDelete: true, canVerify: true });
    }
  });
  test('المحقق: يضيف للقضايا والمذكرات فقط، ولا يضيف للمحتجزين ولا يحذف', () => {
    assert.equal(attachmentUiPermissions('investigator', 'case').canAdd, true);
    assert.equal(attachmentUiPermissions('investigator', 'memo').canAdd, true);
    assert.equal(attachmentUiPermissions('investigator', 'detainee').canAdd, false);
    assert.equal(attachmentUiPermissions('investigator', 'case').canDelete, false);
  });
  test('مستخدم الاطلاع: عرض فقط', () => {
    for (const t of ['case', 'memo', 'detainee'] as const) {
      const p = attachmentUiPermissions('viewer', t);
      assert.equal(p.canView, true); assert.equal(p.canAdd, false); assert.equal(p.canDelete, false);
    }
  });
  test('مشاهد المحتجزين: يرى مرفقات المحتجزين فقط ولا يرى القضايا ولا المذكرات ولا يعدّل', () => {
    const d = attachmentUiPermissions('detention_viewer', 'detainee');
    assert.equal(d.canView, true); assert.equal(d.canAdd, false); assert.equal(d.canDelete, false);
    assert.equal(attachmentUiPermissions('detention_viewer', 'case').canView, false);
    assert.equal(attachmentUiPermissions('detention_viewer', 'memo').canView, false);
  });
  test('دور غير معروف أو فارغ = رفض كامل', () => {
    for (const r of [null, undefined, '', 'hacker']) {
      assert.deepEqual(attachmentUiPermissions(r as any, 'case'), { canView: false, canAdd: false, canDelete: false, canVerify: false });
    }
  });
});

describe('التنسيق والفحص المبدئي', () => {
  test('أرقام عربية وأحجام', () => {
    assert.equal(toArabicDigits('2026'), '٢٠٢٦');
    assert.equal(formatFileSize(500), '٥٠٠ بايت');
    assert.equal(formatFileSize(2048), '٢.٠ كيلوبايت');
    assert.equal(formatFileSize(5 * 1024 * 1024), '٥.٠ ميغابايت');
  });
  test('أنواع الملفات', () => {
    assert.equal(fileTypeLabel('application/pdf'), 'PDF');
    assert.equal(isImageMime('image/png'), true);
    assert.equal(isImageMime('application/pdf'), false);
  });
  test('الفحص المبدئي يرفض النوع والحجم والاسم', () => {
    assert.equal(precheckPickedFile({ name: 'a.pdf', size: 10 }), null);
    assert.equal(precheckPickedFile({ name: 'A.JPEG', size: 10 }), null);
    assert.ok(precheckPickedFile({ name: 'a.exe', size: 10 })?.includes('غير مدعوم'));
    assert.ok(precheckPickedFile({ name: 'a.pdf', size: MAX_ATTACHMENT_BYTES + 1 })?.includes('الحد المسموح'));
    assert.ok(precheckPickedFile({ name: 'a.pdf', size: 0 })?.includes('فارغ'));
    assert.ok(precheckPickedFile({ name: '', size: 10 })?.includes('غير صالح'));
    assert.ok(precheckPickedFile({ name: 'noext', size: 10 })?.includes('غير مدعوم'));
  });
  test('سبب الحذف 5 أحرف على الأقل', () => {
    assert.notEqual(validateDeleteReason('   abc  '), null);
    assert.equal(validateDeleteReason('مرفق خاطئ'), null);
  });
  test('رسائل الأخطاء عربية ولا تسرّب تفاصيل داخلية', () => {
    assert.equal(friendlyAttachmentError(new AttachmentError('DUPLICATE')), 'هذا الملف مرفق مسبقاً بنفس السجل.');
    assert.ok(friendlyAttachmentError(new ForbiddenError('cases.manage')).includes('صلاحية'));
    const generic = friendlyAttachmentError(new Error('SQLITE_CONSTRAINT secret/path'));
    assert.ok(!generic.includes('SQLITE') && !generic.includes('secret'));
  });
  test('رسالة نتيجة فحص السلامة', () => {
    assert.ok(integrityMessage(null).includes('سليم'));
    assert.ok(integrityMessage('INTEGRITY_FAILED').includes('سلامة'));
  });
});
