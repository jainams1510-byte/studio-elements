-- Studio Elements tool: database setup, part 5 (schedule, and a log of backups).
-- Tasks with finish-to-start "After" links, a per-project working calendar,
-- a baseline only an owner can freeze, and a reason for every change after that.
-- Planned dates are never stored: the app computes them (critical path) from durations and links.
-- Needs parts 1-4 first (projects, drawings, private.is_team(), private.is_owner()).

-- 1. Per-project calendar and baseline ------------------------------------------------
create table if not exists public.project_schedules (
  project_id uuid primary key references public.projects (id) on delete restrict,
  start_date date not null,
  -- ISO weekdays that are worked: 1 = Monday ... 7 = Sunday. Default Monday to Saturday.
  work_days smallint[] not null default '{1,2,3,4,5,6}'
    check (cardinality(work_days) > 0 and work_days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  holidays date[] not null default '{}',
  baseline_at timestamptz,
  baseline_by uuid,
  -- The frozen plan as the app computed it: { "<task id>": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" } }
  baseline_plan jsonb,
  -- Write-only channel for "why": read by the trigger, logged, then cleared.
  change_reason text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Tasks -------------------------------------------------------------------------------
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),     -- made by the app so "After" links can be sent in one go
  project_id uuid not null references public.projects (id) on delete restrict,
  stage smallint not null check (stage between 1 and 8),
  name text not null check (length(trim(name)) > 0),
  trade text,
  room text,
  owner_name text,
  duration integer not null default 1 check (duration between 0 and 2000),  -- working days
  milestone boolean not null default false,
  after_ids uuid[] not null default '{}',            -- finish-to-start predecessors
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'done', 'blocked')),
  actual_start date,
  actual_end date,
  gate_drawing_id uuid references public.drawings (id) on delete restrict,  -- "needs this sheet at R0"
  baseline_start date,
  baseline_end date,
  sort_order integer not null default 0,
  template_key text,
  change_reason text,
  removed_at timestamptz,
  removed_by uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not milestone or duration = 0),
  check (actual_end is null or actual_start is null or actual_end >= actual_start)
);
create index if not exists tasks_project on public.tasks (project_id, stage, sort_order);

-- 3. Audit of schedule changes after the baseline is frozen --------------------------------
-- task_id is deliberately not a foreign key: a task's "added" entry is written before the task row exists.
create table if not exists public.schedule_changes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  task_id uuid,
  kind text not null,      -- added, changed, removed, restored, baseline, rebaseline, calendar
  before jsonb,
  after jsonb,
  reason text,
  decision_id uuid,        -- to be linked once Decisions exist
  changed_by uuid default auth.uid(),
  changed_at timestamptz not null default now()
);
create index if not exists schedule_changes_project on public.schedule_changes (project_id, changed_at desc);

-- 4. Rules -----------------------------------------------------------------------------------
create or replace function private.ist_today()
returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;
revoke all on function private.ist_today() from public;
grant execute on function private.ist_today() to authenticated;

-- Before a task is saved: protect fixed columns, keep baselines and removal for owners,
-- fill actual dates from the status, and after the freeze require and log a reason.
create or replace function private.task_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  is_owner boolean := private.is_owner();
  frozen boolean := false;
  changed boolean := false;
  kind text;
  reason text := nullif(trim(coalesce(new.change_reason, '')), '');
