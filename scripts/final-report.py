#!/usr/bin/env python3
# SECURECASEDESK_PHASE12_S4
# أداة التقرير النهائي للمرحلة 12 (المرشح المحلي). تُشغَّل من جذر المشروع:
#   python3 scripts/final-report.py run                      # يشغّل الاختبارات وtsc ويولّد التقرير
#   python3 scripts/final-report.py report                   # يعيد توليد التقرير من النتائج المحفوظة (بلا تشغيل)
#   python3 scripts/final-report.py mark D04 pass "ملاحظة"   # تسجيل نتيجة بند جهاز (pass | fail | pending)
#   python3 scripts/final-report.py apk "وصف/رقم التشغيل" [ملف.apk]   # تسجيل الـ APK المختبَر (مع SHA-256 إن وُجد الملف)
#   python3 scripts/final-report.py status                   # ملخص سريع
# قاعدة الصدق: لا يُحتسب بند جهاز ناجحاً إلا إذا سجّلتَه بنفسك بعد تنفيذه فعلاً.
import datetime, hashlib, json, os, re, subprocess, sys

DOCS = 'docs/phase12'
AUTO = DOCS + '/auto-results.json'
DEV = DOCS + '/device-results.json'
REPORT = DOCS + '/12.4-final-report.md'

# رمز: (البند، مصدر الاختبار الآلي أو '')
DEVICE = [
    ('D01', 'تثبيت وتشغيل APK'), ('D02', 'إعداد أول مدير'), ('D03', 'تسجيل الدخول والخروج'),
    ('D04', 'SQLCipher على البناء الحقيقي'), ('D05', 'إعادة فتح القاعدة المشفّرة'), ('D06', 'الاستمرارية بعد إعادة التشغيل'),
    ('D07', 'القضايا: إنشاء/تعديل/بحث/أرشفة'), ('D08', 'الأقسام'), ('D09', 'المذكرات العشر'),
    ('D10', 'تسجيل محتجز'), ('D11', 'الحركات: إيداع/نقل/إفراج'), ('D12', 'التصحيح التاريخي'),
    ('D13', 'منع حذف/تعديل التاريخ'), ('D14', 'دور المحقق'), ('D15', 'دور الاطلاع'),
    ('D16', 'عزل مشاهد المحتجزين'), ('D17', 'منع الوصول غير المصرّح'), ('D18', 'سلامة سلسلة التدقيق'),
    ('D19', 'تشفير المرفقات وSHA-256'), ('D20', 'التشغيل بلا إنترنت'),
    ('D21', 'RTL عند أول تشغيل (G2)'), ('D22', 'شاشات row-reverse (G3)'), ('D23', 'الخطوط'),
    ('D24', 'الإدخال العربي'), ('D25', 'النوافذ والقوائم'), ('D26', 'PDF للتقارير العشرة'),
    ('D27', 'DOCX للتقارير العشرة (G5)'), ('D28', 'تقرير عريض أفقي'), ('D29', 'تقرير طويل وترقيم PDF (G4)'),
    ('D30', 'الطباعة والمشاركة'), ('D31', 'نص طويل وأسطر متعددة'), ('D32', 'إنشاء نسخة احتياطية'),
    ('D33', 'التحقق من النسخة'), ('D34', 'الاستعادة + PreRestore'), ('D35', 'استعادة بكلمة خاطئة'),
    ('D36', 'انقطاع أثناء الاستعادة'), ('D37', 'استعادة على جهاز نظيف'), ('D38', 'تدقيق أحداث النسخ'),
    ('D39', 'قاعدة قديمة فعلية'), ('D40', 'منع فقدان البيانات'),
]
BLOCKED = {'D39': 'معلّق حتى توفر القاعدة القديمة الفعلية (موثّق)'}
STATE_AR = {'pass': 'نجح', 'fail': 'فشل', 'pending': 'لم يُنفَّذ', 'blocked': 'معلّق'}

ONLINE = ['الخادم ونشره', 'PostgreSQL', 'HTTPS', 'Argon2id من جهة الخادم', 'RBAC من جهة الخادم', 'التفويض عبر API',
          'مزامنة جهازين حقيقيين', 'رفع العمليات المعلّقة', 'تنزيل التحديثات المصرّح بها', 'منع تكرار العمليات والـ Idempotency',
          'كشف تعارض التعديل المتزامن وحفظه', 'انقطاع الإنترنت أثناء المزامنة والتعافي', 'مزامنة المرفقات المشفّرة',
          'تعطيل الحساب وإبطال الجلسة', 'سحب الصلاحيات', 'سجل التدقيق من جهة الخادم', 'اتساق البيانات بين الأجهزة', 'APK النهائي المتكامل']

