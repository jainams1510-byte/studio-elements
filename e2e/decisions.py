"""Browser test of Decisions, Procurement and the Calendar, against the shared stand-in server.

Run:  npm run build && npx vite preview --port 4183 --strictPort &
      python3 e2e/decisions.py
No real data is touched. The stand-in runs no database triggers, so decided dates and variations
are seeded or sent by the app. Expected dates (working days Mon-Sat, order-by, Fridays) are worked
out here in Python, independently of the app's own code.
"""
import os; os.environ.setdefault('APP_URL', 'http://localhost:4183/')  # noqa: E401,E702  (before importing standin)
import datetime as dt, re, sys  # noqa: E401
from playwright.sync_api import sync_playwright, expect
from standin import APP, API, PROJECT, TODAY, Store, check, fits_phone, handler, label, nth_workday, results, sign_in

D = dt.timedelta
iso = lambda d: d.isoformat()  # noqa: E731


def W(n):
    """Date of working day n of a schedule that starts today (Mon-Sat)."""
    return nth_workday(TODAY, n)


def task(tid, name, duration, after=(), **kw):
    return {"id": tid, "project_id": PROJECT, "stage": 6, "name": name, "trade": None, "room": None, "owner_name": None,
            "duration": duration, "milestone": duration == 0, "after_ids": list(after), "status": "planned", "actual_start": None,
            "actual_end": None, "gate_drawing_id": None, "baseline_start": None, "baseline_end": None, "sort_order": 0,
            "removed_at": None, **kw}


def proc(pid, item, **kw):
    return {"id": pid, "project_id": PROJECT, "item": item, "trade": None, "room": None, "task_id": None, "need_by": None, "lead_days": 14,
            "vendor_id": None, "spec_approved": False, "status": "specified", "ordered_on": None, "expected_on": None, "delivered_on": None,
            "note": "", "removed_at": None, **kw}


def decision(did, question, **kw):
    return {"id": did, "project_id": PROJECT, "kind": "rfi", "approval_kind": None, "question": question, "answer": "", "raised_by": None,
            "revision_round": None, "need_by": None, "blocks": "", "decided_by": None, "decided_on": None, "status": "open", "cost_impact": None,
            "drawing_id": None, "boq_item_id": None, "task_id": None, "source_log_id": None, "created_at": "2026-11-20T08:00:00Z",
            "removed_at": None, **kw}


def seed(store):
    # Schedule from today: Civil works (10 d) → Kitchen installation (6 d) → Kitchen ready (milestone);
    # False ceiling framing (3 d) after Civil works waits on SE-EL-01, which is only at P2.
    store.schedules[PROJECT] = {"project_id": PROJECT, "start_date": iso(TODAY), "work_days": [1, 2, 3, 4, 5, 6], "holidays": [],
                                "baseline_at": None, "baseline_by": None, "baseline_plan": None}
    for t in [task("tA", "Civil works", 10), task("tB", "Kitchen installation", 6, ["tA"]), task("tM", "Kitchen ready", 0, ["tB"]),
              task("tG", "False ceiling framing", 3, ["tA"], gate_drawing_id="d1")]:
        store.tasks[t["id"]] = t
    store.table("vendors")["v1"] = {"id": "v1", "name": "Shree Granite", "kind": "supplier", "trade": "Civil", "contact_name": None,
                                    "phone": "98250 00000", "email": None, "gstin": None, "notes": "", "archived": False}
    items = store.table("procurement_items")
    items["p_over"] = proc("p_over", "Bathroom tiles", need_by=iso(TODAY + D(3)), lead_days=10)
    items["p_late"] = proc("p_late", "Wardrobe hardware", status="ordered", spec_approved=True, need_by=iso(TODAY + D(30)),
                           ordered_on=iso(TODAY - D(20)), expected_on=iso(TODAY - D(2)))
    items["p_nit"] = proc("p_nit", "Pendant lights", status="ordered", spec_approved=True, need_by=iso(TODAY + D(15)),
                          ordered_on=iso(TODAY - D(5)), expected_on=iso(TODAY + D(20)))
    items["p_gate"] = proc("p_gate", "Cement bags", task_id="tA", lead_days=0)
    store.table("decisions")["dRev"] = decision("dRev", "Living room TV wall rework", kind="revision", revision_round=2, raised_by="client")
    store.table("decisions")["dOpen"] = decision("dOpen", "Wardrobe shutters, laminate or veneer; client to pick", kind="approval",
                                                 approval_kind="material", need_by=iso(TODAY + D(3)))
    store.table("fee_invoices")["f1"] = {"id": "f1", "project_id": PROJECT, "milestone": "Working drawing issue", "task_id": None, "amount": 50000,
                                         "gst_rate": 18, "due_date": iso(TODAY + D(6)), "status": "raised", "invoice_no": "SE/26/04", "raised_on": iso(TODAY),
                                         "paid_on": None, "paid_amount": None, "note": "", "sort_order": 0, "removed_at": None}
    store.table("ra_bills")["b1"] = {"id": "b1", "project_id": PROJECT, "vendor_id": "v1", "work_order_id": None, "bill_no": "RA-2",
                                     "bill_date": iso(TODAY - D(10)), "claimed_amount": 100000, "certified_amount": 95000, "gst_rate": 18,
                                     "status": "client_approved", "certified_on": iso(TODAY - D(4)), "client_approved_on": iso(TODAY - D(2)),
                                     "paid_on": None, "paid_amount": None, "note": "", "file_link": None, "removed_at": None}


