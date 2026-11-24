#!/usr/bin/env bash
set -euo pipefail
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
[ -f package.json ] && [ -d desktop/backup ] && [ -d src ] || { echo "❌ شغّل من جذر المشروع"; exit 1; }
TARGETS=(
  phase10-5.sh phase10_s7.py phase10_s8.py
  phase11_s1_install.sh phase11_s2_install.sh phase11_s3_install.sh phase11_s4_install.sh phase11_s5_install.sh
  phase12_s1_install.sh phase12_s2_install.sh phase12_s3.py
  apply-10.6.sh apply-phase3.sh section5.sh
  fix_l1_g1_g2.py fix_closedb.py fix_attachments_sdk58.py
  ui_v3_detainees.py ui_v3_memos.py ui_v3_reports_attachments.py
  SecureCaseDesk-ui-v2.zip SecureCaseDesk-updated.zip SecureCaseDesk-desktop-section3.zip
  apk-direct.yml
  .github/workflows/unpack-desktop.yml
  .github/workflows/unpack-desktop-section2.yml
  .github/workflows/unpack-desktop-section3.yml
  .github/workflows/apply-smooth-ui.yml
  .github/workflows/apply-keyboard-fix.yml
  .github/workflows/apply-credits.yml
  scripts/repo-hygiene.sh
)
FOUND=(); SIZE=0
for f in "${TARGETS[@]}"; do
  if [ -f "$f" ]; then FOUND+=("$f"); SIZE=$((SIZE + $(wc -c < "$f"))); fi
done
while IFS= read -r f; do FOUND+=("$f"); SIZE=$((SIZE + $(wc -c < "$f"))); done < <(find src tests desktop -type f \( -name '*.bak' -o -name '*.bak_*' -o -name '*.bak-*' -o -name '*.orig' -o -name '*.pre_*' -o -name '.DS_Store' \) -not -path 'desktop/backup/*' -not -path '*/node_modules/*' 2>/dev/null)
[ "${#FOUND[@]}" -eq 0 ] && { echo "✅ لا شيء للحذف"; exit 0; }
echo "المرشحة للحذف (${#FOUND[@]}) ≈ $((SIZE/1024)) KB:"; printf '  - %s\n' "${FOUND[@]}"
[ "$APPLY" -ne 1 ] && { echo; echo "عرض فقط. للحذف: bash clean.sh --apply"; exit 0; }
BK="../securecasedesk-removed-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$BK" "${FOUND[@]}"; echo "💾 نسخة احتياطية: $BK"
rm -f -- "${FOUND[@]}"; echo "✅ حُذف ${#FOUND[@]} ملف"
(cd desktop/backup && sha256sum -c SecureCaseDesk-original.zip.sha256 || true)
