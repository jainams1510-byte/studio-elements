-- Studio Elements tool: database setup, part 2 (drawing register).
-- Applied to the live project on 22 Nov 2026 as migration "drawing_register".
-- Needs part 1 first (it provides projects, profiles and private.is_team()).

create table if not exists public.drawings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  number text not null check (length(trim(number)) > 0),
  title text not null check (length(trim(title)) > 0),
  discipline text not null default 'Other',
  archived boolean not null default false,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (project_id, number)
);
create index if not exists drawings_project on public.drawings (project_id);

-- P1, P2 ... before approval; R0, R1 ... for construction.
-- rank orders them: every R comes after every P.
create table if not exists public.drawing_revisions (
  id uuid primary key default gen_random_uuid(),
  drawing_id uuid not null references public.drawings (id) on delete restrict,
  code text not null check (code ~ '^(P[1-9][0-9]{0,2}|R[0-9]{1,3})$'),
  rank integer generated always as (
    case when left(code, 1) = 'P' then substring(code from 2)::integer
         else 1000 + substring(code from 2)::integer end
  ) stored,
  revised_on date not null default current_date,
  note text not null default '',
  file_link text,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (drawing_id, code)
);
create index if not exists drawing_revisions_drawing on public.drawing_revisions (drawing_id, rank desc);

create table if not exists public.drawing_issues (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.drawing_revisions (id) on delete restrict,
  issued_to text not null check (length(trim(issued_to)) > 0),
  method text not null default 'WhatsApp'
    check (method in ('WhatsApp', 'Print on site', 'Drive link', 'Email', 'By hand')),
  issued_on date not null default current_date,
  print_photo_path text,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);
create index if not exists drawing_issues_revision on public.drawing_issues (revision_id);

alter table public.drawings enable row level security;
alter table public.drawing_revisions enable row level security;
alter table public.drawing_issues enable row level security;

-- Supabase grants everything to signed-in users by default: take it back,
-- then give only read, add and edit. Nothing in the register can be deleted.
revoke all on public.drawings, public.drawing_revisions, public.drawing_issues from anon, authenticated;
grant select, insert, update on public.drawings, public.drawing_revisions, public.drawing_issues to authenticated;

drop policy if exists "team reads drawings" on public.drawings;
create policy "team reads drawings" on public.drawings for select to authenticated using (private.is_team());
drop policy if exists "team adds drawings" on public.drawings;
create policy "team adds drawings" on public.drawings for insert to authenticated with check (private.is_team());
drop policy if exists "team edits drawings" on public.drawings;
create policy "team edits drawings" on public.drawings for update to authenticated using (private.is_team()) with check (private.is_team());

drop policy if exists "team reads revisions" on public.drawing_revisions;
create policy "team reads revisions" on public.drawing_revisions for select to authenticated using (private.is_team());
drop policy if exists "team adds revisions" on public.drawing_revisions;
create policy "team adds revisions" on public.drawing_revisions for insert to authenticated with check (private.is_team());
drop policy if exists "team edits revisions" on public.drawing_revisions;
create policy "team edits revisions" on public.drawing_revisions for update to authenticated using (private.is_team()) with check (private.is_team());

drop policy if exists "team reads issues" on public.drawing_issues;
create policy "team reads issues" on public.drawing_issues for select to authenticated using (private.is_team());
drop policy if exists "team adds issues" on public.drawing_issues;
create policy "team adds issues" on public.drawing_issues for insert to authenticated with check (private.is_team());
drop policy if exists "team edits issues" on public.drawing_issues;
create policy "team edits issues" on public.drawing_issues for update to authenticated using (private.is_team()) with check (private.is_team());
