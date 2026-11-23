"""Browser test of the schedule (setup, critical path, editing, baseline, timeline, flags) and the backup,
against a stand-in server.

Run:  npm run build && npx vite preview --port 4173 --strictPort &
      python3 e2e/schedule.py
The stand-in keeps everything in memory and answers the requests the app sends to Supabase.
The expected finish dates are worked out here in Python, independently of the app's own engine.
No real data is touched.
"""
import base64, datetime as dt, io, json, re, sys, time, uuid, zipfile
from urllib.parse import urlparse, parse_qs, unquote
from playwright.sync_api import sync_playwright, expect

APP = "http://localhost:4173/"
API = "https://obwkpheueqecifmeaqyc.supabase.co"
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"}
PROJECT = "11111111-1111-4111-8111-111111111111"
START = dt.date(2026, 12, 7)  # a Monday, after today, so "today" never moves the plan
TODAY = dt.date.today()

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS  " if ok else "FAIL  ") + name + (f"  [{detail}]" if detail else ""))


def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def fake_session():
    now = int(time.time())
    token = f"{b64({'alg': 'HS256', 'typ': 'JWT'})}.{b64({'sub': 'user-1', 'role': 'authenticated', 'exp': now + 3600})}.sig"
    user = {"id": "user-1", "aud": "authenticated", "role": "authenticated", "email": "team@example.com",
            "app_metadata": {}, "user_metadata": {}, "created_at": "2026-11-15T00:00:00Z"}
    return {"access_token": token, "token_type": "bearer", "expires_in": 3600, "expires_at": now + 3600,
            "refresh_token": "refresh-1", "user": user}


# ---- independent working-day arithmetic (Mon-Sat) ---------------------------------------------
def workdays_from(start):
    d = start
    while True:
        if d.weekday() != 6:
            yield d
        d += dt.timedelta(days=1)


def nth_workday(start, n):
    for i, d in enumerate(workdays_from(start)):
        if i == n:
            return d


def expected_finish(tasks):
    """Longest path in working days over the stored tasks, by plain recursion."""
    live = {t["id"]: t for t in tasks if not t.get("removed_at")}
    memo = {}

    def finish(tid):
        if tid not in memo:
            t = live[tid]
            start = max([0] + [finish(p) for p in t["after_ids"] if p in live])
            memo[tid] = start + t["duration"]
        return memo[tid]

    return nth_workday(START, max(finish(t) for t in live) - 1)


def label(d):
    return f"{d.day} {d.strftime('%b')}"


# ---- stand-in server -----------------------------------------------------------------------------
class Store:
    def __init__(self, role):
        self.role = role
        self.projects = {PROJECT: {"id": PROJECT, "name": "Sparsh Ekaya", "code": "SE", "stage": 3, "archived": False,
                                   "rooms": ["Living", "Kitchen"], "trades": ["Carpentry", "Electrical", "Civil"]}}
        self.schedules = {}
        self.tasks = {}
        self.changes = []
        self.backups = []
        self.drawings = {"d1": {"id": "d1", "project_id": PROJECT, "number": "SE-EL-01", "title": "Electrical layout",
                                "discipline": "Electrical", "archived": False,
                                "drawing_revisions": [{"id": "r1", "code": "P2", "rank": 2, "revised_on": "2026-11-20", "note": "",
                                                       "file_link": None, "created_at": "2026-11-20T10:00:00Z", "drawing_issues": []}]}}
        self.site_logs = [{"id": "l1", "project_id": PROJECT, "note": "Slab check", "audio_path": f"{PROJECT}/l1/voice.webm", "removed_at": None}]
        self.photos = [{"id": "ph1", "log_id": "l1", "path": f"{PROJECT}/l1/ph1.jpg", "removed_at": None}]
        self.files = {f"{PROJECT}/l1/voice.webm": b"VOICE", f"{PROJECT}/l1/ph1.jpg": b"\xff\xd8JPEG"}
        self.patches = []

    def frozen(self):
        s = self.schedules.get(PROJECT)
        return bool(s and s["baseline_at"])


