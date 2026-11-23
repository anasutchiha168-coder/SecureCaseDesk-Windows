import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeButtons, initialFocusIndex, escapeAction, backdropAction, createAlertQueue, DEFAULT_OK_TEXT,
} from '../../shims/alert-core.ts';

test('بلا أزرار: زر "حسناً" واحد (مثل RN)', () => {
  for (const v of [undefined, null, []]) {
    const b = normalizeButtons(v);
    assert.equal(b.length, 1);
    assert.equal(b[0].text, DEFAULT_OK_TEXT);
    assert.equal(b[0].style, 'default');
  }
});

test('تطبيع الأزرار: نمط غير معروف ⇒ default، نص فارغ ⇒ افتراضي، onPress يُحفظ', () => {
  const fn = () => {};
  const b = normalizeButtons([{ text: 'حذف', style: 'destructive', onPress: fn }, { style: 'cancel' }, { text: '', style: 'weird' }]);
  assert.deepEqual(b.map((x) => x.style), ['destructive', 'cancel', 'default']);
  assert.equal(b[0].onPress, fn);
  assert.equal(b[1].text, 'إلغاء');
  assert.equal(b[2].text, DEFAULT_OK_TEXT);
});

test('التركيز الأولي لا يقع على زر destructive أبداً إن وُجد بديل', () => {
  const mk = (arr) => normalizeButtons(arr);
  assert.equal(initialFocusIndex(mk([{ text: 'إلغاء', style: 'cancel' }, { text: 'حذف', style: 'destructive' }])), 0);
  assert.equal(initialFocusIndex(mk([{ text: 'إلغاء', style: 'cancel' }, { text: 'موافق' }])), 1);
  assert.equal(initialFocusIndex(mk([{ text: 'حذف', style: 'destructive', isPreferred: true }, { text: 'إلغاء', style: 'cancel' }])), 1);
  assert.equal(initialFocusIndex(mk([{ text: 'أ' }, { text: 'ب' }])), 1);
});

test('Escape: cancel ← dismiss(cancelable) ← الزر الوحيد ← لا شيء', () => {
  const req = (buttons, cancelable = false) => ({ buttons: normalizeButtons(buttons), cancelable });
  assert.deepEqual(escapeAction(req([{ text: 'x', style: 'cancel' }, { text: 'y' }])), { kind: 'press', index: 0 });
  assert.deepEqual(escapeAction(req([{ text: 'x' }, { text: 'y' }], true)), { kind: 'dismiss' });
  assert.deepEqual(escapeAction(req([{ text: 'x' }])), { kind: 'press', index: 0 });
  assert.deepEqual(escapeAction(req([{ text: 'حذف', style: 'destructive' }, { text: 'نعم' }])), { kind: 'none' });
});

test('النقر على الخلفية: فقط عند cancelable', () => {
  assert.deepEqual(backdropAction({ cancelable: true }), { kind: 'dismiss' });
  assert.deepEqual(backdropAction({ cancelable: false }), { kind: 'none' });
});

test('الطابور: FIFO، التالي يظهر قبل تنفيذ رد النداء، والتنبيه المتولّد يصطف خلفه', () => {
  const log = [];
  const q = createAlertQueue();
  q.subscribe(() => log.push('render:' + (q.current()?.title ?? 'none')));
  q.enqueue('أ', 'm', [{ text: 'ok', onPress: () => { log.push('press-a'); q.enqueue('ج'); } }]);
  q.enqueue('ب');
  assert.equal(q.current().title, 'أ');
  assert.equal(q.size(), 2);
  q.press(0);
  assert.deepEqual(log.slice(-3), ['render:ب', 'press-a', 'render:ب']); // ج دخل خلف ب
  assert.equal(q.current().title, 'ب');
  assert.equal(q.size(), 2);
  q.press(0);
  assert.equal(q.current().title, 'ج');
  q.press(0);
  assert.equal(q.current(), null);
});

test('onPress يُستدعى مرة واحدة فقط، وفهرس غير صالح يُتجاهل', () => {
  let n = 0;
  const q = createAlertQueue();
  q.enqueue('t', 'm', [{ text: 'a', onPress: () => n++ }, { text: 'b' }]);
  q.press(5); q.press(-1); q.press(1.5);
  assert.equal(n, 0);
  assert.equal(q.size(), 1);
  q.press(0); q.press(0);
  assert.equal(n, 1);
});

test('dismiss يستدعي onDismiss لا onPress', () => {
  const calls = [];
  const q = createAlertQueue();
  q.enqueue('t', 'm', [{ text: 'a', onPress: () => calls.push('press') }], { cancelable: true, onDismiss: () => calls.push('dismiss') });
  q.close({ kind: 'dismiss' });
  assert.deepEqual(calls, ['dismiss']);
});

test('خطأ داخل onPress لا يكسر الطابور ويُبلَّغ عنه', () => {
  const errors = [];
  const q = createAlertQueue({ reportError: (e) => errors.push(e.message) });
  q.enqueue('أ', '', [{ text: 'ok', onPress: () => { throw new Error('boom'); } }]);
  q.enqueue('ب');
  q.press(0);
  assert.deepEqual(errors, ['boom']);
  assert.equal(q.current().title, 'ب');
});

test('عنوان/رسالة غير نصية تُحوَّل لنص؛ null ⇒ فارغ', () => {
  const q = createAlertQueue();
  q.enqueue(404, null);
  assert.equal(q.current().title, '404');
  assert.equal(q.current().message, '');
});
