'use strict';
// القسم 6: قنوات scd:db:* . تُسجَّل فقط عند حقن ctx.db من main.cjs.
const { ScdError } = require('../lib/errors.cjs');
const { object, isPlainObject } = require('../lib/validate.cjs');

const bad = (m) => new ScdError('INVALID_PAYLOAD', m);
const handleOf = (o) => { if (!Number.isSafeInteger(o.handle) || o.handle < 1) throw bad('handle غير صالح'); return o.handle; };
const sqlOf = (o) => { if (typeof o.sql !== 'string' || !o.sql.trim() || o.sql.length > 2 * 1024 * 1024) throw bad('sql غير صالح'); return o.sql; };
const paramsOf = (o) => {
  const p = o.params;
  if (p === undefined || p === null) return [];
  if (Array.isArray(p) || isPlainObject(p)) return p;
  throw bad('params غير صالح');
};

function registerDb(add, ctx) {
  const { db } = ctx;
  add('scd:db:open', (p) => {
    const o = object(p);
    if (typeof o.name !== 'string' || !o.name || o.name.length > 128) throw bad('name غير صالح');
    if (o.directory !== undefined && o.directory !== null && (typeof o.directory !== 'string' || !o.directory || o.directory.length > 4096)) throw bad('directory غير صالح');
    return { name: o.name, directory: o.directory || undefined };
  }, (p) => db.open(p));
  add('scd:db:exec', (p) => { const o = object(p); return { handle: handleOf(o), sql: sqlOf(o) }; }, (p) => db.exec(p));
  const q = (p) => { const o = object(p); return { handle: handleOf(o), sql: sqlOf(o), params: paramsOf(o) }; };
  add('scd:db:run', q, (p) => db.run(p));
  add('scd:db:all', q, (p) => db.all(p));
  add('scd:db:first', q, (p) => db.first(p));
  add('scd:db:tx', (p) => {
    const o = object(p);
    if (o.action !== 'begin' && o.action !== 'commit' && o.action !== 'rollback') throw bad('action غير صالح');
    return { handle: handleOf(o), action: o.action };
  }, (p) => db.tx(p));
  add('scd:db:close', (p) => ({ handle: handleOf(object(p)) }), (p) => db.close(p));
}

module.exports = { registerDb };
