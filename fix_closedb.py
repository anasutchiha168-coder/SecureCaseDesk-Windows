#!/usr/bin/env python3
# يزيل نسخة closeDb() المكررة التي أضافها phase10_s7.py (لأن db.ts فيه closeDb سابقة).
# شغّله من جذر المشروع:  python3 fix_closedb.py
import re, shutil, sys, time
DB = 'src/database/db.ts'
src = open(DB, encoding='utf-8').read()
pat = re.compile(r'\n*// SECURECASEDESK_PHASE10_S7\n// يغلق الاتصال الحالي[^\n]*\nexport async function closeDb\(\): Promise<void> \{.*?\n\}\n', re.S)
found = len(re.findall(r'export\s+async\s+function\s+closeDb\b', src))
print('عدد تعريفات closeDb الحالية:', found)
if found < 2:
    sys.exit('لا يوجد تكرار؛ لم يُعدَّل شيء.')
new, n = pat.subn('\n', src, count=1)
if n != 1:
    sys.exit('لم أجد كتلة 10.7 المضافة بالشكل المتوقع. احذف تعريف closeDb الثاني (قرب نهاية الملف) يدوياً.')
if len(re.findall(r'export\s+async\s+function\s+closeDb\b', new)) != 1:
    sys.exit('بقي أكثر من تعريف؛ لم أحفظ شيئاً.')
shutil.copy2(DB, DB + '.bak_fixclose_' + time.strftime('%Y%m%d_%H%M%S'))
open(DB, 'w', encoding='utf-8', newline='\n').write(new.rstrip('\n') + '\n')
m = re.search(r'export\s+async\s+function\s+closeDb\b.*?\n\}', new, re.S)
body = m.group(0)
print('أُزيل التكرار. التعريف المتبقي:\n' + body)
if not re.search(r'\bdb\s*=\s*null\b', body) or 'close' not in body:
    print('\n⚠️ التعريف المتبقي لا يبدو أنه يغلق الاتصال ويصفّر المرجع db؛ أرسله لي قبل استعمال التراجع الآمن.')
else:
    print('\nيبدو أنه يغلق الاتصال ويصفّر db كما يلزم. شغّل الآن: npx tsc --noEmit')
