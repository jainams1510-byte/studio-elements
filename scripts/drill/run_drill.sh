#!/usr/bin/env bash
# Restore drill: build database A from supabase/001..006, fill every table through the app's rules,
# export it in the backup format, restore into an empty database B, and compare every table.
# Needs PostgreSQL 16 server binaries (/usr/lib/postgresql/16/bin) and a 'postgres' system user.
set -euo pipefail
cd "$(dirname "$0")/../.."
PG=/usr/lib/postgresql/16/bin; DIR=/tmp/pgdrill; PORT=5499
PSQL="psql -h $DIR -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
if ! pg_isready -h $DIR -p $PORT >/dev/null 2>&1; then
  rm -rf $DIR && mkdir -p $DIR && chown postgres $DIR
  su postgres -c "$PG/initdb -D $DIR/data -A trust -U postgres >$DIR/init.log && $PG/pg_ctl -D $DIR/data -o '-p $PORT -k $DIR' -l $DIR/log.txt start >/dev/null"
  sleep 2
fi
for db in drill_a drill_b; do
  $PSQL -d postgres -c "drop database if exists $db" -c "create database $db"
  $PSQL -d $db -f scripts/drill/bootstrap.sql
  for f in supabase/00[1-9]_*.sql; do $PSQL -d $db -f "$f" >/dev/null; done
done
$PSQL -d drill_a -f scripts/drill/seed.sql
python3 - <<'PY'
import sys; sys.path.insert(0, 'scripts')
from restore_check import ORDER
parts = ",\n".join(f"'{t}',(select coalesce(json_agg(t),'[]') from public.{t} t)" for t in ORDER)
open('/tmp/pgdrill/export.sql', 'w').write(f"select json_build_object('format','studio-elements-backup','version',1,'exported_at',now(),'files','[]'::json,'tables',json_build_object({parts}));")
PY
psql -h $DIR -p $PORT -U postgres -d drill_a -Atf $DIR/export.sql > $DIR/data.json
python3 scripts/restore_check.py $DIR/data.json --sql $DIR/restore.sql
# A restore needs the sign-in accounts to exist first (in Supabase they are re-invited by email).
$PSQL -d drill_b -c "insert into auth.users (id, email) values ('5ed9d262-a672-4844-996b-7e8de37fa9da','owner@example.com'),('1fd9ffad-cfc4-44d1-ac2f-14f4318cf0d2','studio@example.com')"
$PSQL -d drill_b -f $DIR/restore.sql >/dev/null
python3 scripts/drill/compare.py
python3 scripts/drill/access_check.py
