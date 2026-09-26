-- ROLLBACK of 20260927000200_revision_snapshots_device_key.sql
-- Returns the schema to the baseline (v1). The app DATA in ayyam_data is never modified.
-- Nothing is thrown away: every automatic snapshot is first archived into ayyam_recovery_points.
-- Only run this if the v2 client has NOT been rolled out yet (v2 clients need the RPCs).
begin;

insert into public.ayyam_recovery_points (reason, row_id, data, source_updated_at)
  select format('rollback-archive: snapshot #%s rev %s (%s)', id, revision, reason), row_id, data, created_at
    from public.ayyam_snapshots order by id;

drop trigger if exists ayyam_track_direct_write on public.ayyam_data;
drop function if exists public.ayyam_restore(text, bigint, bigint, uuid);
drop function if exists public.ayyam_list_snapshots(text);
drop function if exists public.ayyam_commit(text, bigint, jsonb, uuid, text);
drop function if exists public.ayyam_pull(text);
drop function if exists public.ayyam_track_direct_write();
drop function if exists public.ayyam_prune();
drop function if exists public.ayyam_set_device_key(text);
drop function if exists public.ayyam_key_ok(text);
drop table if exists public.ayyam_ops;
drop table if exists public.ayyam_snapshots;
drop table if exists public.ayyam_config;
alter table public.ayyam_data drop constraint if exists ayyam_data_revision_positive;
alter table public.ayyam_data drop column if exists last_op_id;
alter table public.ayyam_data drop column if exists epoch;
alter table public.ayyam_data drop column if exists revision;

-- restore the baseline guard (without the via_commit bypass)
create or replace function public.ayyam_guard_first_insert() returns trigger
language plpgsql as $$
declare has_activity boolean;
begin
  if exists (select 1 from public.ayyam_data where id = new.id) then
    return new;
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

commit;
