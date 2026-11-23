"""Access test: tries every table as four kinds of user on the drill database (run run_drill.sh first).

  anon         signed out             must not read, add, change or delete anything
  stranger     signed in, no profile  must see nothing and add nothing
  coordinator  team member            reads team tables; owner-only tables look empty and refuse writes
  owner        owner                  reads everything; still cannot delete anything
"""
import subprocess, sys
sys.path.insert(0, 'scripts')
from restore_check import ORDER

OWNER_ONLY = {"project_fees", "fee_proposals", "fee_invoices", "studio_costs", "studio_private"}
USERS = {
    "owner": "5ed9d262-a672-4844-996b-7e8de37fa9da",
    "coordinator": "1fd9ffad-cfc4-44d1-ac2f-14f4318cf0d2",
    "stranger": "99999999-9999-4999-8999-999999999999",
}

def run(role, sql):
    """Run sql as role inside a transaction that always rolls back. Returns (ok, output)."""
    if role == "anon":
        prefix = "set local role anon;"
    else:
        prefix = (f"select set_config('request.jwt.claims', '{{\"sub\":\"{USERS[role]}\",\"role\":\"authenticated\"}}', true);"
                  "set local role authenticated;")
    p = subprocess.run(["psql", "-h", "/tmp/pgdrill", "-p", "5499", "-U", "postgres", "-d", "drill_a", "-At",
                        "-v", "ON_ERROR_STOP=1", "-c", f"begin; {prefix} {sql}; rollback;"],
                       capture_output=True, text=True)
    return p.returncode == 0, (p.stdout + p.stderr).strip()

def count(role, t):
    ok, out = run(role, f"select count(*) from public.{t}")
    lines = [l for l in out.splitlines() if l.strip().isdigit()]
    return int(lines[-1]) if ok and lines else None   # None = refused

def total(t):
    return int(subprocess.run(["psql", "-h", "/tmp/pgdrill", "-p", "5499", "-U", "postgres", "-d", "drill_a", "-Atc",
                               f"select count(*) from public.{t}"], capture_output=True, text=True).stdout)

def changes(role, t):
    """How many rows an update of the table touches (0 if hidden or refused)."""
    ok, out = run(role, f"with u as (update public.{t} set id = id returning 1) select count(*) from u"
                  if t not in PK_OTHER else f"with u as (update public.{t} set {PK_OTHER[t]} = {PK_OTHER[t]} returning 1) select count(*) from u")
    lines = [l for l in out.splitlines() if l.strip().isdigit()]
    return int(lines[-1]) if ok and lines else 0

PK_OTHER = {"project_schedules": "project_id", "project_briefs": "project_id", "project_fees": "project_id",
            "fee_proposals": "project_id", "project_decks": "project_id"}

fails, checks = [], 0
def expect(cond, msg):
    global checks
    checks += 1
    if not cond:
        fails.append(msg)

for t in ORDER:
    n = total(t)
    expect(n > 0, f"{t}: drill data has no rows, so this table is not really tested")
    # Nobody may delete, not even an owner.
    for role in ("anon", "stranger", "coordinator", "owner"):
        ok, out = run(role, f"delete from public.{t}")
        expect(not ok and "permission denied" in out, f"{t}: {role} could delete ({out[-80:]})")
    # Signed out: no reading, no changing.
    expect(count("anon", t) is None, f"{t}: anon can read")
    expect(changes("anon", t) == 0, f"{t}: anon can change rows")
    # Signed in without a profile: sees nothing, changes nothing.
    expect(count("stranger", t) in (None, 0), f"{t}: stranger sees {count('stranger', t)} rows")
    expect(changes("stranger", t) == 0, f"{t}: stranger can change rows")
    # Coordinator and owner.
    if t in OWNER_ONLY:
        expect(count("coordinator", t) in (None, 0), f"{t}: coordinator sees owner-only rows")
        expect(changes("coordinator", t) == 0, f"{t}: coordinator can change owner-only rows")
    else:
        expect(count("coordinator", t) == n, f"{t}: coordinator sees {count('coordinator', t)} of {n} rows")
    expect(count("owner", t) == n, f"{t}: owner sees {count('owner', t)} of {n} rows")

# Owner-only inserts are refused for the coordinator.
pid = subprocess.run(["psql", "-h", "/tmp/pgdrill", "-p", "5499", "-U", "postgres", "-d", "drill_a", "-Atc",
                      "select id from public.projects limit 1"], capture_output=True, text=True).stdout.strip()
for t, sql in {
    "fee_invoices": f"insert into public.fee_invoices (project_id, milestone, amount) values ('{pid}', 'x', 1)",
    "studio_costs": f"insert into public.studio_costs (project_id, category, amount) values ('{pid}', 'Printing', 1)",
}.items():
    ok, out = run("coordinator", sql)
    expect(not ok, f"{t}: coordinator could add a row")
    ok, out = run("stranger", sql.replace(t, t))
    expect(not ok, f"{t}: stranger could add a row")
ok, out = run("stranger", f"insert into public.site_logs (id, project_id, note, logged_at) values (gen_random_uuid(), '{pid}', 'x', now())")
expect(not ok, "site_logs: stranger could add a log")
def after(role, sql, check):
    """Run sql as role, then return what check reads in the same transaction ('' if refused)."""
    ok, out = run(role, f"{sql}; select 'RESULT=' || coalesce(({check})::text, 'null')")
    hits = [l[7:] for l in out.splitlines() if l.startswith("RESULT=")]
    return hits[-1] if ok and hits else ""

expect(after("coordinator", "update public.studio_settings set name = 'Changed'",
             "select name from public.studio_settings") != "Changed",
       "studio_settings: coordinator can change settings")
# Controls: the same changes must work for an owner, or the checks above prove nothing.
expect(after("owner", "update public.studio_settings set name = 'Changed'",
             "select name from public.studio_settings") == "Changed",
       "control failed: owner cannot change settings")
expect(after("coordinator", "update public.projects set name = 'Changed'",
             "select count(*) from public.projects where name = 'Changed'") not in ("", "0"),
       "control failed: coordinator cannot edit a project")
expect(after("coordinator", "update public.profiles set role = 'owner' where id = auth.uid()",
             "select role from public.profiles where id = auth.uid()") != "owner",
       "profiles: coordinator can make themselves owner")
expect(after("coordinator", "update public.ra_bills set certified_amount = 1",
             "select certified_amount from public.ra_bills limit 1") != "1.00",
       "ra_bills: coordinator can change a certified amount")

print(f"{checks - len(fails)}/{checks} access checks passed")
for f in fails:
    print("FAIL  " + f)
sys.exit(1 if fails else 0)
