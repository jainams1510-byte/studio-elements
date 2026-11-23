"""Browser test of Project -> Money (estimate, settings, exports, quotes, work orders, RA bills, overrun flag,
variations, client report), owner and coordinator, phone sizes, against the stand-in server.

Run:  npm run build && npx vite preview --port 4181 --strictPort &
      python3 e2e/money.py
Expected amounts are worked out by hand in the comments below, not by the app's code. The stand-in does not run
database triggers, so the dates and amounts the app sends are checked in the stored rows.
No real data is touched.
"""
import os; os.environ.setdefault('APP_URL', 'http://localhost:4181/')  # noqa: E702  (before standin reads it)
import datetime as dt, io, re, sys, zipfile
from playwright.sync_api import sync_playwright, expect
from standin import *  # noqa: F403
from standin import results

SHOTS = "/tmp/money-shots"
os.makedirs(SHOTS, exist_ok=True)
TODAY_ISO = dt.date.today().isoformat()
MONEY = APP + f"#/project/{PROJECT}/money"


def section(page, name):
    page.get_by_role("group", name="Money sections").get_by_role("button", name=name, exact=True).click()


def fig(page, label, scope=".m-totals"):
    row = page.locator(f"{scope} .m-fig").filter(has=page.locator(".m-fig-label", has_text=re.compile(label)))
    return row.first.locator(".m-fig-value").inner_text()


def add_line(page, category, item, qty, unit, rate, waste="0", room=None, trade=None, source="", verified=False, optional=False):
    page.get_by_role("button", name="Add a line").click()
    f = page.locator("form.m-editor")
    f.get_by_label("Category").select_option(category)
    f.get_by_label("Item").fill(item)
    if room:
        f.get_by_label("Room").select_option(room)
    if trade:
        f.get_by_label("Trade").select_option(trade)
    f.get_by_label("Quantity").fill(qty)
    f.get_by_label("Unit").select_option(unit)
    f.get_by_label("Rate (₹)", exact=True).fill(rate)
    f.get_by_label("Wastage %").fill(waste)
    f.get_by_label("Rate source").fill(source)
    if verified:
        f.get_by_label("Rate verified").check()
    if optional:
        f.get_by_label("Optional").check()
    f.get_by_role("button", name="Save").click()
    expect(page.locator("form.m-editor")).to_have_count(0)


def item_id(store, name):
    return next(k for k, r in store.table("boq_items").items() if r["item"] == name)


