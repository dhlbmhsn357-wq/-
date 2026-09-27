-- Reliability v2 — server foundation. Purely ADDITIVE and backward compatible:
--  * existing data is untouched (the live row just gets revision = 1, epoch = 0);
--  * the current (v1) client keeps working through its direct table access;
--  * from now on EVERY write — v1 direct upsert or v2 RPC — bumps `revision` and snapshots the
--    previous data first, so nothing can be overwritten without a recovery copy.
-- Idempotent: safe to run again.
--
-- v2 clients use only these RPCs (all require the device key):
--   ayyam_pull(key)                                   → current data + revision/epoch
--   ayyam_commit(key, expected_revision, data, op_id, reason)
--                                                     → compare-and-swap write, idempotent by op_id
--   ayyam_list_snapshots(key) / ayyam_restore(key, snapshot_id, expected_revision, op_id)
-- Direct table access for anon is removed only at the v2 cut-over migration.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- ayyam_data: concurrency metadata
-- An existing row starts at revision 1 (the default fills it). Any row that exists has revision >= 1,
-- so "expected revision 0" can only ever mean "the row does not exist yet" — including rows a v1
-- client inserts directly after this migration.
alter table public.ayyam_data add column if not exists revision   bigint  not null default 1;
alter table public.ayyam_data add column if not exists epoch      integer not null default 0; -- bumped by reset/import/restore
alter table public.ayyam_data add column if not exists last_op_id uuid;
alter table public.ayyam_data alter column revision set default 1;
update public.ayyam_data set revision = 1 where revision < 1;
update public.ayyam_data set updated_at = now() where updated_at is null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ayyam_data_revision_positive') then
    alter table public.ayyam_data add constraint ayyam_data_revision_positive check (revision >= 1 and epoch >= 0);
  end if;
end $$;

-- ---------------------------------------------------------------- snapshots (automatic history)
create table if not exists public.ayyam_snapshots (
  id         bigint generated always as identity primary key,
  row_id     text        not null,
  revision   bigint      not null,          -- revision of the data stored here
  epoch      integer     not null,
  data       jsonb       not null,
  reason     text        not null,          -- e.g. 'before:sync', 'before:reset', 'before:legacy-write'
  created_at timestamptz not null default now()
);
create index if not exists ayyam_snapshots_row_created_idx on public.ayyam_snapshots (row_id, created_at desc);
alter table public.ayyam_snapshots enable row level security;
revoke all on public.ayyam_snapshots from anon, authenticated;

-- ---------------------------------------------------------------- applied operations (idempotency)
create table if not exists public.ayyam_ops (
  op_id      uuid        primary key,
  row_id     text        not null,
  revision   bigint      not null,          -- revision this operation produced
  applied_at timestamptz not null default now()
);
create index if not exists ayyam_ops_applied_idx on public.ayyam_ops (applied_at);
alter table public.ayyam_ops enable row level security;
revoke all on public.ayyam_ops from anon, authenticated;

-- ---------------------------------------------------------------- device key (not an account)
-- One secret for all of the owner's devices, entered once per device. Only a bcrypt hash is stored.
create table if not exists public.ayyam_config (
  id              smallint    primary key default 1 check (id = 1),
  device_key_hash text,                     -- null = not configured → every RPC answers 'unauthorized'
  updated_at      timestamptz not null default now()
);
insert into public.ayyam_config (id) values (1) on conflict (id) do nothing;
alter table public.ayyam_config enable row level security;
revoke all on public.ayyam_config from anon, authenticated;

