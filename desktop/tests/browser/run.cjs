const { chromium } = require('playwright');
const path = require('path');
let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '✔ ' : '✘ ') + name + (cond ? '' : '  → ' + detail)); if (!cond) fails++; };
(async () => {
  const b = await chromium.launch();
  const url = 'file://' + path.resolve('out/index.html');
  const errors = [];
  async function open(w, h, q = '') {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
    await p.goto(url + q); await p.waitForTimeout(150);
    return p;
  }
  const shell = (p) => p.evaluate(() => { const e = document.querySelector('[data-scd-shell]'); return e ? { shell: e.getAttribute('data-scd-shell'), sidebar: e.getAttribute('data-scd-sidebar'), cw: e.getAttribute('data-scd-content-width') } : null; });
  const rect = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height }; }, sel);

  // 1) شاشة الدخول (segments=[]): عمود ضيق وبلا قائمة
  let p = await open(1360, 860);
  let s = await shell(p);
  ok('الدخول: وضع auth وبلا قائمة', s && s.shell === 'auth' && s.sidebar === 'none', JSON.stringify(s));
  let col = await rect(p, '[data-name="plain-screen"]');
  ok('الدخول: عرض العمود ≤ 520 ومُوسَّط', col && col.w <= 520 && Math.abs(col.l - (1360 - col.r)) < 2, JSON.stringify(col));

  // 2) بعد الدخول: القائمة على اليمين بعرض 248 والمحتوى 1111
  await p.evaluate(() => window.__go('/(tabs)')); await p.waitForTimeout(200);
  s = await shell(p);
  ok('التبويبات: وضع app وقائمة موسّعة', s && s.shell === 'app' && s.sidebar === 'expanded', JSON.stringify(s));
  const items = await p.$$eval('[aria-label]', (els) => els.filter((e) => e.getAttribute('role') === 'button').map((e) => e.getAttribute('aria-label')));
  ok('عناصر القائمة بترتيب Tabs.Screen وبلا href:null (audit مخفي)', JSON.stringify(items.filter((x) => x !== 'طيّ القائمة')) === JSON.stringify(['الرئيسية', 'القضايا', 'المحتجزون', 'المذكرات', 'المستخدمون', 'الإعدادات']), JSON.stringify(items));
  const side = await rect(p, '[data-scd-shell] > div:first-child');
  ok('القائمة على اليمين (RTL) وعرضها 248', side && Math.abs(side.r - 1360) < 1.5 && Math.abs(side.w - 248) < 1.5, JSON.stringify(side));
  col = await rect(p, '[data-name="stack"]');
  ok('عمود المحتوى = 1360−249 = 1111', col && Math.abs(col.w - 1111) < 2, JSON.stringify(col));
  const meta = await p.$eval('[data-name="tabs-meta"]', (e) => JSON.parse(e.textContent));
  ok('شريط التبويبات الأصلي مخفي (display:none) والعميل لم يفقد خياراته (keepMe)', meta.tabBarDisplay === 'none' && meta.keepsOwn === 1, JSON.stringify(meta));
  const active = await p.$$eval('[role="button"][aria-selected="true"]', (e) => e.map((x) => x.getAttribute('aria-label')));
  ok('العنصر النشط: الرئيسية', JSON.stringify(active) === '["الرئيسية"]', JSON.stringify(active));
  const focused = await p.$$eval('[data-focused="true"]', (e) => e.length);
  ok('tabBarIcon الأصلية تُستدعى بـ focused للنشط فقط', focused === 1, String(focused));

  // 3) اختصار Ctrl+2 ونقر عنصر
  await p.keyboard.press('Control+2'); await p.waitForTimeout(150);
  ok('Ctrl+2 ينقل إلى القضايا', (await p.$eval('[data-name="tab-screen"]', (e) => e.textContent)) === 'tab:cases', '');
  await p.click('[aria-label="المحتجزون"]'); await p.waitForTimeout(150);
  ok('النقر على عنصر ينقل', (await p.$eval('[data-name="tab-screen"]', (e) => e.textContent)) === 'tab:detainees', '');
  await p.keyboard.press('Control+9'); await p.waitForTimeout(100);
  ok('Ctrl+9 بلا عنصر لا يغيّر شيئاً', (await p.$eval('[data-name="tab-screen"]', (e) => e.textContent)) === 'tab:detainees', '');

  // 4) شاشة Stack أخرى (تقارير): القائمة تبقى
  await p.evaluate(() => window.__go('/reports')); await p.waitForTimeout(200);
  s = await shell(p);
  ok('شاشة /reports: القائمة باقية (المخزن لم يُمسح لأن Tabs ما زالت مركّبة)', s && s.shell === 'app' && s.sidebar === 'expanded', JSON.stringify(s));
  const act2 = await p.$$eval('[role="button"][aria-selected="true"]', (e) => e.length);
  ok('شاشة /reports: لا عنصر نشط', act2 === 0, String(act2));

  // 5) طيّ/توسيع يدوي ويُحفظ
  await p.evaluate(() => window.__go('/(tabs)')); await p.waitForTimeout(150);
  await p.click('[aria-label="طيّ القائمة"]'); await p.waitForTimeout(150);
  s = await shell(p); ok('الطيّ اليدوي ⇒ compact', s.sidebar === 'compact', JSON.stringify(s));
  const side2 = await rect(p, '[data-scd-shell] > div:first-child');
  ok('عرض القائمة المطوية 76', side2 && Math.abs(side2.w - 76) < 1.5, JSON.stringify(side2));
  ok('الاختيار محفوظ في localStorage', (await p.evaluate(() => localStorage.getItem('scd.sidebar'))) === 'compact', '');
  await p.reload(); await p.waitForTimeout(150); await p.evaluate(() => window.__go('/(tabs)')); await p.waitForTimeout(200);
  s = await shell(p); ok('بعد إعادة التحميل يبقى compact', s.sidebar === 'compact', JSON.stringify(s));
  await p.click('[aria-label="توسيع القائمة"]'); await p.waitForTimeout(100);
  s = await shell(p); ok('التوسيع اليدوي ⇒ expanded', s.sidebar === 'expanded', JSON.stringify(s));

  // 6) تسجيل الخروج: segments=[] ⇒ auth بلا قائمة
  await p.evaluate(() => window.__go('/')); await p.waitForTimeout(150);
  s = await shell(p); ok('الخروج إلى / ⇒ auth وبلا قائمة', s.shell === 'auth' && s.sidebar === 'none', JSON.stringify(s));
  await p.context().close();

  // 7) الأحجام: 1024 تلقائياً compact، 2560 عمود محتوى مقيّد بـ 1280 ومُوسَّط
  p = await open(1024, 680); await p.evaluate(() => window.__go('/(tabs)')); await p.waitForTimeout(200);
  s = await shell(p); ok('1024: compact تلقائياً', s.sidebar === 'compact' && Number(s.cw) === 1024 - 77, JSON.stringify(s));
  const sd = await rect(p, '[data-scd-shell] > div:first-child'); ok('1024: القائمة يميناً بعرض 76', sd && Math.abs(sd.r - 1024) < 1.5 && Math.abs(sd.w - 76) < 1.5, JSON.stringify(sd));
  await p.setViewportSize({ width: 2560, height: 1300 }); await p.waitForTimeout(250);
  s = await shell(p); ok('2560: موسّعة والمحتوى 1280', s.sidebar === 'expanded' && Number(s.cw) === 1280, JSON.stringify(s));
  col = await rect(p, '[data-name="stack"]'); ok('2560: العمود الفعلي 1280', col && Math.abs(col.w - 1280) < 2, JSON.stringify(col));
  const stage = await rect(p, '[data-scd-shell] > div:last-child');
  ok('2560: العمود مُوسَّط داخل المساحة المتبقية', stage && Math.abs((col.l - stage.l) - (stage.r - col.r)) < 2, JSON.stringify({ stage, col }));
  await p.context().close();

  // 8) دور بلا صلاحيات: users/memos مخفية
  p = await open(1360, 860, '?role=viewer'); await p.evaluate(() => window.__go('/(tabs)')); await p.waitForTimeout(200);
  const vi = await p.$$eval('[role="button"][aria-label]', (els) => els.map((e) => e.getAttribute('aria-label')).filter((x) => x !== 'طيّ القائمة'));
  ok('دور viewer: القائمة لا تعرض المستخدمين/المذكرات', JSON.stringify(vi) === JSON.stringify(['الرئيسية', 'القضايا', 'المحتجزون', 'الإعدادات']), JSON.stringify(vi));
  await p.context().close();

  ok('لا أخطاء صفحة/كونسول', errors.length === 0, errors.slice(0, 4).join(' | '));
  await b.close();
  console.log(fails ? `\nفشل ${fails}` : '\nكل الفحوص نجحت');
  process.exit(fails ? 1 : 0);
})();
