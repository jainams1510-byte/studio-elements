-- Studio Elements tool: database setup, part 6.
-- Money (estimate/BOQ, quotes, work orders, RA bills, fees, fee proposals, studio costs), vendors,
-- project brief, decisions and variations, procurement, site visits, presentation decks, studio settings.
-- Team-visible: everything about the client's project money and the site.
-- Owner-only: the studio's own money (fees, fee proposals, invoices, studio costs, opening cash).
-- Needs parts 1-5 (projects, drawings, tasks, site_logs, private.is_team/is_owner/ist_today).
-- Applied live on 23 Nov 2026 as three migrations (money_part1_tables, money_part2_rules, money_part3_access)
-- because the combined prompt was too large for the app to confirm. This file is the same, combined and re-runnable.

-- 0. Helpers ---------------------------------------------------------------------------------

-- The project a row of another table belongs to (for "same project" checks).
create or replace function private.project_of(tbl text, ref uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare p uuid;
begin
  execute format('select project_id from public.%I where id = $1', tbl) into p using ref;
  return p;
end;
$$;
revoke all on function private.project_of(text, uuid) from public;

create or replace function private.assert_same_project(p uuid, tbl text, ref uuid, what text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if ref is not null and private.project_of(tbl, ref) is distinct from p then
    raise exception '% belongs to another project or does not exist.', what using errcode = '23503';
  end if;
end;
$$;
revoke all on function private.assert_same_project(uuid, text, uuid, text) from public;

-- Shared rules for project records: fixed columns stay fixed; only owners remove or restore.
create or replace function private.row_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
    new.removed_at := null;
    new.removed_by := null;
    return new;
  end if;
  new.id := old.id;
  new.project_id := old.project_id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.removed_by := old.removed_by;
  if new.removed_at is distinct from old.removed_at then
    if not private.is_owner() then
      raise exception 'Only an owner can remove or restore this.' using errcode = '42501';
    end if;
    if new.removed_at is null then
      new.removed_by := null;
    else
      new.removed_at := now();
      new.removed_by := auth.uid();
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Shared columns for project records (written out per table below):
--   id, project_id, created_by, created_at, updated_at, removed_at, removed_by

-- 1. Vendors (agencies, suppliers, consultants) --------------------------------------------
create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  kind text not null default 'agency' check (kind in ('agency', 'supplier', 'consultant')),
  trade text,
  contact_name text,
  phone text,
  email text,
  gstin text,
  notes text not null default '',
  archived boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists vendors_name on public.vendors (lower(trim(name)));

create or replace function private.vendor_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.archived := false;
    return new;
  end if;
  new.id := old.id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if new.archived is distinct from old.archived and not private.is_owner() then
    raise exception 'Only an owner can remove or restore a vendor.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists a_vendor_guard on public.vendors;
create trigger a_vendor_guard before insert or update on public.vendors for each row execute function private.vendor_guard();

-- 2. Project brief (from Project Studio) ---------------------------------------------------
create table if not exists public.project_briefs (
  project_id uuid primary key references public.projects (id) on delete restrict,
  client_name text,
  client_phone text,
  client_email text,
  site_address text,
  city text,
  typology text not null default 'residential'
    check (typology in ('residential', 'commercial', 'hospitality', 'office', 'retail', 'institutional', 'other')),
  area numeric(12, 2) check (area is null or area >= 0),
  area_unit text not null default 'sq. ft.' check (area_unit in ('sq. ft.', 'sq. m.')),
  issue_date date,
  agreement_date date,
  start_date date,
  end_date date,
  duration_months numeric(5, 1) check (duration_months is null or duration_months >= 0),
  client_budget numeric(14, 2) check (client_budget is null or client_budget >= 0),
  budget_includes_gst boolean not null default false,
  estimate_gst_rate numeric(5, 2) not null default 18 check (estimate_gst_rate between 0 and 28),
  contingency_pct numeric(5, 2) not null default 5 check (contingency_pct between 0 and 50),
  -- Which internal details the client estimate PDF shows (Project Studio's "Client PDF" ticks).
  estimate_pdf jsonb not null default '{"room":true,"qty":true,"optional":true,"cat":true,"cont":true,"gst":true,"psf":false,"budget":false,"rate":false,"waste":false,"src":false,"status":false}',
  updated_at timestamptz not null default now()
);

-- 3. Estimate / BOQ -------------------------------------------------------------------------
create table if not exists public.work_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  vendor_id uuid not null references public.vendors (id) on delete restrict,
  quote_id uuid,
  trade text,
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  issued_on date not null default current_date,
  note text not null default '',
  file_link text,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid
);

create table if not exists public.boq_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  category text not null default 'Other',
  trade text,
  room text,
  item text not null check (length(trim(item)) > 0),
  unit text not null default 'no.',
  quantity numeric(14, 3) not null default 0 check (quantity >= 0),
  rate numeric(14, 2) not null default 0 check (rate >= 0),           -- estimate / budget rate
  wastage_pct numeric(5, 2) not null default 0 check (wastage_pct between 0 and 100),
  rate_source text not null default '',
  verified boolean not null default false,
  optional boolean not null default false,                             -- shown, but not in the total
  work_order_id uuid references public.work_orders (id) on delete restrict,
  committed_rate numeric(14, 2) check (committed_rate is null or committed_rate >= 0),
  sort_order integer not null default 0,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid
);
create index if not exists boq_items_project on public.boq_items (project_id, category, sort_order);

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  vendor_id uuid not null references public.vendors (id) on delete restrict,
  trade text,
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  received_on date not null default current_date,
  status text not null default 'received' check (status in ('received', 'compared', 'accepted', 'rejected')),
  note text not null default '',
  file_link text,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid
);
alter table public.work_orders drop constraint if exists work_orders_quote_id_fkey;
alter table public.work_orders add constraint work_orders_quote_id_fkey foreign key (quote_id) references public.quotes (id) on delete restrict;

