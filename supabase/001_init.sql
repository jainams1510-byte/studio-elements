-- Studio Elements tool: database setup, part 1 (sign-in, projects, site log).
-- Run once: Supabase dashboard > SQL editor > paste this whole file > Run.
-- Safe to run again: every statement checks before it creates.

-- 1. People --------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  role text not null default 'team' check (role in ('owner', 'team', 'coordinator')),
  created_at timestamptz not null default now()
);

-- Every user you add in the dashboard gets a profile automatically.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users created before this script ran.
insert into public.profiles (id, full_name)
select u.id, split_part(u.email, '@', 1)
from auth.users u
on conflict (id) do nothing;

-- "Is the signed-in person on the team?" Used by every rule below.
create or replace function public.is_team()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()));
$$;

-- These helpers are for the rules and the trigger only, not for callers on the web.
revoke execute on function public.is_team() from public, anon;
grant execute on function public.is_team() to authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- 2. Projects ------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text,
  stage smallint not null default 1 check (stage between 1 and 8),
  rooms text[] not null default '{}',
  trades text[] not null default array[
    'Carpentry', 'Electrical', 'Plumbing', 'Civil',
    'False ceiling', 'Tiling', 'Glass', 'Modular'
  ],
  archived boolean not null default false,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

-- 3. Site log ------------------------------------------------------------
-- The id comes from the phone, so a log uploaded twice is stored once.
create table if not exists public.site_logs (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete restrict,
  room text,
  trade text,
  note text not null default '',
  audio_path text,
  logged_at timestamptz not null,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);
create index if not exists site_logs_project_time on public.site_logs (project_id, logged_at desc);

create table if not exists public.site_log_photos (
  id uuid primary key,
  log_id uuid not null references public.site_logs (id) on delete cascade,
  path text not null,
  created_at timestamptz not null default now()
);
create index if not exists site_log_photos_log on public.site_log_photos (log_id);

-- 4. Access rules --------------------------------------------------------
-- Only signed-in team members can read or write. Nobody can delete a log
-- from the app: a site log is a record.
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.site_logs enable row level security;
alter table public.site_log_photos enable row level security;

-- Supabase grants every privilege on new tables to signed-in users by default.
-- Take that away and give back only what the app needs. No delete, no truncate.
revoke all on public.profiles, public.projects, public.site_logs, public.site_log_photos from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.projects to authenticated;
grant select, insert, update on public.site_logs to authenticated;
grant select, insert, update on public.site_log_photos to authenticated;

drop policy if exists "team reads profiles" on public.profiles;
create policy "team reads profiles" on public.profiles
  for select to authenticated using (public.is_team());

drop policy if exists "person edits own profile" on public.profiles;
create policy "person edits own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "team reads projects" on public.projects;
create policy "team reads projects" on public.projects
  for select to authenticated using (public.is_team());
drop policy if exists "team adds projects" on public.projects;
create policy "team adds projects" on public.projects
  for insert to authenticated with check (public.is_team());
drop policy if exists "team edits projects" on public.projects;
create policy "team edits projects" on public.projects
  for update to authenticated using (public.is_team()) with check (public.is_team());

drop policy if exists "team reads logs" on public.site_logs;
create policy "team reads logs" on public.site_logs
  for select to authenticated using (public.is_team());
drop policy if exists "team adds logs" on public.site_logs;
create policy "team adds logs" on public.site_logs
  for insert to authenticated with check (public.is_team() and created_by = (select auth.uid()));
-- Update is allowed only so the same person's retried upload can land.
drop policy if exists "author re-uploads own log" on public.site_logs;
create policy "author re-uploads own log" on public.site_logs
  for update to authenticated
  using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));

drop policy if exists "team reads log photos" on public.site_log_photos;
create policy "team reads log photos" on public.site_log_photos
  for select to authenticated using (public.is_team());
drop policy if exists "team adds log photos" on public.site_log_photos;
create policy "team adds log photos" on public.site_log_photos
  for insert to authenticated with check (public.is_team());
drop policy if exists "team re-uploads log photos" on public.site_log_photos;
create policy "team re-uploads log photos" on public.site_log_photos
  for update to authenticated using (public.is_team()) with check (public.is_team());

-- 5. Photo and voice storage --------------------------------------------
insert into storage.buckets (id, name, public)
values ('site-media', 'site-media', false)
on conflict (id) do nothing;

drop policy if exists "team reads site media" on storage.objects;
create policy "team reads site media" on storage.objects
  for select to authenticated using (bucket_id = 'site-media' and public.is_team());
drop policy if exists "team adds site media" on storage.objects;
create policy "team adds site media" on storage.objects
  for insert to authenticated with check (bucket_id = 'site-media' and public.is_team());
drop policy if exists "team re-uploads site media" on storage.objects;
create policy "team re-uploads site media" on storage.objects
  for update to authenticated
  using (bucket_id = 'site-media' and public.is_team())
  with check (bucket_id = 'site-media' and public.is_team());
