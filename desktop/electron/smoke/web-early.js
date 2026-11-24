// يُحقن أول <head> في فحص حزمة الويب: يلتقط كل خطأ قبل تشغيل التطبيق.
(function () {
  var errs = (window.__scdErrors = []);
  var push = function (s) { try { errs.push(String(s).slice(0, 400)); } catch (e) {} };
  window.addEventListener('error', function (e) { push('error: ' + (e.message || e.error)); });
  window.addEventListener('unhandledrejection', function (e) { push('unhandledrejection: ' + ((e.reason && (e.reason.name + ': ' + e.reason.message)) || e.reason)); });
  var ce = console.error;
  var describe = function (v) {
    if (v instanceof Error) {
      return v.name + ': ' + v.message +
        '\\nSTACK:\\n' + (v.stack || 'NO_STACK');
    }
    if (v && typeof v === 'object') {
      try { return JSON.stringify(v); } catch (_) {}
    }
    return String(v);
  };
  console.error = function () {
    var args = Array.prototype.slice.call(arguments);
    push('console.error: ' + args.map(describe).join(' '));
    return ce.apply(console, args);
  };
})();
