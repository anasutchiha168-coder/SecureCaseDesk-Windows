import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forceDesktopRtlStart, RTL_PENDING_LINE } from '../../scripts/lib/stage.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('forceDesktopRtlStart: يعطّل مسار إعادة التشغيل ويفشل بوضوح إن غاب السطر', () => {
  const r = forceDesktopRtlStart('a\n' + RTL_PENDING_LINE + '\nb');
  assert.ok(r.ok); assert.match(r.source, /RTL_PENDING_AT_START = false/);
  assert.equal(forceDesktopRtlStart('x').ok, false);
});
test('src/app/_layout.tsx الحقيقي يحوي السطر المستهدف مرة واحدة (والملف نفسه لا يُعدَّل)', () => {
  const s = readFileSync(path.join(root, 'src', 'app', '_layout.tsx'), 'utf8');
  assert.equal(s.split(RTL_PENDING_LINE).length - 1, 1);
});