create or replace function public.ayyam_key_ok(p_key text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare h text;
begin
  select device_key_hash into h from public.ayyam_config where id = 1;
  if h is null or p_key is null or length(p_key) < 16 or length(p_key) > 256 then
    return false;
  end if;
  return extensions.crypt(p_key, h) = h;
end $$;

-- Admin only (run from the SQL editor / Management API — never from the app).
create or replace function public.ayyam_set_device_key(p_key text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_key is null or length(p_key) < 16 then
    raise exception 'device key must be at least 16 characters';
  end if;
  update public.ayyam_config
     set device_key_hash = extensions.crypt(p_key, extensions.gen_salt('bf', 8)), updated_at = now()
   where id = 1;
end $$;

-- ---------------------------------------------------------------- retention
-- Keeps: the 50 newest snapshots; the newest snapshot of each day for 60 days; snapshots taken
-- before reset/import/restore for 365 days. Applied-op records: 30 days (retries happen in minutes).
create or replace function public.ayyam_prune() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.ayyam_snapshots s
   where s.id not in (select id from public.ayyam_snapshots order by id desc limit 50)
     and not (s.reason in ('before:reset', 'before:import', 'before:restore')
              and s.created_at > now() - interval '365 days')
     and not (s.created_at > now() - interval '60 days'
              and s.id in (select max(id) from public.ayyam_snapshots
                           group by row_id, (created_at at time zone 'UTC')::date));
  delete from public.ayyam_ops where applied_at < now() - interval '30 days';
end $$;

-- ---------------------------------------------------------------- v1 (direct) writes stay safe
-- Any UPDATE that does not come from ayyam_commit (i.e. an old client's upsert) still bumps the
-- revision — so v2 clients detect it as a concurrent change — and snapshots the old data first.
create or replace function public.ayyam_track_direct_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('ayyam.via_commit', true), '') = 'on' then
    return new;
  end if;
  insert into public.ayyam_snapshots (row_id, revision, epoch, data, reason)
    values (old.id, old.revision, old.epoch, old.data, 'before:legacy-write');
  new.revision   := old.revision + 1;
  new.epoch      := old.epoch;
  new.last_op_id := null;
  new.updated_at := now();
  perform public.ayyam_prune();
  return new;
end $$;
drop trigger if exists ayyam_track_direct_write on public.ayyam_data;
create trigger ayyam_track_direct_write before update on public.ayyam_data
  for each row execute function public.ayyam_track_direct_write();

-- The first-insert guard applies to direct (v1) inserts only; ayyam_commit is key-protected.
create or replace function public.ayyam_guard_first_insert() returns trigger
language plpgsql as $$
declare has_activity boolean;
begin
  if coalesce(current_setting('ayyam.via_commit', true), '') = 'on' then
    return new;
  end if;
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

-- ---------------------------------------------------------------- RPC: pull
create or replace function public.ayyam_pull(p_key text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.ayyam_data%rowtype;
begin
  if not public.ayyam_key_ok(p_key) then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  select * into r from public.ayyam_data where id = 'main';
  if not found then
    return jsonb_build_object('status', 'ok', 'exists', false, 'revision', 0, 'epoch', 0);
  end if;
  return jsonb_build_object('status', 'ok', 'exists', true, 'revision', r.revision, 'epoch', r.epoch,
                            'updated_at', r.updated_at, 'data', r.data);
end $$;

-- ---------------------------------------------------------------- RPC: compare-and-swap commit
-- status: ok | duplicate (op already applied — safe retry) | conflict (someone else wrote first:
-- pull, merge, retry) | unauthorized | invalid | too_large
create or replace function public.ayyam_commit(
  p_key text, p_expected_revision bigint, p_data jsonb, p_op_id uuid, p_reason text default 'sync'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r         public.ayyam_data%rowtype;
  prev      public.ayyam_ops%rowtype;
  new_rev   bigint;
  new_epoch integer;
begin
  if not public.ayyam_key_ok(p_key) then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if p_op_id is null or p_expected_revision is null or p_expected_revision < 0
     or p_reason is null or p_reason not in ('sync', 'init', 'reset', 'import', 'restore')
     or p_data is null or jsonb_typeof(p_data) <> 'object'
     or jsonb_typeof(p_data->'template') is distinct from 'object'
     or jsonb_typeof(p_data->'logs') is distinct from 'object' then
    return jsonb_build_object('status', 'invalid');
  end if;
  if octet_length(p_data::text) > 2000000 then
    return jsonb_build_object('status', 'too_large');
  end if;

  -- Serialize all writers on the single row, then check idempotency and the revision.
  select * into r from public.ayyam_data where id = 'main' for update;

  select * into prev from public.ayyam_ops where op_id = p_op_id;
  if found then
    return jsonb_build_object('status', 'duplicate', 'revision', prev.revision,
                              'current_revision', coalesce(r.revision, 0), 'epoch', coalesce(r.epoch, 0));
  end if;

  perform set_config('ayyam.via_commit', 'on', true);

  if r.id is null then
    if p_expected_revision <> 0 then
      return jsonb_build_object('status', 'conflict', 'exists', false, 'revision', 0, 'epoch', 0);
    end if;
    begin
      insert into public.ayyam_data (id, data, revision, epoch, updated_at, last_op_id)
        values ('main', p_data, 1, 0, now(), p_op_id);
    exception when unique_violation then
      -- another device created the row at the same moment
      select * into r from public.ayyam_data where id = 'main';
      return jsonb_build_object('status', 'conflict', 'exists', true, 'revision', r.revision, 'epoch', r.epoch,
                                'updated_at', r.updated_at, 'data', r.data);
    end;
    insert into public.ayyam_ops (op_id, row_id, revision) values (p_op_id, 'main', 1);
    return jsonb_build_object('status', 'ok', 'revision', 1, 'epoch', 0);
  end if;

  if r.revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'exists', true, 'revision', r.revision, 'epoch', r.epoch,
                              'updated_at', r.updated_at, 'data', r.data);
  end if;

  insert into public.ayyam_snapshots (row_id, revision, epoch, data, reason)
    values (r.id, r.revision, r.epoch, r.data, 'before:' || p_reason);

  new_rev   := r.revision + 1;
  new_epoch := r.epoch + case when p_reason in ('reset', 'import', 'restore') then 1 else 0 end;
  update public.ayyam_data
     set data = p_data, revision = new_rev, epoch = new_epoch, updated_at = now(), last_op_id = p_op_id
   where id = 'main';
  insert into public.ayyam_ops (op_id, row_id, revision) values (p_op_id, 'main', new_rev);
  perform public.ayyam_prune();
  return jsonb_build_object('status', 'ok', 'revision', new_rev, 'epoch', new_epoch);
end $$;

-- ---------------------------------------------------------------- RPC: recovery
create or replace function public.ayyam_list_snapshots(p_key text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.ayyam_key_ok(p_key) then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  return jsonb_build_object('status', 'ok', 'snapshots', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'revision', s.revision, 'epoch', s.epoch, 'reason', s.reason, 'created_at', s.created_at,
             'log_days', (select count(*) from jsonb_object_keys(
                            case when jsonb_typeof(s.data->'logs') = 'object' then s.data->'logs' else '{}'::jsonb end)),
             'bytes', octet_length(s.data::text))
           order by s.id desc)
    from public.ayyam_snapshots s where s.row_id = 'main'), '[]'::jsonb));
