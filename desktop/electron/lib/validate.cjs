'use strict';
const { ScdError } = require('./errors.cjs');
// كل قناة تُحقّق حمولتها قبل التنفيذ. الأقسام 5–7 تضيف مخططاتها هنا.
const none = (p) => {
  if (p !== undefined && p !== null) throw new ScdError('INVALID_PAYLOAD', 'هذه القناة لا تقبل حمولة');
  return undefined;
};
const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const object = (p) => {
  if (!isPlainObject(p)) throw new ScdError('INVALID_PAYLOAD', 'الحمولة يجب أن تكون كائناً بسيطاً');
  return p;
};
module.exports = { none, object, isPlainObject };
