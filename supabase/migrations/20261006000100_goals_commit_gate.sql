-- Goals launch gate (Phase 1) — minimum-writer-schema check in ayyam_commit_v2.
--
-- A pre-Goals client has no unknown-key preservation: if it pulls a row containing goal:* registers and then
-- saves, its diff TOMBSTONES those keys and this RPC would accept the destructive write. To prevent that, the
-- commit now takes an additive trailing param p_writer_schema (default 2). A client that is Goals-safe (it
-- preserves unknown register families) passes 3. When the STORED row already holds a live goal:* register and
-- the writer declares < 3, the commit is REFUSED with status 'client_too_old' — no revision change, no
-- snapshot, no write (the row is left exactly as it was). Rows WITHOUT goals are unaffected, so old clients
-- keep working normally until Goals data exists on their row.
--
-- We replace the 4-arg function with a 5-arg one so there is NO gate-less overload left behind: an old client
-- still calls the 4-arg form, which resolves to this function with p_writer_schema defaulting to 2 — i.e. it is
-- gated too. data.v is NOT bumped (an old client must keep reading the row), and ayyam_pull_v2 is unchanged.

-- Idempotent: drop BOTH the original 4-arg signature (first run) and this migration's own 5-arg signature
-- (re-runs), so applying the migration twice is a no-op rather than an "already exists" error.
drop function if exists public.ayyam_commit_v2(bigint, jsonb, uuid, text);
drop function if exists public.ayyam_commit_v2(bigint, jsonb, uuid, text, int);

create function public.ayyam_commit_v2(
  p_expected_revision bigint,
  p_data jsonb,
  p_op_id uuid,
  p_reason text default 'sync',
  p_writer_schema int default 2
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare r public.ayyam_data%rowtype; prev public.ayyam_ops%rowtype; uid uuid; rid text; new_rev bigint; new_epoch integer;
begin
  uid := auth.uid();
  if uid is null then return jsonb_build_object('status','unauthorized'); end if;
  rid := 'u:' || uid::text;
  if p_op_id is null or p_expected_revision is null or p_expected_revision < 0
     or p_reason is null or p_reason not in ('sync','init','reset','import','restore')
     or p_data is null or jsonb_typeof(p_data) <> 'object'
     or not ((p_data ? 'reg' and jsonb_typeof(p_data->'reg') = 'object')
             or (p_data ? 'template' and p_data ? 'logs'
                 and jsonb_typeof(p_data->'template') = 'object' and jsonb_typeof(p_data->'logs') = 'object')) then
    return jsonb_build_object('status','invalid');
  end if;
  if octet_length(p_data::text) > 2000000 then return jsonb_build_object('status','too_large'); end if;

  select * into r from public.ayyam_data where id = rid for update;

  -- Idempotency check comes BEFORE the gate: a duplicate op_id is a harmless replay, answered normally.
  select * into prev from public.ayyam_ops where op_id = p_op_id and user_id = uid;
  if found then
    return jsonb_build_object('status','duplicate','revision',prev.revision,
      'current_revision',coalesce(r.revision,0),'epoch',coalesce(r.epoch,0));
  end if;

  -- GOALS GATE: refuse an under-capable writer when the stored row already holds a live goal:* register.
  -- Returns BEFORE any snapshot/update — revision and data are untouched.
  if coalesce(p_writer_schema, 2) < 3
     and r.id is not null and r.data ? 'reg'
     and exists (select 1 from jsonb_object_keys(r.data->'reg') k where k like 'goal:%') then
    return jsonb_build_object('status','client_too_old','revision',r.revision,'epoch',r.epoch);
  end if;

  perform set_config('ayyam.via_commit','on',true);

  if r.id is null then
    if p_expected_revision <> 0 then return jsonb_build_object('status','conflict','exists',false,'revision',0,'epoch',0); end if;
    begin
      insert into public.ayyam_data (id, user_id, data, revision, epoch, updated_at, last_op_id)
        values (rid, uid, p_data, 1, 0, now(), p_op_id);
    exception when unique_violation then
      select * into r from public.ayyam_data where id = rid;
      return jsonb_build_object('status','conflict','exists',true,'revision',r.revision,'epoch',r.epoch,
                                'updated_at',r.updated_at,'data',r.data);
    end;
    insert into public.ayyam_ops (op_id, row_id, revision, user_id) values (p_op_id, rid, 1, uid);
    return jsonb_build_object('status','ok','revision',1,'epoch',0);
  end if;

  if r.revision <> p_expected_revision then
    return jsonb_build_object('status','conflict','exists',true,'revision',r.revision,'epoch',r.epoch,
                              'updated_at',r.updated_at,'data',r.data);
  end if;

  insert into public.ayyam_snapshots (row_id, revision, epoch, data, reason, user_id)
    values (rid, r.revision, r.epoch, r.data, 'before:' || p_reason, uid);

  new_rev   := r.revision + 1;
  new_epoch := greatest(r.epoch + case when p_reason in ('reset','import','restore') then 1 else 0 end,
                        coalesce((p_data->>'epoch')::int, 0));
  update public.ayyam_data set data = p_data, revision = new_rev, epoch = new_epoch, updated_at = now(), last_op_id = p_op_id
    where id = rid;
  insert into public.ayyam_ops (op_id, row_id, revision, user_id) values (p_op_id, rid, new_rev, uid);
  return jsonb_build_object('status','ok','revision',new_rev,'epoch',new_epoch);
end $function$;

revoke all on function public.ayyam_commit_v2(bigint, jsonb, uuid, text, int) from public, anon, authenticated;
grant execute on function public.ayyam_commit_v2(bigint, jsonb, uuid, text, int) to authenticated;
