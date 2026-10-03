-- Rollback for 20260930000300_p4_admin_analytics.sql (additive → fully reversible).
drop function if exists public.ayyam_admin_users(text, int, int, text, text);
drop function if exists public.ayyam_admin_overview();
drop function if exists public.ayyam_track(text, text, text, text);
drop function if exists public.ayyam_event_allowed(text);
drop table if exists public.ayyam_events;
drop index if exists public.profiles_created_idx;
drop index if exists public.profiles_last_seen_idx;
drop index if exists public.profiles_platform_idx;
drop index if exists public.profiles_version_idx;
drop index if exists public.profiles_onboarded_idx;
alter table public.profiles drop column if exists platform_last_seen;
alter table public.profiles drop column if exists app_version_last_seen;
