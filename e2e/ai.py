"""Browser test of the voice-note review queue and weekly reports, against a stand-in server.

Run:  npm run build && npx vite preview --port 4173 --strictPort &
      python3 e2e/ai.py
The stand-in keeps logs, AI results, reviews and reports in memory and plays the AI
server function. No real data is touched and Gemini is never called.
"""
import base64, datetime, io, json, re, time, uuid
from urllib.parse import urlparse, parse_qs
from PIL import Image
from playwright.sync_api import sync_playwright, expect

APP = "http://localhost:4173/"
API = "https://obwkpheueqecifmeaqyc.supabase.co"
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"}
PROJECT = "proj-1"
ME, OTHER = "user-1", "user-2"
PEOPLE = {ME: {"full_name": "Jainam Shah", "role": "owner"}, OTHER: {"full_name": "Studio Team", "role": "team"}}


def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def fake_session():
    now = int(time.time())
    token = f"{b64({'alg': 'HS256', 'typ': 'JWT'})}.{b64({'sub': ME, 'role': 'authenticated', 'exp': now + 3600})}.sig"
    user = {"id": ME, "aud": "authenticated", "role": "authenticated", "email": "team@example.com",
            "app_metadata": {}, "user_metadata": {}, "created_at": "2026-11-15T00:00:00Z"}
    return {"access_token": token, "token_type": "bearer", "expires_in": 3600, "expires_at": now + 3600,
            "refresh_token": "refresh-1", "user": user}


def week_start():
    d = datetime.date.today()
    return (d - datetime.timedelta(days=d.weekday())).isoformat()


results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS  " if ok else "FAIL  ") + name + (f"  [{detail}]" if detail else ""))


def ai_done(summary):
    return {"status": "done", "language": "Gujarati", "transcript": "રસોડામાં ટાઇલ્સ પૂરી થઈ ગઈ.", "summary": summary,
            "final_summary": summary, "suggested_room": "Kitchen", "suggested_trade": "Tiling", "error": None,
            "updated_at": "2026-11-22T10:00:00Z"}


class Store:
    def __init__(self):
        self.projects = {PROJECT: {"id": PROJECT, "name": "Sparsh Ekaya", "code": "SE", "stage": 3, "rooms": ["Kitchen"],
                                   "trades": ["Tiling"], "archived": False}}
        self.logs = {
            "log-a": {"id": "log-a", "project_id": PROJECT, "note": "", "room": None, "trade": None,
                      "audio_path": f"{PROJECT}/log-a/voice.webm", "logged_at": "2026-11-21T06:00:00Z"},
            "log-b": {"id": "log-b", "project_id": PROJECT, "note": "Plumber came late", "room": None, "trade": None,
                      "audio_path": f"{PROJECT}/log-b/voice.webm", "logged_at": "2026-11-20T06:00:00Z"},
            "log-c": {"id": "log-c", "project_id": PROJECT, "note": "", "room": None, "trade": None,
                      "audio_path": f"{PROJECT}/log-c/voice.webm", "logged_at": "2026-11-19T06:00:00Z"},
        }
        self.ai = {"log-a": ai_done("Kitchen wall tiling finished; grouting tomorrow."),
                   "log-c": {**ai_done(""), "status": "failed", "error": "The AI service is busy. Try again in a minute."}}
        self.reviews = {}  # (log_id, reviewer) -> decision
        self.reports = {}
        self.fn_calls = []
        self.patches = []

    def ai_view(self, log_id):
        a = self.ai.get(log_id)
        if not a:
            return None
        revs = [{"reviewer_id": r, "decision": d, "profiles": PEOPLE[r]} for (l, r), d in self.reviews.items() if l == log_id]
        return {**a, "site_log_reviews": revs}

    def log_view(self, log):
        return {**log, "profiles": {"full_name": "Site Coordinator"}, "site_log_photos": [], "site_log_ai": self.ai_view(log["id"])}


