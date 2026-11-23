// يُحقن أول <head> في فحص حزمة الويب: يلتقط كل خطأ قبل تشغيل التطبيق.
(function () {
  var errs = (window.__scdErrors = []);
  var push = function (s) { try { errs.push(String(s).slice(0, 400)); } catch (e) {} };
  window.addEventListener('error', function (e) { push('error: ' + (e.message || e.error)); });
  window.addEventListener('unhandledrejection', function (e) { push('unhandledrejection: ' + ((e.reason && (e.reason.name + ': ' + e.reason.message)) || e.reason)); });
  var ce = console.error;
  console.error = function () { push('console.error: ' + Array.prototype.slice.call(arguments).join(' ')); return ce.apply(console, arguments); };
})();
