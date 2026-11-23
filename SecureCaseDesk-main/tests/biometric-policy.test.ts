// SECURECASEDESK_BIOMETRIC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unavailableReason, decideBiometricLogin } from '../src/security/biometric-policy';

test('البصمة: رسائل عدم التوفر', () => {
  assert.equal(unavailableReason({ hasHardware: true, enrolled: true }), null);
  assert.match(unavailableReason({ hasHardware: false, enrolled: false })!, /لا يدعم/);
  assert.match(unavailableReason({ hasHardware: true, enrolled: false })!, /لا توجد بصمة/);
});

test('البصمة: الدخول يُرفض لحساب غير موجود أو معطّل', () => {
  assert.equal(decideBiometricLogin(null).ok, false);
  assert.equal(decideBiometricLogin({ id: '1', username: 'a', is_active: 0 }).ok, false);
});

test('البصمة: الدخول يُسمح لحساب نشط (is_active=1 أو غير محدد)', () => {
  assert.equal(decideBiometricLogin({ id: '1', username: 'a', is_active: 1 }).ok, true);
  assert.equal(decideBiometricLogin({ id: '1', username: 'a' }).ok, true);
});

import { shouldLockAfterBackground, BIOMETRIC_LOCK_TIMEOUT_MS } from '../src/security/biometric-policy';

test('القفل التلقائي: دقيقة واحدة في الخلفية', () => {
  assert.equal(BIOMETRIC_LOCK_TIMEOUT_MS, 60_000);
  const t = 1_000_000;
  assert.equal(shouldLockAfterBackground(null, t), false);            // لم يخرج
  assert.equal(shouldLockAfterBackground(t - 59_999, t), false);      // أقل من دقيقة
  assert.equal(shouldLockAfterBackground(t - 60_000, t), true);       // دقيقة بالضبط
  assert.equal(shouldLockAfterBackground(t - 600_000, t), true);      // أكثر
  assert.equal(shouldLockAfterBackground(t + 5_000, t), true);        // ساعة غير منطقية → قفل احتياطي
});
