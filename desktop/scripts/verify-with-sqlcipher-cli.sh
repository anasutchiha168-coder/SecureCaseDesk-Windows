#!/usr/bin/env bash
# يقرأ قاعدة أنشأها محركنا (windows-made.db) بـ sqlcipher CLI الرسمي ويتحقق من المحتوى والسلامة.
set -euo pipefail
D="${1:?usage: verify-with-sqlcipher-cli.sh <fixture-dir>}"
KEY="$(cat "$D/fixture-key.txt")"
OUT="$(sqlcipher "$D/windows-made.db" "PRAGMA key='$KEY'; SELECT count(*) FROM cases; SELECT title FROM cases WHERE id='1'; PRAGMA integrity_check;")"
echo "$OUT"
echo "$OUT" | grep -qx "3" || { echo "❌ عدد الصفوف غير مطابق"; exit 1; }
echo "$OUT" | grep -q "قضية اعتداء" || { echo "❌ النص العربي غير مطابق"; exit 1; }
echo "$OUT" | grep -qx "ok" || { echo "❌ integrity_check فشل"; exit 1; }
echo "✅ sqlcipher الرسمي قرأ قاعدة Windows بنجاح"