LIMITS = [
    ('G1', 'escapeXml/escapeHtml لا تحذفان محارف تجاوز الاتجاه (U+202A–202E وU+2066–2069)', 'مدخل ضار قد يقلب ترتيب نص ظاهر في مستند رسمي', 'غير مُصلَح'),
    ('G2', 'forceRTL بلا إعادة تحميل', 'قد يكون أول تشغيل على جهاز لغته غير عربية LTR', 'غير مُصلَح — يُتحقق بـ D21'),
    ('G3', 'استخدام مباشر لـ row-reverse في 5 ملفات (17 موضعاً)', 'قد تختلف هذه الشاشات عن بقية التطبيق', 'غير مُصلَح — يُتحقق بـ D22'),
    ('G4', 'ترقيم PDF يعتمد على @page { @bottom-center }', 'قد لا يدعمه WebView على بعض إصدارات Android', 'يُتحقق بـ D29'),
    ('G5', 'DOCX يطلب الخط Arial للعربية', 'قد يستبدله Word/WPS بخط آخر (الشكل لا المعنى)', 'يُتحقق بـ D27'),
    ('L1', 'تقييد الوصول حسب القسم للمحقق غير منفَّذ: عمود users.department_id موجود لكن listCases لا يفلتر به', 'المحقق يرى قضايا كل الأقسام (مخالف للقسم 9 من المواصفات)', 'مفتوح — قرار الجدولة لك'),
    ('L2', 'مفتاح SQLCipher واحد للقاعدة؛ العزل بين الأدوار في طبقة التطبيق فقط', 'من ينفّذ كوداً على الجهاز يتجاوز الصلاحيات', 'قيد معماري (SECURITY.md)'),
    ('L3', 'الدور يُقرأ عند الدخول وبدء التشغيل فقط', 'تغيير الدور لا يسري على جلسة قائمة', 'يُعالَج في المرحلة 13'),
    ('L4', 'حماية المشغّلات تمنع SQL العادي فقط لا تعديل الملف الخام', 'سيناريو نادر يتطلب فك التشفير', 'قيد معماري (SECURITY.md)'),
    ('L5', 'اختبارات Node تعمل على node:sqlite والأسرار محاكاة', 'لا تثبت SQLCipher ولا SecureStore', 'يثبتها D04/D05 على الجهاز'),
    ('L6', 'الذكاء الاصطناعي لم يُختبر على جهاز Android حقيقي', 'انظر docs/phase11/11.5-ai-privacy-final.md', 'لم يُنفَّذ'),
]

def load(p, default):
    try: return json.load(open(p, encoding='utf8'))
    except Exception: return default
