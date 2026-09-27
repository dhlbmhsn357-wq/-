-- Schedules the ayyam-reminders edge function every 5 minutes, authenticated with a cron secret.
-- Run in Supabase → SQL Editor AFTER: (1) the migrations are applied, (2) the edge function is deployed,
-- (3) the cron secret is stored (owner-run, value never in the repo):
--
--     select vault.create_secret('<STRONG_RANDOM_SECRET>', 'ayyam_cron_secret');
--     -- and set the SAME value as the function secret CRON_SECRET:
--     -- supabase secrets set CRON_SECRET=<same value> --project-ref <ref>
--
-- The cron job reads the secret from Vault and sends it as X-Cron-Secret. The function returns 401 to
-- any request without it, so the endpoint can't be triggered by anyone on the internet.
-- Safe to run again.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- remove any earlier jobs (the placeholder-URL one, and previous versions of this job)
select cron.unschedule(jobid) from cron.job where jobname in ('ayyam-reminders', 'send-prayer-reminders-every-2-min');

select cron.schedule(
  'ayyam-reminders',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://oiyfhymdjvsvodkzzive.supabase.co/functions/v1/ayyam-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ayyam_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
