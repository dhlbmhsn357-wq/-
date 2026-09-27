-- Phase 4 — hardened, retry-safe push notifications. ADDITIVE and idempotent.
-- Model:
--   push_subscriptions  one row per device endpoint (now with lifecycle columns)
--   push_reminders      one row per (day, period) that was evaluated: 'active' (has a message) or
--                       'skipped' (no open tasks) — created once, so the 5-min cron never re-sends
--   push_deliveries     one row per (reminder, subscription): an independent state machine per device
-- Sending is claim/lease based, so two concurrent cron runs never send the same delivery twice, and a
-- temporary failure is retried with backoff instead of being lost. A (day,period) is only 'active' when
-- buildMessage produced a message. Browsers no longer touch push_subscriptions directly — registration
-- goes through register_push (device-key protected). See supabase/setup-reminders.sql for the cron job.

-- ---------------------------------------------------------------- push_subscriptions lifecycle
alter table public.push_subscriptions add column if not exists updated_at    timestamptz not null default now();
alter table public.push_subscriptions add column if not exists last_seen_at  timestamptz not null default now();
alter table public.push_subscriptions add column if not exists failure_count integer     not null default 0;
alter table public.push_subscriptions add column if not exists disabled_at   timestamptz;

-- Browsers must NOT read/insert/update/delete this table any more (registration goes via register_push,
-- which runs as definer). The edge function uses the service role and bypasses RLS.
drop policy if exists "allow select from anon" on public.push_subscriptions;
drop policy if exists "allow insert from anon" on public.push_subscriptions;
drop policy if exists "allow delete from anon" on public.push_subscriptions;
revoke all on public.push_subscriptions from anon, authenticated;

-- ---------------------------------------------------------------- reminders (per day+period)
create table if not exists public.push_reminders (
  id         bigint generated always as identity primary key,
  day        date        not null,
  period     text        not null,
  status     text        not null default 'active' check (status in ('active','skipped')),
  title      text,
  body       text,
  tag        text,
  created_at timestamptz not null default now(),
  unique (day, period)
);
alter table public.push_reminders enable row level security; -- service role only
revoke all on public.push_reminders from anon, authenticated;

-- ---------------------------------------------------------------- deliveries (per reminder+device)
create table if not exists public.push_deliveries (
  id            bigint generated always as identity primary key,
  reminder_id   bigint      not null references public.push_reminders(id) on delete cascade,
  subscription_id uuid      not null references public.push_subscriptions(id) on delete cascade,
  status        text        not null default 'pending' check (status in ('pending','processing','sent','failed','skipped')),
  attempt_count integer     not null default 0,
  claimed_at    timestamptz,
  lease_until   timestamptz,
  sent_at       timestamptz,
  next_retry_at timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  unique (reminder_id, subscription_id)
);
create index if not exists push_deliveries_claimable_idx on public.push_deliveries (status, next_retry_at);
alter table public.push_deliveries enable row level security; -- service role only
revoke all on public.push_deliveries from anon, authenticated;