def filters(url):
    out = {}
    for k, v in parse_qs(urlparse(url).query).items():
        if k in ("select", "order", "limit", "columns", "on_conflict"):
            continue
        if v[0].startswith("eq."):
            raw = v[0][3:]
            out[k] = {"true": True, "false": False}.get(raw, raw)
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
        m = re.search(r"/rest/v1/(\w+)", url)
        table = m.group(1) if m else None
        f = filters(url)
        is_json = "/rest/v1/" in url or "/storage/v1/object/sign/" in url or "/functions/v1/" in url
        body = json.loads(req.post_data) if (is_json and method in ("POST", "PATCH") and req.post_data) else None
        rows = lambda r, s=200: route.fulfill(status=s, headers=hdr, body=json.dumps(r))

        if "/functions/v1/ai" in url:
            store.fn_calls.append(body)
            if body["action"] == "transcribe":
                if body["log_id"] == "log-c" and not body.get("force"):
                    return rows({"error": "Already failed; pass force to retry."}, 409)
                store.ai[body["log_id"]] = ai_done(f"Summary for {body['log_id']}.")
                return rows({"status": "done"})
            if body["action"] == "weekly_report":
                saved = []
                for kind in ("client", "internal"):
                    key = (body["project_id"], body["week_start"], kind)
                    old = store.reports.get(key)
                    if old and old["status"] == "approved":
                        continue
                    store.reports[key] = {"id": old["id"] if old else str(uuid.uuid4()), "project_id": body["project_id"],
                                          "week_start": body["week_start"], "kind": kind,
                                          "language": body["language"] if kind == "client" else "English",
                                          "body": f"Sparsh Ekaya: week of {body['week_start']}\n{kind} draft text",
                                          "status": "draft", "approved_at": None, "generated_at": "2026-11-22T12:00:00Z",
                                          "profiles": None}
                    saved.append(kind)
                return rows({"saved": saved, "skipped": [], "awaiting_verification": 1})

        if table == "projects" and method == "GET":
            return rows([p for p in store.projects.values() if matches(p, f)])
        if table == "site_logs" and method == "GET":
            return rows([store.log_view(l) for l in store.logs.values() if matches(l, f)])
        if table == "site_log_reviews" and method == "POST":
            key = (body["log_id"], ME)
            if key in store.reviews:
                return rows({"code": "23505", "message": "duplicate key value"}, 409)
            store.reviews[key] = body["decision"]
            return route.fulfill(status=201, headers=hdr, body="")
        if table == "site_log_reviews" and method == "PATCH":
            store.reviews[(f["log_id"], f["reviewer_id"])] = body["decision"]
            return route.fulfill(status=204, headers=CORS)
        if table == "site_log_ai" and method == "PATCH":
            store.patches.append(("ai", f, body))
            store.ai[f["log_id"]]["final_summary"] = body["final_summary"]
            store.reviews = {k: v for k, v in store.reviews.items() if k[0] != f["log_id"]}  # the trigger
            return route.fulfill(status=204, headers=CORS)
        if table == "weekly_reports" and method == "GET":
            return rows([r for r in store.reports.values() if matches(r, f)])
        if table == "weekly_reports" and method == "PATCH":
            store.patches.append(("report", f, body))
            for r in store.reports.values():
                if matches(r, f):
                    if "body" in body and body["body"] != r["body"] and r["status"] == "approved":
                        r["status"] = "draft"
                    r.update(body)
                    if body.get("status") == "approved":
                        r["profiles"] = {"full_name": PEOPLE[ME]["full_name"]}
            return route.fulfill(status=204, headers=CORS)
        if "/storage/v1/object/sign/site-media" in url and method == "POST":
            return rows([{"path": p, "signedURL": f"/object/sign/site-media/{p}?token=t", "error": None} for p in body.get("paths", [])])
        if method == "GET" and table:
            return rows([])
        if "/storage/v1/object/sign/" in url:
            return route.fulfill(status=200, headers={**CORS, "content-type": "audio/webm"}, body=b"")
        return rows({"message": f"not mocked: {method} {url}"}, 404)
    return handle


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=APP.rstrip("/"))
    store = Store()
    ctx.route(re.compile(re.escape(API) + ".*"), handler(store))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script("delete Navigator.prototype.share")  # exercise the copy fallback

    page.goto(APP)
    page.get_by_label("Email").fill("team@example.com")
    page.get_by_label("Password").fill("x")
    page.get_by_role("button", name="Sign in").click()
    expect(page.get_by_role("heading", name="Today")).to_be_visible()
    expect(page.get_by_text(re.compile(r"voice notes? to review"))).to_be_visible()
    check("Today asks for voice notes to be reviewed", True)
    due = datetime.date.today().weekday() >= 5 or (datetime.date.today().weekday() == 4 and datetime.datetime.now().hour >= 17)
    if due:
        expect(page.get_by_text("Weekly report due")).to_be_visible()
        check("Today shows the weekly report is due (weekend)", True)

    # Review queue: the missing log is sent for transcription on open
    page.get_by_role("button", name="Review", exact=True).click()
    expect(page.get_by_role("heading", name="Review")).to_be_visible()
    expect(page.get_by_text("Summary for log-b.")).to_be_visible(timeout=10000)
    check("a voice note never transcribed is sent once, without force",
          [c for c in store.fn_calls if c["action"] == "transcribe"] == [{"action": "transcribe", "log_id": "log-b", "force": False}],
          str(store.fn_calls))
    page.screenshot(path="/tmp/ai-review.png", full_page=True)

    card_a = page.locator("li.card", has_text="Kitchen wall tiling finished")
    expect(card_a.get_by_text("Needs the coordinator and one team member")).to_be_visible()
    card_a.get_by_role("button", name="Confirm").click()
    expect(card_a.get_by_text("Jainam Shah confirmed")).to_be_visible()
    expect(card_a.get_by_text("Needs one team member")).to_be_visible()
    expect(card_a.get_by_role("button", name="Confirmed")).to_be_disabled()
    check("owner confirmation counts as the senior one; one team member still needed", store.reviews.get(("log-a", ME)) == "confirm")

    card_a.get_by_role("button", name="Reject").click()
    expect(page.locator("li.card", has_text="Kitchen wall tiling finished")).to_have_count(0)
    check("changing your mind updates your own review (insert, then update on duplicate)", store.reviews.get(("log-a", ME)) == "reject")
    page.get_by_role("button", name=re.compile(r"Show \d+ finished")).click()
    expect(page.locator("li.card", has_text="Kitchen wall tiling finished").get_by_text("Rejected", exact=True)).to_be_visible()
    store.reviews[("log-a", ME)] = "confirm"

    # Edit clears confirmations
    page.reload()
    card_a = page.locator("li.card", has_text="Kitchen wall tiling finished")
    expect(card_a.get_by_text("Jainam Shah confirmed")).to_be_visible()
    card_a.get_by_role("button", name="Edit").click()
    card_a.get_by_label("Summary").fill("Kitchen wall tiling finished. Grouting Monday.")
    card_a.get_by_role("button", name="Save summary").click()
    card_a = page.locator("li.card", has_text="Grouting Monday")
    expect(card_a.get_by_text("No confirmations yet")).to_be_visible()
    check("editing the summary saves the new words and clears confirmations",
          store.ai["log-a"]["final_summary"] == "Kitchen wall tiling finished. Grouting Monday." and not any(k[0] == "log-a" for k in store.reviews))

    # Two people, one senior -> verified and moves to finished
    store.reviews[("log-a", OTHER)] = "confirm"
    card_a.get_by_role("button", name="Confirm").click()
    expect(page.locator("ul.logs > li.card", has_text="Grouting Monday")).to_have_count(0)
    check("two confirmations including a senior verify it", True)

    # Failed transcription retried with force
    card_c = page.locator("li.card", has_text="The AI service is busy")
    card_c.get_by_role("button", name="Try again").click()
    expect(page.get_by_text("Summary for log-c.")).to_be_visible(timeout=10000)
    check("a failed transcription is retried with force", store.fn_calls[-1] == {"action": "transcribe", "log_id": "log-c", "force": True})

    # Log list shows the state
    page.goto(APP + f"#/project/{PROJECT}")
    expect(page.locator("text=Verified").first).to_be_visible()
    expect(page.get_by_text("Kitchen wall tiling finished. Grouting Monday.")).to_be_visible()
    check("site log list shows the summary with its Verified tag", True)

    # Reports
    page.get_by_role("button", name="Reports").click()
    page.get_by_label("Client report language").select_option("Gujarati")
    page.get_by_role("button", name="Draft reports").click()
    expect(page.get_by_text("Client report, Gujarati")).to_be_visible()
    expect(page.get_by_text("Internal report", exact=True)).to_be_visible()
    expect(page.get_by_text("1 voice note is not verified yet")).to_be_visible()
    wr = [c for c in store.fn_calls if c["action"] == "weekly_report"]
    check("drafting sends this week's Monday and the chosen language",
          wr == [{"action": "weekly_report", "project_id": PROJECT, "week_start": week_start(), "language": "Gujarati"}], str(wr))

    box = page.get_by_label("Client report text")
    box.fill(box.input_value() + "\nNext week: grouting.")
    page.locator("article", has_text="Client report").get_by_role("button", name="Approve").click()
    client = page.locator("article", has_text="Client report")
    expect(client.get_by_text("Approved", exact=True)).to_be_visible()
    expect(client.get_by_text("Approved by Jainam Shah")).to_be_visible()
    last = [x for x in store.patches if x[0] == "report"][-1]
    check("approving saves the edit and the approval together",
          last[2].get("status") == "approved" and last[2].get("body", "").endswith("Next week: grouting."), str(last[2]))
    page.screenshot(path="/tmp/ai-reports.png", full_page=True)

    client.get_by_role("button", name="Share").click()
    expect(page.get_by_text("Copied. Paste it into WhatsApp.")).to_be_visible()
    copied = page.evaluate("navigator.clipboard.readText()")
    check("share copies the approved text (no share sheet available)", copied.endswith("Next week: grouting."))

    # Editing an approved report shows the warning and Save puts it back to draft
    box.fill(box.input_value() + " Edited.")
    expect(client.get_by_text("Saving a change puts it back to draft.")).to_be_visible()
    client.get_by_role("button", name="Save edit").click()
    expect(client.get_by_text("Draft", exact=True)).to_be_visible()
    check("saving a change to an approved report puts it back to draft",
          list(store.reports.values())[0]["status"] == "draft")

    check("no page errors", not errors, "; ".join(errors))
    browser.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
