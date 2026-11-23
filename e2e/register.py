"""Browser test of editing/removing projects and the drawing register, against a stand-in server.

Run:  npm run build && npx vite preview --port 4173 --strictPort &
      python3 e2e/register.py
The stand-in keeps projects, drawings, revisions and issues in memory and answers the
same requests the app sends to Supabase. No real data is touched.
"""
import io, json, re, sys, time, uuid
from urllib.parse import urlparse, parse_qs
from PIL import Image
from playwright.sync_api import sync_playwright, expect

import base64

APP = "http://localhost:4173/"
API = "https://obwkpheueqecifmeaqyc.supabase.co"
CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
}
def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def fake_session():
    now = int(time.time())
    token = f"{b64({'alg': 'HS256', 'typ': 'JWT'})}.{b64({'sub': 'user-1', 'role': 'authenticated', 'exp': now + 3600})}.sig"
    user = {"id": "user-1", "aud": "authenticated", "role": "authenticated", "email": "team@example.com",
            "app_metadata": {}, "user_metadata": {}, "created_at": "2026-11-15T00:00:00Z"}
    return {"access_token": token, "token_type": "bearer", "expires_in": 3600, "expires_at": now + 3600,
            "refresh_token": "refresh-1", "user": user}



results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS  " if ok else "FAIL  ") + name + (f"  [{detail}]" if detail else ""))


def rank(code):
    return int(code[1:]) if code[0] == "P" else 1000 + int(code[1:])


class Store:
    def __init__(self):
        self.projects = {}
        self.drawings = {}
        self.revisions = {}
        self.issues = {}
        self.files = {}
        self.calls = []

    def drawing_view(self, d):
        revs = []
        for r in self.revisions.values():
            if r["drawing_id"] != d["id"]:
                continue
            issues = [i for i in self.issues.values() if i["revision_id"] == r["id"]]
            revs.append({**{k: r[k] for k in ("id", "code", "rank", "revised_on", "note", "file_link", "created_at")}, "drawing_issues": issues})
        return {**d, "drawing_revisions": revs}


def filters(url):
    q = parse_qs(urlparse(url).query)
    out = {}
    for k, v in q.items():
        if k in ("select", "order", "limit", "columns", "on_conflict"):
            continue
        val = v[0]
        if val.startswith("eq."):
            raw = val[3:]
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
        store.calls.append((method, url.split("?")[0].replace(API, "")))
        if "/auth/v1/token" in url:
            return route.fulfill(status=200, headers=hdr, body=json.dumps(fake_session()))
        if "/auth/v1/user" in url:
            return route.fulfill(status=200, headers=hdr, body=json.dumps(fake_session()["user"]))
        single = "vnd.pgrst.object" in (req.headers.get("accept") or "")
        wants_rep = "return=representation" in (req.headers.get("prefer") or "")

        def reply(rows, status=200):
            if single:
                if not rows:
                    return route.fulfill(status=200, headers=hdr, body="null") if "maybe" else None
                return route.fulfill(status=status, headers=hdr, body=json.dumps(rows[0]))
            return route.fulfill(status=status, headers=hdr, body=json.dumps(rows))

        def conflict():
            return route.fulfill(status=409, headers=hdr, body=json.dumps({"code": "23505", "message": "duplicate key value violates unique constraint"}))

        m = re.search(r"/rest/v1/(\w+)", url)
        table = m.group(1) if m else None
        f = filters(url)
        is_json = "/rest/v1/" in url or "/storage/v1/object/sign/" in url
        body = json.loads(req.post_data) if (is_json and method in ("POST", "PATCH") and req.post_data) else None

        if table == "projects":
            if method == "GET":
                rows = sorted([p for p in store.projects.values() if matches(p, f)], key=lambda p: p["name"])
                return reply(rows)
            if method == "POST":
                p = {"id": str(uuid.uuid4()), "code": None, "stage": 1, "rooms": [], "trades": ["Carpentry", "Electrical"], "archived": False, **body}
                store.projects[p["id"]] = p
                return reply([p] if wants_rep else [], 201)
            if method == "PATCH":
                for p in store.projects.values():
                    if matches(p, f):
                        p.update(body)
                return route.fulfill(status=204, headers=CORS)
        if table == "site_logs" and method == "GET":
            return reply([])
        if table == "drawings":
            if method == "GET":
                rows = [store.drawing_view(d) for d in store.drawings.values() if matches(d, f)]
                return reply(rows)
            if method == "POST":
                if any(d["project_id"] == body["project_id"] and d["number"] == body["number"] for d in store.drawings.values()):
                    return conflict()
                d = {"id": str(uuid.uuid4()), "archived": False, "discipline": "Other", **body}
                store.drawings[d["id"]] = d
                return reply([{"id": d["id"]}] if wants_rep else [], 201)
        if table == "drawing_revisions" and method == "POST":
            if not re.fullmatch(r"P[1-9]\d{0,2}|R\d{1,3}", body["code"]):
                return route.fulfill(status=400, headers=hdr, body=json.dumps({"code": "23514", "message": "check constraint"}))
            if any(r["drawing_id"] == body["drawing_id"] and r["code"] == body["code"] for r in store.revisions.values()):
                return conflict()
            r = {"id": str(uuid.uuid4()), "note": "", "file_link": None, "created_at": f"2026-11-22T10:{len(store.revisions):02d}:00Z", **body, "rank": rank(body["code"])}
            store.revisions[r["id"]] = r
            return route.fulfill(status=201, headers=hdr, body="")
        if table == "drawing_issues" and method == "POST":
            i = {"id": str(uuid.uuid4()), "print_photo_path": None, "created_at": f"2026-11-22T11:{len(store.issues):02d}:00Z", **body}
            store.issues[i["id"]] = i
            return route.fulfill(status=201, headers=hdr, body="")
        if "/storage/v1/object/sign/site-media" in url and method == "POST":
            paths = body.get("paths", [])
            return route.fulfill(status=200, headers=hdr, body=json.dumps([{"path": p, "signedURL": f"/object/sign/site-media/{p}?token=t", "error": None} for p in paths]))
        if "/storage/v1/object/site-media/" in url and method == "POST":
            path = url.split("/storage/v1/object/site-media/")[1].split("?")[0]
            store.files[path] = len(req.post_data_buffer or b"")
            return route.fulfill(status=200, headers=hdr, body=json.dumps({"Key": "site-media/" + path}))
        if "/storage/v1/object/sign/" in url and method == "GET":
            buf = io.BytesIO(); Image.new("RGB", (40, 40), "#888").save(buf, "JPEG")
            return route.fulfill(status=200, headers={**CORS, "content-type": "image/jpeg"}, body=buf.getvalue())
        return route.fulfill(status=404, headers=hdr, body=json.dumps({"message": f"not mocked: {method} {url}"}))
    return handle