def save(p, d):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf8').write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
def now(): return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def run(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf8', errors='replace')
    return p.returncode, (p.stdout or '') + (p.stderr or '')

def parse_tap(out):
    # يقبل صيغة TAP ("# tests 41") وصيغة spec في Node 24 ("ℹ tests 41"): أي بادئة غير لاتينية
    d = {}
    for k in ('tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
        ms = re.findall(r'^[^A-Za-z\n]*\s*' + k + r'\s+(\d+)\s*$', out, re.M)
        if ms: d[k] = int(ms[-1])
    return d

def failures(out):
    names, todos = [], []
    for l in out.splitlines():
        s = l.strip()
        if s.startswith('not ok') or s.startswith('\u2716'):
            (todos if '# TODO' in s else names).append(re.sub(r'\s+', ' ', s))
    return sorted(set(names)), sorted(set(todos))

def do_run():
    if not os.path.isfile('package.json'): sys.exit('شغّل من جذر المشروع.')
    print('== preflight');   rcp, op = run('node scripts/preflight-build.mjs')
    print('== tsc');         rct, ot = run('npx tsc --noEmit')
    print('== test:all (TAP)'); rca, oa = run('npm run test:all -- --test-reporter=tap')
    sa = parse_tap(oa)
    valid = bool(sa.get('tests')) and 'pass' in sa and 'fail' in sa
    fl, td = failures(oa)
    if sa.get('fail', 0) == 0: fl = []
    a = {'at': now(), 'node': run('node -v')[1].strip(),
         'preflight_rc': rcp, 'tsc_rc': rct, 'tsc_tail': ot[-1500:] if rct else '',
         'tests_rc': rca, 'summary': sa, 'summary_valid': valid, 'failed': fl, 'todo': td}
    if not valid: a['raw_tail'] = oa[-2500:]
    save(AUTO, a)
    print('preflight :', 'نجح' if rcp == 0 else 'فشل')
    print('tsc       :', 'نجح' if rct == 0 else 'فشل')
    print('test:all  :', 'نجح' if rca == 0 else 'فشل', sa)
    if not valid: print('! تعذّرت قراءة العدّادات؛ لن يُعدّ التقرير ذلك نجاحاً موثوقاً.')
    for f in fl: print('  فشل:', f)

def device_state(dev, code):
    if code in BLOCKED and code not in dev.get('items', {}): return 'blocked', BLOCKED[code], ''
    it = dev.get('items', {}).get(code)
    if not it: return 'pending', '', ''
    return it['state'], it.get('note', ''), it.get('at', '')

def build():
    a, dev = load(AUTO, None), load(DEV, {'items': {}})
    L = []
    auto_ok = bool(a and a.get('summary_valid') and a['tests_rc'] == 0 and a['summary'].get('fail', 1) == 0 and a['tsc_rc'] == 0 and a['preflight_rc'] == 0)
    states = {c: device_state(dev, c) for c, _ in DEVICE}
    cnt = {k: sum(1 for s in states.values() if s[0] == k) for k in STATE_AR}
    dev_ok = all(states[c][0] == 'pass' for c, _ in DEVICE if c != 'D39') and states['D39'][0] in ('pass', 'blocked')
    verdict = ('مرشح إصدار محلي مكتمل' if (auto_ok and dev_ok) else 'غير مكتمل')

    L += ['# المرحلة 12 / القسم 12.4 — التقرير النهائي للمرشح المحلي', '',
          '> مُولَّد آلياً من `scripts/final-report.py`. لا يحتسب أي بند جهاز ناجحاً إلا إذا سجّلته بنفسك. التاريخ: ' + now(), '',
          '## الحكم الحالي: **' + verdict + '**', '',
          'هذا الإصدار **مرشح تشغيل محلي** (القسم 21.1). لا مزامنة فيه ولا خادم مركزي، ولا يجوز وصفه بأنه المنتج النهائي متعدد الأجهزة. المشروع لا يكتمل قبل المرحلة 13.', '']
    L += ['| الشرط | الحالة |', '|---|---|',
          '| الاختبارات الآلية + tsc + preflight | ' + ('نجحت' if auto_ok else ('لم تُشغَّل بعد' if not a else 'فيها فشل أو عدّاد غير موثوق — راجع القسم أدناه')) + ' |',
          '| بنود الجهاز (39 بنداً ما عدا D39) | نجح %d • فشل %d • لم يُنفَّذ %d • معلّق %d |' % (cnt['pass'], cnt['fail'], cnt['pending'], cnt['blocked']),
          '| APK مسجَّل | ' + ('نعم' if dev.get('apk') else 'لا') + ' |', '']

    L += ['## أولاً: نتائج الاختبارات الآلية (Node، ليست SQLCipher ولا جهاز)', '']
    if not a: L += ['لم تُشغَّل بعد. نفّذ: `python3 scripts/final-report.py run`', '']
    else:
        s = a['summary']
        L += ['- وقت التشغيل: ' + a['at'] + ' — Node ' + a['node'],
              '- preflight: ' + ('نجح' if a['preflight_rc'] == 0 else 'فشل'), '- tsc --noEmit: ' + ('نجح' if a['tsc_rc'] == 0 else 'فشل'),
              '- test:all: ' + ('نجح' if a['tests_rc'] == 0 else 'فشل') + ' — ' + (', '.join(k + '=' + str(v) for k, v in s.items()) if a['summary_valid'] else 'العدّادات غير مقروءة (نتيجة غير موثوقة)'), '']
        if a['failed']: L += ['### اختبارات فاشلة'] + ['- ' + f for f in a['failed']] + ['']
        if a['todo']: L += ['### فجوات معلّمة todo (لا تُفشل التشغيل)'] + ['- ' + f for f in a['todo']] + ['']
        if a['tsc_rc'] and a.get('tsc_tail'): L += ['```', a['tsc_tail'], '```', '']

    L += ['## ثانياً: اختبارات الجهاز الحقيقي (القسم 22.1)', '', '| الرمز | البند | الحالة | ملاحظة | التاريخ |', '|---|---|---|---|---|']
    for c, n in DEVICE:
        st, note, at = states[c]
        L.append('| %s | %s | %s | %s | %s |' % (c, n, STATE_AR[st], note.replace('|', '/'), at))
    L += ['']

    L += ['## ثالثاً: القيود والفجوات المعروفة', '', '| # | الوصف | الأثر | الحالة |', '|---|---|---|---|']
    for r in LIMITS: L.append('| ' + ' | '.join(r) + ' |')
    L += ['']

    L += ['## رابعاً: الـ APK', '']
    ap = dev.get('apk')
    if ap:
        L += ['- المسجَّل: ' + ap['desc'], '- تاريخ التسجيل: ' + ap['at']]
        if ap.get('sha256'): L += ['- SHA-256: `' + ap['sha256'] + '` — الحجم: ' + str(ap['size']) + ' بايت']
        L += ['']
    else: L += ['لم يُسجَّل APK بعد: `python3 scripts/final-report.py apk "تشغيل Actions رقم N" [ملف.apk]`', '']
    L += ['**الاسترجاع:** GitHub ← Actions ← «Android APK (local release candidate)» ← Run workflow (profile: preview) ← بعد النجاح Artifact باسم `SecureCaseDesk-apk-preview-run<N>` (فيه APK و`.sha256` و`build-info.txt`، يُحفظ 30 يوماً، والمستودع يجب أن يكون Private).',
          '**التحقق:** `sha256sum -c SecureCaseDesk-preview-run<N>.apk.sha256` ثم التثبيت (`adb install -r` أو تفعيل المصادر غير المعروفة).',
          '**أسرار:** `EXPO_TOKEN` فقط في GitHub Secrets؛ مفتاح SQLCipher يُولَّد على الجهاز ولا يوجد في CI.', '']

    L += ['## خامساً: اختبارات الخادم المركزي — معلّقة حتى المرحلة 13 (القسم 22.2)', '', 'لا تُعلَّم قبل وجود الخادم ولم تُنفَّذ:', '']
    L += ['- ' + x for x in ONLINE] + ['']
    L += ['## سادساً: إغلاق المرحلة 12', '',
          '1. شغّل `run`، ثم نفّذ بنود الجهاز على APK مثبّت وسجّل كل بند بـ `mark`.',
          '2. أي بند فاشل يُسجَّل `fail` بملاحظة ويُعالَج أو يُوثَّق كقيد قبل الإعلان.',
          '3. عند اكتمال الشروط يتحول الحكم أعلاه تلقائياً. بعدها فقط: `git tag v2.2.0-rc1` ثم `git push --tags` (يطلق بناء APK عبر Actions).',
          '4. لا تبدأ المرحلة 13 قبل مراجعة هذا التقرير.']
    open(REPORT, 'w', encoding='utf8', newline='\n').write('\n'.join(L) + '\n')
    print('✔ ' + REPORT + ' — الحكم: ' + verdict + ' | جهاز: ' + str(cnt))

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'run'
    if cmd == 'run': do_run(); build()
    elif cmd in ('report', 'status'): build()
    elif cmd == 'mark':
        if len(sys.argv) < 4: sys.exit('الاستخدام: mark D04 pass|fail|pending ["ملاحظة"]')
        code, st = sys.argv[2].upper(), sys.argv[3].lower()
        if code not in dict(DEVICE) or st not in ('pass', 'fail', 'pending'): sys.exit('رمز أو حالة غير صحيحة.')
        dev = load(DEV, {'items': {}})
        dev.setdefault('items', {})[code] = {'state': st, 'note': ' '.join(sys.argv[4:]), 'at': now()}
        save(DEV, dev); print('✔ سُجّل ' + code + ' = ' + STATE_AR[st]); build()
    elif cmd == 'apk':
        if len(sys.argv) < 3: sys.exit('الاستخدام: apk "الوصف" [ملف.apk] | apk --clear')
        dev = load(DEV, {'items': {}})
        if sys.argv[2] == '--clear':
            dev.pop('apk', None); save(DEV, dev); print('✔ مُسح تسجيل الـ APK'); build(); return
        ap = {'desc': sys.argv[2], 'at': now()}
        if len(sys.argv) > 3 and os.path.isfile(sys.argv[3]):
            b = open(sys.argv[3], 'rb').read(); ap['sha256'] = hashlib.sha256(b).hexdigest(); ap['size'] = len(b)
        dev['apk'] = ap; save(DEV, dev); print('✔ سُجّل الـ APK'); build()
    else: sys.exit('أمر غير معروف.')

main()