def add_quote(page, vendor, amount, trade="Carpentry"):
    page.get_by_role("button", name="Add a quote").click()
    page.get_by_label("Vendor", exact=True).select_option("__new__")
    page.get_by_label("New vendor name").fill(vendor)
    page.get_by_label("Vendor trade").select_option(trade)
    page.get_by_label("Phone").fill("98250 00000")
    page.get_by_label("Trade", exact=True).select_option(trade)
    page.get_by_label("Amount (₹)").fill(amount)
    page.get_by_role("button", name="Save quote").click()


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
    errors = []

    # ============================================================== owner, 390 px phone
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, accept_downloads=True)
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=APP.rstrip("/"))
    store = Store("owner")
    down = {"on": False}
    serve = handler(store)
    # Playwright routes still answer when the context is offline, so "no signal" also fails the requests here.
    ctx.route(re.compile(re.escape(API) + ".*"), lambda route: route.abort("internetdisconnected") if down["on"] else serve(route))
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    sign_in(page)
    page.goto(MONEY)
    expect(page.get_by_text("No lines yet")).to_be_visible()
    check("estimate starts empty with no rates filled in", page.get_by_role("button", name="Add a line").is_visible())

    # Rates are never pre-filled.
    page.get_by_role("button", name="Add a line").click()
    check("new line has an empty rate and quantity",
          page.locator("form.m-editor").get_by_label("Rate (₹)", exact=True).input_value() == ""
          and page.locator("form.m-editor").get_by_label("Quantity").input_value() == "")
    page.locator("form.m-editor").get_by_role("button", name="Cancel").click()

    # Hand-worked: tiles 1,000 sq ft x 120 + 5% = 1,26,000; shutters 2 x 45,000 = 90,000; optional bar unit 60,000 left out.
    # Subtotal 2,16,000; contingency 5% = 10,800; taxable 2,26,800; GST 18% = 40,824; total 2,67,624.
    add_line(page, "Flooring and skirting", "Vitrified tiles", "1000", "sq. ft.", "120", "5", room="Living", trade="Civil", source="Agency quote", verified=True)
    add_line(page, "Wardrobes and storage", "Wardrobe shutters", "2", "no.", "45000", room="Kitchen", trade="Carpentry")
    add_line(page, "Loose furniture", "Bar unit", "1", "no.", "60000", optional=True)
    got = [fig(page, "^Subtotal$"), fig(page, "^Contingency"), fig(page, "^Taxable$"), fig(page, "^GST"), fig(page, "^Total$")]
    check("totals equal the hand-worked figures", got == ["₹ 2,16,000", "₹ 10,800", "₹ 2,26,800", "₹ 40,824", "₹ 2,67,624"], str(got))
    check("category subtotal for flooring", fig(page, "^Flooring and skirting$") == "₹ 1,26,000")
    tiles_row = page.locator("li", has=page.locator(".row-title", has_text="Vitrified tiles")).first
    t = tiles_row.inner_text().replace("\xa0", " ")
    check("line shows room, qty x rate, wastage, source and verified tag",
          all(s in t for s in ["Living", "1,000 sq. ft. × ₹ 120", "+5% wastage", "Rate: Agency quote", "Verified", "₹ 1,26,000"]), t.replace("\n", " | "))
    check("optional line is tagged", "Optional, not in total" in page.locator("li", has=page.locator(".row-title", has_text="Bar unit")).first.inner_text())
    row = store.table("boq_items")[item_id(store, "Vitrified tiles")]
    check("line saved with every field", (row["quantity"], row["rate"], row["wastage_pct"], row["unit"], row["room"], row["trade"], row["verified"], row["optional"])
          == (1000, 120, 5, "sq. ft.", "Living", "Civil", True, False), str(row))

    # Settings: contingency 10% -> 21,600; taxable 2,37,600; GST 42,768; total 2,80,368.
    page.get_by_label("Contingency %").fill("10")
    check("contingency change previews the totals", fig(page, "^Total$") == "₹ 2,80,368", fig(page, "^Total$"))
    page.get_by_role("button", name="Save settings").click()
    expect(page.get_by_role("button", name=re.compile("^(Save settings|Saving)$"))).to_have_count(0)
    brief = store.table("project_briefs").get(PROJECT, {})
    check("settings saved to the project brief (upsert)", brief.get("contingency_pct") == 10 and brief.get("estimate_gst_rate") == 18, str(brief))
    page.get_by_text("Budget and area").click()
    page.get_by_label("Client budget (₹)").fill("250000")
    page.get_by_label("Area", exact=True).fill("1200")
    page.get_by_role("button", name="Save settings").click()
    expect(page.locator(".m-var")).to_contain_text("Within budget. Remaining ₹ 12,400")  # 2,50,000 - 2,37,600
    check("budget within: remaining 12,400 before GST", "Within budget. Remaining ₹ 12,400" in page.locator(".m-var").inner_text())
    check("cost per sq ft = 2,37,600 / 1,200 = 198", fig(page, "^Cost per sq. ft.") == "₹ 198", fig(page, "^Cost per sq. ft."))
    page.get_by_label("Budget includes GST").check()
    page.get_by_role("button", name="Save settings").click()
    expect(page.locator(".m-var")).to_contain_text("exceeds")
    check("budget incl. GST: exceeds by 30,368, nothing adjusted",
          "Estimate exceeds budget by ₹ 30,368. Nothing has been adjusted." in page.locator(".m-var").inner_text(), page.locator(".m-var").inner_text())
    check("budget settings stored", store.table("project_briefs")[PROJECT].get("budget_includes_gst") is True
          and store.table("project_briefs")[PROJECT].get("client_budget") == 250000 and store.table("project_briefs")[PROJECT].get("area") == 1200)

    # ---- exports
    with page.expect_download() as dl:
        page.get_by_role("button", name="XLSX").click()
    path = f"{SHOTS}/estimate.xlsx"
    dl.value.save_as(path)
    check("XLSX file name", dl.value.suggested_filename == "Sparsh-Ekaya-estimate.xlsx", dl.value.suggested_filename)
    import openpyxl
    wb = openpyxl.load_workbook(path)
    est, summ = wb["Estimate"], wb["Summary"]
    check("XLSX has Summary and Estimate sheets", wb.sheetnames == ["Summary", "Estimate"], str(wb.sheetnames))
    check("XLSX amount is a live formula", est["H2"].value == "=D2*F2*(1+G2/100)" and est["B2"].value == "Vitrified tiles", f"{est['H2'].value} {est['B2'].value}")
    sformulas = [c.value for r in summ.iter_rows() for c in r if isinstance(c.value, str) and c.value.startswith("=")]
    check("XLSX summary uses SUMIFS on non-optional lines", any('SUMIFS(Estimate!$H:$H,Estimate!$A:$A,A6,Estimate!$I:$I,"No")' in f for f in sformulas), str(sformulas[:3]))
    vals = {r[0].value: r[1].value for r in openpyxl.load_workbook(path, data_only=True)["Summary"].iter_rows() if r[0].value}
    check("XLSX cached values match (total 2,80,368)", vals.get("Total") == 280368 and vals.get("Contingency") == 21600, str({k: vals.get(k) for k in ("Subtotal", "Contingency", "Total")}))
    with page.expect_download() as dl:
        page.get_by_role("button", name="CSV").click()
    csv = open(dl.value.path(), encoding="utf-8-sig", newline="").read()
    check("CSV has the lines and the total", "Flooring and skirting,Vitrified tiles,Living,Civil,1000,sq. ft.,120,5,126000" in csv and "\r\nTotal,,,,,,,,280368\r\n" in csv, csv[:160])
    with page.expect_download() as dl:
        page.get_by_role("button", name="Client PDF").click()
    pdf = open(dl.value.path(), "rb").read()
    check("client PDF is a PDF with the header and Rs.", pdf.startswith(b"%PDF") and b"Draft estimate. Figures are subject to verification" in pdf and b"Rs." in pdf and b"Sparsh Ekaya" in pdf)
    check("client PDF shows optional lines by default and no rates", b"Bar unit" in pdf and b"Agency quote" not in pdf)
    page.get_by_text("What the client PDF shows").click()
    page.get_by_label("Optional lines").uncheck()
    page.get_by_label("Rate source").check()
    page.wait_for_timeout(300)
    check("PDF ticks saved to the brief", store.table("project_briefs")[PROJECT].get("estimate_pdf", {}).get("optional") is False
          and store.table("project_briefs")[PROJECT]["estimate_pdf"].get("src") is True)
    with page.expect_download() as dl:
        page.get_by_role("button", name="Client PDF").click()
    pdf2 = open(dl.value.path(), "rb").read()
    check("PDF follows the ticks (no optional line, rate source shown)", b"Bar unit" not in pdf2 and b"Agency quote" in pdf2)
    page.screenshot(path=f"{SHOTS}/estimate-390.png", full_page=True)

    # ---- quotes and work orders
    section(page, "Quotes & orders")
    add_quote(page, "Shree Interiors", "85000")
    expect(page.get_by_text("Shree Interiors").first).to_be_visible()
    add_quote(page, "Om Woodworks", "92000")
    expect(page.locator(".m-quote", has_text="Om Woodworks")).to_be_visible()
    page.get_by_role("button", name="Add a quote").click()
    page.get_by_label("Vendor", exact=True).select_option("__new__")
    page.get_by_label("New vendor name").fill("shree  interiors")
    page.get_by_label("Amount (₹)").fill("1")
    page.get_by_role("button", name="Save quote").click()
    check("duplicate vendor name refused clearly", page.get_by_role("alert").filter(has_text="already exists").count() == 1)
    check("no duplicate vendor stored", len(store.table("vendors")) == 2, str(len(store.table("vendors"))))
    page.get_by_role("button", name="Cancel").click()
    card = page.locator(".card", has=page.get_by_text("Carpentry", exact=True))
    check("comparison shows the Carpentry estimate (90,000)", "Estimate ₹ 90,000" in card.inner_text(), card.inner_text().replace("\n", " | ")[:200])
    shree = page.locator(".m-quote", has_text="Shree Interiors")
    om = page.locator(".m-quote", has_text="Om Woodworks")
    check("lowest quote highlighted", "Lowest" in shree.inner_text() and "Lowest" not in om.inner_text() and "lowest" in (shree.get_attribute("class") or ""))
    check("difference vs estimate", "₹ 5,000 under estimate" in shree.inner_text().replace("\xa0", " ") and "₹ 2,000 over estimate" in om.inner_text().replace("\xa0", " "))
    shree.get_by_role("group").get_by_role("button", name="Accepted").click()
    expect(shree.get_by_role("button", name="Issue work order")).to_be_visible()
    shree.get_by_role("button", name="Issue work order").click()
    check("work order offers the Carpentry line, ticked", page.get_by_role("checkbox", name=re.compile("^Wardrobe shutters")).is_checked() and page.get_by_role("checkbox", name=re.compile("^Vitrified tiles")).count() == 0)
    page.get_by_label("Committed rate for Wardrobe shutters").fill("42000")
    page.screenshot(path=f"{SHOTS}/workorder-390.png", full_page=True)
    page.get_by_role("button", name="Save work order").click()
    expect(page.locator("form.m-inset")).to_have_count(0)
    wos = list(store.table("work_orders").values())
    sh = item_id(store, "Wardrobe shutters")
    check("work order stored from the quote", len(wos) == 1 and wos[0]["amount"] == 85000 and wos[0]["quote_id"] and wos[0]["trade"] == "Carpentry", str(wos))
    check("BOQ line assigned with committed rate", store.table("boq_items")[sh].get("work_order_id") == wos[0]["id"] and store.table("boq_items")[sh].get("committed_rate") == 42000)
    check("committed total = 2 x 42,000 = 84,000", "Committed ₹ 84,000" in page.locator(".row-line", has_text="Work orders").inner_text())
    check("quote status saved", next(q for q in store.table("quotes").values() if q["amount"] == 85000)["status"] == "accepted")
    page.screenshot(path=f"{SHOTS}/quotes-390.png", full_page=True)

    # ---- RA bill: lines -> measured -> certified -> client approved -> paid
    section(page, "Bills")
    page.get_by_role("button", name="New bill").click()
    page.get_by_label("Vendor", exact=True).select_option(label="Shree Interiors")
    page.get_by_label("Work order, optional").select_option(index=1)
    page.get_by_label("Bill no.").fill("1")
    page.get_by_label("Claimed (₹, before GST)").fill("90000")
    page.get_by_role("button", name="Save bill").click()
    expect(page.get_by_role("button", name="Add a BOQ line")).to_be_visible()
    page.get_by_role("button", name="Add a BOQ line").click()
    check("bill lines default to the work order's lines", page.get_by_label("Only lines on this bill’s work order").is_checked())
    page.get_by_label("BOQ line").select_option(label="Wardrobe shutters · Kitchen")
    page.get_by_label("Claimed qty", exact=True).fill("2")
    page.get_by_label("Certified qty", exact=True).fill("2")
    page.get_by_role("button", name="Add line").click()
    expect(page.locator(".m-bline")).to_have_count(1)
    bill = next(iter(store.table("ra_bills").values()))
    line = next(iter(store.table("ra_bill_lines").values()))
    check("bill stored as submitted with work order", bill["status"] == "submitted" and bill["work_order_id"] == wos[0]["id"] and bill["claimed_amount"] == 90000)
    check("bill line stored at the committed rate", (line["claimed_qty"], line["certified_qty"], line["rate"]) == (2, 2, 42000), str(line))
    check("lines total 2 x 42,000 = 84,000", fig(page, "^Lines, certified qty$", ".m-bill-body") == "₹ 84,000.00")
    page.get_by_role("button", name="Mark measured").click()
    expect(page.get_by_role("button", name="Certify")).to_be_visible()
    page.get_by_role("button", name="Certify").click()
    expect(page.get_by_role("button", name="Client approved")).to_be_visible()
    bill = next(iter(store.table("ra_bills").values()))
    check("certified amount defaults to the lines total", bill["status"] == "certified" and bill["certified_amount"] == 84000 and bill["certified_on"] == TODAY_ISO, str(bill))
    check("GST and total payable: 84,000 + 15,120 = 99,120",
          fig(page, "^GST 18%$", ".m-bill-body") == "₹ 15,120.00" and fig(page, "^Total payable$", ".m-bill-body") == "₹ 99,120.00")
    check("owner can step back after certification", page.get_by_role("button", name="Step back to Measured").is_visible())
    page.get_by_role("button", name="Client approved").click()
    expect(page.get_by_role("button", name="Mark paid")).to_be_visible()
    page.screenshot(path=f"{SHOTS}/bill-390.png", full_page=True)
    page.get_by_role("button", name="Mark paid").click()
    expect(page.locator(".m-bill-head .htag", has_text="Paid")).to_be_visible()
    bill = next(iter(store.table("ra_bills").values()))
    check("paid with amount = certified x 1.18 and stamped dates", bill["status"] == "paid" and bill["paid_amount"] == 99120
          and bill["client_approved_on"] == TODAY_ISO and bill["paid_on"] == TODAY_ISO, str(bill))
    stepper = page.locator(".m-steps").inner_text()
    check("stepper shows stamped dates", stepper.count(dt.date.today().strftime("%b")) >= 3, stepper.replace("\n", " | "))

    section(page, "Estimate")
    sh_row = page.locator("li", has=page.locator(".row-title", has_text="Wardrobe shutters")).first.inner_text()
    check("ledger on the line: committed, certified and paid 84,000", all(s in sh_row for s in ["Committed ₹ 84,000", "Certified ₹ 84,000", "Paid ₹ 84,000"]), sh_row.replace("\n", " | "))

    # ---- overrun: a certified bill for tiles at 1,150 sq ft x 120 = 1,38,000 > 1,26,000 x 1.05 = 1,32,300
    tl = item_id(store, "Vitrified tiles")
    store.table("vendors")["v-tile"] = {"id": "v-tile", "name": "Tile Co", "kind": "agency", "trade": "Civil", "contact_name": None, "phone": None,
                                        "email": None, "gstin": None, "notes": "", "archived": False}
    store.table("ra_bills")["b-tile"] = {"id": "b-tile", "project_id": PROJECT, "vendor_id": "v-tile", "work_order_id": None, "bill_no": "4",
                                         "bill_date": "2026-11-10", "claimed_amount": 140000, "certified_amount": 138000, "gst_rate": 18, "status": "certified",
                                         "certified_on": "2026-11-12", "client_approved_on": None, "paid_on": None, "paid_amount": None, "note": "",
                                         "file_link": None, "removed_at": None}
    store.table("ra_bill_lines")["l-tile"] = {"id": "l-tile", "bill_id": "b-tile", "boq_item_id": tl, "claimed_qty": 1160, "certified_qty": 1150, "rate": 120}
    ten_ago = (dt.date.today() - dt.timedelta(days=10)).isoformat()
    store.table("ra_bills")["b-late"] = {**store.table("ra_bills")["b-tile"], "id": "b-late", "bill_no": "7", "status": "client_approved",
                                         "certified_amount": 50000, "client_approved_on": ten_ago}
    store.table("decisions")["dec1"] = {"id": "dec1", "project_id": PROJECT, "question": "Change kitchen counter to quartz?", "boq_item_id": None, "status": "answered"}
    store.table("variations")["var1"] = {"id": "var1", "project_id": PROJECT, "decision_id": "dec1", "boq_item_id": None,
                                         "description": "Change kitchen counter to quartz?", "amount": 18000, "status": "proposed",
                                         "client_approved_on": None, "removed_at": None}
    page.reload()
    section(page, "Estimate")
    tiles = page.locator("li", has=page.locator(".row-title", has_text="Vitrified tiles")).first
    expect(tiles).to_contain_text("Certified ₹ 1,38,000")
    check("overrun flag: over budget by 9.5% (12,000 / 1,26,000)", "Over budget by 9.5% — needs a variation" in tiles.inner_text(), tiles.inner_text().replace("\n", " | "))
    check("no overrun flag on the line within budget", "Over budget" not in page.locator("li", has=page.locator(".row-title", has_text="Wardrobe shutters")).first.inner_text())

    section(page, "Bills")
    check("client-approved 10 days ago and unpaid is flagged", page.get_by_text("Client approved 10 days ago, unpaid").count() >= 1)

    section(page, "Variations")
    check("variation from a decision shows its question", page.get_by_text("From decision: “Change kitchen counter to quartz?”").is_visible())
    page.get_by_role("group", name="Status of Change kitchen counter to quartz?").get_by_role("button", name="Costed").click()
    page.wait_for_timeout(300)
    check("variation status stepped to costed", store.table("variations")["var1"]["status"] == "costed")
    flag = page.locator(".flag", has_text="Vitrified tiles")
    check("overrun listed under variations", "needs a variation" in flag.inner_text())
    flag.get_by_role("button", name="Add variation").click()
    page.get_by_label("Amount (₹)").fill("12000")
    check("variation form linked to the over-budget line", page.get_by_label("BOQ line").input_value() == tl)
    page.get_by_role("button", name="Save variation").click()
    expect(page.locator(".flag", has_text="Vitrified tiles")).to_have_count(0)
    v = next(x for x in store.table("variations").values() if x["id"] != "var1")
    check("manual variation stored, proposed, linked", v["boq_item_id"] == tl and v["amount"] == 12000 and v["status"] == "proposed")
    page.screenshot(path=f"{SHOTS}/variations-390.png", full_page=True)
    section(page, "Estimate")
    check("variation clears the overrun flag", "Over budget" not in page.locator("li", has=page.locator(".row-title", has_text="Vitrified tiles")).first.inner_text())

    # ---- client report
    section(page, "Client report")
    rep = page.locator(".m-report").inner_text()
    check("client report: category totals and every non-optional item",
          all(s in rep for s in ["Flooring and skirting", "₹ 1,26,000", "Vitrified tiles", "Wardrobe shutters", "₹ 90,000"]) and "Bar unit" not in rep, rep[:200].replace("\n", " | "))
    check("client report totals: contingency 21,600, GST 42,768, total 2,80,368",
          fig(page, r"^Contingency \(10%\)$", ".m-report") == "₹ 21,600" and fig(page, r"^GST \(18%\)$", ".m-report") == "₹ 42,768" and fig(page, "^Total$", ".m-report") == "₹ 2,80,368")
    page.get_by_role("button", name="Copy").click()
    expect(page.get_by_role("status").filter(has_text="Copied")).to_be_visible()
    clip = page.evaluate("navigator.clipboard.readText()")
    check("copied text has items and totals, no optional line", "• Vitrified tiles · Living · 1,000 sq. ft.: ₹ 1,26,000" in clip and "Total: ₹ 2,80,368" in clip and "Bar unit" not in clip, clip[:120])
    with page.expect_download() as dl:
        page.get_by_role("button", name="PDF").click()
    check("client report PDF downloads", open(dl.value.path(), "rb").read().startswith(b"%PDF"))
    page.screenshot(path=f"{SHOTS}/report-390.png", full_page=True)

    # ---- owner removes and restores a line
    section(page, "Estimate")
    page.locator("button.row", has_text="Bar unit").click()
    page.get_by_role("button", name="Remove line").click()
    page.get_by_role("button", name="Remove", exact=True).click()
    expect(page.get_by_text("Removed lines (1)")).to_be_visible()
    bar = item_id(store, "Bar unit")
    check("removed line hidden, not deleted", store.table("boq_items")[bar]["removed_at"] is not None and page.locator(".row-title", has_text="Bar unit").count() == 0)
    page.get_by_text("Removed lines (1)").click()
    page.get_by_role("button", name="Restore").click()
    expect(page.locator(".row-title", has_text="Bar unit")).to_have_count(1)
    check("line restored", store.table("boq_items")[bar]["removed_at"] is None)

    # ---- offline: the phone's copy, read-only
    ctx.set_offline(True)
    down["on"] = True
    page.goto(APP + f"#/project/{PROJECT}/drawings")
    page.goto(MONEY)
    expect(page.get_by_text("No signal.").first).to_be_visible()
    check("offline shows the cached estimate read-only", page.locator(".row-title", has_text="Vitrified tiles").count() == 1
          and page.get_by_role("button", name="Add a line").count() == 0 and page.get_by_role("button", name="Save settings").count() == 0)
    ctx.set_offline(False)
    ctx.close()

    # ============================================================== coordinator: certified bill is locked
    cstore = Store("coordinator")
    for name in ("boq_items", "vendors", "ra_bills", "ra_bill_lines", "work_orders"):
        cstore.tables[name] = {k: dict(v) for k, v in store.table(name).items()}
    cctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    cctx.route(re.compile(re.escape(API) + ".*"), handler(cstore))
    cpage = cctx.new_page()
    cpage.on("pageerror", lambda e: errors.append(str(e)))
    sign_in(cpage)
    cpage.goto(MONEY)
    section(cpage, "Bills")
    cpage.locator(".m-bill-head", has_text="RA bill 4").click()
    check("coordinator sees the certified lock message", cpage.get_by_text("The certified amount and the bill lines are locked").is_visible())
    check("coordinator cannot step back or edit certified figures", cpage.get_by_role("button", name=re.compile("^Step back")).count() == 0
          and cpage.get_by_label("Certified amount (₹, before GST)").count() == 0 and cpage.get_by_role("button", name="Add a BOQ line").count() == 0)
    check("coordinator can move it forward", cpage.get_by_role("button", name="Client approved", exact=True).is_visible())
    section(cpage, "Estimate")
    cpage.locator("button.row", has_text="Bar unit").click()
    check("coordinator gets no Remove on a line", cpage.get_by_role("button", name="Remove line").count() == 0)
    cctx.close()

    # ============================================================== phone fit, every section, 360 and 390
    for width in (360, 390):
        fctx = browser.new_context(viewport={"width": width, "height": 800}, has_touch=True, is_mobile=True, device_scale_factor=2)
        fctx.route(re.compile(re.escape(API) + ".*"), handler(store))
        fp = fctx.new_page()
        fp.on("pageerror", lambda e: errors.append(str(e)))
        sign_in(fp)
        fp.goto(MONEY)
        section(fp, "Estimate")
        expect(fp.locator(".m-totals")).to_be_visible()
        fp.get_by_text("Budget and area").click()
        fits_phone(fp, "Money · Estimate", width)
        fp.get_by_role("button", name="Add a line").click()
        fits_phone(fp, "Money · Estimate line editor", width)
        fp.locator("form.m-editor").get_by_role("button", name="Cancel").click()
        section(fp, "Quotes & orders")
        fp.get_by_role("button", name="Add a quote").click()
        fp.get_by_label("Vendor", exact=True).select_option("__new__")
        fits_phone(fp, "Money · Quotes and add-quote form", width)
        fp.get_by_role("button", name="Cancel").click()
        fp.get_by_role("button", name="BOQ lines").first.click()
        fits_phone(fp, "Money · Work order lines", width)
        section(fp, "Bills")
        fp.locator(".m-bill-head", has_text="RA bill 4").click()
        fits_phone(fp, "Money · Bills with a bill open", width)
        if width == 390:
            fp.screenshot(path=f"{SHOTS}/bill-open-390.png", full_page=True)
        fp.get_by_role("button", name="New bill").click()
        fits_phone(fp, "Money · New bill form", width)
        section(fp, "Variations")
        fits_phone(fp, "Money · Variations", width)
        section(fp, "Client report")
        fits_phone(fp, "Money · Client report", width)
        if width == 360:
            fp.screenshot(path=f"{SHOTS}/report-360.png", full_page=True)
            section(fp, "Estimate")
            fp.screenshot(path=f"{SHOTS}/estimate-360.png", full_page=True)
        fctx.close()

    check("no page errors", not errors, "; ".join(errors[:3]))
    browser.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
