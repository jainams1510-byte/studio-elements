-- Studio Elements tool: database setup, part 3 (AI transcripts, two-person review, weekly reports).
-- Needs parts 1 and 2 first.
--
-- Rules this enforces:
-- * Only the server function writes AI output. The team can read it and edit the summary text.
-- * Editing the summary clears every confirmation, so reviewers always confirm the same words.
-- * A person can only record their own review. Nothing can be deleted from the app.
-- * Editing an approved weekly report puts it back to draft.

-- 1. AI output for a site log ---------------------------------------------
create table if not exists public.site_log_ai (
  log_id uuid primary key references public.site_logs (id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  language text,
  transcript text,
  summary text,
  final_summary text,
  suggested_room text,
  suggested_trade text,
  model text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Reviews: one per person per log ---------------------------------------
create table if not exists public.site_log_reviews (
  id uuid primary key default gen_random_uuid(),
  log_id uuid not null references public.site_log_ai (log_id) on delete restrict,
  reviewer_id uuid not null default auth.uid() references public.profiles (id),
  decision text not null check (decision in ('confirm', 'reject')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (log_id, reviewer_id)
);
create index if not exists site_log_reviews_log on public.site_log_reviews (log_id);

-- 3. Weekly reports ---------------------------------------------------------
create table if not exists public.weekly_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  week_start date not null check (extract(isodow from week_start) = 1),
  kind text not null check (kind in ('client', 'internal')),
  language text not null default 'English' check (language in ('English', 'Hindi', 'Gujarati')),
  body text not null default '',
  status text not null default 'draft' check (status in ('draft', 'approved')),
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  model text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (project_id, week_start, kind)
);

-- 4. Triggers ---------------------------------------------------------------
create or replace function private.ai_summary_edited()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.final_summary is distinct from old.final_summary then
    delete from public.site_log_reviews where log_id = new.log_id;
  end if;
  return new;
end;
$$;
drop trigger if exists site_log_ai_edited on public.site_log_ai;
create trigger site_log_ai_edited before update on public.site_log_ai
  for each row execute function private.ai_summary_edited();

create or replace function private.review_touched()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists site_log_reviews_touched on public.site_log_reviews;
create trigger site_log_reviews_touched before update on public.site_log_reviews
  for each row execute function private.review_touched();

create or replace function private.report_edited()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.body is distinct from old.body and old.status = 'approved' and new.status = 'approved' then
    new.status := 'draft';
    new.approved_by := null;
    new.approved_at := null;
  end if;
  if new.status = 'approved' and old.status is distinct from 'approved' then
    new.approved_by := (select auth.uid());
    new.approved_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists weekly_reports_edited on public.weekly_reports;
create trigger weekly_reports_edited before update on public.weekly_reports
  for each row execute function private.report_edited();

revoke execute on function private.ai_summary_edited(), private.review_touched(), private.report_edited() from public, anon, authenticated;

-- 5. Access rules -----------------------------------------------------------
alter table public.site_log_ai enable row level security;
alter table public.site_log_reviews enable row level security;
alter table public.weekly_reports enable row level security;

revoke all on public.site_log_ai, public.site_log_reviews, public.weekly_reports from anon, authenticated;

-- AI output: the team reads it and may edit only the summary text.
grant select on public.site_log_ai to authenticated;
grant update (final_summary) on public.site_log_ai to authenticated;
drop policy if exists "team reads ai" on public.site_log_ai;
create policy "team reads ai" on public.site_log_ai for select to authenticated using (private.is_team());
drop policy if exists "team edits ai summary" on public.site_log_ai;
create policy "team edits ai summary" on public.site_log_ai for update to authenticated
  using (private.is_team() and status = 'done') with check (private.is_team() and status = 'done');

-- Reviews: everyone on the team reads them; each person writes only their own.
grant select on public.site_log_reviews to authenticated;
grant insert (log_id, decision) on public.site_log_reviews to authenticated;
grant update (decision) on public.site_log_reviews to authenticated;
drop policy if exists "team reads reviews" on public.site_log_reviews;
create policy "team reads reviews" on public.site_log_reviews for select to authenticated using (private.is_team());
drop policy if exists "person adds own review" on public.site_log_reviews;
create policy "person adds own review" on public.site_log_reviews for insert to authenticated
  with check (private.is_team() and reviewer_id = (select auth.uid()));
drop policy if exists "person changes own review" on public.site_log_reviews;
create policy "person changes own review" on public.site_log_reviews for update to authenticated
  using (reviewer_id = (select auth.uid())) with check (reviewer_id = (select auth.uid()));

-- Reports: the server writes drafts; the team reads, edits text and language, and approves.
grant select on public.weekly_reports to authenticated;
grant update (body, language, status) on public.weekly_reports to authenticated;
drop policy if exists "team reads reports" on public.weekly_reports;
create policy "team reads reports" on public.weekly_reports for select to authenticated using (private.is_team());
drop policy if exists "team edits reports" on public.weekly_reports;
create policy "team edits reports" on public.weekly_reports for update to authenticated
  using (private.is_team()) with check (private.is_team());
