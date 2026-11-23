#!/usr/bin/env python3
"""Check a Studio Elements backup and (optionally) write the SQL that restores it.

Usage:
  python3 scripts/restore_check.py studio-elements-backup-2026-11-23-0905.zip
  python3 scripts/restore_check.py backup.zip --sql restore.sql

What it checks:
  - the file is a Studio Elements backup (format and version)
  - every expected table is present (owner-only tables appear only in an owner's backup)
  - links between records resolve (e.g. every site log's project exists)
  - every photo, voice note and deck image a record points to is inside media/ (or listed as missing)

The restore SQL (for a fresh Supabase project that already has supabase/001..006 applied and the
same users created in Authentication > Users with the same ids):
  - loads tables parents first, with the app's own rules (triggers) switched off per table so that
    who-made-what and the timestamps are kept exactly
  - converts types inside Postgres (jsonb_populate_recordset), skipping generated columns
  - runs as one transaction: it either all loads or nothing does
"""
import argparse
import json
import sys
import zipfile

# Parents before children; must match src/backup.ts BACKUP_TABLES.
ORDER = [
    "profiles", "projects", "site_logs", "site_log_photos", "site_log_ai", "site_log_reviews",
    "drawings", "drawing_revisions", "drawing_issues", "weekly_reports", "project_schedules", "tasks",
    "schedule_changes", "backup_log", "vendors", "project_briefs", "quotes", "work_orders", "boq_items",
    "ra_bills", "ra_bill_lines", "decisions", "variations", "procurement_items", "site_visits",
    "project_decks", "studio_settings", "project_fees", "fee_proposals", "fee_invoices", "studio_costs",
    "studio_private",
]
OWNER_ONLY = {"project_fees", "fee_proposals", "fee_invoices", "studio_costs", "studio_private"}
PKEY = {"project_schedules": "project_id", "project_briefs": "project_id", "project_decks": "project_id",
        "project_fees": "project_id", "fee_proposals": "project_id", "site_log_ai": "log_id"}

# child table, column, parent table, parent key
LINKS = [
    ("site_logs", "project_id", "projects", "id"), ("site_log_photos", "log_id", "site_logs", "id"),
    ("site_log_ai", "log_id", "site_logs", "id"), ("site_log_reviews", "log_id", "site_logs", "id"),
    ("site_log_reviews", "reviewer_id", "profiles", "id"), ("drawings", "project_id", "projects", "id"),
    ("drawing_revisions", "drawing_id", "drawings", "id"), ("drawing_issues", "revision_id", "drawing_revisions", "id"),
    ("weekly_reports", "project_id", "projects", "id"), ("project_schedules", "project_id", "projects", "id"),
    ("tasks", "project_id", "projects", "id"), ("tasks", "gate_drawing_id", "drawings", "id"),
    ("schedule_changes", "project_id", "projects", "id"), ("project_briefs", "project_id", "projects", "id"),
    ("quotes", "project_id", "projects", "id"), ("quotes", "vendor_id", "vendors", "id"),
    ("work_orders", "project_id", "projects", "id"), ("work_orders", "vendor_id", "vendors", "id"),
    ("work_orders", "quote_id", "quotes", "id"), ("boq_items", "project_id", "projects", "id"),
    ("boq_items", "work_order_id", "work_orders", "id"), ("ra_bills", "project_id", "projects", "id"),
    ("ra_bills", "vendor_id", "vendors", "id"), ("ra_bills", "work_order_id", "work_orders", "id"),
    ("ra_bill_lines", "bill_id", "ra_bills", "id"), ("ra_bill_lines", "boq_item_id", "boq_items", "id"),
    ("decisions", "project_id", "projects", "id"), ("decisions", "drawing_id", "drawings", "id"),
    ("decisions", "boq_item_id", "boq_items", "id"), ("decisions", "task_id", "tasks", "id"),
    ("decisions", "source_log_id", "site_logs", "id"), ("variations", "project_id", "projects", "id"),
    ("variations", "decision_id", "decisions", "id"), ("variations", "boq_item_id", "boq_items", "id"),
    ("procurement_items", "project_id", "projects", "id"), ("procurement_items", "task_id", "tasks", "id"),
    ("procurement_items", "vendor_id", "vendors", "id"), ("site_visits", "project_id", "projects", "id"),
    ("project_decks", "project_id", "projects", "id"), ("project_fees", "project_id", "projects", "id"),
    ("fee_proposals", "project_id", "projects", "id"), ("fee_invoices", "project_id", "projects", "id"),
    ("fee_invoices", "task_id", "tasks", "id"), ("studio_costs", "project_id", "projects", "id"),
    ("studio_costs", "vendor_id", "vendors", "id"),
]


def load(path):
    if path.endswith(".json"):
        return json.load(open(path, encoding="utf-8")), None
    z = zipfile.ZipFile(path)
    return json.loads(z.read("data.json")), z


