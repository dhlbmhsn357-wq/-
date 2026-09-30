-- P5 — onboarding progress + completion (STRICTLY ADDITIVE). Server-side, resumable, idempotent.
--
-- Completion is REAL server-side state (profiles.onboarding_completed_at), never inferred from opening a
-- screen. The tour is resumable via a monotonic onboarding_step. Completion (finished OR skipped) is marked
-- exactly once — a Settings "replay" re-runs the tour but never re-marks or double-counts. No user content is
-- ever recorded. Idempotent (safe to re-run).
--
-- SECURITY DEFINER RULES (as P1/P4): search_path='', identity from auth.uid(), never a caller user_id.

alter table public.profiles add column if not exists onboarding_step int not null default 0;

-- Read the caller's onboarding state (resume point + whether it is completed — the authoritative flag).
create or replace function public.ayyam_onboarding_get() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles%rowtype;
begin
  if auth.uid() is null then return jsonb_build_object('status','unauthorized'); end if;
  select * into p from public.profiles where id = auth.uid();
  if not found then return jsonb_build_object('status','ok','step',0,'completed',false); end if;
  return jsonb_build_object('status','ok','step',coalesce(p.onboarding_step,0),
    'completed', p.onboarding_completed_at is not null);
end $$;
revoke all on function public.ayyam_onboarding_get() from public, anon;
grant execute on function public.ayyam_onboarding_get() to authenticated;

-- Advance onboarding: step is monotonic (never regresses); when p_done, mark completed ONCE and record the
-- 'onboarding_completed' event only on the FIRST completion (so replay from Settings can't double-count).
-- p_via ('finished' | 'skipped') is accepted for clarity; no user choices/content are ever stored.
create or replace function public.ayyam_onboarding_progress(p_step int, p_done boolean default false, p_via text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid; new_step int; done_at timestamptz;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  new_step := greatest(coalesce(p_step, 0), 0);

  insert into public.profiles (id, created_at, last_seen_at, onboarding_step, onboarding_completed_at)
    values (uid, now(), now(), new_step, case when p_done then now() else null end)
  on conflict (id) do update set
    onboarding_step         = greatest(public.profiles.onboarding_step, new_step),
    last_seen_at            = now(),
    onboarding_completed_at = case when p_done then coalesce(public.profiles.onboarding_completed_at, now())
                                   else public.profiles.onboarding_completed_at end;

  if p_done and not exists (select 1 from public.ayyam_events e where e.user_id = uid and e.name = 'onboarding_completed') then
    insert into public.ayyam_events (user_id, name) values (uid, 'onboarding_completed');
  end if;

  select onboarding_completed_at into done_at from public.profiles where id = uid;
  return jsonb_build_object('status','ok',
    'step', (select onboarding_step from public.profiles where id = uid),
    'completed', done_at is not null);
end $$;
revoke all on function public.ayyam_onboarding_progress(int, boolean, text) from public, anon;
grant execute on function public.ayyam_onboarding_progress(int, boolean, text) to authenticated;

-- ============================================================ SECURITY DEFINER AUDIT (this migration)
-- Function                          | search_path='' | identity=auth.uid() | caller user_id? | granted
-- ayyam_onboarding_get()            | yes            | yes                 | no              | authenticated
-- ayyam_onboarding_progress(...)    | yes            | yes                 | no              | authenticated
