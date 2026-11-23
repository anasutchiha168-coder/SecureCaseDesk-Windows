// فحص حزمة الويب الحقيقية داخل Electron تحت CSP الإنتاج. النتيجة في window.__smokeResult.
// أخطاء DesktopNotImplementedError متوقعة حتى تُنفَّذ الأقسام 5–7؛ أي خطأ آخر يُفشل الفحص.
(async function () {
  var checks = [];
  var check = function (name, pass, detail, informational) { checks.push({ name: name, pass: pass === true, detail: pass === true ? undefined : detail, informational: !!informational }); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var deadline = Date.now() + 12000;
  var root = document.getElementById('root');
  while (Date.now() < deadline && !(root && root.childNodes.length > 0)) await sleep(200);
  await sleep(1500); // نترك التطبيق يبدأ (الخطوط، AuthContext...)

  check('shim react-native هو المُحمَّل', window.__SCD_RN_WEB__ && window.__SCD_RN_WEB__.shim === 1 && window.__SCD_RN_WEB__.rtl === true, 'لا __SCD_RN_WEB__');
  check('اتجاه المستند RTL وlang=ar', document.documentElement.dir === 'rtl' && document.documentElement.lang === 'ar', document.documentElement.dir + '/' + document.documentElement.lang);
  check('الواجهة رُسمت داخل #root', !!(root && root.childNodes.length > 0), '#root فارغ');
  // تشخيص RTL: سلسلة العقد من #root مع dir/lang، وعدّادات الجذرَين (AppRegistry وSafeAreaProvider). تُطبع كل قيمة في سطر مستقل.
  var chain = [];
  for (var n = root, i = 0; n && n.firstElementChild && i < 6; i++) { n = n.firstElementChild; chain.push(n.tagName.toLowerCase() + '[dir=' + (n.getAttribute('dir') || '-') + ']'); }
  var diagInfo = window.__SCD_RN_DIAG ? JSON.stringify(window.__SCD_RN_DIAG) : (window.__SCD_RN_WEB__ && window.__SCD_RN_WEB__.diag ? JSON.stringify(window.__SCD_RN_WEB__.diag) : 'لا diag');
  var rtlUntil = Date.now() + 5000; // مهلة قصيرة: قد يتأخر رسم الجذر لحظات بعد أول عقدة
  while (!document.querySelector('#root [dir="rtl"]') && Date.now() < rtlUntil) await sleep(250);
  var rtlNode = document.querySelector('#root [dir="rtl"]');
  check('عقدة RN-web الجذرية dir=rtl', !!rtlNode, 'path=' + location.pathname + ' | diag=' + diagInfo + ' | chain=' + chain.join(' > ') + ' | rootChildren=' + (root ? root.childNodes.length : 0));
  check('crypto.subtle وrandomUUID متاحان (سياق آمن)', !!(window.crypto && crypto.subtle && typeof crypto.randomUUID === 'function' && crypto.randomUUID().length === 36), 'السياق غير آمن');

  var fontsLoaded = [];
  try { await document.fonts.ready; document.fonts.forEach(function (f) { if (f.status === 'loaded') fontsLoaded.push(f.family); }); } catch (e) {}
  var cairo = fontsLoaded.filter(function (f) { return /Cairo/.test(f); });
  check('خطوط Cairo حُمّلت', cairo.length >= 1, 'المحمّل: ' + (fontsLoaded.join(',') || 'لا شيء'));
  var text = (root && root.innerText) || '';
  check('يوجد نص عربي مرسوم', /[؀-ۿ]/.test(text), 'النص: ' + text.slice(0, 80), true);

  var expected = /DesktopNotImplementedError|غير منفَّذ بعد/;
  var all = window.__scdErrors || [];
  var unexpected = all.filter(function (e) { return !expected.test(e); });
  check('لا أخطاء غير متوقعة في الواجهة', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));

  var ok = checks.every(function (c) { return c.pass || c.informational; });
  window.__smokeResult = { ok: ok, checks: checks, errors: all };
})();
