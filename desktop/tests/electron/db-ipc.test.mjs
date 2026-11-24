// تحقق حمولات قنوات scd:db:* (القسم 6): كل ما يصل من الواجهة غير موثوق.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildHandlers } = require('../../electron/ipc/handlers.cjs');

const calls = [];
const db = new Proxy({}, { get: (_t, op) => (p) => { calls.push([op, p]); return { ok: op }; } });
const h = buildHandlers({ app: {}, getWindow: () => null, versions: {}, platform: 'win32', arch: 'x64', db });
const val = (ch, p) => h.get(ch).validate(p);
const rejects = (ch, p) => assert.throws(() => val(ch, p), { code: 'INVALID_PAYLOAD' }, `${ch} ${JSON.stringify(p)}`);

test('open: اسم مطلوب وحدود', () => {
  assert.deepEqual(val('scd:db:open', { name: 'a.db' }), { name: 'a.db', directory: undefined });
  rejects('scd:db:open', {}); rejects('scd:db:open', { name: '' }); rejects('scd:db:open', { name: 'x'.repeat(129) });
  rejects('scd:db:open', { name: 'a', directory: 5 }); rejects('scd:db:open', 'a.db'); rejects('scd:db:open', [1]);
});
test('exec/run/all/first: handle وsql وparams', () => {
  for (const ch of ['scd:db:run', 'scd:db:all', 'scd:db:first']) {
    assert.deepEqual(val(ch, { handle: 1, sql: 'SELECT 1' }), { handle: 1, sql: 'SELECT 1', params: [] });
    assert.deepEqual(val(ch, { handle: 2, sql: 'x', params: { $a: 1 } }).params, { $a: 1 });
    rejects(ch, { handle: 0, sql: 'x' }); rejects(ch, { handle: 1.5, sql: 'x' }); rejects(ch, { handle: '1', sql: 'x' });
    rejects(ch, { handle: 1, sql: '' }); rejects(ch, { handle: 1, sql: 5 }); rejects(ch, { handle: 1, sql: 'x', params: 'a' });
    rejects(ch, { handle: 1, sql: 'x'.repeat(2 * 1024 * 1024 + 1) });
  }
  assert.deepEqual(val('scd:db:exec', { handle: 3, sql: 'PRAGMA key = \'k\';' }), { handle: 3, sql: "PRAGMA key = 'k';" });
  rejects('scd:db:exec', { sql: 'x' });
});
test('tx/close', () => {
  for (const a of ['begin', 'commit', 'rollback']) assert.equal(val('scd:db:tx', { handle: 1, action: a }).action, a);
  rejects('scd:db:tx', { handle: 1, action: 'savepoint' }); rejects('scd:db:tx', { handle: 1 });
  assert.deepEqual(val('scd:db:close', { handle: 4 }), { handle: 4 });
  rejects('scd:db:close', {});
});
test('التنفيذ يمرّر للخدمة', async () => {
  const e = h.get('scd:db:run');
  assert.deepEqual(await e.run(e.validate({ handle: 1, sql: 'x' })), { ok: 'run' });
  assert.equal(calls.at(-1)[0], 'run');
});