def find(store, table, **kv):
    return next(r for r in store.table(table).values() if all(r.get(k) == v for k, v in kv.items()))


def field(scope, caption, kind="select"):
    """The select or input of the label.field whose caption is exactly this text."""
    return scope.locator(f"label.field:has(> span:text-is('{caption}')) {kind}")


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
    errors = []
    store = Store("owner")
    seed(store)

    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, accept_downloads=True)
    ctx.route(re.compile(re.escape(API) + ".*"), handler(store))
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    sign_in(page)

    # ================================================================== Decisions
    page.goto(APP + f"#/project/{PROJECT}/decisions")
    expect(page.locator("section[data-state=ready]")).to_be_visible()

    def add_decision(kind, question, fill=lambda: None):
        page.get_by_role("button", name="Add a decision").click()
        form = page.locator("form.dc-form")
        form.get_by_role("group", name="Kind").get_by_role("button", name=kind, exact=True).click()
        fill()
        form.get_by_label(re.compile("^(Question|Instruction|What changes)$")).fill(question)
        form.get_by_role("button", name="Add decision").click()
        expect(page.locator("form.dc-form")).to_have_count(0)
        expect(page.locator("li.dc-card", has_text=question)).to_be_visible()

    q_rfi = "Kitchen counter height, 850 or 900 mm?"
    add_decision("RFI", q_rfi, lambda: (field(page, "Task").select_option("tB"),
                                         page.get_by_label("Need by").fill(iso(TODAY + D(8)))))
    r = find(store, "decisions", question=q_rfi)
    check("RFI saved with its task link and need-by", r["kind"] == "rfi" and r["task_id"] == "tB" and r["need_by"] == iso(TODAY + D(8))
          and r["approval_kind"] is None and r["revision_round"] is None)
    check("RFI card names the linked task", "Task Kitchen installation" in page.locator("li.dc-card", has_text=q_rfi).inner_text())

    q_app = "Kitchen counter: granite, or quartz; confirm"
    add_decision("Approval", q_app, lambda: (page.get_by_role("group", name="Approval of").get_by_role("button", name="Client approval").click(),
                                             page.get_by_label("Need by").fill(iso(TODAY - D(2))),
                                             field(page, "Sheet").select_option("d1"),
                                             page.get_by_label("Blocks (what waits on it)").fill("kitchen carcass production")))
    a = find(store, "decisions", question=q_app)
    check("approval saved as a client approval with its sheet", a["kind"] == "approval" and a["approval_kind"] == "client" and a["drawing_id"] == "d1")
    card = page.locator("li.dc-card", has_text=q_app)
    check("approval past its need-by date is flagged Overdue", card.locator(".htag.late", has_text="Overdue").count() == 1)
    check("card shows need-by, blocks and sheet", all(s in card.inner_text() for s in [label(TODAY - D(2)), "kitchen carcass production", "SE-EL-01"]))
    check("open approval in future is not overdue", page.locator("li.dc-card", has_text="Wardrobe shutters").locator(".htag.late").count() == 0)
    check("open decisions are listed first (overdue approval at the top)", "granite, or quartz" in page.locator("li.dc-card").first.inner_text())
    card.get_by_role("button", name="Draft reminder to the client").click()
    rem = card.locator("textarea").input_value()
    check("overdue approval drafts a client reminder", f"needed by {label(TODAY - D(2))}" in rem and "kitchen carcass production is waiting on it" in rem, rem[:120])
    card.get_by_role("button", name="Close draft").click()

    q_si = "Shift the bedroom switchboard 300 mm left"
    add_decision("Site instruction", q_si)
    check("site instruction saved", find(store, "decisions", question=q_si)["kind"] == "site_instruction")

    q_rev = "Master bedroom wardrobe moved to the east wall"
    page.get_by_role("button", name="Add a decision").click()
    page.locator("form.dc-form").get_by_role("group", name="Kind").get_by_role("button", name="Design revision").click()
    check("next revision round suggested (seeded round 2 → 3)", page.get_by_label("Revision round").input_value() == "3")
    field(page, "Raised by").select_option("internal")
    page.get_by_label("What changes").fill(q_rev)
    page.get_by_role("button", name="Add decision").click()
    expect(page.locator("li.dc-card", has_text=q_rev)).to_be_visible()
    rv = find(store, "decisions", question=q_rev)
    check("revision saved with round 3, raised internally", rv["kind"] == "revision" and rv["revision_round"] == 3 and rv["raised_by"] == "internal")
    check("revision card says round and who raised it", "round 3 (internal)" in page.locator("li.dc-card", has_text=q_rev).inner_text())

    # Kind filter.
    page.get_by_role("group", name="Filter by kind").get_by_role("button", name=re.compile("^Design revision")).click()
    check("kind filter shows only revisions", page.locator("li.dc-card").count() == 2)
    page.get_by_role("group", name="Filter by kind").get_by_role("button", name=re.compile("^All")).click()

    # Answer and confirm the approval.
    card.get_by_role("button", name="Edit").click()
    form = page.locator("form.dc-form")
    form.get_by_role("group", name="Status").get_by_role("button", name="Confirmed").click()
    form.get_by_role("button", name="Save").click()
    check("cannot confirm without an answer", form.get_by_text("Write the answer before marking it confirmed.").is_visible())
    form.get_by_label("Answer").fill("Quartz, Caesarstone 4001 Fresh Concrete")
    form.get_by_label("Decided by").fill("Mr Sunil Shah")
    form.get_by_label("Cost impact (₹)").fill("45000")
    form.get_by_role("button", name="Save").click()
    expect(page.locator("form.dc-form")).to_have_count(0)
    a = find(store, "decisions", question=q_app)
    check("confirmed with answer, decided by, decided on and cost", a["status"] == "confirmed" and a["decided_by"] == "Mr Sunil Shah"
          and a["decided_on"] == iso(TODAY) and a["cost_impact"] == 45000)
    store.table("variations")["var1"] = {"id": "var1", "project_id": PROJECT, "decision_id": a["id"], "boq_item_id": None, "description": q_app,
                                         "amount": 45000, "status": "costed", "client_approved_on": None, "removed_at": None}
    page.reload()
    expect(page.locator("section[data-state=ready]")).to_be_visible()
    card = page.locator("li.dc-card", has_text=q_app)
    expect(card).to_be_visible()
    check("card shows cost impact and the linked variation's status", "₹ 45,000 · variation costed" in card.inner_text(), card.inner_text().replace("\n", " | ")[:200])
    check("confirmed card is no longer overdue", card.locator(".htag.late").count() == 0)
    card.get_by_role("button", name="Draft confirmation for the WhatsApp group").click()
    text = card.locator("textarea").input_value()
    check("confirmation draft holds question, decision, who and when", all(s in text for s in [
        f"Question: {q_app}", "Decision: Quartz, Caesarstone 4001 Fresh Concrete", f"Decided by Mr Sunil Shah on {label(TODAY)}.",
        "Refers to: Sheet SE-EL-01 Electrical layout.", "Cost impact: ₹ 45,000"]), text[:200])
    check("confirmation is addressed to the project group, to share yourself", "To Project WhatsApp group" in card.inner_text())
    fits_phone(page, "Decisions with a confirmation draft", 390)
    page.screenshot(path="/tmp/dc-decisions-390.png", full_page=True)

    # Owner remove and restore.
    page.locator("li.dc-card", has_text=q_si).get_by_role("button", name="Edit").click()
    page.get_by_role("button", name="Remove this decision").click()
    page.get_by_role("button", name="Remove", exact=True).click()
    expect(page.locator("li.dc-card", has_text=q_si)).to_have_count(0)
    check("removed, not deleted", find(store, "decisions", question=q_si)["removed_at"] is not None)
    page.get_by_text(re.compile(r"^Removed decisions \(1\)")).click()
    page.get_by_role("button", name="Restore").click()
    expect(page.locator("li.dc-card", has_text=q_si)).to_be_visible()
    check("restored", find(store, "decisions", question=q_si)["removed_at"] is None)

    # ================================================================== Procurement
    page.goto(APP + f"#/project/{PROJECT}/procurement")
    expect(page.locator("section[data-state=ready]")).to_be_visible()
    gate = page.get_by_label("Material not on site")
    try:
        expect(gate).to_contain_text(re.compile("Civil works .*Cement bags"))
        gate_ok = gate.count() == 1
    except AssertionError:
        gate_ok = False
    check("material gate lists the task starting within 7 days", gate_ok, gate.inner_text() if gate.count() == 1 else f"{gate.count()} gates")
    check("material gate leaves out tasks more than 7 days away", "Kitchen installation" not in gate.inner_text())

    def item_card(name):
        return page.locator("li.dc-card", has_text=name)

    check("flag: Order overdue", item_card("Bathroom tiles").locator("[data-flag=order_overdue]").count() == 1)
    check("flag: Delivery late", item_card("Wardrobe hardware").locator("[data-flag=delivery_late]").inner_text() == "Delivery late")
    nit = item_card("Pendant lights").locator("[data-flag=not_in_time]")
    check("flag: Not in time (expected after need date)", nit.count() == 1 and nit.inner_text() == f"Not in time for the need-by date ({label(TODAY + D(15))})")
    check("no Delivery late before the expected date", item_card("Pendant lights").locator("[data-flag=delivery_late]").count() == 0)

    page.get_by_role("button", name="Add an item").click()
    form = page.locator("form.dc-form")
    form.get_by_label("Item", exact=True).fill("Kitchen granite slab, 20 mm")
    field(form, "Room").select_option("Kitchen")
    field(form, "Needed on site before this task starts").select_option("tB")
    form.get_by_label("Lead time (days)").fill("7")
    start_b = W(10)
    order_by = start_b - D(7)
    check("form shows need = task forecast start and the order-by date", form.locator(".dc-calc").inner_text() ==
          f"Needed {label(start_b)} (task forecast start) → order by {label(order_by)}", form.locator(".dc-calc").inner_text())
    form.get_by_role("button", name="Add a vendor").click()
    form.get_by_label("Vendor name").fill("  shree GRANITE ")
    form.get_by_role("button", name="Save vendor").click()
    check("duplicate vendor name (any case) refused and the existing one selected",
          form.get_by_text("Shree Granite is already in the vendor list. Selected it.").is_visible() and field(form, "Vendor").input_value() == "v1"
          and len(store.table("vendors")) == 1)
    fits_phone(page, "Procurement form with vendor add", 390)
    form.get_by_label("Vendor name").fill("Patel Stone Works")
    form.get_by_label("Phone").fill("98989 12345")
    form.get_by_role("button", name="Save vendor").click()
    expect(form.get_by_text("Added Patel Stone Works.")).to_be_visible()
    nv = find(store, "vendors", name="Patel Stone Works")
    check("new vendor saved as a supplier and selected", nv["kind"] == "supplier" and nv["phone"] == "98989 12345"
          and field(form, "Vendor").input_value() == nv["id"])
    form.get_by_role("button", name="Add item").click()
    expect(page.locator("form.dc-form")).to_have_count(0)
    g = find(store, "procurement_items", item="Kitchen granite slab, 20 mm")
    check("item saved with task, lead and vendor", g["task_id"] == "tB" and g["lead_days"] == 7 and g["vendor_id"] == nv["id"] and g["room"] == "Kitchen")
    gc = item_card("Kitchen granite slab")
    check("card: order-by from the linked task's forecast start (computed independently)", gc.locator(".dc-orderby").inner_text() == f"{label(order_by)} · 7 days lead",
          gc.locator(".dc-orderby").inner_text())
    check("card: need date names the task", gc.locator(".dc-need").inner_text() == f"{label(start_b)} (Kitchen installation starts)")
    soon = gc.locator("[data-flag=order_soon]")
    days_left = (order_by - TODAY).days
    check(f"flag: Order by within 7 days ({days_left} days)", soon.count() == (1 if 0 <= days_left <= 7 else 0) and (soon.count() == 0 or soon.inner_text() == f"Order by {label(order_by)}"))
    order_rows = page.locator("li.dc-card .row-title").all_inner_texts()
    check("items sorted by order-by date", order_rows.index("Bathroom tiles") < order_rows.index("Kitchen granite slab, 20 mm"), str(order_rows))
    gc.get_by_role("button", name="Draft order reminder").click()
    body = gc.locator("textarea").input_value()
    check("order reminder names item, vendor and order-by date", all(s in body for s in ["Kitchen granite slab, 20 mm", "Patel Stone Works", label(order_by)]), body[:160])
    gc.get_by_role("button", name="Close draft").click()

    # Mark it ordered: flags clear, ordered date stamped.
    gc.get_by_role("button", name="Edit").click()
    page.locator("form.dc-form").get_by_role("group", name="Status").get_by_role("button", name="Ordered").click()
    page.locator("form.dc-form").get_by_label("Expected on site").fill(iso(start_b - D(1)))
    page.locator("form.dc-form").get_by_role("button", name="Save").click()
    expect(page.locator("form.dc-form")).to_have_count(0)
    g = find(store, "procurement_items", item="Kitchen granite slab, 20 mm")
    check("ordered: status, spec approved and ordered date saved", g["status"] == "ordered" and g["spec_approved"] is True and g["ordered_on"] == iso(TODAY))
    check("ordered and expected in time: no flags", item_card("Kitchen granite slab").locator(".htag").count() == 0)
    page.screenshot(path="/tmp/dc-procurement-390.png", full_page=True)

    # ================================================================== Calendar (phone agenda)
    # Put an open order back so its order-by date shows (the granite slab is ordered now).
    store.table("procurement_items")["p_cal"] = proc("p_cal", "Kitchen hob", task_id="tB", lead_days=7)
    page.goto(APP + "#/calendar")
    expect(page.locator("main[data-state=ready]")).to_be_visible()
    page.get_by_role("button", name="Add site visit").click()
    vf = page.locator("form.cal-visit")
    vf.get_by_label("Date").fill(iso(TODAY + D(2)))
    vf.get_by_label("Time").fill("10:30")
    vf.get_by_label("Purpose").fill("Electrical point marking")
    fits_phone(page, "Calendar with the visit form", 390)
    vf.get_by_role("button", name="Add visit").click()
    expect(page.locator("form.cal-visit")).to_have_count(0)
    sv = find(store, "site_visits", purpose="Electrical point marking")
    check("site visit saved with date, time and project", sv["visit_on"] == iso(TODAY + D(2)) and sv["visit_time"] == "10:30" and sv["project_id"] == PROJECT)

    friday = TODAY + D((4 - TODAY.weekday()) % 7)
    expected = [
        ("milestone", W(15), "Kitchen ready"),  # Civil 10 + Kitchen 6 working days: milestone on working day 15
        ("order", start_b - D(7), "Order Kitchen hob"),
        ("sheet", start_b, f"Sheet SE-EL-01 needed by {label(start_b)}"),  # False ceiling framing starts after Civil works
        ("visit", TODAY + D(2), "Site visit: Electrical point marking"),
        ("fee", TODAY + D(6), "Fee invoice due: Working drawing issue"),
        ("bill", TODAY + D(5), "Payment expected: Shree Granite bill RA-2"),  # client approved 2 days ago + 7
        ("decision", TODAY + D(3), "Wardrobe shutters, laminate or veneer; client to pick"),
        ("report", friday, "Weekly report"),
    ]
    for kind, day, title in expected:
        block = page.locator(f"li.cal-day[data-day='{iso(day)}']")
        ok = block.count() == 1 and block.locator(f".cal-entry[data-type={kind}]", has_text=title).count() >= 1
        check(f"agenda: {kind} on {label(day)}", ok, block.inner_text().replace("\n", " | ")[:160] if block.count() else "no day block")
    check("agenda: today comes first", page.locator("li.cal-day").first.get_attribute("data-day") == iso(TODAY))
    check("agenda: only milestones carry the accent colour", page.locator(".cal-entry.ms").count() >= 1 and
          all(page.locator(f".cal-entry[data-type={k}].ms").count() == 0 for k in ["order", "sheet", "visit", "fee", "bill", "decision", "report"]))
    days = page.locator("li.cal-day").evaluate_all("els => els.map(e => e.dataset.day)")
    check("agenda: days in order, none repeated", days == sorted(days) and len(days) == len(set(days)))
    weeks = page.locator("h2.cal-week").all_inner_texts()
    check("agenda: grouped into weeks starting Monday", weeks[:1] in (["This week"], ["Next week"]), str(weeks[:3]))

    # Filters.
    page.get_by_role("group", name="Entry types").get_by_role("button", name="Reports").click()
    check("type filter hides weekly reports", page.locator(".cal-entry[data-type=report]").count() == 0 and page.locator(".cal-entry[data-type=milestone]").count() >= 1)
    page.get_by_role("group", name="Entry types").get_by_role("button", name="Reports").click()
    store.projects["p2"] = {"id": "p2", "name": "Aggrawal Atelier", "code": "AA", "stage": 6, "archived": False, "rooms": [], "trades": []}
    page.reload()
    expect(page.locator("main[data-state=ready]")).to_be_visible()
    try:
        page.locator(".cal-entry[data-type=report]", has_text="Aggrawal Atelier").first.wait_for(timeout=8000)
        p2_ok = True
    except Exception:
        p2_ok = False
    check("second project adds its weekly reports", p2_ok)
    fri_block = page.locator(f"li.cal-day[data-day='{iso(friday)}']")
    check("one merged weekly-report entry per Friday, a button per project",
          fri_block.locator(".cal-entry[data-type=report]").count() == 1
          and fri_block.locator(".cal-parts .pill").all_inner_texts() == ["Aggrawal Atelier", "Sparsh Ekaya"])
    fri_block.locator(".cal-parts").get_by_role("button", name="Aggrawal Atelier").click()
    check("merged report entry opens that project's Reports tab", page.url.endswith("#/project/p2/reports"))
    page.goto(APP + "#/calendar")
    page.get_by_role("combobox", name=re.compile("^Project")).select_option("p2")
    check("project filter shows only that project", page.locator(".cal-entry", has_text="Sparsh Ekaya").count() == 0 and page.locator(".cal-entry").count() >= 1)
    page.get_by_role("combobox", name=re.compile("^Project")).select_option("all")

    # Past 7 days toggle (the bill was client-approved 2 days ago: nothing past; add a past visit).
    store.table("site_visits")["old"] = {"id": "old", "project_id": PROJECT, "visit_on": iso(TODAY - D(3)), "visit_time": None, "purpose": "Slab check", "removed_at": None}
    page.reload()
    expect(page.locator("main[data-state=ready]")).to_be_visible()
    check("past entries hidden by default", page.locator(f"li.cal-day[data-day='{iso(TODAY - D(3))}']").count() == 0)
    page.get_by_role("button", name="Past 7 days").click()
    check("Past 7 days shows last week's visit", page.locator(f"li.cal-day[data-day='{iso(TODAY - D(3))}']", has_text="Slab check").count() == 1)

    # ICS download.
    with page.expect_download() as dl:
        page.get_by_role("button", name="Add to phone calendar").click()
    raw = open(dl.value.path(), "rb").read().decode("utf-8")
    unfolded = raw.replace("\r\n ", "")
    check("ICS: file name", dl.value.suggested_filename == f"studio-elements-calendar-{iso(TODAY)}.ics", dl.value.suggested_filename)
    check("ICS: VCALENDAR with CRLF line ends only", raw.startswith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n") and raw.endswith("END:VCALENDAR\r\n")
          and "\n" not in raw.replace("\r\n", ""))
    check("ICS: lines at most 75 octets", all(len(l.encode()) <= 75 for l in raw.split("\r\n")))
    check("ICS: milestone as an all-day event", f"DTSTART;VALUE=DATE:{W(15).strftime('%Y%m%d')}\r\nDTEND;VALUE=DATE:{(W(15) + D(1)).strftime('%Y%m%d')}" in unfolded)
    check("ICS: commas and semicolons escaped", "SUMMARY:Decision: Wardrobe shutters\\, laminate or veneer\\; client to pick" in unfolded)
    lines_lf = unfolded.replace("\r\n", "\n")
    uids = re.findall(r"^UID:(.+)$", lines_lf, re.M)
    check("ICS: one unique UID and a DTSTAMP per event", len(uids) == unfolded.count("BEGIN:VEVENT") == len(set(uids)) == len(re.findall(r"^DTSTAMP:\d{8}T\d{6}Z$", lines_lf, re.M)) > 8,
          f"{len(uids)} events")
    check("ICS: past entries left out", "Slab check" not in unfolded)
    page.screenshot(path="/tmp/dc-calendar-390.png", full_page=True)

    # Tap an entry → its source.
    page.locator(".cal-entry[data-type=decision]").first.click()
    check("decision entry opens the project's Decisions tab", page.url.endswith(f"#/project/{PROJECT}/decisions"))
    page.goto(APP + "#/calendar")
    page.locator(".cal-entry[data-type=sheet]").first.click()
    check("sheet entry opens the drawing", page.url.endswith("#/drawing/d1"))
    page.goto(APP + "#/calendar")
    page.locator(".cal-entry[data-type=visit]", has_text="Electrical point marking").click()
    check("visit entry opens it for editing", page.locator("form.cal-visit").get_by_label("Purpose").input_value() == "Electrical point marking")
    ctx.close()

    # ================================================================== Desktop month grid
    dctx = browser.new_context(viewport={"width": 1440, "height": 900})
    dctx.route(re.compile(re.escape(API) + ".*"), handler(store))
    dpage = dctx.new_page()
    dpage.on("pageerror", lambda e: errors.append(str(e)))
    sign_in(dpage)
    dpage.goto(APP + "#/calendar")
    expect(dpage.locator("main[data-state=ready] .cal-grid")).to_be_visible()
    heads = dpage.locator(".cal-wd").all_inner_texts()
    first = dt.date.fromisoformat(dpage.locator(".cal-cell").first.get_attribute("data-day"))
    check("month grid: Monday is the first column", heads[:1] == ["Mon"] and heads[-1] == "Sun" and first.weekday() == 0, f"{heads} {first}")
    check("month grid: shows this month", dpage.locator(".cal-monthname").inner_text() == TODAY.strftime("%B %Y"))
    check("month grid: today marked", dpage.locator(f".cal-cell.today[data-day='{iso(TODAY)}']").count() == 1)
    check("month grid: uses the desktop width", dpage.evaluate("document.querySelector('.cal-grid').getBoundingClientRect().width") > 1000)
    cells = dpage.locator(".cal-cell").count()
    check("month grid: whole weeks", cells % 7 == 0 and cells >= 28)
    ms_day = iso(W(15))
    if dpage.locator(f".cal-cell[data-day='{ms_day}']").count() == 0:
        dpage.get_by_role("button", name="Next month").click()
    check("month grid: milestone pill on its day, in colour", dpage.locator(f".cal-cell[data-day='{ms_day}'] .cal-pill.ms", has_text="Kitchen ready").count() == 1)
    dpage.get_by_role("button", name="Next month").click()
    nxt = (TODAY.replace(day=1) + D(32)).replace(day=1)
    nxt2 = (nxt + D(32)).replace(day=1)
    check("next month moves the grid", dpage.locator(".cal-monthname").inner_text() in (nxt.strftime("%B %Y"), nxt2.strftime("%B %Y")))
    dpage.locator(".cal-nav").get_by_role("button", name="Today").click()
    check("Today returns to this month", dpage.locator(".cal-monthname").inner_text() == TODAY.strftime("%B %Y"))
    dpage.screenshot(path="/tmp/dc-calendar-1440.png", full_page=True)
    dctx.close()

    # ================================================================== Phone fit, 360 and 390
    for width in (360, 390):
        fctx = browser.new_context(viewport={"width": width, "height": 800}, has_touch=True, is_mobile=True)
        fctx.route(re.compile(re.escape(API) + ".*"), handler(store))
        fp = fctx.new_page()
        fp.on("pageerror", lambda e: errors.append(str(e)))
        sign_in(fp)
        fp.goto(APP + f"#/project/{PROJECT}/decisions")
        expect(fp.locator("section[data-state=ready]")).to_be_visible()
        fits_phone(fp, "Decisions list", width)
        fp.get_by_role("button", name="Add a decision").click()
        fp.locator("form.dc-form").get_by_role("group", name="Kind").get_by_role("button", name="Design revision").click()
        fits_phone(fp, "Decision form (revision)", width)
        fp.locator("form.dc-form").get_by_role("group", name="Status").get_by_role("button", name="Confirmed").click()
        fits_phone(fp, "Decision form (status stepper)", width)
        fp.screenshot(path=f"/tmp/dc-decision-form-{width}.png", full_page=True)
        fp.goto(APP + f"#/project/{PROJECT}/procurement")
        expect(fp.locator("section[data-state=ready]")).to_be_visible()
        fits_phone(fp, "Procurement list", width)
        fp.get_by_role("button", name="Add an item").click()
        fp.get_by_role("button", name="Add a vendor").click()
        fp.locator("form.dc-form").get_by_role("group", name="Status").get_by_role("button", name="On site").click()
        fits_phone(fp, "Procurement form (vendor add, on site)", width)
        fp.screenshot(path=f"/tmp/dc-procurement-form-{width}.png", full_page=True)
        fp.goto(APP + "#/calendar")
        expect(fp.locator("main[data-state=ready]")).to_be_visible()
        fits_phone(fp, "Calendar agenda", width)
        fp.get_by_role("button", name="Past 7 days").click()
        fp.get_by_role("button", name="Add site visit").click()
        fits_phone(fp, "Calendar with past week and visit form", width)
        if width == 390:
            # No signal: the phone's copy shows, read-only, with a notice.
            fp.goto(APP + f"#/project/{PROJECT}/decisions")
            expect(fp.locator("li.dc-card").first).to_be_visible()
            fp.goto(APP + f"#/project/{PROJECT}/procurement")
            expect(fp.locator("li.dc-card").first).to_be_visible()
            fctx.set_offline(True)
            api = re.compile(re.escape(API) + ".*")
            abort = lambda r: r.abort("internetdisconnected")  # noqa: E731  (routed requests ignore set_offline)
            fctx.route(api, abort)
            fp.goto(APP + f"#/project/{PROJECT}/decisions")
            expect(fp.get_by_text(re.compile("^No signal. Showing decisions"))).to_be_visible()
            check("offline: decisions from the phone's copy, no Add or Edit", fp.locator("li.dc-card").count() >= 5
                  and fp.get_by_role("button", name="Add a decision").count() == 0 and fp.locator("li.dc-card").get_by_role("button", name="Edit").count() == 0)
            fp.goto(APP + f"#/project/{PROJECT}/procurement")
            expect(fp.get_by_text(re.compile("^No signal. Showing procurement"))).to_be_visible()
            check("offline: procurement from the phone's copy, flags still shown, no Add",
                  fp.locator("[data-flag=order_overdue]").count() == 1 and fp.get_by_role("button", name="Add an item").count() == 0)
            fp.goto(APP + "#/calendar")
            expect(fp.get_by_text(re.compile("^No signal. Showing the calendar"))).to_be_visible()
            expect(fp.locator(".cal-entry[data-type=milestone]")).to_be_visible()
            check("offline: calendar from the phone's copy, no Add site visit", fp.locator(".cal-entry[data-type=milestone]").count() == 1
                  and fp.get_by_role("button", name="Add site visit").count() == 0)
            fctx.unroute(api, abort)
            fctx.set_offline(False)
        fctx.close()

    check("no page errors", not errors, "; ".join(errors[:3]))
    browser.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
