-- Android FCM push channel — ADDITIVE and backwards-compatible. The Web/PWA Web Push path
-- (push_subscriptions + VAPID) is unchanged: existing rows default to channel='webpush' and every
-- Phase-4 function keeps working. Nothing here is applied to Production in Phase F (branch-only).

-- ---------------------------------------------------------------- android FCM tokens
create table if not exists public.android_push_subscriptions (
  id            bigserial primary key,
  platform      text        not null default 'android',
  token         text        not null unique,
  device_id     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  disabled_at   timestamptz,
  failure_count integer     not null default 0
);
alter table public.android_push_subscriptions enable row level security; -- service role only; browser uses the RPC

-- ---------------------------------------------------------------- deliveries become channel-aware
alter table public.push_deliveries add column if not exists channel text not null default 'webpush';
alter table public.push_deliveries add column if not exists android_subscription_id bigint
  references public.android_push_subscriptions(id) on delete cascade;
-- webpush rows still set subscription_id; fcm rows leave it null and set android_subscription_id instead
alter table public.push_deliveries alter column subscription_id drop not null;
-- one fcm delivery per (reminder, token); the existing unique(reminder_id, subscription_id) covers webpush
create unique index if not exists push_deliveries_fcm_uniq
  on public.push_deliveries(reminder_id, android_subscription_id) where channel = 'fcm';

-- ---------------------------------------------------------------- register an FCM token (device-key gated)
create or replace function public.register_android_push(p_key text, p_token text, p_device_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare existed boolean;
begin
  if not public.ayyam_key_ok(p_key) then return jsonb_build_object('status','unauthorized'); end if;
  if p_token is null or length(p_token) < 10 or length(p_token) > 4096 then
    return jsonb_build_object('status','invalid');
  end if;
  select true into existed from public.android_push_subscriptions where token = p_token;
  insert into public.android_push_subscriptions (token, device_id, last_seen_at, updated_at)
    values (p_token, p_device_id, now(), now())
  on conflict (token) do update
    set device_id = coalesce(excluded.device_id, public.android_push_subscriptions.device_id),
        last_seen_at = now(), updated_at = now(), disabled_at = null, failure_count = 0;
  return jsonb_build_object('status','ok','existed',coalesce(existed,false));
end $$;

-- ---------------------------------------------------------------- enqueue: fan out to web AND android
create or replace function public.push_enqueue(p_day date, p_period text, p_title text, p_body text, p_tag text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare rid bigint; nw int := 0; na int := 0;
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
  if rid is null then
    select id into rid from public.push_reminders where day = p_day and period = p_period;
    return jsonb_build_object('status','exists','reminder_id',rid);
  end if;
  insert into public.push_deliveries (reminder_id, channel, subscription_id)
    select rid, 'webpush', s.id from public.push_subscriptions s where s.disabled_at is null;
  get diagnostics nw = row_count;
  insert into public.push_deliveries (reminder_id, channel, android_subscription_id)
    select rid, 'fcm', a.id from public.android_push_subscriptions a where a.disabled_at is null;
  get diagnostics na = row_count;
  return jsonb_build_object('status','created','reminder_id',rid,'deliveries',nw + na,'web',nw,'fcm',na);
end $$;

-- ---------------------------------------------------------------- claim: channel-aware (web endpoint OR fcm token)
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
    returning d.id, d.reminder_id, d.subscription_id, d.android_subscription_id, d.channel, d.attempt_count
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'delivery_id', c.id, 'attempt', c.attempt_count, 'channel', c.channel,
           'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
           'token', a.token,
           'title', r.title, 'body', r.body, 'tag', r.tag)), '[]'::jsonb)
    into result
  from claimed c
  join public.push_reminders r on r.id = c.reminder_id
  left join public.push_subscriptions s on s.id = c.subscription_id
  left join public.android_push_subscriptions a on a.id = c.android_subscription_id;
  return result;
end $$;

-- ---------------------------------------------------------------- disable a dead FCM token (UNREGISTERED etc.)
create or replace function public.push_disable_android(p_id bigint, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare sub bigint;
begin
  select android_subscription_id into sub from public.push_deliveries where id = p_id;
  update public.push_deliveries set status='sent', sent_at=null, lease_until=null, next_retry_at=null, last_error=left(p_error,500) where id = p_id;
  update public.android_push_subscriptions set disabled_at = now(), failure_count = failure_count + 1 where id = sub;
  update public.push_deliveries d set status='skipped', lease_until=null
    where d.android_subscription_id = sub and d.status in ('pending','failed','processing');
end $$;

-- ---------------------------------------------------------------- cleanup long-disabled android tokens too
create or replace function public.push_cleanup()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.push_reminders where created_at < now() - interval '14 days';
  delete from public.push_subscriptions where disabled_at is not null and disabled_at < now() - interval '30 days';
  delete from public.android_push_subscriptions where disabled_at is not null and disabled_at < now() - interval '30 days';
  delete from public.push_log where day < (now() - interval '30 days')::date;
exception when undefined_table then null; -- push_log is legacy/optional
end $$;

-- ---------------------------------------------------------------- privileges
revoke all on function public.register_android_push(text,text,text) from public, anon, authenticated;
grant execute on function public.register_android_push(text,text,text) to anon;         -- the only android push fn the browser/app may call
grant execute on function public.register_android_push(text,text,text) to service_role;
grant execute on function public.push_disable_android(bigint,text)     to service_role;
