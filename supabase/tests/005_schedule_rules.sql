-- Live rule checks for part 5 (schedule and backup log). Safe to run on the live database:
-- it impersonates the real owner and coordinator, and always ends in an exception, so nothing is kept.
-- Read the result from the error text: "RESULTS: n/n passed ...".
do $$
declare
  owner_id uuid := (select id from public.profiles where role = 'owner' order by id limit 1);
  coord_id uuid := (select id from public.profiles where role = 'coordinator' order by id limit 1);
  proj uuid := (select id from public.projects where archived = false order by created_at limit 1);
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  passed int := 0;
  total int := 0;
  failures text := '';
  v text;
  n int;

  -- not a real function: a nested block per check, see below
begin
  if owner_id is null or coord_id is null or proj is null then
    raise exception 'RESULTS: setup missing (owner %, coordinator %, project %)', owner_id, coord_id, proj;
  end if;

  ------------------------------------------------------------------ as the coordinator
  perform set_config('request.jwt.claims', json_build_object('sub', coord_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  total := total + 1;
  begin
    insert into public.project_schedules (project_id, start_date, baseline_at, baseline_plan) values (proj, '2026-12-07', now(), '{}');
    failures := failures || ' [1 coordinator froze on insert]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  total := total + 1;
  begin
    insert into public.project_schedules (project_id, start_date) values (proj, '2026-12-07');
    passed := passed + 1;
  exception when others then failures := failures || ' [2 coordinator could not create schedule: ' || sqlerrm || ']';
  end;

  total := total + 1;
  begin
    insert into public.tasks (id, project_id, stage, name, duration, after_ids, sort_order)
    values (a, proj, 3, 'Rule test A', 3, '{}', 1), (b, proj, 3, 'Rule test B', 2, array[a], 2);
    select count(*) into n from public.tasks where id in (a, b) and created_by = coord_id;
    if n = 2 then passed := passed + 1; else failures := failures || ' [3 created_by not stamped]'; end if;
  exception when others then failures := failures || ' [3 multi-row insert with link failed: ' || sqlerrm || ']';
  end;

  total := total + 1;
  begin
    insert into public.tasks (project_id, stage, name, duration, after_ids) values (proj, 3, 'Bad link', 1, array[gen_random_uuid()]);
    failures := failures || ' [4 link to a missing task accepted]';
  exception when foreign_key_violation then passed := passed + 1;
  end;

  total := total + 1;
  begin
    update public.tasks set after_ids = array[b] where id = a;
    failures := failures || ' [5 loop accepted]';
  exception when check_violation then passed := passed + 1;
  end;

  total := total + 1;
  update public.tasks set status = 'done' where id = a;
  select actual_start::text || '|' || actual_end::text into v from public.tasks where id = a;
  if v = ((now() at time zone 'Asia/Kolkata')::date)::text || '|' || ((now() at time zone 'Asia/Kolkata')::date)::text then passed := passed + 1;
  else failures := failures || ' [6 done did not fill IST dates: ' || coalesce(v, 'null') || ']'; end if;

  total := total + 1;
  update public.tasks set baseline_end = '2030-01-01' where id = a;
  if (select baseline_end from public.tasks where id = a) is null then passed := passed + 1;
  else failures := failures || ' [7 coordinator set a baseline date]'; end if;

  total := total + 1;
  begin
    update public.tasks set removed_at = now() where id = b;
    failures := failures || ' [8 coordinator removed a task]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  total := total + 1;
  begin
    update public.project_schedules set baseline_at = now(), baseline_plan = '{}' where project_id = proj;
    failures := failures || ' [9 coordinator froze the baseline]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  total := total + 1;
  begin
    insert into public.schedule_changes (project_id, kind) values (proj, 'forged');
    failures := failures || ' [10 change log writable]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  total := total + 1;
  begin
    delete from public.tasks where id = a;
    failures := failures || ' [11 delete allowed]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  total := total + 1;
  begin
    insert into public.backup_log (summary) values ('x');
    failures := failures || ' [12 coordinator recorded a backup]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  ------------------------------------------------------------------ as the owner
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  total := total + 1;
  update public.project_schedules
     set baseline_at = now(),
         baseline_plan = jsonb_build_object(a::text, jsonb_build_object('start', '2026-12-07', 'end', '2026-12-09'),
                                            b::text, jsonb_build_object('start', '2026-12-10', 'end', '2026-12-11'))
   where project_id = proj;
  select baseline_end::text into v from public.tasks where id = b;
  if v = '2026-12-11'
     and (select baseline_by from public.project_schedules where project_id = proj) = owner_id
     and exists (select 1 from public.schedule_changes where project_id = proj and kind = 'baseline') then passed := passed + 1;
  else failures := failures || ' [13 freeze did not copy or log: ' || coalesce(v, 'null') || ']'; end if;

  total := total + 1;
  begin
    update public.tasks set duration = 5 where id = b;
    failures := failures || ' [14 change after freeze accepted without reason]';
  exception when raise_exception then passed := passed + 1;
  end;

  total := total + 1;
  update public.tasks set duration = 5, change_reason = 'Rule test reason' where id = b;
  if (select duration from public.tasks where id = b) = 5
     and (select change_reason from public.tasks where id = b) is null
     and exists (select 1 from public.schedule_changes where task_id = b and kind = 'changed' and reason = 'Rule test reason'
                 and (before ->> 'duration')::int = 2 and (after ->> 'duration')::int = 5) then passed := passed + 1;
  else failures := failures || ' [15 reasoned change not saved or logged]'; end if;

  total := total + 1;
  begin
    update public.project_schedules set baseline_at = null where project_id = proj;
    failures := failures || ' [16 baseline unfrozen]';
  exception when raise_exception then passed := passed + 1;
  end;

  total := total + 1;
  begin
    update public.project_schedules set baseline_plan = '{}'::jsonb || baseline_plan || '{"x": 1}'::jsonb where project_id = proj;
    failures := failures || ' [17 re-baseline without reason accepted]';
  exception when raise_exception then passed := passed + 1;
  end;

  total := total + 1;
  update public.project_schedules
     set baseline_plan = jsonb_build_object(b::text, jsonb_build_object('start', '2026-12-10', 'end', '2026-12-16')), change_reason = 'Rule test rebaseline'
   where project_id = proj;
  if (select baseline_end from public.tasks where id = b) = '2026-12-16'
     and (select baseline_end from public.tasks where id = a) is null
     and exists (select 1 from public.schedule_changes where project_id = proj and kind = 'rebaseline' and reason = 'Rule test rebaseline') then passed := passed + 1;
  else failures := failures || ' [18 re-baseline not applied or logged]'; end if;

  total := total + 1;
  begin
    update public.project_schedules set work_days = '{1,2,3,4,5}' where project_id = proj;
    failures := failures || ' [19 calendar change without reason accepted]';
  exception when raise_exception then passed := passed + 1;
  end;

  total := total + 1;
  update public.tasks set removed_at = now(), change_reason = 'Rule test remove' where id = b;
  if (select removed_by from public.tasks where id = b) = owner_id
     and exists (select 1 from public.schedule_changes where task_id = b and kind = 'removed') then passed := passed + 1;
  else failures := failures || ' [20 owner remove not stamped or logged]'; end if;

  total := total + 1;
  begin
    insert into public.backup_log (summary, files) values ('Rule test', 2);
    if (select made_by from public.backup_log where summary = 'Rule test') = owner_id then passed := passed + 1;
    else failures := failures || ' [21 backup made_by wrong]'; end if;
  exception when others then failures := failures || ' [21 owner could not record backup: ' || sqlerrm || ']';
  end;

  total := total + 1;
  begin
    insert into public.backup_log (summary, made_by) values ('Forged', coord_id);
    failures := failures || ' [22 backup made_by forgeable]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  ------------------------------------------------------------------ signed out
  execute 'reset role';
  execute 'set local role anon';
  total := total + 1;
  begin
    perform 1 from public.tasks limit 1;
    failures := failures || ' [23 anon can read tasks]';
  exception when insufficient_privilege then passed := passed + 1;
  end;

  execute 'reset role';
  raise exception 'RESULTS: %/% passed.%', passed, total, case when failures = '' then ' All good.' else ' Failures:' || failures end;
end;
$$;
