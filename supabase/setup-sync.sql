-- Cloud sync for the single shared row public.ayyam_data (id = 'main'). Safe to run again.
-- The app has no login (owner's choice), so the anon role may read/write that one row only.
-- RLS was enabled with no policies, which silently blocked every read/write from the app.

drop policy if exists "ayyam anon read main"   on public.ayyam_data;
drop policy if exists "ayyam anon insert main" on public.ayyam_data;
drop policy if exists "ayyam anon update main" on public.ayyam_data;

create policy "ayyam anon read main"   on public.ayyam_data for select to anon using (id = 'main');
create policy "ayyam anon insert main" on public.ayyam_data for insert to anon with check (id = 'main');
create policy "ayyam anon update main" on public.ayyam_data for update to anon using (id = 'main') with check (id = 'main');
-- no delete policy: the row can be reset from the app, but never deleted

-- Guard: the row may only be CREATED from a device that has real activity (a checked task, an
-- extra task, a hidden/edited task). This stops a fresh browser from seeding the server with the
-- default schedule before the phone that holds the real history uploads it.
create or replace function public.ayyam_guard_first_insert() returns trigger
language plpgsql as $$
declare has_activity boolean;
begin
  if exists (select 1 from public.ayyam_data where id = new.id) then
    return new; -- upsert of an existing row: allowed (conflict → update)
  end if;
  select exists (
    select 1
    from jsonb_each(case when jsonb_typeof(new.data->'logs') = 'object' then new.data->'logs' else '{}'::jsonb end) l
    where jsonb_typeof(l.value) = 'object' and (
         (jsonb_typeof(l.value->'done') = 'object'
            and exists (select 1 from jsonb_each(l.value->'done') d where d.value = 'true'::jsonb))
      or (jsonb_typeof(l.value->'extra') = 'array' and jsonb_array_length(l.value->'extra') > 0)
      or (jsonb_typeof(l.value->'hidden') = 'object' and l.value->'hidden' <> '{}'::jsonb)
      or (jsonb_typeof(l.value->'overrides') = 'object' and l.value->'overrides' <> '{}'::jsonb)
    )
  ) into has_activity;
  if not has_activity then
    raise exception 'ayyam: first upload must come from a device with activity' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists ayyam_guard_first_insert on public.ayyam_data;
create trigger ayyam_guard_first_insert before insert on public.ayyam_data
  for each row execute function public.ayyam_guard_first_insert();
