-- P1 — Auth foundation (STRICTLY ADDITIVE / DORMANT). Public-launch groundwork.
--
-- NON-NEGOTIABLE for this migration:
--  * It changes NOTHING about the currently-shipped v1.1.2 path: the legacy device-key RPCs
--    (ayyam_pull/commit/list_snapshots/restore, register_push) and the single row id='main' are left
--    FUNCTIONALLY UNTOUCHED, still granted to `anon`, still hard-scoped to id='main'. No revoke, no
--    freeze, no cut-over here.
--  * Everything below is new and dormant: the current app never calls any *_v2 / claim / freeze function.
--  * Legacy RPCs can only ever touch id='main' (user rows use id='u:'||uid), so they can never read or
--    write a user-owned row. A test proves this.
--
-- Adds: profiles (personal data only), user_roles (server-controlled), user_account_state
-- (server-controlled migration/security lifecycle), nullable user_id ownership on ayyam_data/snapshots/
-- ops (+ indexes), RLS for the `authenticated` role, new authenticated user-scoped *_v2 RPCs, and the
-- claim/freeze schema+functions (present, not invoked). Idempotent (safe to re-run).
--
-- SECURITY DEFINER RULES enforced on every new user-owned function (see audit at the bottom):
--   (1) `security definer` + fixed `set search_path = ''` (all objects fully qualified).
--   (2) identity is derived ONLY from auth.uid(); a caller-supplied user_id is NEVER accepted as authority.
--   (3) reject when auth.uid() is null; operate strictly on rows where user_id = auth.uid().
--   (4) revoke from public/anon; grant execute to `authenticated` only (claim/freeze also need the key).

-- ============================================================ profiles (personal data ONLY, no role)
create table if not exists public.profiles (
  id                      uuid primary key references auth.users(id) on delete cascade,
  display_name            text,
  avatar_url              text,
  timezone                text,
  locale                  text,
  onboarding_completed_at timestamptz,
  platform_first_seen     text,
  app_version_first_seen  text,
  created_at              timestamptz not null default now(),
  last_seen_at            timestamptz
);
alter table public.profiles enable row level security;
-- A user may read + create + edit ONLY their own profile. There is deliberately NO privileged column here.
drop policy if exists "profiles self select" on public.profiles;
drop policy if exists "profiles self insert" on public.profiles;
drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self select" on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles self insert" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles self update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- No delete policy: account deletion is a controlled server flow (later phase), not a direct row delete.