-- 4. RA bills (agency bills, certified by the studio, paid by the client) ---------------------
create table if not exists public.ra_bills (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  vendor_id uuid not null references public.vendors (id) on delete restrict,
  work_order_id uuid references public.work_orders (id) on delete restrict,
  bill_no text not null check (length(trim(bill_no)) > 0),
  bill_date date not null default current_date,
  claimed_amount numeric(14, 2) not null default 0 check (claimed_amount >= 0),
  certified_amount numeric(14, 2) check (certified_amount is null or certified_amount >= 0),
  gst_rate numeric(5, 2) not null default 18 check (gst_rate between 0 and 28),
  status text not null default 'submitted' check (status in ('submitted', 'measured', 'certified', 'client_approved', 'paid')),
  certified_on date,
  client_approved_on date,
  paid_on date,
  paid_amount numeric(14, 2) check (paid_amount is null or paid_amount >= 0),
  note text not null default '',
  file_link text,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid,
  unique (project_id, vendor_id, bill_no)
);

create table if not exists public.ra_bill_lines (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.ra_bills (id) on delete restrict,
  boq_item_id uuid not null references public.boq_items (id) on delete restrict,
  claimed_qty numeric(14, 3) not null default 0 check (claimed_qty >= 0),
  certified_qty numeric(14, 3) check (certified_qty is null or certified_qty >= 0),
  rate numeric(14, 2) check (rate is null or rate >= 0),               -- filled from the BOQ when left empty
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (bill_id, boq_item_id)
);

-- 5. Studio money (owner only) --------------------------------------------------------------
create table if not exists public.project_fees (
  project_id uuid primary key references public.projects (id) on delete restrict,
  fee_amount numeric(14, 2) not null default 0 check (fee_amount >= 0),       -- agreed fee before GST
  gst_rate numeric(5, 2) not null default 18 check (gst_rate between 0 and 28),
  payment_terms_days integer not null default 7 check (payment_terms_days between 0 and 180),
  updated_at timestamptz not null default now()
);

