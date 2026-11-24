#!/usr/bin/env bash
# ينشئ قاعدة بمحرك SQLCipher الرسمي (حزمة sqlcipher في Ubuntu = SQLCipher 4، نفس إعدادات أندرويد) لاختبار التوافق.
set -euo pipefail
OUT="${1:?usage: make-sqlcipher-fixture.sh <dir>}"
KEY="f47ac10b-58cc-4372-a567-0e02b2c3d479"
mkdir -p "$OUT"; rm -f "$OUT/sqlcipher-4.db"
printf '%s' "$KEY" > "$OUT/fixture-key.txt"
sqlcipher "$OUT/sqlcipher-4.db" <<SQL
PRAGMA key = '$KEY';
CREATE TABLE cases (id TEXT PRIMARY KEY, title TEXT NOT NULL, n INTEGER);
INSERT INTO cases VALUES ('1','قضية اعتداء',1),('2','قضية سرقة',2),('3','قضية ٣',3);
CREATE TABLE movements (id INTEGER PRIMARY KEY, t TEXT);
CREATE TRIGGER trg_no_update BEFORE UPDATE ON movements BEGIN SELECT RAISE(ABORT, 'سجل الحركات لا يقبل التعديل'); END;
INSERT INTO movements(t) VALUES ('x');
SQL
sqlcipher --version || true
echo "fixture: $OUT/sqlcipher-4.db"
