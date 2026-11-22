"""End-to-end check of the built app in Chrome, with the server mocked.

Run:  npm run build && npx vite preview --port 4173 --strictPort &
      python3 e2e/smoke.py
It signs in, saves a log with a photo and voice note while offline, goes
online, and checks exactly what was uploaded. No real Supabase is touched.
"""
import base64, io, json, re, sys, time
from PIL import Image
from playwright.sync_api import sync_playwright, expect

APP = "http://localhost:4173/"
API = "https://obwkpheueqecifmeaqyc.supabase.co"
CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
}
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


class Server:
    """Records what the app sends, and can be told to refuse a log once."""

    def __init__(self):
        self.files, self.logs, self.photos, self.prefers = [], [], [], []
        self.fail_next_log = False

    def handle(self, route):
        req = route.request
        url, method = req.url, req.method
        if method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        hdr = {**CORS, "content-type": "application/json"}
        if "/auth/v1/token" in url:
            return route.fulfill(status=200, headers=hdr, body=json.dumps(fake_session()))
        if "/auth/v1/user" in url:
            return route.fulfill(status=200, headers=hdr, body=json.dumps(fake_session()["user"]))
        if "/auth/v1/logout" in url:
            return route.fulfill(status=204, headers=CORS)
        if "/rest/v1/projects" in url and method == "GET":
            body = [{"id": "p1", "name": "Project A", "code": None, "stage": 6,
                     "rooms": ["Living", "Kitchen"], "trades": ["Carpentry", "Electrical"], "archived": False}]
            return route.fulfill(status=200, headers=hdr, body=json.dumps(body))
        if "/rest/v1/site_logs" in url and method == "GET":
            return route.fulfill(status=200, headers=hdr, body="[]")
        if "/rest/v1/site_logs" in url and method == "POST":
            if self.fail_next_log:
                self.fail_next_log = False
                return route.fulfill(status=500, headers=hdr, body=json.dumps({"message": "server refused"}))
            self.logs.append(json.loads(req.post_data))
            self.prefers.append(req.headers.get("prefer") or "")
            return route.fulfill(status=201, headers=hdr, body="")
        if "/rest/v1/site_log_photos" in url and method == "POST":
            self.photos.extend(json.loads(req.post_data))
            self.prefers.append(req.headers.get("prefer") or "")
            return route.fulfill(status=201, headers=hdr, body="")
        if "/storage/v1/object/site-media/" in url and method == "POST":
            path = url.split("/storage/v1/object/site-media/")[1].split("?")[0]
            self.files.append((path, req.post_data_buffer or b""))
            return route.fulfill(status=200, headers=hdr, body=json.dumps({"Key": "site-media/" + path}))
        return route.fulfill(status=404, headers=hdr, body=json.dumps({"message": "not mocked: " + url}))