create table if not exists public.fee_proposals (
  project_id uuid primary key references public.projects (id) on delete restrict,
  method text not null default 'fixed' check (method in ('fixed', 'percent', 'per_sqft')),
  fixed_fee numeric(14, 2),
  percent numeric(6, 3),
  rate_psf numeric(10, 2),
  stage_pct numeric(6, 2)[] not null default '{20,30,30,20}',
  stage_override numeric(14, 2)[] not null default '{null,null,null,null}',
  milestones jsonb not null default '[{"name":"Appointment and commencement","pct":20},{"name":"Concept approval","pct":30},{"name":"Working drawing issue","pct":30},{"name":"Final handover","pct":20}]',
  legal_reviewed boolean not null default false,
  updated_at timestamptz not null default now(),
  check (cardinality(stage_pct) = 4 and cardinality(stage_override) = 4)
);

create table if not exists public.fee_invoices (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  milestone text not null check (length(trim(milestone)) > 0),
  task_id uuid references public.tasks (id) on delete restrict,     -- schedule milestone that triggers it
  amount numeric(14, 2) not null default 0 check (amount >= 0),       -- before GST
  gst_rate numeric(5, 2) not null default 18 check (gst_rate between 0 and 28),
  due_date date,
  status text not null default 'scheduled' check (status in ('scheduled', 'raised', 'paid')),
  invoice_no text,
  raised_on date,
  paid_on date,
  paid_amount numeric(14, 2) check (paid_amount is null or paid_amount >= 0),
  note text not null default '',
  sort_order integer not null default 0,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid
);

create table if not exists public.studio_costs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  spent_on date not null default current_date,
  category text not null default 'Other' check (category in ('Consultant', 'Travel', 'Printing', 'Site visit', 'Samples', 'Other')),
  vendor_id uuid references public.vendors (id) on delete restrict,
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  status text not null default 'paid' check (status in ('planned', 'paid')),
  note text not null default '',
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid
);

create table if not exists public.studio_private (
  id integer primary key default 1 check (id = 1),
  opening_cash numeric(14, 2) not null default 0,
  updated_at timestamptz not null default now()
);

-- 6. Studio settings and clause library (team reads, owners write) --------------------------
create table if not exists public.studio_settings (
  id integer primary key default 1 check (id = 1),
  name text not null default 'Studio Elements',
  tagline text not null default 'Architecture · Interior Design · Project Management',
  website text not null default 'www.studioelements.in',
  email text not null default 'info@studioelements.in',
  phone text not null default '+91 8511357002',
  gstin text not null default '',
  logo_path text,
  clauses jsonb not null default '{}',     -- overrides of the reference clause text, by key
  updated_at timestamptz not null default now()
);
insert into public.studio_settings (id) values (1) on conflict (id) do nothing;

-- 7. Decisions, approvals, revisions and variations -------------------------------------------
create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  kind text not null default 'rfi' check (kind in ('rfi', 'approval', 'site_instruction', 'revision')),
  approval_kind text check (approval_kind is null or approval_kind in ('client', 'material')),
  question text not null check (length(trim(question)) > 0),
  answer text not null default '',
  raised_by text,                     -- for revisions: client or internal
  revision_round integer check (revision_round is null or revision_round between 1 and 50),
  need_by date,
  blocks text not null default '',    -- what waits on it
  decided_by text,
  decided_on date,
  status text not null default 'open' check (status in ('open', 'answered', 'confirmed', 'closed')),
  cost_impact numeric(14, 2),
  drawing_id uuid references public.drawings (id) on delete restrict,
  boq_item_id uuid references public.boq_items (id) on delete restrict,
  task_id uuid references public.tasks (id) on delete restrict,
  source_log_id uuid references public.site_logs (id) on delete restrict,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid
);
create index if not exists decisions_project on public.decisions (project_id, status);

create table if not exists public.variations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  decision_id uuid references public.decisions (id) on delete restrict,
  boq_item_id uuid references public.boq_items (id) on delete restrict,
  description text not null check (length(trim(description)) > 0),
  amount numeric(14, 2) not null default 0,
  status text not null default 'proposed' check (status in ('proposed', 'costed', 'client_approved', 'executed', 'billed')),
  client_approved_on date,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid
);
create unique index if not exists variations_one_per_decision on public.variations (decision_id) where decision_id is not null;

