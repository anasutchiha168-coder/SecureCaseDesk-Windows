#!/usr/bin/env python3
# SECURECASEDESK_DETAINEES_V22_S1_IMPORT
# يستخرج القيم الخام من الورقة الأولى في ملف معلومية السجناء إلى JSON. لا تحويلات ولا تخمين هنا.
# الاستخدام: python3 scripts/import/excel_to_json.py "الملف.xlsx" import-data/detainees.json
import sys, json, os, datetime as D
import openpyxl

src, out = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
ws = wb[wb.sheetnames[0]]

def t(v):
    if v is None: return None
    if isinstance(v, float) and v.is_integer(): v = int(v)
    s = str(v).strip()
    return s or None

def d(v):
    if isinstance(v, D.datetime): return v.strftime('%Y-%m-%d')
    if isinstance(v, D.date): return v.isoformat()
    return None

rows = []
for i, r in enumerate(ws.iter_rows(min_row=3, values_only=True), start=3):
    r = list(r) + [None] * (26 - len(r))
    if not t(r[1]): continue          # صف فارغ (معادلات فقط)
    rows.append({
        'excelRow': i, 'serial': t(r[0]), 'name': t(r[1]), 'age': t(r[2]),
        'idType': t(r[3]), 'idNumber': t(r[4]), 'phone': t(r[5]),
        'governorate': t(r[6]), 'district': t(r[7]), 'subDistrict': t(r[8]),
        'residence': t(r[9]), 'occupation': t(r[10]), 'offense': t(r[11]),
        'caseRole': t(r[12]), 'reportNo': t(r[13]), 'depositAuthority': t(r[14]),
        'admission': d(r[15]), 'legalStatus': t(r[16]), 'referralDate': d(r[17]),
        'place': t(r[18]), 'release': d(r[19]), 'exitType': t(r[20]),
        'exitProcedure': t(r[21]), 'exitSource': t(r[22]), 'fate': t(r[23]), 'notes': t(r[24]),
    })
os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
with open(out, 'w', encoding='utf-8') as f:
    json.dump(rows, f, ensure_ascii=False)
print('تم استخراج', len(rows), 'سجلاً إلى', out)
