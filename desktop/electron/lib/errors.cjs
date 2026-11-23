'use strict';
class ScdError extends Error {
  constructor(code, message) { super(message); this.name = 'ScdError'; this.code = code; }
}
const toEnvelopeError = (e) => (e instanceof ScdError
  ? { code: e.code, message: e.message }
  : { code: 'INTERNAL', message: 'خطأ داخلي في العملية الرئيسية' }); // لا نسرّب رسائل/مسارات داخلية للواجهة
module.exports = { ScdError, toEnvelopeError };
