"""Phone-layout test: every screen must fit the phone's width, so the browser never zooms out.

Run:  npm run build && npx vite preview --port 4173 --strictPort &
      python3 e2e/mobile_layout.py
Uses the shared stand-in server (no real data). For each screen, at 360 and 390 px wide, it checks that
nothing sticks out past the right edge (except inside a deliberate sideways-scrolling area), that the
page cannot be scrolled sideways, and that text boxes are at least 16 px (smaller ones make iPhones
zoom in when tapped).
"""
import re, sys
from playwright.sync_api import sync_playwright, expect
import datetime as dt
from standin import APP, API, PROJECT, START, TODAY, Store, check, handler, results, sign_in

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

SMALL_INPUTS = """() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=file]), select, textarea')]
  .filter(e => e.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(e).fontSize) < 16)
  .map(e => `${e.tagName.toLowerCase()} ${e.getAttribute('aria-label') || e.name || ''} ${getComputedStyle(e).fontSize}`)"""


def measure(page, name, width):
    page.wait_for_timeout(250)
    m = page.evaluate(FIND_OVERFLOW)
    ok = m["inner"] <= width and m["scroll"] <= width and not m["out"]
    check(f"{width}px  {name}: fits the screen", ok, "" if ok else f"inner {m['inner']}, scroll {m['scroll']}, {m['out']}")
    small = page.evaluate(SMALL_INPUTS)
    check(f"{width}px  {name}: text boxes 16 px or more", not small, "; ".join(small[:3]))


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
    errors = []
    store = Store("owner")

    # Build a realistic schedule once, through the app itself.
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    ctx.route(re.compile(re.escape(API) + ".*"), handler(store))
    page = ctx.new_page()
    sign_in(page)
    page.goto(APP + f"#/project/{PROJECT}/schedule")
    page.get_by_label("Schedule starts on").fill(START.isoformat())
    page.get_by_role("button", name="Create schedule").click()
    expect(page.get_by_text("Forecast finish")).to_be_visible()
    for t in store.tasks.values():  # long names, as real ones will be
        if t["name"] == "Electrical and plumbing rough-ins":
            t["name"] = "Electrical and plumbing rough-ins, living, dining and all four bedrooms"
        if t["name"] == "Electrical drawings":  # started 10 days ago for 4 days, waiting on SE-EL-01 at P2
            t.update(status="in_progress", actual_start=(TODAY - dt.timedelta(days=10)).isoformat(), gate_drawing_id="d1", owner_name="Malav")
    # The site holds P1 of SE-EL-01 while P2 is current.
    store.drawings["d1"]["drawing_revisions"].insert(0, {"id": "r0", "code": "P1", "rank": 1, "revised_on": "2026-11-10", "note": "",
        "file_link": None, "created_at": "2026-11-10T10:00:00Z", "drawing_issues": [{"id": "i0", "issued_to": "Site", "method": "Print on site",
        "issued_on": "2026-11-11", "print_photo_path": None, "created_at": "2026-11-11T10:00:00Z"}]})
    ctx.close()

    for width in (360, 390):
        ctx = browser.new_context(viewport={"width": width, "height": 800}, has_touch=True, is_mobile=True, device_scale_factor=3)
        ctx.route(re.compile(re.escape(API) + ".*"), handler(store))
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        sign_in(page)
        expect(page.get_by_text("Schedule at risk").or_(page.get_by_text("Schedule delayed")).first).to_be_visible()
        measure(page, "Today (briefing, tiles, chart, cards, activity)", width)
        page.screenshot(path=f"/tmp/m-today-{width}.png", full_page=True)
        if width == 390:
            brief = page.locator(".brief").inner_text()
            check("briefing names the project at risk", "Sparsh Ekaya" in brief and "Biggest concern" in brief, brief.replace("\n", " | "))
            check("handover chart drawn", page.locator("svg.handover circle").count() == 1)
            card = page.locator(".pcard").first.inner_text()
            check("project card shows status, progress and days to handover", ("At risk" in card or "Delayed" in card) and "% " in card.replace("\n", " ") and " d" in card,
                  card.replace("\n", " | "))
            check("activity feed lists the print issue", page.get_by_text("SE-EL-01 P1 issued to Site by Print on site").count() == 1)
            tile = int(page.locator(".tile-k").first.locator("b").inner_text())
            page.locator(".tile-k").first.click()
            expect(page.get_by_role("heading", name="Drafts")).to_be_visible()
            cards = page.locator("li.draft")
            check("drafts tile count matches the drafts listed", cards.count() == tile and tile >= 3, f"{tile} vs {cards.count()}")
            kinds = page.locator("li.draft .tag").all_inner_texts()
            check("drafts include a site print note and internal reminders", "Site" in kinds and "Internal" in kinds, ", ".join(kinds))
            site = page.locator("li.draft", has_text="Replace print SE-EL-01")
            check("site draft says which print to use", "use only P2" in site.locator("textarea").input_value())
            site.get_by_role("button", name="Dismiss").click()
            expect(page.locator("li.draft")).to_have_count(tile - 1)
            check("dismissing removes the draft", True)
            page.reload()
            expect(page.get_by_role("heading", name="Drafts")).to_be_visible()
            page.wait_for_timeout(500)
            check("a dismissed draft stays dismissed after reopening", page.locator("li.draft").count() == tile - 1)
            measure(page, "Drafts", width)
            page.screenshot(path="/tmp/m-drafts.png", full_page=True)
            page.goto(APP + "#/team")
            expect(page.get_by_role("heading", name="Team workload")).to_be_visible()
            page.wait_for_timeout(300)
            check("team workload puts Malav's overdue task first", page.locator("section h2").first.inner_text().startswith("Malav") and
                  "Overdue" in page.locator("section").first.inner_text())
        page.goto(APP + "#/drafts"); expect(page.get_by_role("heading", name="Drafts")).to_be_visible()
        measure(page, "Drafts", width)
        page.goto(APP + "#/team"); expect(page.get_by_role("heading", name="Team workload")).to_be_visible()
        measure(page, "Team workload", width)
        page.goto(APP + "#/projects"); expect(page.get_by_role("heading", name="Projects")).to_be_visible()
        measure(page, "Projects (with backup card)", width)
        page.goto(APP + "#/log"); page.wait_for_timeout(300)
        measure(page, "New log", width)
        page.goto(APP + "#/review"); page.wait_for_timeout(300)
        measure(page, "Review", width)
        for tab in ("", "/drawings", "/reports"):
            page.goto(APP + f"#/project/{PROJECT}{tab}"); page.wait_for_timeout(300)
            measure(page, f"Project {tab or '/logs'}", width)
        page.goto(APP + "#/drawing/d1"); page.wait_for_timeout(300)
        measure(page, "Drawing detail", width)

        page.goto(APP + f"#/project/{PROJECT}/schedule")
        expect(page.get_by_text("Forecast finish")).to_be_visible()
        measure(page, "Schedule tab", width)
        page.locator("li.task", has_text="Electrical and plumbing rough-ins").get_by_role("button", name=re.compile("^Electrical and plumbing")).click()
        expect(page.get_by_role("heading", name="Edit task")).to_be_visible()
        page.get_by_role("button", name="In progress").click()
        measure(page, "Task editor (long name, dates shown)", width)
        page.get_by_role("button", name="Cancel").click()
        page.get_by_text(re.compile("^Calendar:")).click()
        measure(page, "Calendar settings open", width)
        page.get_by_role("button", name="Add a task").click()
        measure(page, "Add task form", width)

        page.goto(APP + f"#/project/{PROJECT}/timeline")
        expect(page.get_by_role("heading", name="Timeline")).to_be_visible()
        measure(page, "Timeline", width)
        g = page.evaluate("""() => { const c = document.querySelector('.gantt-chart'); const t = c.querySelector('line[data-today]');
          const x = Number(t.getAttribute('x1')); return { w: c.clientWidth, sw: c.scrollWidth, left: c.scrollLeft, x } }""")
        check(f"{width}px  timeline chart gets most of the width", g["w"] >= width * 0.5, f"{g['w']}px")
        check(f"{width}px  timeline chart swipes sideways and opens at today", g["sw"] > g["w"] and g["left"] <= g["x"] <= g["left"] + g["w"], str(g))
        page.locator(".gantt-name").nth(3).click()
        measure(page, "Timeline with a task selected", width)
        page.screenshot(path=f"/tmp/m-timeline-{width}.png", full_page=True)
        page.goto(APP + f"#/project/{PROJECT}/schedule")
        expect(page.get_by_text("Forecast finish")).to_be_visible()
        page.screenshot(path=f"/tmp/m-schedule-{width}.png")
        ctx.close()

    check("no script errors", not errors, "; ".join(errors[:3]))
    browser.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
