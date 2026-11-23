-- Live rule checks for part 6 (money, decisions, procurement). Always ends in an exception, so nothing is kept.
do $$
declare
  owner_id uuid := (select id from public.profiles where role = 'owner' order by id limit 1);
  coord_id uuid := (select id from public.profiles where role = 'coordinator' order by id limit 1);
  proj uuid := (select id from public.projects where archived = false order by created_at limit 1);
  other uuid := (select id from public.projects where id <> proj order by created_at limit 1);
  v uuid; boq_id uuid; bill uuid; dec uuid; inv uuid; wo uuid;
  passed int := 0; total int := 0; failures text := ''; n int; t text;
begin
  -- As the coordinator (studio account)
  perform set_config('request.jwt.claims', json_build_object('sub', coord_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  total := total + 1;
  begin
    insert into public.vendors (name, kind, trade) values ('Rule Test Joinery', 'agency', 'Carpentry') returning id into v;
    insert into public.boq_items (project_id, category, item, unit, quantity, rate) values (proj, 'Kitchen', 'Rule test shutter', 'sq. ft.', 100, 1200) returning id into boq_id;
    select count(*) into n from public.boq_items where id = boq_id and created_by = coord_id;
    if n = 1 then passed := passed + 1; else failures := failures || ' [1 created_by]'; end if;
  exception when others then failures := failures || ' [1 team cannot add vendor/BOQ: ' || sqlerrm || ']';
  end;

  total := total + 1;
  begin
    insert into public.vendors (name) values ('rule test joinery ');
    failures := failures || ' [2 duplicate vendor name accepted]';
  exception when unique_violation then passed := passed + 1;
  end;

  total := total + 1;
  begin
    insert into public.ra_bills (project_id, vendor_id, bill_no, claimed_amount) values (proj, v, 'RA-1', 120000) returning id into bill;
    insert into public.ra_bill_lines (bill_id, boq_item_id, claimed_qty, certified_qty) values (bill, boq_id, 100, 95);
    select count(*) into n from public.ra_bill_lines where bill_id = bill and rate = 1200;
    if n = 1 then passed := passed + 1; else failures := failures || ' [3 line rate not filled from BOQ]'; end if;
  exception when others then failures := failures || ' [3 bill/line: ' || sqlerrm || ']';
  end;

  total := total + 1;
  begin
    update public.ra_bills set status = 'certified' where id = bill;
    failures := failures || ' [4 certified without amount]';
  exception when raise_exception then passed := passed + 1;
  end;

  total := total + 1;
  update public.ra_bills set status = 'certified', certified_amount = 114000 where id = bill;
  if (select certified_on from public.ra_bills where id = bill) = (now() at time zone 'Asia/Kolkata')::date then passed := passed + 1;
  else failures := failures || ' [5 certified_on not stamped]'; end if;

  total := total + 1;
  begin
    update public.ra_bill_lines set certified_qty = 99 where bill_id = bill;
    failures := failures || ' [6 lines editable after certification]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  total := total + 1;
  begin
    update public.ra_bills set certified_amount = 1 where id = bill;
    failures := failures || ' [7 coordinator changed certified amount]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  total := total + 1;
  begin
    update public.ra_bills set status = 'measured' where id = bill;
    failures := failures || ' [8 coordinator moved bill back]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  total := total + 1;
  update public.ra_bills set status = 'paid' where id = bill;
  if (select paid_amount from public.ra_bills where id = bill) = 134520.00 then passed := passed + 1;
  else failures := failures || ' [9 paid amount not certified + GST: ' || coalesce((select paid_amount from public.ra_bills where id = bill)::text, 'null') || ']'; end if;

  total := total + 1;
  begin
    update public.boq_items set removed_at = now() where id = boq_id;
    failures := failures || ' [10 coordinator removed BOQ item]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  -- Owner-only money is invisible and closed to the coordinator
  foreach t in array array['project_fees', 'fee_proposals', 'fee_invoices', 'studio_costs', 'studio_private'] loop
    total := total + 1;
    execute format('select count(*) from public.%I', t) into n;
    if n = 0 then passed := passed + 1; else failures := failures || ' [11 coordinator sees ' || t || ']'; end if;
  end loop;

  total := total + 1;
  begin
    insert into public.fee_invoices (project_id, milestone, amount) values (proj, 'Rule test', 1);
    failures := failures || ' [12 coordinator added a fee invoice]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  total := total + 1;
  begin
    update public.studio_settings set name = 'Hacked' where id = 1;
    get diagnostics n = row_count;
    if n = 0 then passed := passed + 1; else failures := failures || ' [13 coordinator edited studio settings]'; end if;
  exception when insufficient_privilege then passed := passed + 1;
  end;

  total := total + 1;
  begin
    insert into public.decisions (project_id, kind, question, cost_impact, boq_item_id) values (proj, 'site_instruction', 'Rule test: add pelmet', 15000, boq_id) returning id into dec;
    select count(*) into n from public.variations where decision_id = dec and amount = 15000 and status = 'proposed' and boq_item_id = boq_id;
    if n = 1 then passed := passed + 1; else failures := failures || ' [14 cost impact did not propose a variation]'; end if;
  exception when others then failures := failures || ' [14 decision: ' || sqlerrm || ']';
  end;

  total := total + 1;
  update public.decisions set cost_impact = 18000 where id = dec;
  select count(*) into n from public.variations where decision_id = dec;
  if n = 1 then passed := passed + 1; else failures := failures || ' [15 second variation created]'; end if;

  total := total + 1;
  if other is null then passed := passed + 1;
  else
    begin
      insert into public.decisions (project_id, question, boq_item_id) values (other, 'Cross-project link', boq_id);
      failures := failures || ' [16 cross-project link accepted]';
    exception when foreign_key_violation then passed := passed + 1;
    end;
  end if;

  total := total + 1;
  insert into public.procurement_items (project_id, item, lead_days) values (proj, 'Rule test hob', 21) returning id into wo;
  update public.procurement_items set status = 'on_site' where id = wo;
  if (select spec_approved and ordered_on is not null and delivered_on is not null from public.procurement_items where id = wo) then passed := passed + 1;
  else failures := failures || ' [17 procurement dates not stamped]'; end if;

  total := total + 1;
  begin
    delete from public.boq_items where id = boq_id;
    failures := failures || ' [18 delete allowed]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  -- As the owner
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  total := total + 1;
  begin
    insert into public.project_fees (project_id, fee_amount, gst_rate) values (proj, 200000, 18)
      on conflict (project_id) do update set fee_amount = 200000;
    insert into public.fee_invoices (project_id, milestone, amount, gst_rate, status) values (proj, 'Rule test stage 1', 40000, 18, 'paid') returning id into inv;
    if (select paid_amount = 47200 and raised_on is not null from public.fee_invoices where id = inv) then passed := passed + 1;
    else failures := failures || ' [19 fee invoice paid amount/dates]'; end if;
  exception when others then failures := failures || ' [19 owner fees: ' || sqlerrm || ']';
  end;

  total := total + 1;
  update public.ra_bills set status = 'certified' where id = bill;
  if (select paid_on is null and paid_amount is null from public.ra_bills where id = bill) then passed := passed + 1;
  else failures := failures || ' [20 owner move-back did not clear paid]'; end if;

  total := total + 1;
  update public.boq_items set removed_at = now() where id = boq_id;
  if (select removed_by = owner_id from public.boq_items where id = boq_id) then passed := passed + 1;
  else failures := failures || ' [21 owner remove not stamped]'; end if;

  total := total + 1;
  update public.studio_settings set gstin = 'TEST' where id = 1;
  get diagnostics n = row_count;
  if n = 1 then passed := passed + 1; else failures := failures || ' [22 owner cannot edit settings]'; end if;

  -- Signed out
  execute 'reset role';
  execute 'set local role anon';
  total := total + 1;
  begin
    perform 1 from public.boq_items limit 1;
    failures := failures || ' [23 anon can read BOQ]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  execute 'reset role';
  raise exception 'RESULTS: %/% passed.%', passed, total, case when failures = '' then ' All good.' else ' Failures:' || failures end;
end;
$$;
