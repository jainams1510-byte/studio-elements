"""Stand-in Supabase server and helpers shared by the schedule and phone-layout browser tests."""
import base64, datetime as dt, io, json, re, sys, time, uuid, zipfile
from urllib.parse import urlparse, parse_qs, unquote
from playwright.sync_api import sync_playwright, expect

APP = __import__("os").environ.get("APP_URL", "http://localhost:4173/")
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
        # Any other table: rows kept here by table name (see generic_table below).
        self.tables = {}
        self.role_name = "jainam"

    def table(self, name):
        return self.tables.setdefault(name, {})

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
        if "/storage/v1/object/" in url and method in ("POST", "PUT") and "/sign/" not in url:
            path = unquote(re.split(r"/storage/v1/object/(?:authenticated/)?site-media/", url)[1].split("?")[0])
            store.files[path] = req.post_data_buffer or b""
            return route.fulfill(status=200, headers=hdr, body=json.dumps({"Key": "site-media/" + path}))
        if "/storage/v1/object/sign/site-media" in url and method == "POST":
            data = json.loads(req.post_data or "{}")
            paths = data.get("paths") or ([url.split("/sign/site-media/")[1].split("?")[0]] if "/sign/site-media/" in url else [])
            signed = [{"path": p_, "signedURL": f"/object/sign/site-media/{p_}?token=t", "error": None} for p_ in paths]
            return route.fulfill(status=200, headers=hdr, body=json.dumps(signed if data.get("paths") else {"signedURL": signed[0]["signedURL"]}))
        if table:
            return generic_table(store, route, req, table, method, f, body, single, hdr)
        return route.fulfill(status=404, headers=hdr, body=json.dumps({"message": f"not mocked: {method} {url}"}))
    return handle


# Primary keys of the per-project and single-row tables (everything else uses "id").
PKEYS = {"project_briefs": "project_id", "project_fees": "project_id", "fee_proposals": "project_id",
         "project_decks": "project_id", "studio_settings": "id", "studio_private": "id", "site_log_ai": "log_id"}
DEFAULTS = {
    "studio_settings": {"name": "Studio Elements", "tagline": "Architecture · Interior Design · Project Management",
                        "website": "www.studioelements.in", "email": "info@studioelements.in", "phone": "+91 8511357002",
                        "gstin": "", "logo_path": None, "clauses": {}},
    "studio_private": {"opening_cash": 0},
}


def generic_table(store, route, req, table, method, f, body, single, hdr):
    """A small in-memory PostgREST: eq/is filters, insert (one or many, upsert), update by filter.
    It does not run database rules; tests that need a rule should check the request instead."""
    rows = store.table(table)
    if table in DEFAULTS and 1 not in rows:
        rows[1] = {"id": 1, **DEFAULTS[table]}
    pk = PKEYS.get(table, "id")
    prefer = req.headers.get("prefer") or ""
    wants = "return=representation" in prefer

    def out(lst, status=200):
        if single:
            if not lst:
                return route.fulfill(status=406 if method != "GET" else 200, headers=hdr, body="null" if method == "GET" else json.dumps({"code": "PGRST116", "message": "no rows"}))
            return route.fulfill(status=status, headers=hdr, body=json.dumps(lst[0]))
        return route.fulfill(status=status, headers=hdr, body=json.dumps(lst))

    if method == "GET":
        return out([r for r in rows.values() if matches(r, f)])
    if method == "POST":
        items = body if isinstance(body, list) else [body]
        saved = []
        for it in items:
            key = it.get(pk) if pk in it else (str(uuid.uuid4()) if pk == "id" else None)
            if key in rows and "resolution=merge-duplicates" not in prefer:
                if "resolution=ignore-duplicates" in prefer:
                    continue
                return route.fulfill(status=409, headers=hdr, body=json.dumps({"code": "23505", "message": "duplicate key value violates unique constraint"}))
            row = {**rows.get(key, {"removed_at": None, "created_at": "2026-11-23T08:00:00Z"}), **it, pk: key}
            rows[key] = row
            saved.append(row)
        return out(saved, 201) if wants else route.fulfill(status=201, headers=hdr, body="")
    if method == "PATCH":
        hit = [r for r in rows.values() if matches(r, f)]
        for r in hit:
            r.update(body or {})
        return out(hit) if wants else route.fulfill(status=204, headers={**hdr})
    return route.fulfill(status=405, headers=hdr, body=json.dumps({"message": "method not allowed"}))


# ---- phone layout checks shared by browser tests ----------------------------------------------
FIND_OVERFLOW = """() => {
  const W = document.documentElement.clientWidth
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.right <= W + 1) continue
    let p = el.parentElement, contained = false
    while (p && p !== document.body) {
      const ox = getComputedStyle(p).overflowX
      if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') && p.getBoundingClientRect().right <= W + 1) { contained = true; break }
      p = p.parentElement
    }
    if (!contained) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} right=${Math.round(r.right)}`)
  }
  return { W, inner: window.innerWidth, scroll: document.documentElement.scrollWidth, out: out.slice(0, 6) }
}"""

SMALL_INPUTS = """() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=file]):not([type=radio]), select, textarea')]
  .filter(e => e.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(e).fontSize) < 16)
  .map(e => `${e.tagName.toLowerCase()} ${e.getAttribute('aria-label') || e.name || ''} ${getComputedStyle(e).fontSize}`)"""


def fits_phone(page, name, width):
    """Check the current screen fits a phone of this width and has no text box under 16 px."""
    page.wait_for_timeout(250)
    m = page.evaluate(FIND_OVERFLOW)
    ok = m["inner"] <= width and m["scroll"] <= width and not m["out"]
    check(f"{width}px  {name}: fits the screen", ok, "" if ok else f"inner {m['inner']}, scroll {m['scroll']}, {m['out']}")
    small = page.evaluate(SMALL_INPUTS)
    check(f"{width}px  {name}: text boxes 16 px or more", not small, "; ".join(small[:3]))


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


