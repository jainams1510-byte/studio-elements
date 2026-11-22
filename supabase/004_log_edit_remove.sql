-- Studio Elements: owners can edit or remove site logs and remove single photos.
-- Removing hides; nothing is deleted, and an owner can restore it.
-- Also: people can change only their own display name, never their role.

-- Who is an owner. Lives in the private schema so it is not exposed through the web API.
create or replace function private.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'owner');
$$;
revoke all on function private.is_owner() from public;
grant execute on function private.is_owner() to authenticated;

-- Roles are set by the studio in the dashboard, not by the person themselves.
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

-- edited_by and removed_by hold a person's id but are deliberately not linked to profiles:
-- a second link from site_logs to profiles would make the app's existing
-- "profiles(full_name)" lookups ambiguous and break them on phones not yet updated.
alter table public.site_logs
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by uuid,
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid;

alter table public.site_log_photos
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid;

grant update (removed_at) on public.site_logs to authenticated;
grant update (removed_at) on public.site_log_photos to authenticated;

-- Phones re-send a log when an upload was interrupted. For anyone but an owner an update
-- therefore changes nothing: the retry succeeds and the stored record stays as it is.
-- For an owner only the note, room, trade and removal can change, and who did it is recorded.
create or replace function private.site_log_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_owner() then
    return old;
  end if;
  new.id := old.id;
  new.project_id := old.project_id;
  new.audio_path := old.audio_path;
  new.logged_at := old.logged_at;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.edited_at := old.edited_at;
  new.edited_by := old.edited_by;
  new.removed_by := old.removed_by;
  if (new.note, new.room, new.trade) is distinct from (old.note, old.room, old.trade) then
    new.edited_at := now();
    new.edited_by := auth.uid();
  end if;
  if new.removed_at is distinct from old.removed_at then
    if new.removed_at is null then
      new.removed_by := null;
    else
      new.removed_at := now();
      new.removed_by := auth.uid();
    end if;
  else
    new.removed_at := old.removed_at;
  end if;
  return new;
end;
$$;

drop trigger if exists site_log_guard on public.site_logs;
create trigger site_log_guard before update on public.site_logs
  for each row execute function private.site_log_guard();

create or replace function private.site_log_photo_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_owner() then
    return old;
  end if;
  new.id := old.id;
  new.log_id := old.log_id;
  new.path := old.path;
  new.created_at := old.created_at;
  if new.removed_at is distinct from old.removed_at then
    if new.removed_at is null then
      new.removed_by := null;
    else
      new.removed_at := now();
      new.removed_by := auth.uid();
    end if;
  else
    new.removed_by := old.removed_by;
  end if;
  return new;
end;
$$;

drop trigger if exists site_log_photo_guard on public.site_log_photos;
create trigger site_log_photo_guard before update on public.site_log_photos
  for each row execute function private.site_log_photo_guard();

-- Owners may update any log; authors may still re-send their own (the trigger makes that a no-op).
drop policy if exists "owner edits logs" on public.site_logs;
create policy "owner edits logs" on public.site_logs
  for update to authenticated using (private.is_owner()) with check (private.is_owner());
