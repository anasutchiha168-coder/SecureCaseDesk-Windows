// يشغّل exe مُحزَّماً بوضع SCD_SMOKE=1 (فحوص الأمان/IPC داخل التطبيق نفسه) ويقرأ SCD_SMOKE_RESULT من stdout.
import { spawn } from 'node:child_process';

export function runSmokeExe(exe, { timeoutMs = 90000, env = {} } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const child = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SCD_SMOKE: '1', SCD_DISABLE_GPU: '1', ...env } });
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { child.kill(); } catch { /* */ } resolve(r); };
    const t = setTimeout(() => finish({ ok: false, error: 'انتهت المهلة (' + timeoutMs / 1000 + 's)', checks: [], out: out.slice(-1500), err: err.slice(-1500) }), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: 'تعذّر التشغيل: ' + e.message, checks: [] }));
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('SCD_SMOKE_RESULT '));
      if (!line) return finish({ ok: false, error: 'لا نتيجة فحص (رمز ' + code + ')', checks: [], out: out.slice(-1500), err: err.slice(-1500) });
      try { const r = JSON.parse(line.slice('SCD_SMOKE_RESULT '.length)); finish({ ...r, ok: !!r.ok && code === 0, exit: code }); }
      catch (e) { finish({ ok: false, error: 'نتيجة غير صالحة: ' + e.message, checks: [] }); }
    });
  });
}

export const fmtChecks = (r) => (r.checks || []).map((c) => `${c.pass ? '✔' : '✘'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`).join('\n');
