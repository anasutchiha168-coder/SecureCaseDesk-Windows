#!/usr/bin/env python3
# SECURECASEDESK_FIX_ATTACHMENTS_SDK58
# إصلاح المرفقات: في Expo SDK 58 أصبحت File.write و FileHandle.writeBytes غير متزامنتين (تُرجعان Promise)،
# وكان الكود يستدعيهما بدون انتظار فيفشل الحفظ ("تعذر حفظ الملف") ويُصفَّر الملف المؤقت قبل اكتمال الكتابة.
# الحل: استخدام النسخ المتزامنة writeSync / writeBytesSync.
# التشغيل من جذر المشروع:  python3 fix_attachments_sdk58.py
import pathlib, sys

EDITS = [
    ("src/modules/attachments/attachments-storage.ts",
     "  f.create();\n  f.write(bytes);\n}",
     "  f.create();\n  f.writeSync(bytes); // SDK 58: write() غير متزامنة؛ writeSync هي المتزامنة\n}"),
    ("src/modules/attachments/attachments-storage.ts",
     "  try { h.writeBytes(bytes); } finally { h.close(); }",
     "  try { h.writeBytesSync(bytes); } finally { h.close(); } // SDK 58: writeBytes غير متزامنة"),
    ("src/services/attachments.service.ts",
     "  out.create();\n  out.write(bytes);\n  bytes.fill(0);",
     "  out.create();\n  out.writeSync(bytes); // SDK 58: write() غير متزامنة؛ كان bytes.fill(0) يصفّر البيانات قبل اكتمال الكتابة\n  bytes.fill(0);"),
]

def main() -> int:
    changed = 0
    for path, old, new in EDITS:
        p = pathlib.Path(path)
        if not p.exists():
            print(f"✗ الملف غير موجود: {path}  (شغّل السكربت من جذر المشروع)")
            return 1
        s = p.read_text(encoding="utf-8")
        if new in s:
            print(f"• مطبَّق مسبقاً: {path}")
            continue
        if s.count(old) != 1:
            print(f"✗ لم أجد النص المتوقع في {path} — لم يُعدَّل شيء في هذا الملف")
            return 1
        p.write_text(s.replace(old, new), encoding="utf-8")
        print(f"✓ عُدِّل: {path}")
        changed += 1
    print(f"تم. عدد التعديلات الجديدة: {changed}")
    print("التالي:  npx tsc --noEmit  ثم  npm run test:attachments  ثم أعد بناء الـ APK")
    return 0

if __name__ == "__main__":
    sys.exit(main())
