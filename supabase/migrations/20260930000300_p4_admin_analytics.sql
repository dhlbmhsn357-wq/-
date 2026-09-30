-- P4 — Admin dashboard + product analytics (STRICTLY ADDITIVE). Public-launch groundwork.
--
-- Adds: privacy-conscious product events (ayyam_events — NO personal content, ever), per-user presence
-- columns on profiles (last-seen platform/version), a single ingest RPC (ayyam_track), and two admin-only
-- read RPCs (ayyam_admin_overview, ayyam_admin_users). Nothing here touches the shipped legacy path or the
-- user sync path.
--
-- SECURITY DEFINER RULES (same as P1): (1) security definer + fixed search_path=''. (2) identity derived
-- ONLY from auth.uid(); a caller-supplied user_id is never accepted. (3) reject when auth.uid() is null.
-- (4) admin read RPCs additionally gate on public.is_admin() and return 'forbidden' otherwise — the gate is
-- BACKEND-SIDE, so an ordinary authenticated user can call the RPC but gets nothing.
--
-- PRIVACY: the admin surface is product analytics ONLY. No function here reads ayyam_data / ayyam_snapshots
-- (task titles, times, notes, prayer logs, excused/replaced content). ayyam_events stores only an event
-- NAME from a fixed whitelist + platform + app_version. Idempotent (safe to re-run).

-- ============================================================ per-user presence (LAST seen platform/ver)
-- profiles already carries created_at / last_seen_at / onboarding_completed_at / *_first_seen. Add the
-- "last known" platform + version so the overview can show the CURRENT distribution, not just first-seen.
alter table public.profiles add column if not exists platform_last_seen    text;
alter table public.profiles add column if not exists app_version_last_seen text;
create index if not exists profiles_created_idx    on public.profiles (created_at);
create index if not exists profiles_last_seen_idx  on public.profiles (last_seen_at);
create index if not exists profiles_platform_idx   on public.profiles (platform_last_seen);
create index if not exists profiles_version_idx    on public.profiles (app_version_last_seen);
create index if not exists profiles_onboarded_idx  on public.profiles (onboarding_completed_at);

-- ============================================================ product events (privacy-conscious, no content)
create table if not exists public.ayyam_events (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  name        text not null,
  platform    text,
  app_version text,
  created_at  timestamptz not null default now()
);
-- deliberately NO columns for title / notes / prayer / log content — the schema itself makes leakage impossible.
alter table public.ayyam_events enable row level security;
revoke all on public.ayyam_events from anon, authenticated;   -- read only via the admin definer RPC below
create index if not exists ayyam_events_created_idx on public.ayyam_events (created_at desc);
create index if not exists ayyam_events_name_idx    on public.ayyam_events (name);
create index if not exists ayyam_events_user_idx    on public.ayyam_events (user_id);