def big_photo():
    img = Image.effect_noise((4000, 3000), 60).convert("RGB")  # a 12-megapixel "camera" photo
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=92)
    return buf.getvalue()


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=[
        "--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    server = Server()
    ctx.route(re.compile(re.escape(API) + ".*"), server.handle)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # 1. Sign in
    page.goto(APP)
    expect(page.get_by_role("heading", name="Studio Elements")).to_be_visible()
    check("sign-in screen shows when signed out", True)
    page.get_by_label("Email").fill("team@example.com")
    page.get_by_label("Password").fill("secret-password")
    page.get_by_role("button", name="Sign in").click()
    expect(page.get_by_role("heading", name="Today")).to_be_visible()
    expect(page.get_by_text("Project A")).to_be_visible()
    check("signing in opens Today with the project list", True)

    # 2. Capture a log
    page.get_by_role("button", name="New site log").click()
    expect(page.get_by_role("heading", name="Site log")).to_be_visible()
    original = big_photo()
    page.locator('input[type="file"]').set_input_files({"name": "site.jpg", "mimeType": "image/jpeg", "buffer": original})
    expect(page.get_by_alt_text("Photo 1")).to_be_visible()
    page.get_by_role("button", name="Record a voice note").click()
    expect(page.get_by_text("Recording")).to_be_visible()
    page.wait_for_timeout(1500)
    page.get_by_role("button", name="Stop recording").click()
    expect(page.locator("audio")).to_be_visible()
    check("photo preview and voice recording work", True)
    page.get_by_role("button", name="Living").click()
    page.get_by_role("button", name="Carpentry").click()
    page.get_by_label("One line, optional").fill("Framing done, boards start tomorrow")

    # 3. Save with no signal
    ctx.set_offline(True)
    page.get_by_role("button", name="Save log").click()
    expect(page.get_by_role("heading", name="Today")).to_be_visible()
    expect(page.get_by_role("button", name="1 to upload")).to_be_visible()
    expect(page.get_by_text("No signal.")).to_be_visible()
    check("offline save keeps the log on the phone and shows the count", True)
    check("nothing was sent while offline", len(server.files) == 0 and len(server.logs) == 0)

    # 4. Signal returns: upload happens by itself
    ctx.set_offline(False)
    expect(page.get_by_role("button", name="All uploaded")).to_be_visible(timeout=15000)
    check("upload starts by itself when signal returns", True)
    photo_files = [f for f in server.files if f[0].endswith(".jpg")]
    voice_files = [f for f in server.files if "/voice." in f[0]]
    check("one photo and one voice file uploaded", len(photo_files) == 1 and len(voice_files) == 1,
          f"{[f[0].split('/')[-1] for f in server.files]}")
    sent = photo_files[0][1] if photo_files else b""
    check("photo was shrunk before upload", 0 < len(sent) < len(original) / 2 and b"\xff\xd8\xff" in sent,
          f"{len(original) // 1024} KB -> {len(sent) // 1024} KB")
    check("voice file is not empty", bool(voice_files) and len(voice_files[0][1]) > 500,
          f"{len(voice_files[0][1]) if voice_files else 0} bytes")
    log = server.logs[0] if server.logs else {}
    check("log record carries room, trade, note and project",
          log.get("room") == "Living" and log.get("trade") == "Carpentry"
          and log.get("note") == "Framing done, boards start tomorrow" and log.get("project_id") == "p1")
    check("uploads never overwrite a stored log or photo (ignore duplicates)",
          bool(server.prefers) and all("resolution=ignore-duplicates" in x for x in server.prefers), str(server.prefers[:2]))
    check("log record points at the voice file", bool(voice_files) and log.get("audio_path") == voice_files[0][0])
    check("photo record points at the uploaded photo",
          len(server.photos) == 1 and bool(photo_files) and server.photos[0]["path"] == photo_files[0][0]
          and server.photos[0]["log_id"] == log.get("id"))

    # 5. Server refuses once: the log must stay, then go on retry, with no duplicate
    server.fail_next_log = True
    page.get_by_role("button", name="New site log").click()
    page.get_by_label("One line, optional").fill("Second log")
    page.get_by_role("button", name="Save log").click()
    expect(page.get_by_role("button", name="1 to upload")).to_be_visible(timeout=15000)
    expect(page.get_by_text("A log could not upload")).to_be_visible(timeout=15000)
    check("a refused upload stays on the phone and says why", True)
    page.get_by_role("button", name="1 to upload").click()
    expect(page.get_by_role("button", name="All uploaded")).to_be_visible(timeout=15000)
    ids = [l["id"] for l in server.logs]
    check("retry succeeds with no duplicate record", len(ids) == 2 and len(set(ids)) == 2, f"{len(ids)} records")

    # 6. Reopen the app with no signal: it must still load
    page.wait_for_function("navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true)")
    page.reload()
    page.wait_for_timeout(1500)
    ctx.set_offline(True)
    page.reload()
    expect(page.get_by_role("heading", name="Today")).to_be_visible(timeout=15000)
    expect(page.get_by_text("Project A")).to_be_visible()
    check("app opens with no signal and still lists projects", True)
    page.get_by_role("button", name="New site log").click()
    expect(page.locator("select")).to_have_value("p1")
    check("site log is usable with no signal", True)

    check("no script errors on the page", len(errors) == 0, "; ".join(errors)[:200])
    browser.close()

print(f"\n{sum(results)} of {len(results)} checks passed")
sys.exit(0 if all(results) else 1)
