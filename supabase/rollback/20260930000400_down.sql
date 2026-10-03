-- Rollback for 20260930000400_p5_onboarding.sql (additive → reversible).
drop function if exists public.ayyam_onboarding_progress(int, boolean, text);
drop function if exists public.ayyam_onboarding_get();
alter table public.profiles drop column if exists onboarding_step;
