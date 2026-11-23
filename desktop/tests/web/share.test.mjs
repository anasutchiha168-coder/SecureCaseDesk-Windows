import test from 'node:test';
import assert from 'node:assert/strict';
import { createShare, buildShareText, COPIED_TITLE } from '../../shims/web-share.ts';
import { I18nManagerWeb } from '../../shims/web-i18n.ts';

test('buildShareText: message + url', () => {
  assert.equal(buildShareText({ message: 'أ', url: 'https://x' }), 'أ\nhttps://x');
  assert.equal(buildShareText({ message: 'أ' }), 'أ');
  assert.equal(buildShareText({}), '');
});

test('بلا message ولا url: خطأ مثل React Native', async () => {
  await assert.rejects(createShare({}).share({}), /message.*url/);
});

test('navigator.share ينجح ⇒ sharedAction ولا ننسخ', async () => {
  let copied = false;
  const s = createShare({ navigatorShare: async () => {}, writeClipboard: async () => { copied = true; return true; } });
  assert.equal((await s.share({ message: 'x' })).action, 'sharedAction');
  assert.equal(copied, false);
});

test('إلغاء المستخدم (AbortError) ⇒ dismissedAction دون نسخ', async () => {
  let copied = false;
  const s = createShare({
    navigatorShare: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; },
    writeClipboard: async () => { copied = true; return true; },
  });
  assert.equal((await s.share({ message: 'x' })).action, 'dismissedAction');
  assert.equal(copied, false);
});

test('navigator.share غير مدعوم ⇒ نسخ للحافظة مع إشعار', async () => {
  let text = null; let notice = null;
  const s = createShare({ writeClipboard: async (t) => { text = t; return true; }, notify: (t) => { notice = t; } });
  assert.equal((await s.share({ message: 'تقرير' })).action, 'sharedAction');
  assert.equal(text, 'تقرير');
  assert.equal(notice, COPIED_TITLE);
});

test('فشل navigator.share بخطأ آخر ⇒ ننتقل للحافظة', async () => {
  let text = null;
  const s = createShare({ navigatorShare: async () => { throw new Error('NotAllowed'); }, writeClipboard: async (t) => { text = t; return true; } });
  await s.share({ message: 'م' });
  assert.equal(text, 'م');
});

test('لا وسيلة نسخ ⇒ خطأ صريح لا نجاح كاذب', async () => {
  await assert.rejects(createShare({ writeClipboard: async () => false }).share({ message: 'x' }), /تعذّرت المشاركة/);
  await assert.rejects(createShare({}).share({ message: 'x' }), /تعذّرت المشاركة/);
});

test('I18nManager: RTL ثابت ولا يُغيَّر بـ forceRTL', () => {
  I18nManagerWeb.forceRTL(false); I18nManagerWeb.allowRTL(false);
  assert.equal(I18nManagerWeb.isRTL, true);
  assert.equal(I18nManagerWeb.getConstants().isRTL, true);
});
