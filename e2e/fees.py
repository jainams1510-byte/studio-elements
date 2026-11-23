"""Browser test of studio money: Fees tab (proposal, agreed fee, invoices, costs, margin, exports), Finances, Vendors.

Run:  npm run build && (npx vite preview --port 4182 --strictPort &) && python3 e2e/fees.py
Uses the shared stand-in server (no real data). The stand-in runs no database triggers, so the app's own
requests are checked instead. Expected figures are worked out here by hand, independently of the app's code.
"""
import os
os.environ.setdefault('APP_URL', 'http://localhost:4182/')
import datetime as dt, html, io, math, re, sys, zipfile
from playwright.sync_api import sync_playwright, expect
from standin import APP, API, PROJECT, START, TODAY, Store, check, fits_phone, handler, nth_workday, results, sign_in


# ---- independent formatting (Indian grouping) -------------------------------------------------
def group(n):
    s = str(abs(n))
    head, tail = s[:-3], s[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ("-" if n < 0 else "") + ",".join(parts + [tail]) if parts else ("-" if n < 0 else "") + tail


def jround(x):
    return math.floor(x + 0.5)


def inr(v):
    return "₹ " + group(jround(v))


def inr_exact(v):
    whole = int(abs(v))
    paise = jround((abs(v) - whole) * 100)
    return "₹ " + group(whole) + f".{paise:02d}"


def inr_short(v):
    a, sign = abs(v), ("−" if v < 0 else "")
    def t(x):
        r = jround(x * 10) / 10
        return str(int(r)) if r == int(r) else str(r)
    if a >= 1e7: return f"{sign}₹ {t(a / 1e7)} Cr"
    if a >= 1e5: return f"{sign}₹ {t(a / 1e5)} L"
    if a >= 1e3: return f"{sign}₹ {t(a / 1e3)} K"
    return f"{sign}₹ {jround(a)}"


def long_date(d):
    return f"{d.day} {d.strftime('%b')} {d.year}"


def day_label(d):
    return f"{d.day} {d.strftime('%b')}"


def pct(part, whole):
    return jround(part / whole * 1000) / 10


# ---- seed ---------------------------------------------------------------------------------------
TM1_END = nth_workday(START, 4)    # "Concept approved": done, on day 4
TM2_END = nth_workday(START, 14)   # "Working drawings issued": after 5 + 10 working days


def task(tid, name, duration, after=(), **kw):
    return {"id": tid, "project_id": PROJECT, "stage": 3, "name": name, "trade": None, "room": None, "owner_name": None,
            "duration": duration, "milestone": duration == 0, "after_ids": list(after), "status": "planned", "actual_start": None,
            "actual_end": None, "gate_drawing_id": None, "baseline_start": None, "baseline_end": None, "sort_order": 0, "removed_at": None, **kw}


def seed(store):
    store.table("project_briefs")[PROJECT] = {
        "project_id": PROJECT, "client_name": "Mr Sunil Shah", "client_phone": None, "client_email": None,
        "site_address": "Sparsh Ekaya, Bopal", "city": "Ahmedabad", "typology": "residential", "area": 1500, "area_unit": "sq. ft.",
        "issue_date": TODAY.isoformat(), "agreement_date": None, "start_date": None, "end_date": None, "duration_months": 10,
        "client_budget": None, "budget_includes_gst": False, "estimate_gst_rate": 18, "contingency_pct": 5, "estimate_pdf": {}}
    store.schedules[PROJECT] = {"project_id": PROJECT, "start_date": START.isoformat(), "work_days": [1, 2, 3, 4, 5, 6], "holidays": [],
                                "baseline_at": None, "baseline_by": None}
    for t in (task("ta", "Concept design", 5),
              task("tm1", "Concept approved", 0, ["ta"], status="done", actual_start=TM1_END.isoformat(), actual_end=TM1_END.isoformat()),
              task("tb", "Working drawings", 10, ["tm1"]),
              task("tm2", "Working drawings issued", 0, ["tb"])):
        store.tasks[t["id"]] = t
    store.table("vendors")["v1"] = {"id": "v1", "name": "Sharma Interiors", "kind": "agency", "trade": "Carpentry", "contact_name": "Ramesh",
                                    "phone": "98250 12345", "email": None, "gstin": None, "notes": "", "archived": False}
    store.table("work_orders")["w1"] = {"id": "w1", "project_id": PROJECT, "vendor_id": "v1", "quote_id": None, "trade": "Carpentry",
                                        "amount": 400000, "issued_on": "2026-11-01", "note": "", "file_link": None, "removed_at": None}
    bill = lambda bid, status, cert, **kw: {"id": bid, "project_id": PROJECT, "vendor_id": "v1", "work_order_id": "w1", "bill_no": bid,
                                            "bill_date": "2026-11-10", "claimed_amount": 0, "certified_amount": cert, "gst_rate": 18,
                                            "status": status, "certified_on": None, "client_approved_on": None, "paid_on": None,
                                            "paid_amount": None, "note": "", "file_link": None, "removed_at": None, **kw}
    store.table("ra_bills").update({"RA-1": bill("RA-1", "client_approved", 100000, client_approved_on="2026-11-12"),
                                    "RA-0": bill("RA-0", "paid", 50000, paid_amount=59000),
                                    "RA-2": bill("RA-2", "submitted", None)})
    for qid in ("q1", "q2"):
        store.table("quotes")[qid] = {"id": qid, "project_id": PROJECT, "vendor_id": "v1", "trade": "Carpentry", "amount": 1, "received_on": "2026-10-01",
                                      "status": "received", "note": "", "file_link": None, "removed_at": None}
    def item(iid, expected, delivered, status="on_site"):
        return {"id": iid, "project_id": PROJECT, "item": iid, "trade": None, "room": None, "task_id": None, "need_by": None, "lead_days": 14,
                "vendor_id": "v1", "spec_approved": True, "status": status, "ordered_on": None, "expected_on": expected, "delivered_on": delivered,
                "note": "", "removed_at": None}
    for it in (item("p1", "2026-11-01", "2026-10-30"), item("p2", "2026-11-01", "2026-11-01"), item("p3", "2026-11-01", "2026-11-04"),
               item("p4", "2026-12-01", None, "ordered")):
        store.table("procurement_items")[it["id"]] = it


def tile(page, label):
    return page.locator(".fees-tile", has=page.get_by_text(label, exact=True)).locator("b").inner_text()


def chip(page, name):
    page.get_by_role("group", name="Fees sections").get_by_role("button", name=re.compile("^" + name)).click()


errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
    store = Store("owner")
    seed(store)
    state = {"offline": False}
    base = handler(store)

    def route(r):
        if state["offline"] and "/rest/v1/" in r.request.url:
            return r.abort()
        return base(r)

    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, accept_downloads=True)
    ctx.route(re.compile(re.escape(API) + ".*"), route)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    sign_in(page)

    # ---- Proposal ------------------------------------------------------------------------------
    page.goto(APP + f"#/project/{PROJECT}/fees")
    expect(page.get_by_label("Fixed fee (₹)")).to_be_visible()
    fits_phone(page, "Fees: proposal (empty)", 390)
    page.get_by_label("Fixed fee (₹)").fill("175000")
    # Hand-worked: 1,75,000 × 20/30/30/20 % = 35,000 / 52,500 / 52,500 / 35,000; GST 18% = 31,500; payable 2,06,500.
    got = [page.get_by_test_id(f"stage-{i}").inner_text() for i in range(1, 5)]
    check("stage fees are 20/30/30/20 % of ₹1,75,000", got == ["₹ 35,000", "₹ 52,500", "₹ 52,500", "₹ 35,000"], str(got))
    check("total and total payable incl. 18% GST", page.get_by_test_id("fee-total").inner_text() == "₹ 1,75,000"
          and page.get_by_test_id("fee-payable").inner_text() == "₹ 2,06,500")
    check("amount in words, before GST", "Rupees One Lakh Seventy Five Thousand Only (fee before GST)" in page.get_by_test_id("fee-words").inner_text())
    check("stages reconcile message", page.get_by_text("Stage fees reconcile with the total.").is_visible())
    page.locator("li.fees-stage").nth(1).get_by_label("Override ₹").fill("60000")
    # 35,000 + 60,000 + 52,500 + 35,000 = 1,82,500, 7,500 over.
    check("override that breaks the total is flagged with the difference",
          page.get_by_text("Stage fees add up to ₹ 1,82,500, which differs from the total by ₹ 7,500").is_visible())
    page.locator("li.fees-stage").nth(1).get_by_label("Override ₹").fill("")
    expect(page.get_by_text("Stage fees reconcile with the total.")).to_be_visible()
    miles = page.locator("li.fees-mile")
    miles.nth(3).get_by_label("%").fill("10")
    check("milestones not totalling 100% are flagged", page.get_by_text("Milestones total 90%, not 100%.").is_visible())
    miles.nth(3).get_by_label("%").fill("20")
    page.get_by_role("button", name="Add a milestone").click()
    check("adding a milestone adds a row", miles.count() == 5)
    page.get_by_role("button", name="Remove milestone 5").click()
    check("milestones back to 100%", page.get_by_text("Milestones total 100%.").is_visible() and miles.count() == 4)
    page.get_by_role("button", name="Per sq. ft.").click()
    page.get_by_label("Rate per sq. ft. (₹)").fill("120")
    check("per sq. ft.: 1,500 sq. ft. × ₹120 = ₹1,80,000", page.get_by_test_id("fee-total").inner_text() == "₹ 1,80,000")
    page.get_by_role("button", name="% of client budget").click()
    check("% of budget with no client budget says what is needed", page.get_by_text("Needed for this method: the client budget").is_visible())
    page.get_by_role("button", name="Fixed fee").click()
    check("fixed fee kept when switching back", page.get_by_test_id("fee-total").inner_text() == "₹ 1,75,000")
    page.get_by_label("Contract clauses reviewed by a legal professional").check()
    page.get_by_role("button", name="Use as the agreed fee").click()
    expect(page.get_by_text("The agreed fee is now ₹ 1,75,000 before GST.")).to_be_visible()
    fee = store.table("project_fees").get(PROJECT, {})
    prop = store.table("fee_proposals").get(PROJECT, {})
    check("agreed fee saved (₹1,75,000, 18%, 7 days)", fee.get("fee_amount") == 175000 and fee.get("gst_rate") == 18 and fee.get("payment_terms_days") == 7, str(fee))
    check("proposal saved with method, fee, milestones and legal tick", prop.get("method") == "fixed" and prop.get("fixed_fee") == 175000
          and [m["pct"] for m in prop.get("milestones", [])] == [20, 30, 30, 20] and prop.get("legal_reviewed") is True, str(prop)[:200])
    expect(page.locator(".fees-tile", has=page.get_by_text("Agreed fee (before GST)", exact=True)).locator("b")).to_have_text(inr_short(175000))
    check("agreed fee tile", tile(page, "Agreed fee (before GST)") == inr_short(175000), tile(page, "Agreed fee (before GST)"))

    # Exports
    with page.expect_download() as dl:
        page.get_by_role("button", name="Export DOCX").click()
    d = dl.value
    check("DOCX file name", d.suggested_filename == "Sparsh-Ekaya-Fee-Proposal.docx", d.suggested_filename)
    xml = zipfile.ZipFile(d.path()).read("word/document.xml").decode("utf-8")
    plain = html.unescape(re.sub(r"<[^>]+>", "", xml))
    check("DOCX has the project name, title, client and fee table",
          "Sparsh Ekaya" in plain and "DESIGN FEE PROPOSAL" in plain and "Mr Sunil Shah" in plain and "₹ 1,75,000" in plain)
    check("DOCX keeps the DRAFT note and red placeholders", "DRAFT — the agreement clauses" in plain and "[to be confirmed]" in plain and 'w:val="A23B2A"' in xml)
    check("DOCX section order", plain.index("1. ABOUT STUDIO ELEMENTS") < plain.index("2. PROJECT DETAILS") < plain.index("4B. FEE STRUCTURE")
          < plain.index("5. PAYMENT TERMS") < plain.index("15. AGREEMENT & ACCEPTANCE"))
    zf = zipfile.ZipFile(d.path())
    names = zf.namelist()
    footers = "".join(zf.read(n).decode() for n in names if n.startswith("word/footer"))
    headers = "".join(zf.read(n).decode() for n in names if n.startswith("word/header"))
    check("DOCX has a logo, header and page numbers", any(n.startswith("word/media/") for n in names) and "PAGE" in footers
          and "Design Fee Proposal" in headers and "Confidential" in footers)
    with page.expect_download() as dl:
        page.get_by_role("button", name="Export PDF").click()
    d = dl.value
    pdf = open(d.path(), "rb").read()
    check("PDF file name and content", d.suggested_filename == "Sparsh-Ekaya-Fee-Proposal.pdf" and pdf.startswith(b"%PDF") and len(pdf) > 20000, f"{d.suggested_filename} {len(pdf)}")
    check("PDF writes Rs. (no rupee glyph)", b"Rs. 1,75,000" in pdf and b"DESIGN FEE PROPOSAL" in pdf)
    page.screenshot(path="/tmp/fees-proposal-390.png", full_page=True)

    # ---- Invoices -------------------------------------------------------------------------------
    chip(page, "Invoices")
    page.get_by_role("button", name="Create invoices from milestones").click()
    expect(page.locator("li.fees-invoice")).to_have_count(4)
    inv = sorted(store.table("fee_invoices").values(), key=lambda r: r["sort_order"])
    check("4 invoices = agreed fee × milestone %", [r["amount"] for r in inv] == [35000, 52500, 52500, 35000] and all(r["status"] == "scheduled" for r in inv),
          str([r["amount"] for r in inv]))
    totals = page.get_by_test_id("invoice-total").all_inner_texts()
    check("invoice totals include GST", totals == [inr_exact(41300), inr_exact(61950), inr_exact(61950), inr_exact(41300)], str(totals))
    page.get_by_role("button", name="Create invoices from milestones").click()
    expect(page.get_by_text("4 invoices already exist. Add another 4?")).to_be_visible()
    page.get_by_role("alertdialog").get_by_role("button", name="Cancel").click()
    check("asks before adding a second set, and Cancel adds nothing", len(store.table("fee_invoices")) == 4)

    def card(name):
        return page.locator("li.fees-invoice", has_text=name)

    card("Working drawing issue").get_by_role("button", name="Edit").click()
    card("Working drawing issue").get_by_label("Schedule milestone").select_option("tm2")
    fits_phone(page, "Fees: invoice edit form", 390)
    card("Working drawing issue").get_by_role("button", name="Save").click()
    due3 = TM2_END + dt.timedelta(days=7)
    expect(card("Working drawing issue").get_by_test_id("invoice-due")).to_contain_text("milestone forecast")
    txt = card("Working drawing issue").get_by_test_id("invoice-due").inner_text()
    check("due = milestone forecast end + 7 days terms", txt == f"Due {long_date(due3)} (milestone forecast {long_date(TM2_END)} + 7 days)", txt)
    card("Appointment and commencement").get_by_role("button", name="Edit").click()
    card("Appointment and commencement").get_by_label("Schedule milestone").select_option("tm1")
    card("Appointment and commencement").get_by_role("button", name="Save").click()
    expect(card("Appointment and commencement").get_by_text("Milestone reached — raise the invoice")).to_be_visible()
    check("milestone done → 'raise the invoice' flag", True)

    raised_on, due1 = TODAY - dt.timedelta(days=20), TODAY - dt.timedelta(days=12)
    c1 = card("Appointment and commencement")
    c1.get_by_role("button", name="Raise").click()
    check("raise form suggests an invoice number", c1.get_by_label("Invoice no.").input_value() == "SE-001", c1.get_by_label("Invoice no.").input_value())
    c1.get_by_label("Invoice no.").fill("SE/26-27/001")
    c1.get_by_label("Invoice date").fill(raised_on.isoformat())
    c1.get_by_label("Due date").fill(due1.isoformat())
    fits_phone(page, "Fees: raise form", 390)
    c1.get_by_role("button", name="Save as raised").click()
    expect(c1.get_by_text("Overdue 12 days")).to_be_visible()
    r1 = next(r for r in store.table("fee_invoices").values() if r["milestone"] == "Appointment and commencement")
    check("raise saves number, date and due date", r1["status"] == "raised" and r1["invoice_no"] == "SE/26-27/001" and r1["raised_on"] == raised_on.isoformat()
          and r1["due_date"] == due1.isoformat(), str({k: r1[k] for k in ("status", "invoice_no", "raised_on", "due_date")}))
    check("overdue flag counts days past due (12)", True)
    check("milestone flag goes once raised", c1.get_by_text("Milestone reached").count() == 0)

    c2 = card("Concept approval")
    c2.get_by_role("button", name="Raise").click()
    check("second number follows the first", c2.get_by_label("Invoice no.").input_value() == "SE/26-27/002")
    c2.get_by_role("button", name="Save as raised").click()
    c2.get_by_role("button", name="Mark paid").click()
    check("paid amount defaults to the total incl. GST", c2.get_by_label("Amount received (₹)").input_value() == "61950", c2.get_by_label("Amount received (₹)").input_value())
    c2.get_by_role("button", name="Save as paid").click()
    expect(c2.locator(".tag")).to_have_text("Paid")
    r2 = next(r for r in store.table("fee_invoices").values() if r["milestone"] == "Concept approval")
    check("mark paid saves date and amount", r2["status"] == "paid" and r2["paid_amount"] == 61950 and r2["paid_on"] == TODAY.isoformat(), str(r2)[:160])
    check("received tile", tile(page, "Received") == inr_short(61950) and tile(page, "Raised, unpaid") == inr_short(41300),
          f"{tile(page, 'Received')} {tile(page, 'Raised, unpaid')}")

    with page.expect_download() as dl:
        c1.get_by_role("button", name="PDF").click()
    d = dl.value
    pdf = open(d.path(), "rb").read()
    check("invoice PDF name", d.suggested_filename == "Sparsh-Ekaya-Invoice-SE-26-27-001.pdf", d.suggested_filename)
    check("invoice PDF has totals, words and the CA note", b"Rs. 41,300.00" in pdf and b"Rs. 6,300.00" in pdf and b"Forty One Thousand Three Hundred" in pdf
          and b"check with your CA" in pdf and b"Mr Sunil Shah" in pdf)
    # Remove and restore (nothing is deleted)
    card("Final handover").get_by_role("button", name="Remove").click()
    expect(page.locator("li.fees-invoice")).to_have_count(3)
    page.get_by_text("Removed invoices (1)").click()
    page.get_by_role("button", name="Restore").click()
    expect(page.locator("li.fees-invoice")).to_have_count(4)
    check("remove hides an invoice and restore brings it back", len(store.table("fee_invoices")) == 4
          and all(r["removed_at"] is None for r in store.table("fee_invoices").values()))
    fits_phone(page, "Fees: invoices", 390)
    page.screenshot(path="/tmp/fees-invoices-390.png", full_page=True)

    # ---- Studio costs and margin -------------------------------------------------------------------
    chip(page, "Costs")
    page.get_by_role("button", name="Add a studio cost").click()
    page.get_by_label("Amount (₹)").fill("12000")
    page.get_by_role("button", name="Add cost").click()
    expect(page.locator(".fees-cost")).to_have_count(1)
    page.get_by_role("button", name="Add a studio cost").click()
    page.get_by_label("Date").fill((TODAY + dt.timedelta(days=10)).isoformat())
    page.get_by_label("Amount (₹)").fill("25000")
    page.get_by_label("Category").select_option("Consultant")
    page.get_by_label("Vendor (optional)").select_option("v1")
    page.get_by_role("button", name="Planned").click()
    fits_phone(page, "Fees: cost form", 390)
    page.get_by_role("button", name="Add cost").click()
    expect(page.locator(".fees-cost")).to_have_count(2)
    costs = list(store.table("studio_costs").values())
    check("costs saved (paid 12,000; planned 25,000 with vendor)", sorted((c["amount"], c["status"]) for c in costs) == [(12000, "paid"), (25000, "planned")]
          and any(c["vendor_id"] == "v1" and c["category"] == "Consultant" for c in costs))
    check("cost totals", page.get_by_test_id("costs-totals").inner_text() == "Paid ₹ 12,000 · planned ₹ 25,000")
    # Margin: 1,75,000 − 12,000 = 1,63,000 (93.1%); − 25,000 more = 1,38,000 (78.9%).
    check("margin to date", page.get_by_test_id("margin-to-date").inner_text() == inr(163000) and f"{pct(163000, 175000)}%" in page.locator(".fees-margin").inner_text())
    check("margin forecast", page.get_by_test_id("margin-forecast").inner_text() == inr(138000) and f"{pct(138000, 175000)}%" in page.locator(".fees-margin").inner_text())
    page.locator(".fees-cost", has_text="Consultant").get_by_role("button", name="Remove").click()
    expect(page.locator(".fees-cost")).to_have_count(1)
    check("removing a cost updates the forecast", page.get_by_test_id("margin-forecast").inner_text() == inr(163000))
    page.get_by_text("Removed costs (1)").click()
    page.get_by_role("button", name="Restore").click()
    expect(page.locator(".fees-cost")).to_have_count(2)
    check("cost restored, never deleted", len(store.table("studio_costs")) == 2 and page.get_by_test_id("margin-forecast").inner_text() == inr(138000))
    fits_phone(page, "Fees: costs and margin", 390)
    page.screenshot(path="/tmp/fees-costs-390.png", full_page=True)

    # ---- Offline: cached copy, read-only ----------------------------------------------------------
    state["offline"] = True
    page.reload()
    expect(page.get_by_text("Showing fees as last seen on this phone (read-only)")).to_be_visible(timeout=20000)
    chip(page, "Costs")
    check("offline: cached costs shown, no editing", page.locator(".fees-cost").count() == 2 and page.get_by_role("button", name="Add a studio cost").count() == 0)
    state["offline"] = False

    # ---- Finances ------------------------------------------------------------------------------------
    big = TODAY + dt.timedelta(days=14)
    store.table("studio_costs")["big"] = {"id": "big", "project_id": PROJECT, "spent_on": big.isoformat(), "category": "Consultant", "vendor_id": None,
                                          "amount": 200000, "status": "planned", "note": "", "removed_at": None}
    page.goto(APP + "#/finances")
    expect(page.get_by_role("heading", name="Finances")).to_be_visible()
    expect(page.get_by_text("Receivables: raised, not paid")).to_be_visible()
    page.wait_for_timeout(400)
    costs_total = 12000 + 25000 + 200000
    want = {"Fees agreed": inr_short(175000), "Invoiced": inr_short(41300 + 61950), "Received": inr_short(61950), "Outstanding": inr_short(41300),
            "Overdue": inr_short(41300), "Studio costs (incl. planned)": inr_short(costs_total), "Margin (forecast)": f"{pct(175000 - costs_total, 175000)}%"}
    got = {k: tile(page, k) for k in want}
    check("Finances KPI tiles (hand-worked)", got == want, str(got))
    rec = page.locator("section[aria-label=Receivables]").inner_text()
    check("receivables list the overdue invoice", "Appointment and commencement" in rec and "Overdue 12 d" in rec and inr(41300) in rec, rec.replace("\n", " | "))
    dues = page.locator("section[aria-label='Agency dues']").inner_text()
    check("agency dues: client-approved bill, incl. GST, paid by the client", "Sharma Interiors" in dues and "RA-1" in dues and inr(118000) in dues
          and "RA-0" not in dues and "Paid by the client" in dues, dues.replace("\n", " | "))
    mb = page.locator("section[aria-label='Margin by project']")
    check("margin by project in danger colour below 10%", "Sparsh Ekaya" in mb.inner_text() and mb.locator(".pbar.fees-low").count() == 1)
    pay = page.locator("section[aria-label='Payables']").inner_text()
    check("payables list planned costs by date", pay.index(inr(25000)) < pay.index(inr(200000)), pay.replace("\n", " | "))

    # Cash flow, worked out independently: Monday buckets from this week, overdue into week 1.
    page.get_by_label("Opening cash (₹)").fill("10000")
    page.get_by_role("button", name="Save", exact=True).click()
    expect(page.get_by_role("button", name="Save", exact=True)).to_have_count(0)
    check("opening cash saved", store.table("studio_private")[1]["opening_cash"] == 10000, str(store.table("studio_private")))
    monday = TODAY - dt.timedelta(days=TODAY.weekday())
    def week(d):
        i = (d - monday).days // 7
        return 0 if i < 0 else (i if i < 8 else None)
    cin, cout = [0] * 8, [0] * 8
    cin[week(due1)] += 41300                     # raised, overdue → week 1
    if week(due3) is not None:
        cin[week(due3)] += 61950                 # scheduled, due milestone + 7 days
    for d_, amt in ((TODAY + dt.timedelta(days=10), 25000), (big, 200000)):
        if week(d_) is not None:
            cout[week(d_)] += amt
    bal, rows_want = 10000, []
    for i in range(8):
        bal += cin[i] - cout[i]
        rows_want.append([day_label(monday + dt.timedelta(days=7 * i)), inr(cin[i]) if cin[i] else "—", inr(cout[i]) if cout[i] else "—",
                          inr(bal) + (" ▼" if bal < 0 else "")])
    rows_got = [r.locator("td").all_inner_texts() for r in page.locator(".fees-table tbody tr").all()]
    check("cash-flow table: 8 Monday weeks, in, out, running balance", rows_got == rows_want, f"got {rows_got} want {rows_want}")
    negs = sum(1 for r in rows_want if r[3].endswith("▼"))
    check("negative weeks flagged in table and chart", negs > 0 and page.locator(".fees-table tr.neg").count() == negs
          and page.locator("svg.fees-chart circle[data-negative]").count() == negs and page.get_by_text("Cash forecast goes below zero").is_visible())
    check("chart scales to the screen", page.evaluate("() => { const s = document.querySelector('svg.fees-chart'); return s.getAttribute('viewBox') && s.getBoundingClientRect().width <= innerWidth }"))
    check("forecast labelled as a forecast", page.get_by_text("A forecast, not a record.").is_visible())
    fits_phone(page, "Finances", 390)
    page.screenshot(path="/tmp/fees-finances-390.png", full_page=True)

    # ---- Vendors -------------------------------------------------------------------------------------
    page.goto(APP + "#/vendors")
    expect(page.get_by_role("heading", name="Vendors")).to_be_visible()
    page.get_by_role("button", name="Add", exact=True).click()
    page.get_by_label("Name", exact=True).fill("Patel Glass")
    page.get_by_role("group", name="Vendor kind", exact=True).get_by_role("button", name="Supplier").click()
    page.get_by_label("Trade").fill("Glass")
    page.get_by_label("Phone").fill("+91 99099 11111")
    fits_phone(page, "Vendors: add form", 390)
    page.get_by_role("button", name="Add vendor").click()
    expect(page.get_by_role("button", name=re.compile("^Patel Glass"))).to_be_visible()
    check("vendor added", any(v["name"] == "Patel Glass" and v["kind"] == "supplier" for v in store.table("vendors").values()))
    page.get_by_role("button", name="Add", exact=True).click()
    page.get_by_label("Name", exact=True).fill("  sharma interiors ")
    page.get_by_role("button", name="Add vendor").click()
    expect(page.get_by_text("A vendor called “sharma interiors” already exists.")).to_be_visible()
    check("duplicate name refused (case and spaces ignored)", len(store.table("vendors")) == 2)
    page.get_by_role("button", name="Cancel").click()
    page.get_by_label("Search").fill("patel")
    check("search filters the list", page.locator("li.fees-vendor").count() == 1)
    page.get_by_label("Search").fill("")
    page.get_by_role("group", name="Vendor kind filter").get_by_role("button", name="Agency").click()
    check("kind chips filter the list", page.locator("li.fees-vendor").count() == 1 and "Sharma" in page.locator("li.fees-vendor").inner_text())
    page.get_by_role("button", name=re.compile("^Sharma Interiors")).click()
    stats = {k: page.get_by_test_id(k).inner_text() for k in ("v-projects", "v-wo", "v-cert", "v-paid", "v-unpaid", "v-quotes", "v-ontime")}
    want = {"v-projects": "1", "v-wo": inr(400000), "v-cert": inr(150000), "v-paid": inr(59000), "v-unpaid": f"{inr(118000)} (1)", "v-quotes": "2", "v-ontime": "67% of 3"}
    check("vendor stats: work orders, certified, paid, unpaid bills, quotes, on-time %", stats == want, str(stats))
    check("call and WhatsApp links", page.get_by_role("link", name="Call").get_attribute("href") == "tel:9825012345"
          and page.get_by_role("link", name="WhatsApp").get_attribute("href") == "https://wa.me/919825012345")
    fits_phone(page, "Vendors: detail open", 390)
    page.screenshot(path="/tmp/fees-vendors-390.png", full_page=True)
    page.get_by_role("button", name="Archive", exact=True).click()
    expect(page.locator("li.fees-vendor")).to_have_count(0)
    check("owner archives a vendor", store.table("vendors")["v1"]["archived"] is True)
    page.get_by_role("group", name="Vendor kind filter").get_by_role("button", name="Archived").click()
    sharma = page.get_by_role("button", name=re.compile("^Sharma Interiors"))
    if sharma.get_attribute("aria-expanded") != "true":
        sharma.click()
    page.get_by_role("button", name="Restore").click()
    expect(page.locator("li.fees-vendor")).to_have_count(0)
    check("owner restores a vendor", store.table("vendors")["v1"]["archived"] is False)
    page.get_by_role("group", name="Vendor kind filter").get_by_role("button", name="All").click()
    p_glass = page.get_by_role("button", name=re.compile("^Patel Glass"))
    p_glass.click()
    check("vendor with no records says 'no record'", page.get_by_test_id("v-ontime").inner_text() == "no record")
    ctx.close()

    # ---- Phone fit at 360 and 390 -----------------------------------------------------------------------
    for width in (360, 390):
        c = browser.new_context(viewport={"width": width, "height": 800}, has_touch=True, is_mobile=True, device_scale_factor=2)
        c.route(re.compile(re.escape(API) + ".*"), handler(store))
        pg = c.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        sign_in(pg)
        pg.goto(APP + f"#/project/{PROJECT}/fees")
        expect(pg.get_by_role("group", name="Fees sections")).to_be_visible()
        pg.wait_for_timeout(300)
        fits_phone(pg, "Fees: invoices", width)
        chip(pg, "Proposal")
        fits_phone(pg, "Fees: proposal", width)
        chip(pg, "Costs")
        fits_phone(pg, "Fees: costs", width)
        pg.goto(APP + "#/finances")
        expect(pg.get_by_text("Cash-flow forecast: next 8 weeks")).to_be_visible()
        pg.wait_for_timeout(300)
        fits_phone(pg, "Finances", width)
        if width == 360:
            pg.screenshot(path="/tmp/fees-finances-360.png", full_page=True)
        pg.goto(APP + "#/vendors")
        expect(pg.get_by_role("heading", name="Vendors")).to_be_visible()
        pg.get_by_role("button", name=re.compile("^Sharma Interiors")).click()
        fits_phone(pg, "Vendors", width)
        c.close()

    # ---- Coordinator: owner-only messages --------------------------------------------------------------
    coord = Store("coordinator")
    seed(coord)
    c = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    c.route(re.compile(re.escape(API) + ".*"), handler(coord))
    pg = c.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    sign_in(pg)
    pg.goto(APP + f"#/project/{PROJECT}/fees")
    expect(pg.get_by_text("Fees are visible to owners only.")).to_be_visible()
    check("coordinator: Fees tab says owners only and is not in the tabs", pg.get_by_role("navigation", name="Project sections").get_by_role("button", name="Fees").count() == 0)
    pg.goto(APP + "#/finances")
    expect(pg.get_by_text("Studio finances are visible to owners only.")).to_be_visible()
    check("coordinator: Finances says owners only, no figures", pg.locator(".fees-tile").count() == 0)
    pg.goto(APP + "#/vendors")
    pg.get_by_role("button", name=re.compile("^Sharma Interiors")).click()
    check("coordinator: sees vendors, can edit, cannot archive", pg.get_by_role("button", name="Edit", exact=True).count() == 1 and pg.get_by_role("button", name="Archive", exact=True).count() == 0)
    fits_phone(pg, "Coordinator: Finances message", 390)
    c.close()

    check("no script errors", not errors, "; ".join(errors[:3]))
    browser.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
