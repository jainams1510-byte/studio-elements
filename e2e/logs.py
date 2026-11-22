"""Browser test of owners editing, removing and restoring site logs, against a stand-in server.

Run:  npm run build && npx vite preview --port 4173 --strictPort &
      python3 e2e/logs.py
The stand-in plays the database rules: only an owner's changes stick; anyone else's
update comes back unchanged (as the live trigger does).
"""
import base64, io, json, re, time
from urllib.parse import urlparse, parse_qs
from PIL import Image
from playwright.sync_api import sync_playwright, expect

APP = "http://localhost:4173/"
API = "https://obwkpheueqecifmeaqyc.supabase.co"
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"}
PROJECT, ME, COORD = "proj-1", "user-1", "user-2"

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS  " if ok else "FAIL  ") + name + (f"  [{detail}]" if detail else ""))


def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def session(uid):
    now = int(time.time())
    token = f"{b64({'alg': 'HS256'})}.{b64({'sub': uid, 'role': 'authenticated', 'exp': now + 3600})}.sig"
    user = {"id": uid, "aud": "authenticated", "role": "authenticated", "email": f"{uid}@example.com",
            "app_metadata": {}, "user_metadata": {}, "created_at": "2026-11-15T00:00:00Z"}
    return {"access_token": token, "token_type": "bearer", "expires_in": 3600, "expires_at": now + 3600,
            "refresh_token": "r", "user": user}


class Store:
    def __init__(self, uid):
        self.uid = uid
        self.roles = {ME: "owner", COORD: "coordinator"}
        self.names = {ME: "Jainam Shah", COORD: "Site Coordinator"}
        self.server_says_owner = None  # None: follow roles; False: refuse even an owner (role changed in the dashboard)
        self.project = {"id": PROJECT, "name": "Sparsh Ekaya", "code": "SE", "stage": 3,
                        "rooms": ["Kitchen", "Living"], "trades": ["Tiling", "Carpentry"], "archived": False}
        self.log = {"id": "log-1", "project_id": PROJECT, "note": "Kitchen tiles half done", "room": "Kitchen",
                    "trade": "Tiling", "audio_path": None, "logged_at": "2026-11-22T06:00:00Z", "edited_at": None,
                    "edited_by": None, "removed_at": None, "removed_by": None}
        self.photos = [{"id": "ph-1", "log_id": "log-1", "path": f"{PROJECT}/log-1/ph-1.jpg", "removed_at": None},
                       {"id": "ph-2", "log_id": "log-1", "path": f"{PROJECT}/log-1/ph-2.jpg", "removed_at": None}]
        self.patches = []

    def owner(self):
        return self.roles[self.uid] == "owner" if self.server_says_owner is None else self.server_says_owner

    def log_view(self):
        return {**self.log, "profiles": {"full_name": self.names[COORD]},
                "site_log_photos": [{k: p[k] for k in ("id", "path", "removed_at")} for p in self.photos], "site_log_ai": None}


def handler(store):
    def handle(route):
        req = route.request
        url, method = req.url, req.method
        hdr = {**CORS, "content-type": "application/json"}
        rows = lambda r, s=200: route.fulfill(status=s, headers=hdr, body=json.dumps(r))
        if method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        if "/auth/v1/token" in url:
            return rows(session(store.uid))
        if "/auth/v1/user" in url:
            return rows(session(store.uid)["user"])
        q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
        body = json.loads(req.post_data) if method in ("POST", "PATCH") and req.post_data else None
        if "/rest/v1/profiles" in url:
            return rows([{"id": i, "full_name": store.names[i], "role": store.roles[i]} for i in store.names])
        if "/rest/v1/projects" in url:
            return rows([store.project])
        if "/rest/v1/site_logs" in url and method == "GET":
            return rows([store.log_view()])
        if "/rest/v1/site_logs" in url and method == "PATCH":
            store.patches.append(("log", body))
            if store.owner():  # what the live trigger does
                for k in ("note", "room", "trade"):
                    if k in body and body[k] != store.log[k]:
                        store.log[k] = body[k]
                        store.log["edited_at"], store.log["edited_by"] = "2026-11-23T03:00:00Z", store.uid
                if "removed_at" in body:
                    store.log["removed_at"] = body["removed_at"] and "2026-11-23T03:05:00Z"
                    store.log["removed_by"] = store.uid if body["removed_at"] else None
            cols = q.get("select", "").split(",")
            return rows([{c: store.log[c] for c in cols if c}])
        if "/rest/v1/site_log_photos" in url and method == "PATCH":
            store.patches.append(("photos", q.get("id"), body))
            ids = re.findall(r"[\w-]+", q.get("id", "").replace("in.", ""))
            if store.owner():
                for p in store.photos:
                    if p["id"] in ids:
                        p["removed_at"] = body["removed_at"]
            return route.fulfill(status=204, headers=CORS)
        if "/storage/v1/object/sign/site-media" in url and method == "POST":
            return rows([{"path": p, "signedURL": f"/object/sign/site-media/{p}?token=t", "error": None} for p in body["paths"]])
        if "/storage/v1/object/sign/" in url:
            buf = io.BytesIO(); Image.new("RGB", (40, 40), "#888").save(buf, "JPEG")
            return route.fulfill(status=200, headers={**CORS, "content-type": "image/jpeg"}, body=buf.getvalue())
        if method == "GET" and "/rest/v1/" in url:
            return rows([])
        return rows({"message": f"not mocked: {method} {url}"}, 404)
    return handle


