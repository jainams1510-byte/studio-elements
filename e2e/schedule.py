"""Browser test of the schedule (setup, critical path, editing, baseline, timeline, flags) and the backup,
against a stand-in server.

Run:  npm run build && npx vite preview --port 4173 --strictPort &
      python3 e2e/schedule.py
The stand-in keeps everything in memory and answers the requests the app sends to Supabase.
The expected finish dates are worked out here in Python, independently of the app's own engine.
No real data is touched.
"""
import json, re, sys, zipfile
from playwright.sync_api import sync_playwright, expect
from standin import *  # noqa: F403  (stand-in server, check(), results, helpers)
from standin import results

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
    errors = []

    # ------------------------------------------------------------------ owner, phone size
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, accept_downloads=True)
    store = Store("owner")
    ctx.route(re.compile(re.escape(API) + ".*"), handler(store))
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    sign_in(page)

    page.goto(APP + f"#/project/{PROJECT}/schedule")
    expect(page.get_by_role("heading", name="Set up the schedule")).to_be_visible()
    page.get_by_label("Schedule starts on").fill(START.isoformat())
    check("template defaults to the project's stage (3)", page.get_by_label("From stage").input_value() == "3")
    page.get_by_role("button", name="Create schedule").click()
    expect(page.get_by_text("Forecast finish")).to_be_visible()

    rows = list(store.tasks.values())
    check("schedule saved Mon-Sat from the chosen date", store.schedules[PROJECT]["work_days"] == [1, 2, 3, 4, 5, 6]
          and store.schedules[PROJECT]["start_date"] == START.isoformat())
    check("tasks start at stage 3 with no links to earlier stages",
          min(t["stage"] for t in rows) == 3 and all(a in store.tasks for t in rows for a in t["after_ids"]), f"{len(rows)} tasks")

    exp = expected_finish(rows)
    check("forecast finish matches an independent longest-path count", forecast_text(page) == label(exp), f"{forecast_text(page)} vs {label(exp)}")
    strip = page.get_by_role("list", name="Critical path")
    check("critical path strip shows Joinery drawings", strip.get_by_text("Joinery drawings").count() == 1)
    check("critical path strip leaves out HVAC drawings", strip.get_by_text("HVAC drawings").count() == 0)
    hvac_row = page.locator("li.task", has_text="HVAC drawings")
    check("HVAC drawings shows its spare days (8 - 2 = 6)", "6d spare" in hvac_row.inner_text(), hvac_row.inner_text().replace("\n", " | "))
    expect(page.get_by_text("Not frozen").first).to_be_visible()

    # Edit a critical task: +2 working days moves the finish by 2 working days.
    page.locator("li.task", has_text="Joinery drawings").get_by_role("button", name=re.compile("^Joinery drawings")).click()
    page.get_by_role("spinbutton", name="Working days").fill("10")
    page.get_by_role("button", name="Save").click()
    expect(page.get_by_role("heading", name="Edit task")).to_have_count(0)
    exp2 = expected_finish(list(store.tasks.values()))
    check("lengthening a critical task moves the finish", forecast_text(page) == label(exp2) and exp2 > exp,
          f"{label(exp)} -> {forecast_text(page)} (expected {label(exp2)})")

    # A loop is refused before it is saved: the editor does not offer it.
    page.locator("li.task", has_text="Electrical drawings").get_by_role("button", name=re.compile("^Electrical drawings")).click()
    options = page.get_by_label("Add an After task").locator("option").all_inner_texts()
    check("the After list does not offer a task that would make a loop", not any("All sheets at R0" in o for o in options))
    page.get_by_role("button", name="Cancel").click()

    # Freeze the baseline.
    page.get_by_role("button", name="Freeze baseline").click()
    page.get_by_role("button", name="Freeze", exact=True).click()
    expect(page.get_by_text(re.compile("^Frozen"))).to_be_visible()
    plan = store.schedules[PROJECT]["baseline_plan"]
    check("baseline plan holds every task", plan is not None and set(plan) == set(store.tasks), f"{len(plan or {})} of {len(store.tasks)}")
    check("baseline finish equals the forecast at freeze", max(v["end"] for v in plan.values()) == exp2.isoformat())

    # After the freeze a duration change needs a reason.
    page.locator("li.task", has_text="Joinery drawings").get_by_role("button", name=re.compile("^Joinery drawings")).click()
    page.get_by_role("spinbutton", name="Working days").fill("12")
    page.get_by_role("button", name="Save").click()
    expect(page.get_by_text("The baseline is frozen. Say why the schedule changes.")).to_be_visible()
    check("no change was sent without a reason", task_by_name(store, "Joinery drawings")["duration"] == 10)
    page.get_by_label("Why the schedule changes (kept in the change log)").fill("Client added a study unit")
    page.get_by_role("button", name="Save").click()
    expect(page.get_by_role("heading", name="Edit task")).to_have_count(0)
    sent = [b for t, b in store.patches if t == "tasks" and b.get("duration") == 12]
    check("the change was sent with its reason", bool(sent) and sent[-1].get("change_reason") == "Client added a study unit")
    slip = page.locator(".slip").inner_text().strip()
    check("summary shows +2d against the baseline", slip == "+2d", slip)
    page.get_by_text(re.compile(r"^Change log")).click()
    check("change log lists the reason", page.get_by_text("Client added a study unit").count() >= 1)
    check("a 2-day slip tags tasks but raises no flags", page.locator(".flag").count() == 0 and page.get_by_text("Slipped 2d").count() > 5,
          f"{page.locator('.flag').count()} flags")

    # Sheet gate: a task in progress whose sheet is still at P2 is flagged here and on Today.
    page.locator("li.task", has_text="Electrical drawings").get_by_role("button", name=re.compile("^Electrical drawings")).click()
    page.get_by_label("Needs sheet at R0 before starting").select_option("d1")
    page.get_by_role("button", name="Save").click()
    expect(page.get_by_role("heading", name="Edit task")).to_have_count(0)
    page.locator("li.task", has_text="Electrical drawings").get_by_role("button", name="Start today").click()
    expect(page.locator(".flag", has_text="SE-EL-01 is at P2")).to_be_visible()
    check("starting a task sends in_progress", task_by_name(store, "Electrical drawings")["status"] == "in_progress")
    page.get_by_role("button", name="Today", exact=True).click()
    risk = page.locator(".row", has_text="Schedule at risk")
    expect(risk).to_be_visible()
    check("Today flags the schedule risk with the sheet gate", "waiting on a sheet at R0" in risk.inner_text(), risk.inner_text().replace("\n", " | "))
    check("Today says a backup is due", page.get_by_text("Backup due").count() == 1)

    # Backup.
    page.get_by_role("navigation", name="Main").get_by_role("button", name="Projects").click()
    with page.expect_download() as dl:
        page.get_by_role("button", name="Download backup").click()
    path = dl.value.path()
    z = zipfile.ZipFile(path)
    data = json.loads(z.read("data.json"))
    check("backup file is named by date", re.fullmatch(r"studio-elements-backup-\d{4}-\d{2}-\d{2}-\d{4}\.zip", dl.value.suggested_filename) is not None,
          dl.value.suggested_filename)
    check("backup holds every task and the schedule", len(data["tables"]["tasks"]) == len(store.tasks) and len(data["tables"]["project_schedules"]) == 1)
    check("backup holds the photo and voice note bytes",
          z.read(f"media/{PROJECT}/l1/voice.webm") == b"VOICE" and z.read(f"media/{PROJECT}/l1/ph1.jpg") == b"\xff\xd8JPEG")
    expect(page.get_by_text(re.compile("^Saved:"))).to_be_visible()
    check("backup is recorded so Today stops asking", len(store.backups) == 1)
    ctx.close()

    # ------------------------------------------------------------------ owner, laptop: timeline
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.route(re.compile(re.escape(API) + ".*"), handler(store))
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    sign_in(page)
    page.goto(APP + f"#/project/{PROJECT}/timeline")
    expect(page.get_by_role("heading", name="Timeline")).to_be_visible()
    live = [t for t in store.tasks.values() if not t["removed_at"]]
    bars = page.locator('.gantt-chart svg rect[rx="2"]:not([fill="none"])').count()
    diamonds = page.locator(".gantt-chart svg rect[transform]").count()
    check("one bar per task and one diamond per milestone",
          bars == sum(1 for t in live if not t["milestone"]) and diamonds == sum(1 for t in live if t["milestone"]), f"{bars} bars, {diamonds} diamonds")
    check("baseline lines drawn for frozen tasks", page.locator(".gantt-chart svg line[stroke-width='1.5']").count() >= len(live))
    check("no arrows until a task is selected", page.locator(".gantt-chart svg path[marker-end]").count() == 0)
    page.locator(".gantt-name", has_text="All sheets at R0").click()
    gate = task_by_name(store, "All sheets at R0")
    succs = [t for t in live if gate["id"] in t["after_ids"]]
    arrows = page.locator(".gantt-chart svg path[marker-end]").count()
    check("selecting a task draws arrows to its links only", arrows == len(gate["after_ids"]) + len(succs), f"{arrows} arrows")
    page.get_by_role("button", name="Edit task").click()
    expect(page.locator(".timeline-panel").get_by_role("heading", name="Edit task")).to_be_visible()
    check("editing opens beside the timeline on a laptop", True)
    page.screenshot(path="/tmp/timeline.png", full_page=True)
    ctx.close()

    # ------------------------------------------------------------------ coordinator
    store.role = "coordinator"
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    ctx.route(re.compile(re.escape(API) + ".*"), handler(store))
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    sign_in(page)
    page.goto(APP + f"#/project/{PROJECT}/schedule")
    expect(page.get_by_text("Forecast finish")).to_be_visible()
    check("coordinator sees no re-baseline button", page.get_by_role("button", name="Re-baseline").count() == 0)
    check("coordinator is told only an owner can freeze", page.get_by_text("Only an owner can freeze or re-baseline.").count() == 1)
    page.locator("li.task", has_text="HVAC drawings").get_by_role("button", name=re.compile("^HVAC drawings")).click()
    check("coordinator gets no Remove option", page.get_by_role("button", name="Remove this task").count() == 0)
    page.get_by_role("navigation", name="Main").get_by_role("button", name="Projects").click()
    check("coordinator sees no backup card", page.get_by_role("button", name="Download backup").count() == 0)
    page.goto(APP + f"#/project/{PROJECT}/schedule")
    page.screenshot(path="/tmp/schedule-phone.png", full_page=True)
    ctx.close()

    check("no script errors in the page", not errors, "; ".join(errors[:3]))
    browser.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
