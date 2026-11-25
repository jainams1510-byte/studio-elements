"""Browser test of the brief, studio settings, presentation deck and review (stand-in server, no real data).

Run:  npm run build && npx vite preview --port 4184 --strictPort &
      python3 e2e/deck.py
Covers: brief save and date warnings; studio settings as owner and read-only as coordinator; clause override and reset;
logo upload; default deck from rooms; image upload shown in the preview; reorder, add, remove/undo, rebuild; PPTX and PDF
downloads (unzipped and read back); review issues listed and cleared after fixing; phone fit at 360/390; no page errors.
"""
import os
os.environ.setdefault("APP_URL", "http://localhost:4184/")

import io, re, sys, tempfile, zipfile
from urllib.parse import unquote
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright, expect
from standin import APP, API, CORS, PROJECT, Store, check, fits_phone, handler, results, sign_in

TMP = tempfile.mkdtemp(prefix="deck-e2e-")


def make_jpeg(name, size, colour):
    im = Image.new("RGB", size, colour)
    d = ImageDraw.Draw(im)
    d.rectangle([size[0] // 4, size[1] // 4, size[0] * 3 // 4, size[1] * 3 // 4], fill=(255, 255, 255))
    path = os.path.join(TMP, name)
    im.save(path, "JPEG", quality=85)
    return path


def make_png(name):
    im = Image.new("RGBA", (300, 200), (0, 0, 0, 0))
    ImageDraw.Draw(im).ellipse([20, 20, 280, 180], fill=(47, 93, 70, 255))
    path = os.path.join(TMP, name)
    im.save(path, "PNG")
    return path


WIDE = make_jpeg("wide.jpg", (1600, 900), (120, 90, 60))
TALL = make_jpeg("tall.jpg", (600, 1000), (60, 90, 120))
LOGO = make_png("logo.png")


def seed(store):
    # The stand-in matches filters as text, so the single settings row is keyed "1" to match ?id=eq.1.
    store.table("studio_settings")["1"] = {"id": "1", "name": "Studio Elements", "tagline": "Architecture · Interior Design · Project Management",
                                           "website": "www.studioelements.in", "email": "info@studioelements.in", "phone": "+91 8511357002",
                                           "gstin": "", "logo_path": None, "clauses": {}}
    store.table("boq_items")["b1"] = {"id": "b1", "project_id": PROJECT, "category": "Flooring and skirting", "trade": None, "room": "Living",
                                      "item": "Italian marble flooring", "unit": "sq. ft.", "quantity": 400, "rate": 0, "wastage_pct": 5,
                                      "rate_source": "", "verified": False, "optional": False, "work_order_id": None, "committed_rate": None,
                                      "sort_order": 0, "removed_at": None}


def file_bytes(req):
    body = req.post_data_buffer or b""
    ctype = req.headers.get("content-type") or ""
    m = re.search(r"boundary=([^;]+)", ctype)
    if "multipart/form-data" not in ctype or not m:
        return body
    for part in body.split(b"--" + m.group(1).strip('"').encode()):
        head, _, rest = part.partition(b"\r\n\r\n")
        if b"filename=" in head or (b"name=\"\"" in head):
            return rest[:-2] if rest.endswith(b"\r\n") else rest
    return body


def with_signed_gets(store, log):
    """Signed-URL GETs (/object/sign/site-media/...) return the stored bytes; everything else goes to the shared stand-in."""
    base = handler(store)

    def handle(route):
        url = route.request.url
        log.append((route.request.method, url))
        if route.request.method in ("POST", "PUT") and "/storage/v1/object/site-media/" in url:
            # supabase-js sends a Blob as multipart form data: keep only the file's bytes, as storage does.
            path = unquote(url.split("/storage/v1/object/site-media/")[1].split("?")[0])
            store.files[path] = file_bytes(route.request)
            return route.fulfill(status=200, headers={**CORS, "content-type": "application/json"}, body='{"Key": "site-media/%s"}' % path)
        if route.request.method == "GET" and "/storage/v1/object/sign/site-media/" in url:
            path = unquote(url.split("/storage/v1/object/sign/site-media/")[1].split("?")[0])
            if path in store.files:
                ctype = "image/png" if store.files[path][:4] == b"\x89PNG" else "image/jpeg"
                return route.fulfill(status=200, headers={**CORS, "content-type": ctype}, body=store.files[path])
            return route.fulfill(status=404, headers=CORS, body="not found")
        return base(route)
    return handle


def settle(page):
    """Wait until the deck has finished saving."""
    page.wait_for_selector(".dk-savestate[data-saving=false]", state="attached")
    page.wait_for_timeout(100)
    page.wait_for_selector(".dk-savestate[data-saving=false]", state="attached")


def deck_row(store):
    return store.table("project_decks").get(PROJECT)


def titles(page):
    return [page.get_by_label(f"Title of slide {i + 1}").input_value() for i in range(page.locator("li.dk-slide").count())]


def review_texts(page):
    page.wait_for_timeout(400)
    return page.locator(".dk-checks li").evaluate_all(
        "els => els.map(li => { const c = li.cloneNode(true); c.querySelectorAll('.sr, .dk-fix').forEach(x => x.remove()); return c.textContent.trim() })")


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
    errors = []
    store = Store("owner")
    seed(store)
    log = []

    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, accept_downloads=True)
    ctx.route(re.compile(re.escape(API) + ".*"), with_signed_gets(store, log))
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    sign_in(page)

    # ---- Review before anything is filled in -------------------------------------------------------
    page.goto(APP + f"#/project/{PROJECT}/review")
    expect(page.get_by_role("heading", name="Review before export")).to_be_visible()
    t = review_texts(page)
    for want in ["Missing: Client name", "Missing: Site address", "Missing: Area", "Missing: Client budget", "Missing: Issue date",
                 "Missing: Agreement date", "Missing: Start date"]:
        check(f"review lists '{want}'", any(x.startswith(want) for x in t), " | ".join(t[:3]))
    check("review: line missing quantity or rate", any("Italian marble flooring" in x and "missing quantity or rate" in x for x in t))
    check("review: unverified line counted", any(x.startswith("1 estimate line unverified") for x in t))
    check("review: [City] placeholder flagged", any("[City]" in x for x in t))
    check("review: Mumbai flagged", any("Mumbai" in x for x in t))
    check("review: owner sees fee check (no proposal yet)", any("No fee proposal saved yet" in x for x in t))
    # Default deck from rooms Living, Kitchen: as built 2 + key plan 1 + 2 rooms x 3 = 9 empty.
    check("review: 9 empty image slots", any(x.startswith("9 image slots") for x in t), next((x for x in t if "image slot" in x), ""))
    levels = page.locator(".dk-checks li").evaluate_all("els => els.map(e => e.classList.contains('bad') ? 0 : e.classList.contains('warn') ? 1 : 2)")
    check("review: bad items come before warnings", levels == sorted(levels) and levels[0] == 0, str(levels))
    page.locator(".dk-check", has_text="Missing: Client name").get_by_role("button", name="Edit").click()
    expect(page.get_by_role("heading", name="Edit project")).to_be_visible()
    check("review 'Edit' link opens the project's Edit screen", page.url.endswith(f"#/project/{PROJECT}/edit"))

    # ---- Brief ------------------------------------------------------------------------------------
    expect(page.get_by_role("heading", name="Brief")).to_be_visible()
    page.get_by_label("Client name").fill("Sunil Shah")
    page.get_by_label("Client phone").fill("+91 98250 00000")
    page.get_by_label("Client email").fill("client@example.com")
    page.get_by_label("Site address").fill("Sparsh Ekaya, Bodakdev")
    page.get_by_label("City and state").fill("Ahmedabad, Gujarat")
    page.get_by_label("Project area").fill("1200")
    page.get_by_label("Proposal issue").fill("2026-11-12")
    page.get_by_label("Agreement", exact=True).fill("2026-11-10")
    page.get_by_label("Planned start").fill("2026-11-05")
    page.get_by_label("Estimated completion").fill("2026-11-01")
    check("brief warns: agreement before issue", page.get_by_text("Agreement date is before the proposal issue date").is_visible())
    check("brief warns: start before agreement", page.get_by_text("Start date is before the agreement date").is_visible())
    check("brief warns: completion not after start", page.get_by_text("Completion date is not after the start date.").is_visible())
    fits_phone(page, "Edit project with brief warnings", 390)
    page.get_by_label("Estimated completion").fill("2027-04-30")
    page.get_by_label("Planned start").fill("2026-12-01")
    page.get_by_label("Proposal issue").fill("2026-11-01")
    check("brief warnings clear once dates are in order", page.locator(".dk-inline").count() == 0)
    page.get_by_label("Duration (months)").fill("5")
    page.get_by_label("Client total budget (₹)").fill("1,00,000")
    page.get_by_label("Contingency (%)").fill("60")
    page.get_by_role("button", name="Save brief").click()
    check("brief refuses contingency over 50 %", page.get_by_role("alert").inner_text().startswith("Contingency must be between 0 and 50"))
    page.get_by_label("Contingency (%)").fill("5")
    page.get_by_role("button", name="Save brief").click()
    expect(page.get_by_role("button", name="Brief saved")).to_be_visible()
    b = store.table("project_briefs").get(PROJECT, {})
    check("brief stored in project_briefs", b.get("client_name") == "Sunil Shah" and b.get("area") == 1200 and b.get("client_budget") == 100000
          and b.get("agreement_date") == "2026-11-10" and b.get("estimate_gst_rate") == 18 and b.get("contingency_pct") == 5
          and b.get("area_unit") == "sq. ft." and b.get("budget_includes_gst") is False, str(b))
    page.get_by_label("Client name").fill("Sunil Shah ")
    check("editing again resets the saved state", page.get_by_role("button", name="Save brief").is_visible())
    page.reload()
    expect(page.get_by_label("Client name")).to_have_value("Sunil Shah")
    check("brief reloads from the server", page.get_by_label("Planned start").input_value() == "2026-12-01")

    # ---- Studio settings (owner) ---------------------------------------------------------------------
    page.goto(APP + "#/settings")
    expect(page.get_by_role("heading", name="Studio settings")).to_be_visible()
    warn = page.locator("[aria-label='Clause warnings']").inner_text()
    check("settings warn about Mumbai and [City]", "Mumbai" in warn and "[City]" in warn, warn)
    page.get_by_label("GSTIN").fill("24ABCDE1234F1Z5")
    page.get_by_role("button", name="Save details").click()
    expect(page.get_by_role("button", name="Details saved")).to_be_visible()
    check("details stored", store.table("studio_settings")["1"]["gstin"] == "24ABCDE1234F1Z5")

    about = page.get_by_label("1. ABOUT STUDIO ELEMENTS")
    about.fill(about.input_value().replace("Mumbai", "Ahmedabad"))
    card = page.locator("[data-clause=about]")
    card.get_by_role("button", name="Save clause").click()
    expect(card.get_by_text("Edited", exact=True)).to_be_visible()
    cl = store.table("studio_settings")["1"]["clauses"]
    check("about clause override stored", "Ahmedabad" in cl.get("about", "") and "Mumbai" not in cl.get("about", ""))
    dispute = page.get_by_label("13. DISPUTE RESOLUTION & GOVERNING LAW")
    dispute.fill(dispute.input_value().replace("[City]", "Ahmedabad"))
    page.locator("[data-clause=dispute]").get_by_role("button", name="Save clause").click()
    expect(page.locator("[aria-label='Clause warnings']")).to_have_count(0)
    check("clause warnings clear after fixing both", True)

    site = page.get_by_label("7. SITE VISITS")
    original_site = site.input_value()
    site.fill(original_site + " Test sentence.")
    page.locator("[data-clause=site]").get_by_role("button", name="Save clause").click()
    expect(page.locator("[data-clause=site]").get_by_text("Edited", exact=True)).to_be_visible()
    check("site clause override stored", store.table("studio_settings")["1"]["clauses"].get("site", "").endswith("Test sentence."))
    page.locator("[data-clause=site]").get_by_role("button", name="Reset to reference text").click()
    expect(page.locator("[data-clause=site]").get_by_text("Reference", exact=True)).to_be_visible()
    cl = store.table("studio_settings")["1"]["clauses"]
    check("reset removes the override and keeps the others", "site" not in cl and "about" in cl and "dispute" in cl, str(list(cl)))
    check("reset shows the reference text again", site.input_value() == original_site)

    page.get_by_label("Replace logo").set_input_files(LOGO)
    expect(page.get_by_role("button", name="Use original logo")).to_be_visible()
    lp = store.table("studio_settings")["1"]["logo_path"]
    data = store.files.get(lp or "", b"")
    ok_png = bool(lp) and re.fullmatch(r"branding/logo-\d+\.png", lp) is not None and data[:4] == b"\x89PNG"
    alpha = Image.open(io.BytesIO(data)).mode if ok_png else ""
    check("logo stored as PNG at branding/logo-<time>.png with transparency kept", ok_png and alpha == "RGBA", f"{lp} {alpha}")
    page.wait_for_function("() => { const i = document.querySelector('.dk-logo img'); return i && i.complete && i.naturalWidth === 300 }")
    check("uploaded logo shown", True)
    fits_phone(page, "Studio settings (owner)", 390)
    page.screenshot(path="/tmp/deck-settings-390.png", full_page=True)
    page.get_by_role("button", name="Use original logo").click()
    expect(page.get_by_role("button", name="Use original logo")).to_have_count(0)
    check("'Use original logo' clears logo_path and keeps the file", store.table("studio_settings")["1"]["logo_path"] is None and lp in store.files)

    # ---- Deck --------------------------------------------------------------------------------------
    page.goto(APP + f"#/project/{PROJECT}/deck")
    expect(page.get_by_role("heading", name="Client presentation")).to_be_visible()
    check("default deck from rooms", titles(page) == ["AS BUILT", "KEY PLAN", "Living", "Kitchen", "THANK YOU"], str(titles(page)))
    check("room slide preview shows Option 1 / Option 2 and the band", page.locator("li.dk-slide").nth(2).locator(".dk-pc").all_inner_texts() == ["Option 1", "Option 2"]
          and page.locator("li.dk-slide").nth(2).locator(".dk-pt").inner_text() == "Living")
    page.get_by_label("Upload Option 1, slide 3").set_input_files(WIDE)
    expect(page.get_by_label("Replace Option 1, slide 3")).to_be_attached()
    settle(page)
    row = deck_row(store)
    a = row and row["slides"][2]["slots"].get("a")
    check("image stored at decks/<project>/<uuid>.jpg and saved in slides[2].slots.a", bool(a) and re.fullmatch(rf"decks/{PROJECT}/[0-9a-f-]{{36}}\.jpg", a) is not None
          and store.files.get(a, b"")[:3] == b"\xff\xd8\xff", str(a))
    img = page.locator("li.dk-slide").nth(2).locator("img[data-slot=a]")
    page.wait_for_function("(el) => el.complete && el.naturalWidth > 0", arg=img.element_handle())
    check("uploaded image is shown in the slide preview", img.evaluate("e => e.naturalWidth") > 0)
    page.get_by_label("Upload key plan, slide 2").set_input_files(TALL)
    expect(page.get_by_label("Replace key plan, slide 2")).to_be_attached()
    settle(page)
    kp = deck_row(store)["key_plan_path"]
    check("key plan saved once as key_plan_path", bool(kp) and kp.startswith(f"decks/{PROJECT}/"))
    check("key plan appears on room slides too", page.locator("li.dk-slide").nth(3).locator("img[data-slot=kp]").count() == 1)
    # Preview stays inside its card and keeps 16:9.
    box = page.locator("li.dk-slide").nth(2).locator(".dk-pv").bounding_box()
    check("slide preview is 16:9", abs(box["width"] / box["height"] - 16 / 9) < 0.02, str(box))
    page.screenshot(path="/tmp/deck-deck-390.png", full_page=True)
    page.locator("li.dk-slide").nth(2).locator(".dk-pv").screenshot(path="/tmp/deck-slide-preview.png")

    page.get_by_role("button", name="Move slide 4 up").click()
    expect(page.get_by_label("Title of slide 3")).to_have_value("Kitchen")
    settle(page)
    check("reorder saved", [s["title"] for s in deck_row(store)["slides"]] == ["AS BUILT", "KEY PLAN", "Kitchen", "Living", "THANK YOU"])
    check("image moves with its slide", deck_row(store)["slides"][3]["slots"].get("a") == a)
    page.get_by_label("Title of slide 3").fill("KITCHEN AND DINING")
    page.get_by_label("Title of slide 3").blur()
    settle(page)
    check("title edit saved", deck_row(store)["slides"][2]["title"] == "KITCHEN AND DINING")
    page.get_by_role("button", name="Add room slide").click()
    page.get_by_label("Room name").fill("Study")
    page.get_by_role("button", name="Add slide").click()
    expect(page.get_by_label("Title of slide 5")).to_have_value("Study")
    check("added room slide goes before THANK YOU", titles(page)[-2:] == ["Study", "THANK YOU"])
    page.get_by_role("button", name="Remove slide 5").click()
    expect(page.get_by_text("Slide “Study” removed")).to_be_visible()
    check("slide removed", "Study" not in titles(page))
    page.get_by_role("button", name="Undo").click()
    expect(page.get_by_label("Title of slide 5")).to_have_value("Study")
    check("undo brings the slide back", True)
    page.get_by_role("button", name="Rebuild from rooms").click()
    page.get_by_role("button", name="Rebuild", exact=True).click()
    settle(page)
    t2 = titles(page)
    row = deck_row(store)
    living = next(s for s in row["slides"] if s["title"] == "Living")
    check("rebuild from rooms: room slides only, images kept", t2 == ["AS BUILT", "KEY PLAN", "Living", "Kitchen", "THANK YOU"] and living["slots"].get("a") == a
          and row["key_plan_path"] == kp, str(t2))
    page.get_by_label("Clear Option 1, slide 3").click()
    settle(page)
    check("clearing a slot empties it and keeps the file", deck_row(store)["slides"][2]["slots"] == {} and a in store.files)
    page.get_by_label("Upload Option 1, slide 3").set_input_files(WIDE)
    expect(page.get_by_label("Replace Option 1, slide 3")).to_be_attached()
    settle(page)
    a = deck_row(store)["slides"][2]["slots"]["a"]

    with page.expect_download() as dl:
        page.get_by_role("button", name="PPTX (editable)").click()
    d = dl.value
    path = d.path()
    check("PPTX file name", d.suggested_filename == "Sparsh-Ekaya-Presentation.pptx", d.suggested_filename)
    z = zipfile.ZipFile(path)
    slide_xml = sorted(n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n))
    allx = "".join(z.read(n).decode("utf8") for n in slide_xml)
    check("PPTX has 5 slides with the room titles", len(slide_xml) == 5 and all(x in allx for x in ["Living", "Kitchen", "AS BUILT", "THANK YOU", "Option 1"]), str(len(slide_xml)))
    media = [n for n in z.namelist() if n.startswith("ppt/media/")]
    check("PPTX carries the uploaded images and logo", any(n.endswith((".jpg", ".jpeg")) for n in media) and any(n.endswith(".png") for n in media), str(media))
    expect(page.get_by_text(re.compile("^PPTX ready"))).to_be_visible()

    with page.expect_download() as dl:
        page.get_by_role("button", name="PDF", exact=True).click()
    d = dl.value
    pdf = open(d.path(), "rb").read()
    pages = len(re.findall(rb"/Type\s*/Page(?!s)", pdf))
    check("PDF file name, 5 pages of 960 x 540", d.suggested_filename == "Sparsh-Ekaya-Presentation.pdf" and pdf[:4] == b"%PDF" and pages == 5
          and b"960" in pdf and b"540" in pdf, f"{d.suggested_filename} {pages}")
    check("PDF embeds images", pdf.count(b"/Subtype /Image") >= 3, str(pdf.count(b"/Subtype /Image")))

    # ---- Review after fixing ------------------------------------------------------------------------
    page.goto(APP + f"#/project/{PROJECT}/review")
    expect(page.get_by_role("heading", name="Review before export")).to_be_visible()
    t = review_texts(page)
    check("review: brief issues cleared", not any(x.startswith("Missing:") for x in t), " | ".join(t))
    check("review: clause issues cleared", not any("[City]" in x or "Mumbai" in x for x in t))
    check("review: remaining empty slots counted (9 - 1 image - key plan on 3 slides = 5)", any(x.startswith("5 image slots") for x in t),
          next((x for x in t if "image slot" in x), ""))
    # Fix the rest the way the other screens would: the estimate line, a fee proposal, the deck images.
    store.table("boq_items")["b1"].update(rate=180, verified=True)
    store.table("fee_proposals")[PROJECT] = {"project_id": PROJECT, "method": "fixed", "fixed_fee": 80000, "percent": None, "rate_psf": None,
                                             "stage_pct": [20, 30, 30, 20], "stage_override": [None, None, None, None],
                                             "milestones": [{"name": "A", "pct": 40}, {"name": "B", "pct": 50}], "legal_reviewed": False}
    page.reload()
    t = review_texts(page)
    check("review: fee problems shown to owner", any("milestones total 90%" in x for x in t) and any("legally reviewed" in x for x in t), " | ".join(t))
    check("review: over budget shown (400 x 180 x 1.05 x 1.05 = 79,380 > ... no)", not any("over the client budget" in x for x in t))
    store.table("boq_items")["b1"].update(rate=250)  # 400 x 250 x 1.05 = 1,05,000 + 5% = 1,10,250 > 1,00,000
    page.reload()
    t = review_texts(page)
    check("review: estimate over budget by ₹ 10,250", any(x.startswith("Estimate is over the client budget by ₹ 10,250") for x in t), " | ".join(t))
    page.locator(".dk-check", has_text="over the client budget").get_by_role("button", name="Money").click()
    expect(page.get_by_role("heading", name="Review before export")).to_have_count(0)
    check("review 'Money' link opens the Money tab", page.url.endswith(f"#/project/{PROJECT}/money"))
    store.table("boq_items")["b1"].update(rate=180)
    store.table("fee_proposals")[PROJECT].update(milestones=[{"name": "A", "pct": 50}, {"name": "B", "pct": 50}], legal_reviewed=True)
    row = deck_row(store)
    for s in row["slides"]:
        if s["kind"] in ("asbuilt", "room"):
            s["slots"] = {"a": a, "b": a}
    page.goto(APP + f"#/project/{PROJECT}/review")  # in-app navigation: the tab must fetch fresh rows, not show its saved copy
    page.wait_for_timeout(1500)
    t = review_texts(page)
    check("review clean after fixing: 'No warnings.'", t == ["No warnings."], " | ".join(t))
    fits_phone(page, "Review (clean)", 390)
    ctx.close()

    # ---- Phone fit at 360 and 390 for each screen ------------------------------------------------------
    store.table("studio_settings")["1"]["clauses"] = {}
    store.table("project_briefs")[PROJECT]["start_date"] = "2026-10-01"
    for width in (360, 390):
        c = browser.new_context(viewport={"width": width, "height": 800}, has_touch=True, is_mobile=True, device_scale_factor=2)
        c.route(re.compile(re.escape(API) + ".*"), with_signed_gets(store, log))
        pg = c.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        sign_in(pg)
        pg.goto(APP + f"#/project/{PROJECT}/edit")
        expect(pg.get_by_role("heading", name="Brief")).to_be_visible()
        pg.wait_for_timeout(300)
        fits_phone(pg, "Edit project + brief", width)
        pg.screenshot(path=f"/tmp/deck-brief-{width}.png", full_page=True)
        pg.goto(APP + "#/settings")
        expect(pg.get_by_label("1. ABOUT STUDIO ELEMENTS")).to_be_visible()
        fits_phone(pg, "Studio settings", width)
        pg.goto(APP + f"#/project/{PROJECT}/deck")
        expect(pg.get_by_role("heading", name="Client presentation")).to_be_visible()
        pg.wait_for_timeout(400)
        fits_phone(pg, "Deck", width)
        pg.screenshot(path=f"/tmp/deck-deck-{width}.png", full_page=True)
        pg.goto(APP + f"#/project/{PROJECT}/review")
        expect(pg.get_by_role("heading", name="Review before export")).to_be_visible()
        pg.wait_for_timeout(400)
        fits_phone(pg, "Review with issues", width)
        pg.screenshot(path=f"/tmp/deck-review-{width}.png", full_page=True)
        small = pg.evaluate("() => [...document.querySelectorAll('main button, main label.pill')].filter(b => b.getBoundingClientRect().height > 0 && b.getBoundingClientRect().height < 44 && !b.classList.contains('back')).map(b => b.textContent.trim()).slice(0, 5)")
        check(f"{width}px  review buttons at least 44 px tall", not small, str(small))
        c.close()

    # ---- Coordinator: read-only settings, no fee checks ---------------------------------------------
    coord = Store("coordinator")
    seed(coord)
    coord.table("studio_settings")["1"]["clauses"] = {"about": "Based in Ahmedabad.", "dispute": "Courts of Ahmedabad."}
    clog = []
    c = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    c.route(re.compile(re.escape(API) + ".*"), with_signed_gets(coord, clog))
    pg = c.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    sign_in(pg)
    pg.goto(APP + "#/settings")
    expect(pg.get_by_text("Read only. Owners can change these.")).to_be_visible()
    check("coordinator: no save or logo buttons", pg.get_by_role("button", name="Save details").count() == 0 and pg.get_by_role("button", name="Save clause").count() == 0
          and pg.get_by_label("Replace logo").count() == 0 and pg.get_by_role("button", name="Reset to reference text").count() == 0)
    check("coordinator: fields and clauses read-only", pg.get_by_label("Studio name").get_attribute("readonly") is not None
          and pg.get_by_label("1. ABOUT STUDIO ELEMENTS").get_attribute("readonly") is not None)
    fits_phone(pg, "Studio settings (coordinator)", 390)
    pg.screenshot(path="/tmp/deck-settings-coord-390.png", full_page=True)
    pg.goto(APP + f"#/project/{PROJECT}/review")
    expect(pg.get_by_role("heading", name="Review before export")).to_be_visible()
    t = review_texts(pg)
    check("coordinator: one note instead of fee checks", "Fee checks are visible to owners." in t and not any("fee proposal" in x.lower() or "legally" in x for x in t), " | ".join(t))
    check("coordinator: fee_proposals never requested", not any("/rest/v1/fee_proposals" in u for _, u in clog))
    c.close()

    check("no page errors", not errors, "; ".join(errors[:3]))
    browser.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
