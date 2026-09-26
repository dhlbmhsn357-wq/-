-- One-time setup for prayer-time reminders (run in Supabase → SQL Editor). Safe to run again.
-- Requires the edge function `ayyam-reminders` to be deployed (with --no-verify-jwt).

-- Subscriptions saved by the app (normally already exists; created only if missing).
create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- One row per (day, prayer) already handled, so a reminder is never sent twice.
create table if not exists public.push_log (
  day date not null,
  period text not null,
  sent_at timestamptz not null default now(),
  primary key (day, period)
);
-- No policies: only the edge function (service role) reads/writes it.
alter table public.push_log enable row level security;

-- Run the function every 5 minutes.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'ayyam-reminders';
select cron.schedule(
  'ayyam-reminders',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://oiyfhymdjvsvodkzzive.supabase.co/functions/v1/ayyam-reminders',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
