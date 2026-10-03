-- P2 — server-recorded migration lifecycle (device-key legacy → account). Additive.
-- The client CANNOT write user_account_state directly (P1 revoked it); these definer RPCs are the ONLY
-- way to advance it, and they act strictly on auth.uid(). Idempotent + safe to re-run after interruption.
-- Same SECURITY DEFINER rules as P1: fixed search_path='', identity from auth.uid(), no caller user_id.

create or replace function public.ayyam_migration_begin_v2() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid; s public.user_account_state%rowtype;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  insert into public.user_account_state (user_id, migration_status)
    values (uid, 'in_progress')
  on conflict (user_id) do update
    set migration_status = case when public.user_account_state.migration_status = 'completed'
                                then 'completed' else 'in_progress' end,  -- never regress a completed migration
        updated_at = now();
  select * into s from public.user_account_state where user_id = uid;
  return jsonb_build_object('status','ok','migration_status',s.migration_status,'migration_version',s.migration_version);
end $$;

create or replace function public.ayyam_migration_complete_v2() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid; s public.user_account_state%rowtype;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  insert into public.user_account_state (user_id, migration_status, migration_version, migrated_from_legacy_at)
    values (uid, 'completed', 1, now())
  on conflict (user_id) do update
    set migration_status = 'completed', migration_version = greatest(public.user_account_state.migration_version, 1),
        migrated_from_legacy_at = coalesce(public.user_account_state.migrated_from_legacy_at, now()), updated_at = now();
  select * into s from public.user_account_state where user_id = uid;
  return jsonb_build_object('status','ok','migration_status',s.migration_status,'migration_version',s.migration_version,
    'migrated_from_legacy_at',s.migrated_from_legacy_at);
end $$;

revoke all on function public.ayyam_migration_begin_v2()    from public, anon, authenticated;
revoke all on function public.ayyam_migration_complete_v2() from public, anon, authenticated;
grant execute on function public.ayyam_migration_begin_v2()    to authenticated;
grant execute on function public.ayyam_migration_complete_v2() to authenticated;
