-- Fill every table through the app's own rules, as the owner and the coordinator would.
insert into auth.users (id, email) values
  ('5ed9d262-a672-4844-996b-7e8de37fa9da', 'owner@example.com'),
  ('1fd9ffad-cfc4-44d1-ac2f-14f4318cf0d2', 'studio@example.com');
update public.profiles set role = 'owner', full_name = 'Jainam' where id = '5ed9d262-a672-4844-996b-7e8de37fa9da';
update public.profiles set role = 'coordinator', full_name = 'Studio' where id = '1fd9ffad-cfc4-44d1-ac2f-14f4318cf0d2';
insert into storage.buckets (id, name) values ('site-media', 'site-media') on conflict do nothing;

do $$
declare p uuid; l uuid := gen_random_uuid(); d uuid; r uuid; t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  v uuid; q uuid; wo uuid; b uuid; boq uuid; dec uuid;
begin
  perform set_config('request.jwt.claims', '{"sub":"5ed9d262-a672-4844-996b-7e8de37fa9da","role":"authenticated"}', true);
  execute 'set local role authenticated';
  insert into public.projects (name, stage, rooms) values ('Sparsh Ekaya', 4, array['Living room','Kitchen']) returning id into p;
  insert into public.site_logs (id, project_id, trade, note, logged_at, created_by) values (l, p, 'Plumbing', 'Toilet flooring', now(), auth.uid());
  insert into public.site_log_photos (id, log_id, path) values (gen_random_uuid(), l, p || '/' || l || '/a.jpg');
  insert into public.drawings (project_id, number, title, discipline) values (p, 'SE-FL-01', 'Furniture layout', 'Furniture layout') returning id into d;
  insert into public.drawing_revisions (drawing_id, code) values (d, 'P1') returning id into r;
  insert into public.drawing_issues (revision_id, issued_to, method) values (r, 'Site', 'Print on site');
  insert into public.project_schedules (project_id, start_date, holidays) values (p, '2026-12-07', array['2026-12-25']::date[]);
  insert into public.tasks (id, project_id, stage, name, duration, after_ids) values
    (t1, p, 6, 'Civil work', 15, '{}'), (t2, p, 6, 'Carpentry', 25, array[t1]);
  update public.project_schedules set baseline_at = now(),
    baseline_plan = jsonb_build_object(t1::text, '{"start":"2026-12-07","end":"2026-12-23"}'::jsonb, t2::text, '{"start":"2026-12-24","end":"2027-01-26"}'::jsonb)
   where project_id = p;
  update public.tasks set duration = 18, change_reason = 'Client added a study' where id = t1;
  insert into public.backup_log (summary, files) values ('drill', 1);
  insert into public.vendors (name, kind, trade, phone) values ('Kalpana Joinery', 'agency', 'Carpentry', '+91 98250 00000') returning id into v;
  insert into public.project_briefs (project_id, client_name, area, client_budget) values (p, 'Mr Sunil Shah', 2200, 2500000);
  insert into public.quotes (project_id, vendor_id, trade, amount, status) values (p, v, 'Carpentry', 480000, 'accepted') returning id into q;
  insert into public.work_orders (project_id, vendor_id, quote_id, trade, amount) values (p, v, q, 'Carpentry', 480000) returning id into wo;
  insert into public.boq_items (project_id, category, trade, item, unit, quantity, rate, work_order_id, committed_rate)
    values (p, 'Wardrobes and storage', 'Carpentry', 'Wardrobe, master bedroom', 'sq. ft.', 120, 1800, wo, 1750) returning id into boq;
  insert into public.ra_bills (project_id, vendor_id, work_order_id, bill_no, claimed_amount) values (p, v, wo, 'RA-1', 100000) returning id into b;
  insert into public.ra_bill_lines (bill_id, boq_item_id, claimed_qty, certified_qty) values (b, boq, 60, 55);
  update public.ra_bills set status = 'paid', certified_amount = 96250 where id = b;
  insert into public.decisions (project_id, kind, question, cost_impact, boq_item_id, need_by) values (p, 'approval', 'Wardrobe laminate change', 12000, boq, '2026-12-01') returning id into dec;
  insert into public.procurement_items (project_id, item, task_id, lead_days, vendor_id) values (p, 'Wardrobe hardware', t2, 21, v);
  insert into public.site_visits (project_id, visit_on, purpose) values (p, '2026-12-10', 'Marking');
  insert into public.project_decks (project_id, slides) values (p, '[{"kind":"room","title":"Living room","slots":{"a":"decks/x/1.jpg"}}]');
  update public.studio_settings set gstin = '24ABCDE1234F1Z5', clauses = '{"about":"Studio Elements is based in Ahmedabad."}' where id = 1;
  insert into public.project_fees (project_id, fee_amount, gst_rate) values (p, 200000, 18);
  insert into public.fee_proposals (project_id, method, percent, legal_reviewed) values (p, 'percent', 8, true);
  insert into public.fee_invoices (project_id, milestone, task_id, amount, status, invoice_no) values (p, 'Stage 1', t1, 40000, 'raised', 'SE/26-27/001');
  insert into public.studio_costs (project_id, category, amount, status) values (p, 'Printing', 2500, 'paid');
  update public.studio_private set opening_cash = 150000 where id = 1;

  -- The coordinator adds a site log too.
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"sub":"1fd9ffad-cfc4-44d1-ac2f-14f4318cf0d2","role":"authenticated"}', true);
  execute 'set local role authenticated';
  insert into public.site_logs (id, project_id, note, logged_at, created_by) values (gen_random_uuid(), p, 'Coordinator log', now(), auth.uid());
  execute 'reset role';
end $$;
