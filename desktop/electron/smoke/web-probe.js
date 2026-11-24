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
  check('عقدة RN-web الجذرية dir=rtl', !!rtlNode, 'path=' + location.pathname + ' | diag=' + diagInfo + ' | chain=' + chain.join(' > ') + ' | rootChildren=' + (root ? root.childNodes.length : 0) + ' | html=' + String((root && root.innerHTML) || '').replace(/ \| /g, ' ').slice(0, 240));
  var dg = window.__SCD_RN_DIAG || {};
  check('سياق RTL داخل React (جذر AppRegistry أو SafeAreaProvider أو الافتراضي)', (dg.rendered > 0) || (dg.rtlRoot > 0) || window.__SCD_RNW_LOCALE__ === 'rtl-default',
    'rendered=' + dg.rendered + ' | rtlRoot=' + dg.rtlRoot + ' | nested=' + dg.rtlRootNested + ' | domRoot=' + dg.domRoot + ' | locale=' + window.__SCD_RNW_LOCALE__ + ' | الاتجاه مضمون على DOM فقط؛ قلب يسار/يمين يتحقق منه القسم 4', true);
  check('crypto.subtle وrandomUUID متاحان (سياق آمن)', !!(window.crypto && crypto.subtle && typeof crypto.randomUUID === 'function' && crypto.randomUUID().length === 36), 'السياق غير آمن');

  var fontsLoaded = [];
  try { await document.fonts.ready; document.fonts.forEach(function (f) { if (f.status === 'loaded') fontsLoaded.push(f.family); }); } catch (e) {}
  var cairo = fontsLoaded.filter(function (f) { return /Cairo/.test(f); });
  check('خطوط Cairo حُمّلت', cairo.length >= 1, 'المحمّل: ' + (fontsLoaded.join(',') || 'لا شيء'));
  var text = (root && root.innerText) || '';
  check('يوجد نص عربي مرسوم', /[؀-ۿ]/.test(text), 'النص: ' + text.slice(0, 80), true);


  // ── القسم 4: غلاف سطح المكتب ──
  var shellEl = null, shellUntil = Date.now() + 5000;
  while (!(shellEl = document.querySelector('[data-scd-shell]')) && Date.now() < shellUntil) await sleep(250);
  var dk = window.__SCD_DESKTOP__;
  check('غلاف سطح المكتب رُسم (القسم 4)', !!shellEl && !!dk && dk.section === 4, 'shellEl=' + !!shellEl + ' | marker=' + JSON.stringify(dk && { shell: dk.shell, section: dk.section }) + ' | diag=' + JSON.stringify(dk && dk.diag) + ' | state=' + JSON.stringify(dk && dk.state) + ' | byId=' + !!document.getElementById('scd-shell-root') + ' | path=' + location.pathname + ' | screen=' + String((root && root.innerText) || '').replace(/\s+/g, ' ').replace(/ \| /g, ' ').slice(0, 90));
  if (shellEl) {
    var mode = shellEl.getAttribute('data-scd-shell'), cw = Number(shellEl.getAttribute('data-scd-content-width'));
    check('عمود المحتوى مُقيَّد وفق الوضع', mode === 'auth' ? (cw > 0 && cw <= 520) : (cw > 0 && cw <= 1280), 'mode=' + mode + ' | contentWidth=' + cw + ' | window=' + window.innerWidth);
    var kids = shellEl.children;
    check('أنماط سطح المكتب محقونة (CSP)', !!document.getElementById('scd-desktop-css'), 'لا عنصر style#scd-desktop-css');
  }
  // قلب textAlign: نقيس عنصراً كُتب له textAlign:'right' فعلياً (شاشة الدخول: تسمية «اسم المستخدم»). معلوماتي إن لم تظهر الشاشة.
  var tf = window.__SCD_TEXTALIGN_FLIP__;
  check('قياس textAlign عند الإقلاع نجح (null=تعذّر القياس)', tf === true || tf === false, 'flip=' + tf, true);
  var lbl = Array.prototype.find.call(document.querySelectorAll('#root div[dir]'), function (n) { return n.textContent === 'اسم المستخدم'; });
  if (lbl) check('تسمية عربية بـ textAlign:right تظهر يميناً فعلاً', getComputedStyle(lbl).textAlign === 'right', 'computed=' + getComputedStyle(lbl).textAlign + ' | flip=' + tf);
  else check('تسمية «اسم المستخدم» (فحص textAlign)', false, 'شاشة الدخول لم تُرسم (قاعدة البيانات غير منفّذة بعد؟)', true);

  // بعد القسم 7 تصل الواجهة إلى فتح القاعدة. هذا الفحص لا يثبّت محرك SQLCipher (يغطيه workflow القسم 6)،
  // فغيابه فشل مغلق مقصود (DB_ENGINE_MISSING) ولا يُعدّ خطأ هنا. أي خطأ آخر يُفشل الفحص.
  var expected = /DesktopNotImplementedError|غير منفَّذ بعد|DesktopDbError: محرك SQLCipher غير متوفر في هذا البناء/;
  var all = window.__scdErrors || [];
  var unexpected = all.filter(function (e) { return !expected.test(e); });
  check('لا أخطاء غير متوقعة في الواجهة', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));

  var ok = checks.every(function (c) { return c.pass || c.informational; });
  window.__smokeResult = { ok: ok, checks: checks, errors: all };
})();