def photo_bytes():
    buf = io.BytesIO()
    Image.effect_noise((2000, 1500), 50).convert("RGB").save(buf, "JPEG", quality=90)
    return buf.getvalue()


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    store = Store()
    ctx.route(re.compile(re.escape(API) + ".*"), handler(store))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(APP)
    page.get_by_label("Email").fill("team@example.com")
    page.get_by_label("Password").fill("x")
    page.get_by_role("button", name="Sign in").click()
    expect(page.get_by_role("heading", name="Today")).to_be_visible()

    # Projects: add, then refuse a duplicate name
    page.get_by_role("button", name="Projects", exact=True).click()
    page.get_by_label("Name").fill("Sparsh Ekaya")
    page.get_by_role("button", name="Add project").click()
    expect(page.get_by_role("button", name=re.compile("^Sparsh Ekaya"))).to_be_visible()
    page.get_by_label("Name").fill("sparsh ekaya ")
    page.get_by_role("button", name="Add project").click()
    expect(page.get_by_text("A project called Sparsh Ekaya already exists.")).to_be_visible()
    check("a second project with the same name is refused", len(store.projects) == 1)

    # Edit
    page.get_by_role("button", name=re.compile("^Sparsh Ekaya")).click()
    page.get_by_role("button", name="Edit").click()
    expect(page.get_by_role("heading", name="Edit project")).to_be_visible()
    page.get_by_label("Current stage").select_option("3")
    page.get_by_label("Rooms, separated by commas").fill("Living, Kitchen, Kitchen, Toilet 1")
    page.get_by_role("button", name="Save changes").click()
    expect(page.get_by_text("Stage 3 of 8 · Working drawings")).to_be_visible()
    proj = next(iter(store.projects.values()))
    check("editing saves stage and rooms, without duplicate rooms", proj["stage"] == 3 and proj["rooms"] == ["Living", "Kitchen", "Toilet 1"], str(proj["rooms"]))

    # Drawing register: add a sheet
    page.get_by_role("button", name="Drawings", exact=True).click()
    expect(page.get_by_text("No sheets in the register yet.")).to_be_visible()
    page.get_by_role("button", name="Add a sheet").click()
    page.get_by_label("Sheet number").fill("SE-EL-01")
    page.get_by_label("Title").fill("Electrical layout")
    page.get_by_label("Discipline").select_option("Electrical")
    page.get_by_role("button", name="Add sheet").click()
    expect(page.get_by_text("Electrical · Not issued to site")).to_be_visible()
    check("a sheet is added with its first revision P1", len(store.drawings) == 1 and [r["code"] for r in store.revisions.values()] == ["P1"])

    page.get_by_role("button", name="Add a sheet").click()
    page.get_by_label("Sheet number").fill("SE-EL-01")
    page.get_by_label("Title").fill("Again")
    page.get_by_role("button", name="Add sheet").click()
    expect(page.get_by_text("Sheet SE-EL-01 is already in this register.")).to_be_visible()
    check("a duplicate sheet number is refused with a plain message", len(store.drawings) == 1)
    page.get_by_role("button", name="Cancel").click()

    # Issue P1 to site with a photo: preliminary print flagged
    page.get_by_role("button", name=re.compile("^SE-EL-01")).click()
    expect(page.get_by_role("heading", name="SE-EL-01")).to_be_visible()
    page.get_by_role("button", name="Record issue").click()
    page.locator('input[type="file"]').set_input_files({"name": "print.jpg", "mimeType": "image/jpeg", "buffer": photo_bytes()})
    expect(page.get_by_alt_text("Print on site")).to_be_visible()
    page.get_by_role("button", name="Save issue").click()
    expect(page.get_by_text("Site holds P1, which is not for construction")).to_be_visible()
    issue = next(iter(store.issues.values()))
    check("issue to site is saved with its print photo", issue["issued_to"] == "Site" and issue["method"] == "Print on site" and issue["print_photo_path"] in store.files,
          f"{issue['print_photo_path']} {store.files.get(issue['print_photo_path'], 0) // 1024} KB")

    # New revision: R0 offered; site print now out of date
    page.get_by_role("button", name="New revision").click()
    expect(page.get_by_label("Code")).to_have_value("P2")
    page.get_by_role("button", name="R0, for construction").click()
    page.get_by_label("What changed").fill("Sofa wall points moved 300 mm")
    page.get_by_role("button", name="Save revision").click()
    expect(page.get_by_text("Site holds P1, current is R0. Replace the print.")).to_be_visible()
    check("a new revision makes the site print out of date", True)

    page.get_by_role("button", name="New revision").click()
    expect(page.get_by_label("Code")).to_have_value("R1")
    page.get_by_label("Code").fill("P3")
    page.get_by_role("button", name="Save revision").click()
    expect(page.get_by_text("P3 is not later than the current revision R0.")).to_be_visible()
    check("an earlier revision code is refused", len(store.revisions) == 2)
    page.get_by_role("button", name="Cancel").click()

    # Today shows the flag
    page.get_by_role("button", name="Today", exact=True).click()
    expect(page.get_by_text("Site print is out of date")).to_be_visible()
    expect(page.get_by_text(re.compile("Sparsh Ekaya · SE-EL-01 · Site holds P1, current is R0"))).to_be_visible()
    check("Today lists the out-of-date print under Needs you", True)

    # Issue R0 to site: flag clears
    page.get_by_text("Site print is out of date").click()
    page.get_by_role("button", name="Record issue").click()
    expect(page.get_by_label("Revision")).to_have_value(next(r["id"] for r in store.revisions.values() if r["code"] == "R0"))
    page.get_by_role("button", name="Save issue").click()
    expect(page.get_by_text("Site has R0")).to_be_visible()
    page.get_by_role("button", name="Today", exact=True).click()
    expect(page.get_by_role("heading", name="Today")).to_be_visible()
    page.wait_for_timeout(800)
    check("issuing the current revision clears the flag", page.get_by_text("Site print is out of date").count() == 0)

    # Remove and restore
    page.get_by_role("button", name="Projects", exact=True).click()
    expect(page.get_by_role("heading", name="Projects", exact=True)).to_be_visible()
    page.locator(".pcard", has_text="Sparsh Ekaya").click()
    page.get_by_role("button", name="Edit").click()
    page.get_by_role("button", name="Remove this project").click()
    expect(page.get_by_text(re.compile("Its site logs and drawings are kept"))).to_be_visible()
    page.get_by_role("button", name="Remove", exact=True).click()
    expect(page.get_by_role("heading", name="Removed projects")).to_be_visible()
    check("removing hides the project and keeps its data", proj["archived"] is True and len(store.drawings) == 1 and len(store.revisions) == 2)
    page.get_by_role("button", name="Restore").click()
    expect(page.get_by_role("heading", name="Removed projects")).to_have_count(0)
    expect(page.get_by_role("button", name=re.compile("^Sparsh Ekaya"))).to_be_visible()
    check("restore brings it back", proj["archived"] is False)

    deletes = [c for c in store.calls if c[0] == "DELETE"]
    check("the app never sends a delete", not deletes, str(deletes))
    check("no script errors on the page", not errors, "; ".join(errors)[:300])
    browser.close()

print(f"\n{sum(results)} of {len(results)} checks passed")
sys.exit(0 if all(results) else 1)