def open_app(p, store):
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    ctx.route(re.compile(re.escape(API) + ".*"), handler(store))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(APP)
    page.get_by_label("Email").fill("x@example.com")
    page.get_by_label("Password").fill("x")
    page.get_by_role("button", name="Sign in").click()
    expect(page.get_by_role("heading", name="Today")).to_be_visible()
    page.goto(APP + f"#/project/{PROJECT}")
    expect(page.get_by_text("Kitchen tiles half done")).to_be_visible()
    return browser, page, errors


with sync_playwright() as p:
    # Owner
    store = Store(ME)
    browser, page, errors = open_app(p, store)
    card = page.locator("li.card").first
    expect(card.get_by_role("button", name="Edit or remove")).to_be_visible()
    check("an owner sees Edit or remove on each log", True)

    card.get_by_role("button", name="Edit or remove").click()
    card.get_by_label("Note").fill("Kitchen wall tiles done, floor tomorrow")
    card.get_by_label("Room").select_option("Living")
    card.get_by_role("button", name="Remove photo 2").click()
    page.screenshot(path="/tmp/log-edit.png", full_page=True)
    card.get_by_role("button", name="Save").click()
    expect(page.get_by_text("Kitchen wall tiles done, floor tomorrow")).to_be_visible()
    expect(page.get_by_text(re.compile("edited by Jainam Shah"))).to_be_visible()
    check("edits to note and room are saved and marked with who edited",
          store.log["note"] == "Kitchen wall tiles done, floor tomorrow" and store.log["room"] == "Living" and store.log["edited_by"] == ME)
    expect(page.locator("li.card .photos .tile")).to_have_count(1)
    check("a removed photo is hidden and kept on the server",
          store.photos[1]["removed_at"] is not None and store.photos[0]["removed_at"] is None and len(store.photos) == 2)

    card = page.locator("li.card").first
    card.get_by_role("button", name="Edit or remove").click()
    card.get_by_role("button", name="Remove log").click()
    expect(card.get_by_text("You can restore it.")).to_be_visible()
    check("removing a log asks first", store.log["removed_at"] is None)
    card.get_by_role("button", name="Remove log").click()
    expect(page.get_by_text("Nothing logged on this project yet.")).to_be_visible()
    check("a removed log disappears from the list and is kept on the server", store.log["removed_at"] is not None and store.log["removed_by"] == ME)

    page.get_by_role("button", name="Show 1 removed log").click()
    removed_card = page.locator("li.card.removed")
    expect(removed_card.get_by_text("Removed by Jainam Shah")).to_be_visible()
    removed_card.get_by_role("button", name="Restore").click()
    expect(page.locator("li.card:not(.removed)", has_text="floor tomorrow")).to_be_visible()
    check("an owner can restore a removed log", store.log["removed_at"] is None)

    # The app thinks you are an owner but the database says otherwise
    store.server_says_owner = False
    card = page.locator("li.card").first
    card.get_by_role("button", name="Edit or remove").click()
    card.get_by_label("Note").fill("Should not stick")
    card.get_by_role("button", name="Save").click()
    expect(card.get_by_text("Not saved. Only an owner can edit site logs.")).to_be_visible()
    check("if the database refuses, the app says so instead of pretending", store.log["note"] != "Should not stick")
    check("no page errors (owner)", not errors, "; ".join(errors))
    browser.close()

    # Coordinator / team account
    store = Store(COORD)
    browser, page, errors = open_app(p, store)
    page.wait_for_timeout(800)
    check("the studio account does not see Edit or remove", page.get_by_role("button", name="Edit or remove").count() == 0)
    check("no page errors (coordinator)", not errors, "; ".join(errors))
    browser.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