-- The only allowed event names. Anything else is ignored (defensive — the client should never send others).
create or replace function public.ayyam_event_allowed(p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select p_name in ('signup_completed','login_success','onboarding_completed','app_open',
                    'task_created','calendar_opened','insights_opened');
$$;

-- ============================================================ ingest RPC (authenticated; derives identity)
-- Records one product event for the CURRENT user and refreshes their presence row (profiles). Accepts only
-- an event name (whitelisted) + platform + app_version, and optionally the user's OWN display name (they
-- control it). It can never write another user's data (user_id = auth.uid()), and stores no personal content.
create or replace function public.ayyam_track(
  p_name text, p_platform text default null, p_app_version text default null, p_display_name text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid; plat text; ver text; nm text;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  if p_name is null or not public.ayyam_event_allowed(p_name) then return jsonb_build_object('status','ignored'); end if;
  plat := nullif(left(coalesce(p_platform,''), 32), '');
  ver  := nullif(left(coalesce(p_app_version,''), 32), '');
  nm   := nullif(left(coalesce(p_display_name,''), 120), '');

  -- presence upsert: first contact stamps created_at/first-seen; every event refreshes last-seen.
  insert into public.profiles (id, display_name, created_at, last_seen_at,
                               platform_first_seen, app_version_first_seen, platform_last_seen, app_version_last_seen,
                               onboarding_completed_at)
    values (uid, nm, now(), now(), plat, ver, plat, ver,
            case when p_name = 'onboarding_completed' then now() else null end)
  on conflict (id) do update set
    last_seen_at          = now(),
    platform_last_seen    = coalesce(plat, public.profiles.platform_last_seen),
    app_version_last_seen = coalesce(ver,  public.profiles.app_version_last_seen),
    display_name          = coalesce(nm,   public.profiles.display_name),
    onboarding_completed_at = case when p_name = 'onboarding_completed'
                                   then coalesce(public.profiles.onboarding_completed_at, now())
                                   else public.profiles.onboarding_completed_at end;

  insert into public.ayyam_events (user_id, name, platform, app_version) values (uid, p_name, plat, ver);
  return jsonb_build_object('status','ok');
end $$;
revoke all on function public.ayyam_track(text, text, text, text) from public, anon;
grant execute on function public.ayyam_track(text, text, text, text) to authenticated;

-- ============================================================ admin overview (admin-gated, aggregates only)
create or replace function public.ayyam_admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare now_ts timestamptz := now();
begin
  if auth.uid() is null then return jsonb_build_object('status','unauthorized'); end if;
  if not public.is_admin()  then return jsonb_build_object('status','forbidden'); end if;
  return jsonb_build_object('status','ok',
    'users', jsonb_build_object(
      'total',    (select count(*) from public.profiles),
      'new_today',(select count(*) from public.profiles where created_at >= date_trunc('day', now_ts)),
      'new_7d',   (select count(*) from public.profiles where created_at >= now_ts - interval '7 days'),
      'new_30d',  (select count(*) from public.profiles where created_at >= now_ts - interval '30 days')),
    'active', jsonb_build_object(
      'today',(select count(*) from public.profiles where last_seen_at >= date_trunc('day', now_ts)),
      'd7',   (select count(*) from public.profiles where last_seen_at >= now_ts - interval '7 days'),
      'd30',  (select count(*) from public.profiles where last_seen_at >= now_ts - interval '30 days')),
    'platform', jsonb_build_object(
      'android',(select count(*) from public.profiles where platform_last_seen = 'android'),
      'web',    (select count(*) from public.profiles where platform_last_seen in ('web','pwa')),
      'unknown',(select count(*) from public.profiles where platform_last_seen is null
                   or platform_last_seen not in ('android','web','pwa'))),
    'versions', coalesce((select jsonb_agg(v order by v->>'version')
                          from (select jsonb_build_object('version', coalesce(app_version_last_seen,'—'),
                                                          'count', count(*)) v
                                from public.profiles group by app_version_last_seen) t), '[]'::jsonb),
    'onboarding', jsonb_build_object(
      'completed',(select count(*) from public.profiles where onboarding_completed_at is not null),
      'total',    (select count(*) from public.profiles),
      'pct', (select case when count(*) = 0 then 0
                     else round(100.0 * count(*) filter (where onboarding_completed_at is not null) / count(*)) end
              from public.profiles)));
end $$;
revoke all on function public.ayyam_admin_overview() from public, anon;
grant execute on function public.ayyam_admin_overview() to authenticated;

-- ============================================================ admin users table (server-side pagination)
-- Returns { status, total, rows:[{ user_id, name, email, created_at, last_seen_at, platform, app_version,
-- status }] }. Search by name/email, whitelisted sort, capped page size. Reads ONLY identity + presence —
-- never any ayyam_data content. Parameterised search (no injection); sort tokens come from a fixed set.
create or replace function public.ayyam_admin_users(
  p_search text default null, p_limit int default 25, p_offset int default 0,
  p_sort text default 'last_seen_at', p_dir text default 'desc'
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare lim int; off int; sort_col text; dir text; total bigint; rows jsonb; needle text;
begin
  if auth.uid() is null then return jsonb_build_object('status','unauthorized'); end if;
  if not public.is_admin()  then return jsonb_build_object('status','forbidden'); end if;
  lim := least(greatest(coalesce(p_limit, 25), 1), 100);
  off := greatest(coalesce(p_offset, 0), 0);
  needle := case when nullif(trim(coalesce(p_search,'')), '') is null then null
                 else '%' || trim(p_search) || '%' end;
  sort_col := case p_sort when 'created_at' then 'p.created_at'
                          when 'last_seen_at' then 'p.last_seen_at'
                          when 'name' then 'p.display_name'
                          when 'email' then 'u.email'
                          else 'p.last_seen_at' end;
  dir := case when lower(coalesce(p_dir,'desc')) = 'asc' then 'asc' else 'desc' end;

  select count(*) into total
  from public.profiles p left join auth.users u on u.id = p.id
  where needle is null or p.display_name ilike needle or u.email ilike needle;

  execute format($f$
    select coalesce(jsonb_agg(r), '[]'::jsonb) from (
      select jsonb_build_object(
        'user_id', p.id, 'name', p.display_name, 'email', u.email,
        'created_at', p.created_at, 'last_seen_at', p.last_seen_at,
        'platform', p.platform_last_seen, 'app_version', p.app_version_last_seen,
        'status', coalesce(s.migration_status, 'none')) r
      from public.profiles p
        left join auth.users u on u.id = p.id
        left join public.user_account_state s on s.user_id = p.id
      where ($1 is null or p.display_name ilike $1 or u.email ilike $1)
      order by %s %s nulls last, p.id asc
      limit %s offset %s
    ) q
  $f$, sort_col, dir, lim, off) into rows using needle;

  return jsonb_build_object('status','ok','total', total, 'limit', lim, 'offset', off, 'rows', rows);
end $$;
revoke all on function public.ayyam_admin_users(text, int, int, text, text) from public, anon;
grant execute on function public.ayyam_admin_users(text, int, int, text, text) to authenticated;

-- ============================================================ SECURITY DEFINER AUDIT (this migration)
-- Function                 | search_path='' | identity = auth.uid() | admin-gated | caller user_id? | granted
-- ayyam_track(...)         | yes            | yes (writes own row)  | n/a         | no              | authenticated
-- ayyam_admin_overview()   | yes            | yes                   | yes         | no              | authenticated
-- ayyam_admin_users(...)   | yes            | yes                   | yes         | no              | authenticated
-- ayyam_events / profiles presence: revoked from anon+authenticated; reachable only via the definer RPCs.
