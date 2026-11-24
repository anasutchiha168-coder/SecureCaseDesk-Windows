'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MAX = 1024 * 1024;

// سجل بسيط في userData/logs. لا نسجّل حمولات IPC ولا بيانات قضايا أبداً: رسائل تشغيلية فقط.
function createLogger(dir, fsImpl = fs) {
  const file = path.join(dir, 'main.log');
  const write = (level, msg) => {
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      try { fsImpl.statSync(file); } catch { fsImpl.appendFileSync(file, '\uFEFF', 'utf8'); }
      try { if (fsImpl.statSync(file).size > MAX) fsImpl.renameSync(file, file + '.1'); } catch { /* لا ملف بعد */ }
      fsImpl.appendFileSync(file, line, 'utf8');
    } catch { /* لا نُفشل التطبيق بسبب السجل */ }
    if (level !== 'info') process.stderr.write(line);
  };
  return { file, info: (m) => write('info', m), warn: (m) => write('warn', m), error: (m) => write('error', m) };
}
module.exports = { createLogger };