begin
  select s.baseline_at is not null into frozen from public.project_schedules s where s.project_id = new.project_id;
  frozen := coalesce(frozen, false);

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.removed_at := null;
    new.removed_by := null;
    if not is_owner then
      new.baseline_start := null;
      new.baseline_end := null;
    end if;
    changed := true;
    kind := 'added';
  else
    new.id := old.id;
    new.project_id := old.project_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.removed_by := old.removed_by;
    if not is_owner then
      new.baseline_start := old.baseline_start;
      new.baseline_end := old.baseline_end;
      if new.removed_at is distinct from old.removed_at then
        raise exception 'Only an owner can remove or restore a task.' using errcode = '42501';
      end if;
    end if;
    if new.removed_at is distinct from old.removed_at then
      if new.removed_at is null then
        new.removed_by := null;
        kind := 'restored';
      else
        new.removed_at := now();
        new.removed_by := auth.uid();
        kind := 'removed';
      end if;
      changed := true;
    elsif (new.duration, new.after_ids) is distinct from (old.duration, old.after_ids) then
      changed := true;
      kind := 'changed';
    end if;
  end if;

  -- Actual dates follow the status (Ahmedabad calendar), unless the app sent them.
  if new.status = 'planned' then
    new.actual_start := null;
    new.actual_end := null;
  elsif new.status = 'in_progress' then
    new.actual_start := coalesce(new.actual_start, private.ist_today());
    new.actual_end := null;
  elsif new.status = 'done' then
    new.actual_start := coalesce(new.actual_start, new.actual_end, private.ist_today());
    new.actual_end := coalesce(new.actual_end, private.ist_today());
  end if;

  if frozen and changed then
    if reason is null then
      raise exception 'The baseline is frozen. Give a reason for this schedule change.' using errcode = 'P0001';
    end if;
    insert into public.schedule_changes (project_id, task_id, kind, before, after, reason)
    values (
      new.project_id, new.id, kind,
      case when tg_op = 'UPDATE' then jsonb_build_object('name', old.name, 'duration', old.duration, 'after_ids', to_jsonb(old.after_ids)) end,
      jsonb_build_object('name', new.name, 'duration', new.duration, 'after_ids', to_jsonb(new.after_ids)),
      reason
    );
  end if;

  new.change_reason := null;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists task_guard on public.tasks;
create trigger task_guard before insert or update on public.tasks
  for each row execute function private.task_guard();

-- After a task is saved (so every row of a multi-row insert is visible):
-- "After" links and the gate sheet must belong to the same project, and links must not loop.
create or replace function private.task_links_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id = any (new.after_ids) then
    raise exception 'A task cannot come after itself.' using errcode = '23514';
  end if;
  if exists (
    select 1 from unnest(new.after_ids) as a(id)
    left join public.tasks t on t.id = a.id and t.project_id = new.project_id
    where t.id is null
  ) then
    raise exception 'An "After" task is missing or belongs to another project.' using errcode = '23503';
  end if;
  if new.gate_drawing_id is not null and not exists (
    select 1 from public.drawings d where d.id = new.gate_drawing_id and d.project_id = new.project_id
  ) then
    raise exception 'The gate sheet belongs to another project.' using errcode = '23503';
  end if;
  if exists (
    with recursive up (id) as (
      select a.id from unnest(new.after_ids) as a(id)
      union
      select p.id from public.tasks t join up on t.id = up.id cross join lateral unnest(t.after_ids) as p(id)
    )
    select 1 from up where up.id = new.id
  ) then
    raise exception 'These "After" links make a loop.' using errcode = '23514';
  end if;
  return null;
end;
$$;

drop trigger if exists task_links_check on public.tasks;
create trigger task_links_check after insert or update of after_ids, gate_drawing_id on public.tasks
  for each row execute function private.task_links_check();

-- Calendar and baseline: only an owner freezes or re-baselines; a frozen baseline cannot be unfrozen;
-- after the freeze, re-baselining and calendar changes need a reason. Everything is logged.
create or replace function private.schedule_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reason text := nullif(trim(coalesce(new.change_reason, '')), '');
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if new.baseline_at is not null and not private.is_owner() then
      raise exception 'Only an owner can freeze the baseline.' using errcode = '42501';
    end if;
    if new.baseline_at is not null then
      new.baseline_at := now();
      new.baseline_by := auth.uid();
    else
      new.baseline_by := null;
      new.baseline_plan := null;
    end if;
  else
    new.project_id := old.project_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if (new.baseline_at, new.baseline_plan) is distinct from (old.baseline_at, old.baseline_plan) then
      if not private.is_owner() then
        raise exception 'Only an owner can freeze or re-baseline the schedule.' using errcode = '42501';
      end if;
      if new.baseline_at is null or new.baseline_plan is null then
        raise exception 'A frozen baseline cannot be unfrozen. Re-baseline instead.' using errcode = 'P0001';
      end if;
      if old.baseline_at is not null and reason is null then
        raise exception 'Give a reason for re-baselining.' using errcode = 'P0001';
      end if;
      new.baseline_at := now();
      new.baseline_by := auth.uid();
      insert into public.schedule_changes (project_id, kind, after, reason)
      values (new.project_id, case when old.baseline_at is null then 'baseline' else 'rebaseline' end,
              jsonb_build_object('tasks', (select count(*) from jsonb_object_keys(new.baseline_plan))), reason);
    else
      new.baseline_by := old.baseline_by;
    end if;
    if old.baseline_at is not null
       and (new.start_date, new.work_days, new.holidays) is distinct from (old.start_date, old.work_days, old.holidays) then
      if reason is null then
        raise exception 'The baseline is frozen. Give a reason for changing the calendar.' using errcode = 'P0001';
      end if;
      insert into public.schedule_changes (project_id, kind, before, after, reason)
      values (new.project_id, 'calendar',
              jsonb_build_object('start_date', old.start_date, 'work_days', to_jsonb(old.work_days), 'holidays', to_jsonb(old.holidays)),
              jsonb_build_object('start_date', new.start_date, 'work_days', to_jsonb(new.work_days), 'holidays', to_jsonb(new.holidays)),
              reason);
    end if;
  end if;
  new.change_reason := null;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists schedule_guard on public.project_schedules;