-- 8. Procurement and site visits -----------------------------------------------------------------
create table if not exists public.procurement_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  item text not null check (length(trim(item)) > 0),
  trade text,
  room text,
  task_id uuid references public.tasks (id) on delete restrict,   -- needed on site before this task starts
  need_by date,                                                    -- used when no task is linked
  lead_days integer not null default 14 check (lead_days between 0 and 365),
  vendor_id uuid references public.vendors (id) on delete restrict,
  spec_approved boolean not null default false,
  status text not null default 'specified' check (status in ('specified', 'approved', 'ordered', 'on_site')),
  ordered_on date,
  expected_on date,
  delivered_on date,
  note text not null default '',
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid
);

create table if not exists public.site_visits (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  visit_on date not null,
  visit_time text,
  purpose text not null default '',
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  removed_at timestamptz, removed_by uuid
);

-- 9. Presentation decks ------------------------------------------------------------------------
-- slides: [{ "kind": "asbuilt"|"keyplan"|"room"|"thanks", "title": text, "slots": { "<slot>": "<storage path>" } }]
create table if not exists public.project_decks (
  project_id uuid primary key references public.projects (id) on delete restrict,
  slides jsonb not null default '[]',
  key_plan_path text,
  updated_at timestamptz not null default now()
);

-- 10. Record-specific rules ---------------------------------------------------------------------

-- Same-project links.
create or replace function private.links_check()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  case tg_table_name
    when 'boq_items' then
      perform private.assert_same_project(new.project_id, 'work_orders', new.work_order_id, 'The work order');
    when 'work_orders' then
      perform private.assert_same_project(new.project_id, 'quotes', new.quote_id, 'The quote');
    when 'ra_bills' then
      perform private.assert_same_project(new.project_id, 'work_orders', new.work_order_id, 'The work order');
    when 'fee_invoices' then
      perform private.assert_same_project(new.project_id, 'tasks', new.task_id, 'The milestone');
    when 'decisions' then
      perform private.assert_same_project(new.project_id, 'drawings', new.drawing_id, 'The sheet');
      perform private.assert_same_project(new.project_id, 'boq_items', new.boq_item_id, 'The BOQ item');
      perform private.assert_same_project(new.project_id, 'tasks', new.task_id, 'The task');
      perform private.assert_same_project(new.project_id, 'site_logs', new.source_log_id, 'The site log');
    when 'variations' then
      perform private.assert_same_project(new.project_id, 'decisions', new.decision_id, 'The decision');
      perform private.assert_same_project(new.project_id, 'boq_items', new.boq_item_id, 'The BOQ item');
    when 'procurement_items' then
      perform private.assert_same_project(new.project_id, 'tasks', new.task_id, 'The task');
    else
      null;
  end case;
  return null;
end;
$$;

-- RA bills: forward through the steps; dates stamped; certified figures fixed except by owners.
create or replace function private.ra_bill_rules()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  steps text[] := array['submitted', 'measured', 'certified', 'client_approved', 'paid'];
  o integer := 0;
  n integer := array_position(steps, new.status);
begin
  if tg_op = 'UPDATE' then
    o := array_position(steps, old.status);
    new.vendor_id := old.vendor_id;
    if n < o and not private.is_owner() then
      raise exception 'Only an owner can move a bill back a step.' using errcode = '42501';
    end if;
    if o >= 3 and new.certified_amount is distinct from old.certified_amount and not private.is_owner() then
      raise exception 'The bill is certified. Only an owner can change the certified amount.' using errcode = '42501';
    end if;
  end if;
  if n >= 3 and new.certified_amount is null then
    raise exception 'Enter the certified amount before certifying.' using errcode = 'P0001';
  end if;
  if n >= 3 then new.certified_on := coalesce(new.certified_on, private.ist_today()); else new.certified_on := null; end if;
  if n >= 4 then new.client_approved_on := coalesce(new.client_approved_on, private.ist_today()); else new.client_approved_on := null; end if;
  if n >= 5 then
    new.paid_on := coalesce(new.paid_on, private.ist_today());
    new.paid_amount := coalesce(new.paid_amount, round(new.certified_amount * (1 + new.gst_rate / 100), 2));
  else
    new.paid_on := null;
    new.paid_amount := null;
  end if;
  return new;