-- ---------------------------------------------------------------- register_push (device-key protected)
-- Real upsert on endpoint: refreshes keys + last_seen, re-enables a previously disabled device.
create or replace function public.register_push(p_key text, p_endpoint text, p_p256dh text, p_auth text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare existed boolean; changed boolean;
begin
  if not public.ayyam_key_ok(p_key) then return jsonb_build_object('status','unauthorized'); end if;
  if p_endpoint is null or p_p256dh is null or p_auth is null
     or length(p_endpoint) < 8 or length(p_endpoint) > 1024 then
    return jsonb_build_object('status','invalid');
  end if;
  select true, (s.p256dh is distinct from p_p256dh or s.auth is distinct from p_auth)
    into existed, changed from public.push_subscriptions s where s.endpoint = p_endpoint;
  insert into public.push_subscriptions (endpoint, p256dh, auth, last_seen_at, updated_at)
    values (p_endpoint, p_p256dh, p_auth, now(), now())
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, last_seen_at = now(), updated_at = now(),
        disabled_at = null, failure_count = 0;
  return jsonb_build_object('status','ok', 'existed', coalesce(existed,false), 'keys_updated', coalesce(changed,false));
end $$;

-- ---------------------------------------------------------------- enqueue one (day,period)
-- Idempotent: the first call fixes the outcome. With a message → 'active' + one delivery per active
-- device. Without a message → 'skipped' (recorded so the cron does not keep re-evaluating/sending).
create or replace function public.push_enqueue(p_day date, p_period text, p_title text, p_body text, p_tag text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare rid bigint; created boolean := false; n int := 0;
begin
  select id into rid from public.push_reminders where day = p_day and period = p_period;
  if rid is not null then
    return jsonb_build_object('status','exists','reminder_id',rid);
  end if;
  if p_title is null or p_body is null then
    insert into public.push_reminders (day, period, status) values (p_day, p_period, 'skipped')
      on conflict (day, period) do nothing returning id into rid;
    return jsonb_build_object('status','skipped','reminder_id',rid);
  end if;
  insert into public.push_reminders (day, period, status, title, body, tag)
    values (p_day, p_period, 'active', p_title, p_body, p_tag)
    on conflict (day, period) do nothing returning id into rid;
  if rid is null then -- lost the race; another run created it
    select id into rid from public.push_reminders where day = p_day and period = p_period;
    return jsonb_build_object('status','exists','reminder_id',rid);
  end if;
  insert into public.push_deliveries (reminder_id, subscription_id)
    select rid, s.id from public.push_subscriptions s where s.disabled_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('status','created','reminder_id',rid,'deliveries',n);
end $$;

-- ---------------------------------------------------------------- claim a batch (lease)
-- Atomically claim due deliveries (pending, or failed & due for retry, or a processing whose lease
-- expired — e.g. a crashed run). FOR UPDATE SKIP LOCKED → concurrent runs get disjoint sets.
create or replace function public.push_claim(p_limit int, p_lease_seconds int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  with due as (
    select d.id from public.push_deliveries d
    where d.status = 'pending'
       or (d.status = 'failed' and d.next_retry_at is not null and d.next_retry_at <= now())
       or (d.status = 'processing' and d.lease_until is not null and d.lease_until < now())
    order by d.id
    for update skip locked
    limit greatest(p_limit, 0)
  ), claimed as (
    update public.push_deliveries d
      set status = 'processing', claimed_at = now(),
          lease_until = now() + make_interval(secs => p_lease_seconds), attempt_count = d.attempt_count + 1
    from due where d.id = due.id
    returning d.id, d.reminder_id, d.subscription_id, d.attempt_count
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'delivery_id', c.id, 'attempt', c.attempt_count,
           'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
           'title', r.title, 'body', r.body, 'tag', r.tag)), '[]'::jsonb)
    into result
  from claimed c
  join public.push_subscriptions s on s.id = c.subscription_id
  join public.push_reminders r on r.id = c.reminder_id;
  return result;
end $$;

create or replace function public.push_mark_sent(p_id bigint)
returns void language sql security definer set search_path = '' as $$
  update public.push_deliveries set status='sent', sent_at=now(), lease_until=null, next_retry_at=null, last_error=null where id=p_id;
$$;

-- retryable → 'failed' with a backoff next_retry_at (capped attempts); otherwise terminal 'failed'.
create or replace function public.push_mark_failed(p_id bigint, p_error text, p_retryable boolean, p_max_attempts int, p_base_seconds int)
returns void language plpgsql security definer set search_path = '' as $$
declare a int;
begin
  select attempt_count into a from public.push_deliveries where id = p_id;
  if p_retryable and a < p_max_attempts then
    update public.push_deliveries
      set status='failed', lease_until=null, last_error=left(p_error,500),
          next_retry_at = now() + make_interval(secs => least(p_base_seconds * power(2, greatest(a-1,0))::int, 3600))
      where id = p_id;
  else
    update public.push_deliveries
      set status='failed', lease_until=null, next_retry_at=null, last_error=left(p_error,500) where id = p_id;
  end if;
end $$;

-- 404/410/403 from the push provider → the device is gone: disable it and skip its open deliveries.
create or replace function public.push_disable_subscription(p_id bigint, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare sub uuid;
begin
  select subscription_id into sub from public.push_deliveries where id = p_id;
  update public.push_deliveries set status='sent', sent_at=null, lease_until=null, next_retry_at=null, last_error=left(p_error,500) where id = p_id;
  update public.push_subscriptions set disabled_at = now(), failure_count = failure_count + 1 where id = sub;
  update public.push_deliveries d set status='skipped', lease_until=null
    where d.subscription_id = sub and d.status in ('pending','failed','processing');
end $$;

-- ---------------------------------------------------------------- cleanup (safe, time-based)
create or replace function public.push_cleanup()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.push_reminders where created_at < now() - interval '14 days'; -- cascades deliveries
  delete from public.push_subscriptions where disabled_at is not null and disabled_at < now() - interval '30 days';
  delete from public.push_log where day < (now() - interval '30 days')::date; -- legacy table
end $$;

-- ---------------------------------------------------------------- privileges
revoke all on function public.register_push(text,text,text,text)              from public, anon, authenticated;
revoke all on function public.push_enqueue(date,text,text,text,text)          from public, anon, authenticated;
revoke all on function public.push_claim(int,int)                             from public, anon, authenticated;
revoke all on function public.push_mark_sent(bigint)                          from public, anon, authenticated;
revoke all on function public.push_mark_failed(bigint,text,boolean,int,int)   from public, anon, authenticated;
revoke all on function public.push_disable_subscription(bigint,text)          from public, anon, authenticated;
revoke all on function public.push_cleanup()                                  from public, anon, authenticated;
grant execute on function public.register_push(text,text,text,text) to anon;  -- the only push function the browser may call
-- the reminders edge function runs as service_role and drives the state machine
grant execute on function public.push_enqueue(date,text,text,text,text)        to service_role;
grant execute on function public.push_claim(int,int)                           to service_role;
grant execute on function public.push_mark_sent(bigint)                        to service_role;
grant execute on function public.push_mark_failed(bigint,text,boolean,int,int) to service_role;
grant execute on function public.push_disable_subscription(bigint,text)        to service_role;
grant execute on function public.push_cleanup()                                to service_role;
grant execute on function public.register_push(text,text,text,text)            to service_role;