-- ============================================================ user_roles (SERVER-CONTROLLED authority)
-- Elevated roles ONLY. A normal user is simply absent. Not reachable by anon/authenticated at all —
-- granted exclusively via the SQL editor / service_role. This is why admin is NOT a profiles column.
create table if not exists public.user_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('admin')),
  granted_by uuid,
  granted_at timestamptz not null default now()
);
alter table public.user_roles enable row level security;
revoke all on public.user_roles from anon, authenticated;   -- no direct read/write for ordinary users

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'admin');
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ============================================================ user_account_state (SERVER-CONTROLLED)
-- Migration/security lifecycle that a user must NEVER be able to set: migration completion, migration
-- version/status. Separated from profiles so no user-updatable row carries these markers.
create table if not exists public.user_account_state (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  migration_status        text not null default 'none' check (migration_status in ('none','in_progress','completed')),
  migration_version       integer not null default 0,
  migrated_from_legacy_at timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
alter table public.user_account_state enable row level security;
revoke all on public.user_account_state from anon, authenticated;  -- read only via a definer RPC below
-- A user may READ (not write) their own state through this function.
create or replace function public.ayyam_account_state_v2() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.user_account_state%rowtype;
begin
  if auth.uid() is null then return jsonb_build_object('status','unauthorized'); end if;
  select * into s from public.user_account_state where user_id = auth.uid();
  if not found then
    return jsonb_build_object('status','ok','migration_status','none','migration_version',0);
  end if;
  return jsonb_build_object('status','ok','migration_status',s.migration_status,
    'migration_version',s.migration_version,'migrated_from_legacy_at',s.migrated_from_legacy_at);
end $$;
revoke all on function public.ayyam_account_state_v2() from public, anon;
grant execute on function public.ayyam_account_state_v2() to authenticated;

-- ============================================================ per-user ownership on the data tables
-- Nullable so the legacy row id='main' (user_id NULL) is untouched. New account rows use id='u:'||uid.
alter table public.ayyam_data      add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.ayyam_snapshots add column if not exists user_id uuid;
alter table public.ayyam_ops       add column if not exists user_id uuid;
create index if not exists ayyam_data_user_idx      on public.ayyam_data (user_id);
create index if not exists ayyam_snapshots_user_idx on public.ayyam_snapshots (user_id, created_at desc);
create index if not exists ayyam_ops_user_idx       on public.ayyam_ops (user_id);

-- RLS for DIRECT (PostgREST) access by the authenticated role: a user sees ONLY their own row. The
-- legacy `to anon` policies (id='main') are LEFT UNTOUCHED and do not apply to `authenticated`. Since
-- auth.uid() is never null, an authenticated token can never match the legacy row (user_id NULL). The
-- *_v2 RPCs are SECURITY DEFINER (bypass RLS) but ALSO enforce user_id = auth.uid() explicitly.
drop policy if exists "ayyam_data self select" on public.ayyam_data;
drop policy if exists "ayyam_data self insert" on public.ayyam_data;
drop policy if exists "ayyam_data self update" on public.ayyam_data;
create policy "ayyam_data self select" on public.ayyam_data for select to authenticated using (user_id = auth.uid());
create policy "ayyam_data self insert" on public.ayyam_data for insert to authenticated with check (user_id = auth.uid() and id = 'u:' || auth.uid()::text);
create policy "ayyam_data self update" on public.ayyam_data for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
-- snapshots/ops stay service-role/definer only (already revoked from anon/authenticated in 000200).

-- ============================================================ push_subscriptions: user ownership (dormant)
alter table public.push_subscriptions add column if not exists user_id uuid references auth.users(id) on delete cascade;
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
-- legacy rows keep user_id NULL; the reminders path is unchanged. v2 registration sets user_id.

-- ============================================================ legacy claim/freeze (PRESENT, not invoked)
create table if not exists public.ayyam_legacy_claim (
  row_id     text primary key default 'main' check (row_id = 'main'),
  claimed_by uuid references auth.users(id),
  claimed_at timestamptz,
  frozen     boolean not null default false,
  frozen_at  timestamptz
);
insert into public.ayyam_legacy_claim (row_id) values ('main') on conflict (row_id) do nothing;
alter table public.ayyam_legacy_claim enable row level security;
revoke all on public.ayyam_legacy_claim from anon, authenticated;  -- reached only through definer functions

-- Transactional, exclusive, one-time, server-recorded claim of the legacy 'main' dataset. Requires BOTH
-- the device key (proves this device is the owner's) AND an authenticated user. Does NOT copy data here
-- (the client performs a deterministic merge + CAS commit); it locks + records ownership and returns the
-- legacy + account snapshots. NOT called by the current app in P1.
create or replace function public.ayyam_claim(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.ayyam_legacy_claim%rowtype; legacy public.ayyam_data%rowtype; acct public.ayyam_data%rowtype; uid uuid;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  if not public.ayyam_key_ok(p_key) then return jsonb_build_object('status','unauthorized'); end if;
  select * into c from public.ayyam_legacy_claim where row_id = 'main' for update;  -- exclusive lock
  if c.claimed_by is not null and c.claimed_by <> uid then
    return jsonb_build_object('status','already_claimed');
  end if;
  if c.claimed_by is null then
    update public.ayyam_legacy_claim set claimed_by = uid, claimed_at = now() where row_id = 'main';
  end if;
  select * into legacy from public.ayyam_data where id = 'main';
  select * into acct   from public.ayyam_data where id = 'u:' || uid::text;
  return jsonb_build_object('status','ok',
    'legacy',  case when legacy.id is null then jsonb_build_object('exists',false)
                    else jsonb_build_object('exists',true,'data',legacy.data,'revision',legacy.revision,'epoch',legacy.epoch) end,
    'account', case when acct.id is null then jsonb_build_object('exists',false,'revision',0,'epoch',0)
                    else jsonb_build_object('exists',true,'data',acct.data,'revision',acct.revision,'epoch',acct.epoch) end);
end $$;
revoke all on function public.ayyam_claim(text) from public, anon;
grant execute on function public.ayyam_claim(text) to authenticated;

-- Deliberately freeze legacy writes to 'main' AFTER a verified claim. Only the claimant may freeze.
-- (The legacy ayyam_commit is NOT modified in P1, so this is dormant until the freeze-aware commit
--  ships in a later phase; the state + function exist now so the machine is complete and testable.)
create or replace function public.ayyam_freeze_legacy(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.ayyam_legacy_claim%rowtype; uid uuid;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  if not public.ayyam_key_ok(p_key) then return jsonb_build_object('status','unauthorized'); end if;
  select * into c from public.ayyam_legacy_claim where row_id = 'main' for update;
  if c.claimed_by is null or c.claimed_by <> uid then return jsonb_build_object('status','not_claimant'); end if;
  update public.ayyam_legacy_claim set frozen = true, frozen_at = coalesce(frozen_at, now()) where row_id = 'main';
  return jsonb_build_object('status','ok','frozen',true);
end $$;
revoke all on function public.ayyam_freeze_legacy(text) from public, anon;
grant execute on function public.ayyam_freeze_legacy(text) to authenticated;

-- ============================================================ v2 RPCs (authenticated, user-scoped)
-- The row id for a user is ALWAYS derived server-side as 'u:'||auth.uid(); a client cannot address
-- another user's row. All set ayyam.via_commit so the legacy triggers no-op on these writes.

create or replace function public.ayyam_pull_v2() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.ayyam_data%rowtype; uid uuid;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  select * into r from public.ayyam_data where id = 'u:' || uid::text and user_id = uid;
  if not found then return jsonb_build_object('status','ok','exists',false,'revision',0,'epoch',0); end if;
  return jsonb_build_object('status','ok','exists',true,'revision',r.revision,'epoch',r.epoch,
                            'updated_at',r.updated_at,'data',r.data);
end $$;

create or replace function public.ayyam_commit_v2(
  p_expected_revision bigint, p_data jsonb, p_op_id uuid, p_reason text default 'sync'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.ayyam_data%rowtype; prev public.ayyam_ops%rowtype; uid uuid; rid text; new_rev bigint; new_epoch integer;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  rid := 'u:' || uid::text;
  if p_op_id is null or p_expected_revision is null or p_expected_revision < 0
     or p_reason is null or p_reason not in ('sync','init','reset','import','restore')
     or p_data is null or jsonb_typeof(p_data) <> 'object'
     or not ((p_data ? 'reg' and jsonb_typeof(p_data->'reg') = 'object')
             or (p_data ? 'template' and p_data ? 'logs'
                 and jsonb_typeof(p_data->'template') = 'object' and jsonb_typeof(p_data->'logs') = 'object')) then
    return jsonb_build_object('status','invalid');
  end if;
  if octet_length(p_data::text) > 2000000 then return jsonb_build_object('status','too_large'); end if;

  select * into r from public.ayyam_data where id = rid for update;

  select * into prev from public.ayyam_ops where op_id = p_op_id and user_id = uid;
  if found then
    return jsonb_build_object('status','duplicate','revision',prev.revision,
      'current_revision',coalesce(r.revision,0),'epoch',coalesce(r.epoch,0));
  end if;

  perform set_config('ayyam.via_commit','on',true);

  if r.id is null then
    if p_expected_revision <> 0 then return jsonb_build_object('status','conflict','exists',false,'revision',0,'epoch',0); end if;
    begin
      insert into public.ayyam_data (id, user_id, data, revision, epoch, updated_at, last_op_id)
        values (rid, uid, p_data, 1, 0, now(), p_op_id);
    exception when unique_violation then
      select * into r from public.ayyam_data where id = rid;
      return jsonb_build_object('status','conflict','exists',true,'revision',r.revision,'epoch',r.epoch,
                                'updated_at',r.updated_at,'data',r.data);
    end;
    insert into public.ayyam_ops (op_id, row_id, revision, user_id) values (p_op_id, rid, 1, uid);
    return jsonb_build_object('status','ok','revision',1,'epoch',0);
  end if;

  if r.revision <> p_expected_revision then
    return jsonb_build_object('status','conflict','exists',true,'revision',r.revision,'epoch',r.epoch,
                              'updated_at',r.updated_at,'data',r.data);
  end if;

  insert into public.ayyam_snapshots (row_id, revision, epoch, data, reason, user_id)
    values (rid, r.revision, r.epoch, r.data, 'before:' || p_reason, uid);

  new_rev   := r.revision + 1;
  new_epoch := greatest(r.epoch + case when p_reason in ('reset','import','restore') then 1 else 0 end,
                        coalesce((p_data->>'epoch')::int, 0));
  update public.ayyam_data set data = p_data, revision = new_rev, epoch = new_epoch, updated_at = now(), last_op_id = p_op_id
    where id = rid;
  insert into public.ayyam_ops (op_id, row_id, revision, user_id) values (p_op_id, rid, new_rev, uid);
  return jsonb_build_object('status','ok','revision',new_rev,'epoch',new_epoch);
end $$;

create or replace function public.ayyam_list_snapshots_v2() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  return jsonb_build_object('status','ok','snapshots', coalesce((
    select jsonb_agg(jsonb_build_object('id',s.id,'revision',s.revision,'epoch',s.epoch,'reason',s.reason,
             'created_at',s.created_at,
             'log_days',(select count(*) from jsonb_object_keys(case when jsonb_typeof(s.data->'logs')='object' then s.data->'logs' else '{}'::jsonb end)),
             'bytes',octet_length(s.data::text)) order by s.id desc)
    from public.ayyam_snapshots s where s.user_id = uid), '[]'::jsonb));
end $$;

create or replace function public.ayyam_restore_v2(p_snapshot_id bigint, p_expected_revision bigint, p_op_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d jsonb; uid uuid;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  select data into d from public.ayyam_snapshots where id = p_snapshot_id and user_id = uid;  -- ownership enforced
  if d is null then return jsonb_build_object('status','not_found'); end if;
  return public.ayyam_commit_v2(p_expected_revision, d, p_op_id, 'restore');
end $$;

create or replace function public.register_push_v2(p_endpoint text, p_p256dh text, p_auth text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  if p_endpoint is null or p_p256dh is null or p_auth is null then return jsonb_build_object('status','invalid'); end if;
  insert into public.push_subscriptions (endpoint, p256dh, auth, user_id, last_seen_at, updated_at)
    values (p_endpoint, p_p256dh, p_auth, uid, now(), now())
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, user_id = uid,
    last_seen_at = now(), updated_at = now(), disabled_at = null, failure_count = 0;
  return jsonb_build_object('status','ok');
end $$;

-- ---- privileges: v2 functions are for authenticated users only (never anon/public) ----
revoke all on function public.ayyam_pull_v2()                                      from public, anon, authenticated;
revoke all on function public.ayyam_commit_v2(bigint, jsonb, uuid, text)           from public, anon, authenticated;
revoke all on function public.ayyam_list_snapshots_v2()                            from public, anon, authenticated;
revoke all on function public.ayyam_restore_v2(bigint, bigint, uuid)               from public, anon, authenticated;
revoke all on function public.register_push_v2(text, text, text)                   from public, anon, authenticated;
grant execute on function public.ayyam_pull_v2()                                   to authenticated;
grant execute on function public.ayyam_commit_v2(bigint, jsonb, uuid, text)        to authenticated;
grant execute on function public.ayyam_list_snapshots_v2()                         to authenticated;
grant execute on function public.ayyam_restore_v2(bigint, bigint, uuid)            to authenticated;
grant execute on function public.register_push_v2(text, text, text)                to authenticated;

-- ============================================================ SECURITY DEFINER AUDIT (this migration)
-- Function                     | search_path='' | identity = auth.uid() | caller user_id accepted? | granted to
-- is_admin()                   | yes            | yes                   | no                       | authenticated
-- ayyam_account_state_v2()     | yes            | yes                   | no                       | authenticated
-- ayyam_pull_v2()              | yes            | yes (id='u:'||uid)    | no                       | authenticated
-- ayyam_commit_v2(...)         | yes            | yes (id='u:'||uid)    | no                       | authenticated
-- ayyam_list_snapshots_v2()    | yes            | yes (user_id=uid)     | no                       | authenticated
-- ayyam_restore_v2(...)        | yes            | yes (user_id=uid)     | no                       | authenticated
-- register_push_v2(...)        | yes            | yes (user_id=uid)     | no                       | authenticated
-- ayyam_claim(key)             | yes            | yes (+ device key)    | no                       | authenticated
-- ayyam_freeze_legacy(key)     | yes            | yes (+ device key)    | no                       | authenticated
-- Legacy functions (ayyam_pull/commit/list_snapshots/restore, register_push): UNCHANGED by this file.
