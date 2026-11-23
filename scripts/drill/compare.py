import subprocess, sys
sys.path.insert(0, '/home/claude/studio-elements/scripts')
from restore_check import ORDER, PKEY
def q(db, sql):
    return subprocess.run(['psql','-h','/tmp/pgdrill','-p','5499','-U','postgres','-d',db,'-Atc',sql],capture_output=True,text=True,check=True).stdout.strip()
bad = 0
for t in ORDER:
    k = PKEY.get(t, 'id')
    sql = f"select count(*)||' '||coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by x.{k})),'-') from public.{t} x"
    a, b = q('drill_a', sql), q('drill_b', sql)
    ok = a == b
    bad += not ok
    print(('SAME ' if ok else 'DIFF ') + f"{t:20s} {a.split()[0]:>4} rows" + ('' if ok else f'  A={a} B={b}'))
print(f"\n{len(ORDER)-bad}/{len(ORDER)} tables identical after restore")
sys.exit(1 if bad else 0)