end $$;

-- Restoring is itself a normal, snapshotted, compare-and-swap commit (epoch is bumped), so a
-- restore can be undone the same way and cannot be silently overwritten by a stale device.
create or replace function public.ayyam_restore(
  p_key text, p_snapshot_id bigint, p_expected_revision bigint, p_op_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d jsonb;
begin
  if not public.ayyam_key_ok(p_key) then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  select data into d from public.ayyam_snapshots where id = p_snapshot_id and row_id = 'main';
  if d is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return public.ayyam_commit(p_key, p_expected_revision, d, p_op_id, 'restore');
end $$;

-- ---------------------------------------------------------------- privileges
-- Supabase grants EXECUTE on new functions to anon by default: lock everything down explicitly.
revoke all on function public.ayyam_key_ok(text)                                   from public, anon, authenticated;
revoke all on function public.ayyam_set_device_key(text)                           from public, anon, authenticated;
revoke all on function public.ayyam_prune()                                        from public, anon, authenticated;
revoke all on function public.ayyam_track_direct_write()                           from public, anon, authenticated;
revoke all on function public.ayyam_pull(text)                                     from public, anon, authenticated;
revoke all on function public.ayyam_commit(text, bigint, jsonb, uuid, text)        from public, anon, authenticated;
revoke all on function public.ayyam_list_snapshots(text)                           from public, anon, authenticated;
revoke all on function public.ayyam_restore(text, bigint, bigint, uuid)            from public, anon, authenticated;
grant execute on function public.ayyam_pull(text)                                  to anon;
grant execute on function public.ayyam_commit(text, bigint, jsonb, uuid, text)     to anon;
grant execute on function public.ayyam_list_snapshots(text)                        to anon;
grant execute on function public.ayyam_restore(text, bigint, bigint, uuid)         to anon;
