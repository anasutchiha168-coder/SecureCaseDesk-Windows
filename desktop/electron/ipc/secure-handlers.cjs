'use strict';
// القسم 7: قنوات scd:secure:* و scd:auth:* . تُسجَّل عند حقن ctx.secure / ctx.auth من main.cjs.
const { ScdError } = require('../lib/errors.cjs');
const { object, none } = require('../lib/validate.cjs');
const { NAME_RE, MAX_VALUE } = require('../lib/secure-service.cjs');

const bad = (m) => new ScdError('INVALID_PAYLOAD', m);
const nameOf = (o) => { if (typeof o.name !== 'string' || !NAME_RE.test(o.name)) throw bad('اسم المفتاح غير صالح'); return o.name; };
const exact = (o, keys) => { for (const k of Object.keys(o)) if (!keys.includes(k)) throw bad('حقل غير متوقع: ' + k); };

function registerSecure(add, ctx) {
  if (ctx.secure) {
    const { secure } = ctx;
    add('scd:secure:get', (p) => { const o = object(p); exact(o, ['name']); return { name: nameOf(o) }; }, (p) => secure.get(p.name));
    add('scd:secure:set', (p) => {
      const o = object(p); exact(o, ['name', 'value']);
      if (typeof o.value !== 'string' || Buffer.byteLength(o.value, 'utf8') > MAX_VALUE) throw bad('القيمة غير صالحة');
      return { name: nameOf(o), value: o.value };
    }, (p) => { secure.set(p.name, p.value); return null; });
    add('scd:secure:remove', (p) => { const o = object(p); exact(o, ['name']); return { name: nameOf(o) }; }, (p) => { secure.remove(p.name); return null; });
  }
  if (ctx.auth) {
    const { auth } = ctx;
    add('scd:auth:available', none, () => auth.available());
    add('scd:auth:prompt', (p) => {
      if (p === undefined || p === null) return {};
      const o = object(p); exact(o, ['message']);
      if (o.message !== undefined && (typeof o.message !== 'string' || o.message.length > 200)) throw bad('message غير صالح');
      return { message: o.message };
    }, (p) => auth.prompt(p));
  }
}
module.exports = { registerSecure };
