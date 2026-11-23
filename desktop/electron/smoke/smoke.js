// يعمل داخل الواجهة تحت نفس CSP الإنتاج (لا inline scripts). النتيجة في window.__smokeResult.
(async () => {
  const checks = [];
  const check = async (name, fn) => {
    try { const r = await fn(); checks.push({ name, pass: r === true, detail: r === true ? undefined : String(r) }); }
    catch (e) { checks.push({ name, pass: false, detail: String(e && e.message) }); }
  };
  const rejects = async (p, prefix) => {
    try { await p; return 'لم يُرفض'; } catch (e) { return String(e.message).startsWith(prefix) ? true : 'رسالة غير متوقعة: ' + e.message; }
  };

  await check('لا require/process/module في الواجهة', () => typeof require === 'undefined' && typeof process === 'undefined' && typeof module === 'undefined');
  await check('المصدر app://bundle', () => location.origin === 'app://bundle' || location.origin);
  await check('window.scd يكشف الواجهة المتوقعة فقط', () => {
    const k = Object.keys(window.scd || {}).sort().join(',');
    return k === 'invoke,isDesktop,on,platform' || k;
  });
  await check('scd:app:info', async () => { const i = await scd.invoke('scd:app:info'); return (i.name === 'SecureCaseDesk' && typeof i.version === 'string') || JSON.stringify(i); });
  await check('window:state', async () => { const s = await scd.invoke('scd:window:state'); return typeof s.maximized === 'boolean' || JSON.stringify(s); });
  await check('قناة خارج القائمة البيضاء تُرفض', () => rejects(scd.invoke('scd:evil'), '[CHANNEL_NOT_ALLOWED]'));
  await check('قناة غير منفذة تُرجع NOT_IMPLEMENTED', () => rejects(scd.invoke('scd:fs:read', { path: 'x' }), '[NOT_IMPLEMENTED]'));
  await check('حمولة غير صالحة تُرفض', () => rejects(scd.invoke('scd:app:info', { x: 1 }), '[INVALID_PAYLOAD]'));
  await check('حدث غير مسموح يُرفض', () => { try { scd.on('evil', () => {}); return 'لم يُرفض'; } catch (e) { return e.message.startsWith('[EVENT_NOT_ALLOWED]') || e.message; } });
  await check('CSP تمنع eval', () => { try { new Function('return 1')(); return 'نُفّذ eval'; } catch { return true; } });
  await check('CSP تمنع الاتصال الخارجي', async () => { try { await fetch('https://example.com/'); return 'نجح الاتصال'; } catch { return true; } });
  await check('window.open مرفوض', () => window.open('https://example.com') === null || 'فُتحت نافذة');
  await check('SPA fallback يعمل', async () => { const r = await fetch('/cases/12'); return r.status === 200 || r.status; });
  await check('traversal (باكسلاش) مرفوض', async () => { const r = await fetch('/..%5C..%5Cmain.cjs'); return r.status === 400 || r.status; });
  await check('traversal (نقاط) لا يخرج من الجذر', async () => { const r = await fetch('/../main.cjs'); return r.status === 404 || r.status; });
  await check('رؤوس الأمان موجودة', async () => { const r = await fetch('/index.html'); return (r.headers.get('content-security-policy') || '').includes("default-src 'none'") || 'لا CSP'; });
  await check('صلاحية الموقع غير ممنوحة', async () => { const s = await navigator.permissions.query({ name: 'geolocation' }); return s.state !== 'granted' || 'ممنوحة'; });

  const ok = checks.every((c) => c.pass);
  document.getElementById('out').textContent = checks.map((c) => `${c.pass ? '✔' : '✘'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`).join('\n');
  window.__smokeResult = { ok, checks };
})();
