#!/usr/bin/env bash
# SECURECASEDESK_PHASE12_S1
# تنظيف مستودع المشروع من ملفات مؤقتة/غريبة. الوضع الافتراضي: عرض فقط (لا يغيّر شيئاً).
#   bash scripts/repo-hygiene.sh            # عرض
#   bash scripts/repo-hygiene.sh --apply    # نقل (لا حذف) إلى tools/legacy-cleanup/ ليمكن التراجع
set -euo pipefail
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
DEST="tools/legacy-cleanup"
list=()
# ملفات فارغة بأسماء غريبة نتجت عن أخطاء إعادة توجيه في الطرفية
for f in "0" "{" "MAX_ATTACHMENT_CIPHER_BYTES"; do [ -f "$f" ] && [ ! -s "$f" ] && list+=("$f"); done
# سكربتات المراحل السابقة (للأرشفة فقط)
for f in phase*.sh phase*.py apply-*.sh fix_*.py fix_project.py*; do [ -f "$f" ] && list+=("$f"); done
# نسخ احتياطية مؤقتة داخل src
while IFS= read -r f; do list+=("$f"); done < <(find src tests -type f \( -name '*.bak' -o -name '*.bak_*' -o -name '*.bak-*' \) 2>/dev/null)
# إزالة التكرار
mapfile -t list < <(printf '%s\n' "${list[@]:-}" | awk 'NF && !seen[$0]++')
if [ "${#list[@]}" -eq 0 ]; then echo "لا شيء للتنظيف."; exit 0; fi
echo "الملفات المرشحة (${#list[@]}):"; printf '  - %s\n' "${list[@]}"
if [ "$APPLY" -ne 1 ]; then echo; echo "وضع العرض فقط. للنقل: bash scripts/repo-hygiene.sh --apply"; exit 0; fi
mkdir -p "$DEST"
for f in "${list[@]}"; do
  mkdir -p "$DEST/$(dirname -- "$f")"
  mv -- "$f" "$DEST/$f"
done
echo "نُقلت إلى $DEST/ (لم يُحذف شيء). راجعها ثم احذف المجلد يدوياً إن أردت."
