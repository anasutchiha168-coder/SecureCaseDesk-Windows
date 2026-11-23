// اختبار حقيقي لحوار Alert في Chromium (Playwright). يُتخطّى تلقائياً إن لم يتوفر Playwright (مثل CI على Windows).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const shims = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shims');
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* غير متوفر */ }

// نجمع alert-core + web-alert في سكربت واحد (نزيل import/export فقط؛ الباقي JS بعد تجريد الأنواع).
function bundle() {
  const strip = (f) => stripTypeScriptTypes(readFileSync(path.join(shims, f), 'utf8'), { mode: 'strip' });
  const core = strip('alert-core.ts').replace(/^export\s+/gm, '');
  const web = strip('web-alert.ts').replace(/^import[^;]*;\s*$/gm, '').replace(/^export\s+/gm, '');
  return `(()=>{${core}\n${web}\nwindow.__t={showAlert,queue:__alertQueue};})();`;
}

const PAGE = '<!doctype html><html lang="ar" dir="rtl"><body><div id="root"><button id="behind">خلفية</button><input id="field"></div></body></html>';

test('حوار Alert في Chromium الحقيقي', { skip: !chromium && 'Playwright غير متوفر' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setContent(PAGE);
    await page.addScriptTag({ content: bundle() });
    const q = (sel) => page.locator(sel);

    // 1) تأكيد حذف: [إلغاء، حذف]
    await page.focus('#field');
    await page.evaluate(() => {
      window.log = [];
      window.__t.showAlert('حذف القضية', 'سطر 1\nسطر 2 <b>لا HTML</b>', [
        { text: 'إلغاء', style: 'cancel', onPress: () => window.log.push('cancel') },
        { text: 'حذف', style: 'destructive', onPress: () => window.log.push('delete') },
      ]);
    });
    assert.equal(await q('.scd-alert-overlay').count(), 1);
    assert.equal(await q('.scd-alert').getAttribute('role'), 'alertdialog');
    assert.equal(await q('.scd-alert').getAttribute('aria-modal'), 'true');
    assert.equal(await q('.scd-alert-title').textContent(), 'حذف القضية');
    assert.equal(await q('.scd-alert-message b').count(), 0, 'HTML حُقن!');
    assert.match(await q('.scd-alert-message').textContent(), /<b>لا HTML<\/b>/);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.scd-alert-overlay')).direction), 'rtl');
    assert.equal(await page.evaluate(() => document.getElementById('root').hasAttribute('inert')), true, 'الخلفية يجب أن تكون inert');
    // التركيز على "إلغاء" لا "حذف"
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'إلغاء');
    // Tab يبقى داخل الحوار
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('.scd-alert')), true);
    // محاولة تركيز عنصر الخلفية تُعاد للحوار
    await page.evaluate(() => document.getElementById('behind').removeAttribute('inert'));
    await page.evaluate(() => document.getElementById('behind').focus());
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('.scd-alert')), true);
    // Escape ⇒ يضغط "إلغاء"
    await page.keyboard.press('Escape');
    assert.equal(await q('.scd-alert-overlay').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.log), ['cancel']);
    assert.equal(await page.evaluate(() => document.getElementById('root').hasAttribute('inert')), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'field', 'يجب أن يعود التركيز لما كان عليه');

    // 2) زر "حذف" بالنقر
    await page.evaluate(() => {
      window.log = [];
      window.__t.showAlert('t', 'm', [{ text: 'إلغاء', style: 'cancel' }, { text: 'حذف', style: 'destructive', onPress: () => window.log.push('delete') }]);
    });
    await q('.scd-alert-btn.scd-destructive').click();
    assert.deepEqual(await page.evaluate(() => window.log), ['delete']);
    assert.equal(await q('.scd-alert-overlay').count(), 0);

    // 3) النقر على الخلفية لا يغلق (غير cancelable)، ويغلق مع cancelable مستدعياً onDismiss فقط
    await page.evaluate(() => { window.log = []; window.__t.showAlert('t', 'm', [{ text: 'موافق', onPress: () => window.log.push('ok') }]); });
    await page.mouse.click(5, 5);
    assert.equal(await q('.scd-alert-overlay').count(), 1);
    await page.keyboard.press('Enter'); // الزر الوحيد مُركَّز
    assert.deepEqual(await page.evaluate(() => window.log), ['ok']);
    await page.evaluate(() => { window.log = []; window.__t.showAlert('t', 'm', [{ text: 'أ', onPress: () => window.log.push('a') }, { text: 'ب' }], { cancelable: true, onDismiss: () => window.log.push('dismiss') }); });
    await page.mouse.click(5, 5);
    assert.deepEqual(await page.evaluate(() => window.log), ['dismiss']);

    // 4) Escape لا يضغط زراً من عدة أزرار بلا cancel (قد يكون حذفاً)
    await page.evaluate(() => { window.log = []; window.__t.showAlert('t', 'm', [{ text: 'حذف', style: 'destructive', onPress: () => window.log.push('delete') }, { text: 'نعم', onPress: () => window.log.push('yes') }]); });
    await page.keyboard.press('Escape');
    assert.equal(await q('.scd-alert-overlay').count(), 1);
    assert.deepEqual(await page.evaluate(() => window.log), []);
    await q('.scd-alert-btn').nth(1).click();

    // 5) تنبيه يتولّد من رد نداء يظهر بعد الأول (طابور)
    await page.evaluate(() => { window.__t.showAlert('أول', '', [{ text: 'تابع', onPress: () => window.__t.showAlert('ثانٍ') }]); });
    await q('.scd-alert-btn').click();
    assert.equal(await q('.scd-alert-title').textContent(), 'ثانٍ');
    await q('.scd-alert-btn').click();
    assert.equal(await q('.scd-alert-overlay').count(), 0);

    // 6) ثلاثة أزرار ⇒ عمودي؛ رسالة طويلة لا تتجاوز الشاشة
    await page.evaluate(() => window.__t.showAlert('ط', 'س\n'.repeat(400), [{ text: 'أ' }, { text: 'ب' }, { text: 'ج' }]));
    assert.equal(await q('.scd-alert-actions.scd-stack').count(), 1);
    const box = await q('.scd-alert').boundingBox();
    const vp = page.viewportSize();
    assert.ok(box.height <= vp.height, `الحوار ${box.height} أطول من الشاشة ${vp.height}`);
    const btnBox = await q('.scd-alert-btn').last().boundingBox();
    assert.ok(btnBox.y + btnBox.height <= vp.height, 'الأزرار خارج الشاشة');
    await q('.scd-alert-btn').first().click();

    assert.deepEqual(errors, [], 'أخطاء صفحة: ' + errors.join('; '));
  } finally {
    await browser.close();
  }
});