end;
$$;

-- RA bill lines: locked once the bill is certified (owners excepted); rate filled from the BOQ.
create or replace function private.ra_line_rules()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  st text;
  bill_project uuid;
  item_project uuid;
begin
  if tg_op = 'UPDATE' then
    new.bill_id := old.bill_id;
    new.boq_item_id := old.boq_item_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  else
    new.created_by := auth.uid();
  end if;
  select b.status, b.project_id into st, bill_project from public.ra_bills b where b.id = new.bill_id;
  select i.project_id into item_project from public.boq_items i where i.id = new.boq_item_id;
  if bill_project is distinct from item_project then
    raise exception 'The BOQ item belongs to another project.' using errcode = '23503';
  end if;
  if st in ('certified', 'client_approved', 'paid') and not private.is_owner() then
    raise exception 'The bill is certified; its lines are locked.' using errcode = '42501';
  end if;
  if new.rate is null then
    select coalesce(i.committed_rate, i.rate) into new.rate from public.boq_items i where i.id = new.boq_item_id;
  end if;
  return new;
end;
$$;

-- Fee invoices: dates stamped from the status.
create or replace function private.fee_invoice_rules()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('raised', 'paid') then
    new.raised_on := coalesce(new.raised_on, private.ist_today());
  else
    new.raised_on := null;
  end if;
  if new.status = 'paid' then
    new.paid_on := coalesce(new.paid_on, private.ist_today());
    new.paid_amount := coalesce(new.paid_amount, round(new.amount * (1 + new.gst_rate / 100), 2));
  else
    new.paid_on := null;
    new.paid_amount := null;
  end if;
  return new;
end;
$$;

-- Decisions: decided date stamped; a cost impact proposes a variation (once).
create or replace function private.decision_rules()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('answered', 'confirmed', 'closed') then
    new.decided_on := coalesce(new.decided_on, private.ist_today());
  else
    new.decided_on := null;
  end if;
  return new;
end;
$$;

create or replace function private.decision_variation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.cost_impact is not null and new.cost_impact <> 0 and new.removed_at is null
     and not exists (select 1 from public.variations v where v.decision_id = new.id) then
    insert into public.variations (project_id, decision_id, boq_item_id, description, amount)
    values (new.project_id, new.id, new.boq_item_id, left(new.question, 300), new.cost_impact);
  end if;
  return null;
end;
$$;

create or replace function private.variation_rules()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('client_approved', 'executed', 'billed') then
    new.client_approved_on := coalesce(new.client_approved_on, private.ist_today());
  else
    new.client_approved_on := null;
  end if;
  return new;
end;
$$;

-- Procurement: dates and spec approval follow the status.
create or replace function private.procurement_rules()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('approved', 'ordered', 'on_site') then new.spec_approved := true; end if;
  if new.status in ('ordered', 'on_site') then new.ordered_on := coalesce(new.ordered_on, private.ist_today()); end if;
  if new.status = 'on_site' then new.delivered_on := coalesce(new.delivered_on, private.ist_today()); else new.delivered_on := null; end if;
  return new;
end;
$$;

