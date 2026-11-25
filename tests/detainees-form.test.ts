// SECURECASEDESK_DETAINEES_V22_S4 - detainees registration form builder tests (pure, no database).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDetentionInput, normalizeDigits, type DetentionFormValues } from '../src/modules/detainees/detainees-form';
import { ID_TYPES, CASE_ROLES, LEGAL_STATUSES } from '../src/modules/detainees/detainees-lists';
import { PERIOD_TEXT_FIELDS } from '../src/modules/detainees/detainees-core';

const NOW = new Date(2026, 10, 25, 12, 0, 0).getTime();
const base = (): DetentionFormValues => ({
  fullName: 'سليم علي حسين جيلان', refNumber: '٦٥٧٥', offense: 'نصب واحتيال', authority: 'البحث الجنائي',
  categoryId: 'cat-1', admission: { d: '25', m: '11', y: '2026' },
  idType: null, idNumber: '', phone: '', age: '', governorate: '', district: '', subDistrict: '',
  residence: '', occupation: '', caseRole: null, reportNumber: '', legalStatus: null,
  referral: { d: '', m: '', y: '' }, notes: '',
});
const err = (v: DetentionFormValues) => {
  const r = buildDetentionInput(v, NOW);
  assert.equal(r.ok, false);
  return r.ok ? '' : r.error;
};

describe('detainees form builder', () => {
  test('minimal valid form: only the four required fields + admission date', () => {
    const r = buildDetentionInput(base(), NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.input.referenceNumber, '6575');
    assert.equal(r.input.admissionDate, new Date(2026, 10, 25).getTime());
    assert.equal(r.input.period?.prosecution_referral_date, null);
  });

  test('required fields', () => {
    assert.equal(err({ ...base(), fullName: '  ' }), 'الاسم الكامل مطلوب');
    assert.equal(err({ ...base(), refNumber: '' }), 'الرقم المرجعي مطلوب');
    assert.equal(err({ ...base(), offense: '' }), 'التهمة المنسوبة مطلوبة');
    assert.equal(err({ ...base(), categoryId: null }), 'اختر فئة المحتجز');
  });

  test('admission date: invalid and future are rejected', () => {
    assert.match(err({ ...base(), admission: { d: '31', m: '2', y: '2026' } }), /تاريخ الدخول غير صحيح/);
    assert.match(err({ ...base(), admission: { d: '26', m: '11', y: '2026' } }), /المستقبل/);
  });

  test('referral date is optional but must be valid and not before admission', () => {
    assert.match(err({ ...base(), referral: { d: '1', m: '', y: '' } }), /إحالة/);
    assert.match(err({ ...base(), referral: { d: '24', m: '11', y: '2026' } }), /لا يسبق/);
    const ok = buildDetentionInput({ ...base(), referral: { d: '٢٥', m: '١١', y: '٢٠٢٦' } }, NOW);
    assert.equal(ok.ok && ok.input.period?.prosecution_referral_date, new Date(2026, 10, 25).getTime());
  });

  test('age, phone and identity rules', () => {
    assert.equal(err({ ...base(), age: '0' }), 'العمر غير صحيح');
    assert.equal(err({ ...base(), age: '٢٤٠' }), 'العمر غير صحيح');
    assert.equal(err({ ...base(), phone: '12ab' }), 'رقم الهاتف غير صحيح');
    assert.equal(err({ ...base(), idNumber: '123' }), 'اختر نوع الهوية');
    assert.equal(err({ ...base(), idType: 'شخصية' }), 'رقم الهوية مطلوب للنوع المختار');
    const none = buildDetentionInput({ ...base(), idType: 'بدون' }, NOW);
    assert.equal(none.ok, true);
    const full = buildDetentionInput({ ...base(), idType: 'شخصية', idNumber: '٠١١٠١٠١٢٨٦٢٣', phone: '٠٧١٦ ٢٣٣ ٤٩٩', age: '٢٤' }, NOW);
    assert.equal(full.ok && full.input.person?.id_number, '01101012862' + '3');
    assert.equal(full.ok && full.input.person?.phone, '0716233499');
    assert.equal(full.ok && full.input.period?.age_at_admission, 24);
  });

  test('lists come from the Excel and core accepts period notes', () => {
    assert.equal(ID_TYPES.length, 11);
    assert.equal(CASE_ROLES.length, 6);
    assert.equal(LEGAL_STATUSES.length, 4);
    assert.ok((PERIOD_TEXT_FIELDS as readonly string[]).includes('notes'));
    assert.equal(normalizeDigits('٠١٢۳'), '0123');
  });
});
