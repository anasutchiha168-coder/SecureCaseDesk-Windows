# SecureCaseDesk - دليل التثبيت والتشغيل (Windows 10/11 x64)

## الملفات
- SecureCaseDesk-Setup.exe : مثبّت NSIS
- SecureCaseDesk-Portable.exe : نسخة بلا تثبيت
- SHA256SUMS.txt : بصمات التحقق

التنزيل من صفحة Releases في المستودع.

## التحقق (PowerShell)
Get-FileHash .\SecureCaseDesk-Setup.exe -Algorithm SHA256
قارن الناتج بـ SHA256SUMS.txt

## التثبيت
1. شغّل SecureCaseDesk-Setup.exe
2. الملف غير موقّع: في SmartScreen اختر More info ثم Run anyway
3. البيانات في %APPDATA%\SecureCaseDesk ولا تُحذف عند الإزالة

## Winlator على Android (اختبار فقط)
1. انسخ SecureCaseDesk-Portable.exe إلى الهاتف وشغّله من حاوية Windows 10 أو أحدث
2. أضف متغيرات البيئة: SCD_WINLATOR=1 و SCD_DISABLE_GPU=1
3. إن فشل Chromium sandbox أضف الوسيط --no-sandbox (للاختبار فقط)
4. SCD_WINLATOR=1 يفعّل تخزين مفاتيح برمجي غير آمن، فلا تستخدم بيانات حقيقية
5. حالة Winlator: لم تُجرَّب بعد، سجّل نتيجتك هنا
