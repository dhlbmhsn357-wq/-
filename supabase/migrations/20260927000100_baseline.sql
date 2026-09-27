-- Baseline: the schema exactly as it existed in production on 2026-09-27 (before reliability v2).
-- Idempotent: safe on the live project (no-ops) and recreates everything on an empty database.
-- Supersedes supabase/setup-sync.sql (tables/policies/trigger). The reminders cron job stays in
-- supabase/setup-reminders.sql until it is migrated with its secret (Phase 4).

-- ---------------------------------------------------------------- ayyam_data (the whole app state)
create table if not exists public.ayyam_data (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz default now()
);
alter table public.ayyam_data enable row level security;

-- Legacy access model (single row 'main', anon role). Replaced at the v2 client cut-over.
drop policy if exists "ayyam anon read main"   on public.ayyam_data;
drop policy if exists "ayyam anon insert main" on public.ayyam_data;
drop policy if exists "ayyam anon update main" on public.ayyam_data;
create policy "ayyam anon read main"   on public.ayyam_data for select to anon using (id = 'main');
create policy "ayyam anon insert main" on public.ayyam_data for insert to anon with check (id = 'main');
create policy "ayyam anon update main" on public.ayyam_data for update to anon using (id = 'main') with check (id = 'main');

-- The row may only be CREATED from a device with real activity (protects the phone's history).
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

drop trigger if exists ayyam_guard_first_insert on public.ayyam_data;
create trigger ayyam_guard_first_insert before insert on public.ayyam_data
  for each row execute function public.ayyam_guard_first_insert();

-- ---------------------------------------------------------------- push notifications
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
-- Legacy (too permissive — fixed in Phase 4): anon may select/insert/delete.
drop policy if exists "allow select from anon" on public.push_subscriptions;
drop policy if exists "allow insert from anon" on public.push_subscriptions;
drop policy if exists "allow delete from anon" on public.push_subscriptions;
create policy "allow select from anon" on public.push_subscriptions for select to anon using (true);
create policy "allow insert from anon" on public.push_subscriptions for insert to anon with check (true);
create policy "allow delete from anon" on public.push_subscriptions for delete to anon using (true);

create table if not exists public.push_log (
  day     date not null,
  period  text not null,
  sent_at timestamptz not null default now(),
  primary key (day, period)
);
alter table public.push_log enable row level security; -- no policies: service role only

-- ---------------------------------------------------------------- manual recovery points (Phase 0)
create table if not exists public.ayyam_recovery_points (
  id                bigint generated always as identity primary key,
  taken_at          timestamptz not null default now(),
  reason            text not null,
  row_id            text not null,
  data              jsonb not null,
  source_updated_at timestamptz
);
alter table public.ayyam_recovery_points enable row level security;
revoke all on public.ayyam_recovery_points from anon, authenticated;
