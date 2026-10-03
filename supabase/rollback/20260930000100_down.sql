-- Rollback for 20260930000100_p1_auth_foundation.sql (P1 auth foundation — additive/dormant).
-- Safe because P1 touched NOTHING the shipped v1.1.2 path uses: it only ADDED new tables, functions,
-- nullable columns and `authenticated`-role policies, none of which the current app calls. Dropping
-- them cannot lose real user data (the new per-user rows/columns are empty until the account phases
-- ship). The legacy row id='main', the legacy RPCs, and the anon policies are left exactly as they were.
-- Idempotent.

-- new v2 / claim / admin functions
drop function if exists public.ayyam_pull_v2();
drop function if exists public.ayyam_commit_v2(bigint, jsonb, uuid, text);
drop function if exists public.ayyam_list_snapshots_v2();
drop function if exists public.ayyam_restore_v2(bigint, bigint, uuid);
drop function if exists public.register_push_v2(text, text, text);
drop function if exists public.ayyam_account_state_v2();
drop function if exists public.ayyam_claim(text);
drop function if exists public.ayyam_freeze_legacy(text);
drop function if exists public.is_admin();

-- authenticated-role policies added to ayyam_data (legacy anon 'main' policies are NOT touched)
drop policy if exists "ayyam_data self select" on public.ayyam_data;
drop policy if exists "ayyam_data self insert" on public.ayyam_data;
drop policy if exists "ayyam_data self update" on public.ayyam_data;

-- new tables
drop table if exists public.ayyam_legacy_claim;
drop table if exists public.user_account_state;
drop table if exists public.user_roles;
drop table if exists public.profiles;

-- ownership columns + indexes (nullable, empty on rollback)
drop index if exists public.ayyam_data_user_idx;
drop index if exists public.ayyam_snapshots_user_idx;
drop index if exists public.ayyam_ops_user_idx;
drop index if exists public.push_subscriptions_user_idx;
alter table public.ayyam_data          drop column if exists user_id;
alter table public.ayyam_snapshots     drop column if exists user_id;
alter table public.ayyam_ops           drop column if exists user_id;
alter table public.push_subscriptions  drop column if exists user_id;

-- NOTE: the test-only `auth` shim lives in tests/, not in migrations; nothing to roll back there.
-- On real Supabase, auth.users / auth.uid() are platform-owned and are never created or dropped by us.