create trigger schedule_guard before insert or update on public.project_schedules
  for each row execute function private.schedule_guard();

-- When the baseline is (re)frozen, copy each task's frozen dates in the same statement.
create or replace function private.schedule_copy_baseline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.baseline_plan is not null and (tg_op = 'INSERT' or new.baseline_plan is distinct from old.baseline_plan) then
    update public.tasks t
       set baseline_start = (new.baseline_plan -> t.id::text ->> 'start')::date,
           baseline_end = (new.baseline_plan -> t.id::text ->> 'end')::date
     where t.project_id = new.project_id;
  end if;
  return null;
end;
$$;

drop trigger if exists schedule_copy_baseline on public.project_schedules;
create trigger schedule_copy_baseline after insert or update on public.project_schedules
  for each row execute function private.schedule_copy_baseline();

-- 5. Access ----------------------------------------------------------------------------------
alter table public.project_schedules enable row level security;
alter table public.tasks enable row level security;
alter table public.schedule_changes enable row level security;

revoke all on public.project_schedules, public.tasks, public.schedule_changes from anon, authenticated;
grant select, insert, update on public.project_schedules, public.tasks to authenticated;
grant select on public.schedule_changes to authenticated;

drop policy if exists "team reads schedules" on public.project_schedules;
create policy "team reads schedules" on public.project_schedules for select to authenticated using (private.is_team());
drop policy if exists "team adds schedules" on public.project_schedules;
create policy "team adds schedules" on public.project_schedules for insert to authenticated with check (private.is_team());
drop policy if exists "team edits schedules" on public.project_schedules;
create policy "team edits schedules" on public.project_schedules for update to authenticated using (private.is_team()) with check (private.is_team());

drop policy if exists "team reads tasks" on public.tasks;
create policy "team reads tasks" on public.tasks for select to authenticated using (private.is_team());
drop policy if exists "team adds tasks" on public.tasks;
create policy "team adds tasks" on public.tasks for insert to authenticated with check (private.is_team());
drop policy if exists "team edits tasks" on public.tasks;
create policy "team edits tasks" on public.tasks for update to authenticated using (private.is_team()) with check (private.is_team());

drop policy if exists "team reads schedule changes" on public.schedule_changes;
create policy "team reads schedule changes" on public.schedule_changes for select to authenticated using (private.is_team());

-- 6. Backups ---------------------------------------------------------------------------------
-- The free tier keeps no backups. Owners download one from the app; this records when.
create table if not exists public.backup_log (
  id uuid primary key default gen_random_uuid(),
  made_at timestamptz not null default now(),
  made_by uuid default auth.uid(),
  summary text not null default '',
  files integer not null default 0,
  missing integer not null default 0
);
alter table public.backup_log enable row level security;
revoke all on public.backup_log from anon, authenticated;
grant select on public.backup_log to authenticated;
grant insert (summary, files, missing) on public.backup_log to authenticated;
drop policy if exists "team reads backup log" on public.backup_log;
create policy "team reads backup log" on public.backup_log for select to authenticated using (private.is_team());
drop policy if exists "owners record backups" on public.backup_log;
create policy "owners record backups" on public.backup_log for insert to authenticated
  with check (private.is_owner() and made_by = (select auth.uid()));