-- Single-row and per-project settings tables: stamp the time.
create or replace function private.touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Wire the triggers. "a_" runs before "b_" (triggers fire in name order).
do $$
declare t text;
begin
  foreach t in array array['work_orders', 'boq_items', 'quotes', 'ra_bills', 'fee_invoices', 'studio_costs',
                           'decisions', 'variations', 'procurement_items', 'site_visits'] loop
    execute format('drop trigger if exists a_row_guard on public.%I', t);
    execute format('create trigger a_row_guard before insert or update on public.%I for each row execute function private.row_guard()', t);
  end loop;
  foreach t in array array['boq_items', 'work_orders', 'ra_bills', 'fee_invoices', 'decisions', 'variations', 'procurement_items'] loop
    execute format('drop trigger if exists z_links_check on public.%I', t);
    execute format('create trigger z_links_check after insert or update on public.%I for each row execute function private.links_check()', t);
  end loop;
  foreach t in array array['project_briefs', 'project_fees', 'fee_proposals', 'studio_private', 'studio_settings', 'project_decks'] loop
    execute format('drop trigger if exists a_touch on public.%I', t);
    execute format('create trigger a_touch before insert or update on public.%I for each row execute function private.touch()', t);
  end loop;
end;
$$;

drop trigger if exists b_ra_bill_rules on public.ra_bills;
create trigger b_ra_bill_rules before insert or update on public.ra_bills for each row execute function private.ra_bill_rules();
drop trigger if exists a_ra_line_rules on public.ra_bill_lines;
create trigger a_ra_line_rules before insert or update on public.ra_bill_lines for each row execute function private.ra_line_rules();
drop trigger if exists b_fee_invoice_rules on public.fee_invoices;
create trigger b_fee_invoice_rules before insert or update on public.fee_invoices for each row execute function private.fee_invoice_rules();
drop trigger if exists b_decision_rules on public.decisions;
create trigger b_decision_rules before insert or update on public.decisions for each row execute function private.decision_rules();
drop trigger if exists y_decision_variation on public.decisions;
create trigger y_decision_variation after insert or update of cost_impact on public.decisions for each row execute function private.decision_variation();
drop trigger if exists b_variation_rules on public.variations;
create trigger b_variation_rules before insert or update on public.variations for each row execute function private.variation_rules();
drop trigger if exists b_procurement_rules on public.procurement_items;
create trigger b_procurement_rules before insert or update on public.procurement_items for each row execute function private.procurement_rules();

-- 11. Access ----------------------------------------------------------------------------------
do $$
declare t text;
begin
  -- Team: read, add, edit. Nothing is deleted.
  foreach t in array array['vendors', 'project_briefs', 'work_orders', 'boq_items', 'quotes', 'ra_bills', 'ra_bill_lines',
                           'decisions', 'variations', 'procurement_items', 'site_visits', 'project_decks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('drop policy if exists "team reads" on public.%I', t);
    execute format('create policy "team reads" on public.%I for select to authenticated using (private.is_team())', t);
    execute format('drop policy if exists "team adds" on public.%I', t);
    execute format('create policy "team adds" on public.%I for insert to authenticated with check (private.is_team())', t);
    execute format('drop policy if exists "team edits" on public.%I', t);
    execute format('create policy "team edits" on public.%I for update to authenticated using (private.is_team()) with check (private.is_team())', t);
  end loop;
  -- Owners only: the studio's own money.
  foreach t in array array['project_fees', 'fee_proposals', 'fee_invoices', 'studio_costs', 'studio_private'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('drop policy if exists "owners read" on public.%I', t);
    execute format('create policy "owners read" on public.%I for select to authenticated using (private.is_owner())', t);
    execute format('drop policy if exists "owners add" on public.%I', t);
    execute format('create policy "owners add" on public.%I for insert to authenticated with check (private.is_owner())', t);
    execute format('drop policy if exists "owners edit" on public.%I', t);
    execute format('create policy "owners edit" on public.%I for update to authenticated using (private.is_owner()) with check (private.is_owner())', t);
  end loop;
end;
$$;

-- Studio settings: everyone on the team reads (for document headers); owners change them.
alter table public.studio_settings enable row level security;
revoke all on public.studio_settings from anon, authenticated;
grant select, update on public.studio_settings to authenticated;
drop policy if exists "team reads" on public.studio_settings;
create policy "team reads" on public.studio_settings for select to authenticated using (private.is_team());
drop policy if exists "owners edit" on public.studio_settings;
create policy "owners edit" on public.studio_settings for update to authenticated using (private.is_owner()) with check (private.is_owner());

insert into public.studio_private (id) values (1) on conflict (id) do nothing;