def referenced_files(tables):
    out = set()
    for r in tables.get("site_logs", []):
        if r.get("audio_path"):
            out.add(r["audio_path"])
    for r in tables.get("site_log_photos", []):
        if r.get("path"):
            out.add(r["path"])
    for r in tables.get("drawing_issues", []):
        if r.get("print_photo_path"):
            out.add(r["print_photo_path"])
    for r in tables.get("studio_settings", []):
        if r.get("logo_path"):
            out.add(r["logo_path"])
    for r in tables.get("project_decks", []):
        if r.get("key_plan_path"):
            out.add(r["key_plan_path"])
        for s in r.get("slides") or []:
            out.update(p for p in (s.get("slots") or {}).values() if p)
    return out


def check(data, z):
    problems, notes = [], []
    if data.get("format") != "studio-elements-backup":
        problems.append("Not a Studio Elements backup (format field missing or wrong).")
        return problems, notes
    if data.get("version") != 1:
        problems.append(f"Unknown backup version {data.get('version')}.")
    tables = data.get("tables", {})
    for t in ORDER:
        if t not in tables:
            (notes if t in OWNER_ONLY else problems).append(f"Table {t} is missing" + (" (owner-only: made by a non-owner?)" if t in OWNER_ONLY else "."))
    unknown = sorted(set(tables) - set(ORDER))
    if unknown:
        problems.append(f"Tables this script does not know (update ORDER): {', '.join(unknown)}")
    for child, col, parent, key in LINKS:
        keys = {r.get(key) for r in tables.get(parent, [])}
        bad = [r for r in tables.get(child, []) if r.get(col) and r.get(col) not in keys]
        if bad:
            problems.append(f"{len(bad)} {child} row(s) point to a missing {parent} via {col}.")
    for r in tables.get("tasks", []):
        missing = [a for a in r.get("after_ids") or [] if a not in {t["id"] for t in tables.get("tasks", [])}]
        if missing:
            problems.append(f"Task {r.get('name')!r} links to {len(missing)} missing task(s).")
    refs = referenced_files(tables)
    if z is not None:
        names = set(z.namelist())
        listed_missing = set()
        if "missing-files.txt" in names:
            listed_missing = {l.strip() for l in z.read("missing-files.txt").decode().splitlines() if l.strip()}
        absent = sorted(p for p in refs if f"media/{p}" not in names and p not in listed_missing)
        if absent:
            problems.append(f"{len(absent)} referenced file(s) are not in the ZIP: {', '.join(absent[:5])}")
        if listed_missing:
            notes.append(f"{len(listed_missing)} file(s) were already missing in storage when the backup was made.")
    else:
        notes.append(f"{len(refs)} media files are referenced; a data.json alone does not contain them.")
    return problems, notes


def restore_sql(data):
    tables = data["tables"]
    out = [
        "-- Studio Elements restore, generated by scripts/restore_check.py",
        f"-- Backup made {data.get('exported_at')}. Run in the SQL editor of a fresh project after supabase/001..006,",
        "-- with the same users created first (profiles rows link to auth users by id).",
        "begin;",
        "create or replace function pg_temp.restore_rows(tbl text, rows jsonb) returns integer language plpgsql as $$",
        "declare cols text; n integer;",
        "begin",
        "  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols",
        "    from information_schema.columns",
        "   where table_schema = 'public' and table_name = tbl and is_generated = 'NEVER';",
        "  execute format('alter table public.%I disable trigger user', tbl);",
        "  execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_recordset(null::public.%1$I, $1)', tbl, cols) using rows;",
        "  get diagnostics n = row_count;",
        "  execute format('alter table public.%I enable trigger user', tbl);",
        "  return n;",
        "end $$;",
    ]
    for t in ORDER:
        rows = tables.get(t)
        if not rows:
            continue
        if t in ("profiles", "studio_settings", "studio_private"):
            # Created automatically in a fresh project (profiles when users are added; the settings rows by
            # the setup scripts): replace them with the backed-up rows.
            out.append(f"delete from public.{t};")
        payload = json.dumps(rows, ensure_ascii=False).replace("$restore$", "")
        out.append(f"select pg_temp.restore_rows('{t}', $restore${payload}$restore$::jsonb);")
    out.append("commit;")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("backup", help="backup .zip (or data.json)")
    ap.add_argument("--sql", help="write restore SQL to this file")
    a = ap.parse_args()
    data, z = load(a.backup)
    problems, notes = check(data, z)
    tables = data.get("tables", {})
    print(f"Backup made {data.get('exported_at')}")
    for t in ORDER:
        if t in tables:
            print(f"  {t:20s} {len(tables[t]):6d}")
    for n in notes:
        print("NOTE  " + n)
    for p in problems:
        print("PROBLEM  " + p)
    if a.sql and problems:
        print("Restore SQL not written: fix the problems above first.")
    elif a.sql:
        open(a.sql, "w", encoding="utf-8").write(restore_sql(data))
        print(f"Restore SQL written to {a.sql}")
    print("OK" if not problems else f"{len(problems)} problem(s)")
    sys.exit(0 if not problems else 1)


if __name__ == "__main__":
    main()