def filters(url):
    out = {}
    for k, v in parse_qs(urlparse(url).query).items():
        val = v[0]
        if val.startswith("eq."):
            raw = unquote(val[3:])
            out[k] = {"true": True, "false": False}.get(raw, raw)
        elif val == "is.null":
            out[k] = None
    return out


def matches(row, f):
    return all(row.get(k) == v for k, v in f.items())


def handler(store):
    def handle(route):
        req = route.request
        url, method = req.url, req.method
        hdr = {**CORS, "content-type": "application/json"}
        if method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        if "/auth/v1/token" in url:
            return route.fulfill(status=200, headers=hdr, body=json.dumps(fake_session()))
        if "/auth/v1/user" in url:
            return route.fulfill(status=200, headers=hdr, body=json.dumps(fake_session()["user"]))
        single = "vnd.pgrst.object" in (req.headers.get("accept") or "")

        def reply(rows, status=200):
            if single:
                return route.fulfill(status=status, headers=hdr, body=json.dumps(rows[0]) if rows else "null")
            return route.fulfill(status=status, headers=hdr, body=json.dumps(rows))

        def fail(message, code="P0001", status=400):
            return route.fulfill(status=status, headers=hdr, body=json.dumps({"code": code, "message": message}))

        m = re.search(r"/rest/v1/(\w+)", url)
        table = m.group(1) if m else None
        f = filters(url)
        select = parse_qs(urlparse(url).query).get("select", [""])[0]
        body = json.loads(req.post_data) if ("/rest/v1/" in url and method in ("POST", "PATCH") and req.post_data) else None

        if table == "profiles":
            return reply([{"id": "user-1", "full_name": "jainam", "role": store.role}])
        if table == "projects" and method == "GET":
            return reply([p for p in store.projects.values() if matches(p, f)])
        if table == "drawings" and method == "GET":
            return reply([d for d in store.drawings.values() if matches(d, f)])
        if table == "project_schedules":
            if method == "GET":
                return reply([s for s in store.schedules.values() if matches(s, f)])
            if method == "POST":
                s = {"work_days": [1, 2, 3, 4, 5, 6], "holidays": [], "baseline_at": None, "baseline_by": None, "baseline_plan": None, **body}
                s.pop("change_reason", None)
                store.schedules[s["project_id"]] = s
                return route.fulfill(status=201, headers=hdr, body="")
            if method == "PATCH":
                s = store.schedules[f["project_id"]]
                store.patches.append(("project_schedules", body))
                if "baseline_plan" in body:
                    if store.role != "owner":
                        return fail("Only an owner can freeze or re-baseline the schedule.", "42501", 403)
                    if s["baseline_at"] and not (body.get("change_reason") or "").strip():
                        return fail("Give a reason for re-baselining.")
                    s["baseline_at"] = "2026-11-23T08:00:00Z"
                    s["baseline_by"] = "user-1"
                    s["baseline_plan"] = body["baseline_plan"]
                    for t in store.tasks.values():
                        plan = body["baseline_plan"].get(t["id"])
                        t["baseline_start"], t["baseline_end"] = (plan["start"], plan["end"]) if plan else (None, None)
                    store.changes.append({"id": str(uuid.uuid4()), "task_id": None, "kind": "baseline", "before": None,
                                          "after": {"tasks": len(body["baseline_plan"])}, "reason": None, "changed_by": "user-1",
                                          "changed_at": "2026-11-23T08:00:00Z"})
                for k in ("start_date", "work_days", "holidays"):
                    if k in body:
                        s[k] = body[k]
                return route.fulfill(status=204, headers=CORS)
        if table == "tasks":
            if method == "GET":
                rows = sorted([t for t in store.tasks.values() if matches(t, f)], key=lambda t: (t["stage"], t["sort_order"]))
                return reply(rows)
            if method in ("POST", "PATCH"):
                rows = body if isinstance(body, list) else [body]
                if method == "PATCH":
                    old = store.tasks[f["id"]]
                    store.patches.append(("tasks", body))
                    sched_change = ("duration" in body and body["duration"] != old["duration"]) or \
                                   ("after_ids" in body and body["after_ids"] != old["after_ids"]) or \
                                   ("removed_at" in body and bool(body["removed_at"]) != bool(old["removed_at"]))
                    if "removed_at" in body and store.role != "owner" and bool(body["removed_at"]) != bool(old["removed_at"]):
                        return fail("Only an owner can remove or restore a task.", "42501", 403)
                    if store.frozen() and sched_change and not (body.get("change_reason") or "").strip():
                        return fail("The baseline is frozen. Give a reason for this schedule change.")
                    if store.frozen() and sched_change:
                        store.changes.insert(0, {"id": str(uuid.uuid4()), "task_id": old["id"], "kind": "changed",
                                                 "before": {"name": old["name"], "duration": old["duration"]},
                                                 "after": {"name": old["name"], "duration": body.get("duration", old["duration"])},
                                                 "reason": body["change_reason"], "changed_by": "user-1", "changed_at": "2026-11-23T09:00:00Z"})
                    upd = {k: v for k, v in body.items() if k != "change_reason"}
                    if upd.get("status") == "in_progress" and not upd.get("actual_start"):
                        upd["actual_start"] = TODAY.isoformat()
                    old.update(upd)
                    return route.fulfill(status=204, headers=CORS)
                for r in rows:
                    t = {"room": None, "owner_name": None, "trade": None, "status": "planned", "actual_start": None, "actual_end": None,
                         "gate_drawing_id": None, "baseline_start": None, "baseline_end": None, "removed_at": None, "milestone": False,
                         "after_ids": [], "sort_order": 0, **r}
                    t.pop("change_reason", None)
                    t.pop("template_key", None)
                    store.tasks[t["id"]] = t
                return route.fulfill(status=201, headers=hdr, body="")
        if table == "schedule_changes":
            return reply(store.changes)
        if table == "backup_log":
            if method == "GET":
                return reply(sorted(store.backups, key=lambda b: b["made_at"], reverse=True))
            store.backups.append({"id": str(uuid.uuid4()), "made_at": "2026-11-23T10:00:00Z", **body})
            return route.fulfill(status=201, headers=hdr, body="")
        if table == "site_logs" and method == "GET":
            return reply(store.site_logs if select == "*" else [])
        if table == "site_log_photos" and method == "GET":
            return reply(store.photos)
        if table in ("site_log_ai", "site_log_reviews", "drawing_revisions", "drawing_issues", "weekly_reports") and method == "GET":
            return reply([])
        if "/storage/v1/object/" in url and method == "GET":
            path = unquote(re.split(r"/storage/v1/object/(?:authenticated/)?site-media/", url)[1].split("?")[0])
            if path in store.files:
                return route.fulfill(status=200, headers={**CORS, "content-type": "application/octet-stream"}, body=store.files[path])
            return route.fulfill(status=404, headers=hdr, body=json.dumps({"message": "not found"}))
        return route.fulfill(status=404, headers=hdr, body=json.dumps({"message": f"not mocked: {method} {url}"}))
    return handle


def sign_in(page):
    page.goto(APP)
    page.get_by_label("Email").fill("team@example.com")
    page.get_by_label("Password").fill("x")
    page.get_by_role("button", name="Sign in").click()
    expect(page.get_by_role("heading", name="Today")).to_be_visible()


def task_by_name(store, name):
    return next(t for t in store.tasks.values() if t["name"] == name)


def forecast_text(page):
    return page.locator(".summary-row > div").first.locator("strong").inner_text()


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
