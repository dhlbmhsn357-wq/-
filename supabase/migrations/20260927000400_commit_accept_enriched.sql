-- Fix: ayyam_commit's payload validation (from 000200) only accepted the v1 "materialized" shape
-- ({template, logs, ...}). The v2 client stores the CONFLICT-MODEL "enriched" shape ({v, epoch, reg,
-- tomb}). Accept BOTH so real v2 syncs are not rejected as 'invalid'. CREATE OR REPLACE = idempotent,
-- additive; behaviour is otherwise identical to 000200. (Caught by the Phase 6 real-backend E2E.)
create or replace function public.ayyam_commit(
  p_key text, p_expected_revision bigint, p_data jsonb, p_op_id uuid, p_reason text default 'sync'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r         public.ayyam_data%rowtype;
  prev      public.ayyam_ops%rowtype;
  new_rev   bigint;
  new_epoch integer;
begin
  if not public.ayyam_key_ok(p_key) then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if p_op_id is null or p_expected_revision is null or p_expected_revision < 0
     or p_reason is null or p_reason not in ('sync', 'init', 'reset', 'import', 'restore')
     or p_data is null or jsonb_typeof(p_data) <> 'object'
     or not (
          (p_data ? 'reg' and jsonb_typeof(p_data->'reg') = 'object')  -- v2 enriched
          or (p_data ? 'template' and p_data ? 'logs'
              and jsonb_typeof(p_data->'template') = 'object' and jsonb_typeof(p_data->'logs') = 'object') -- v1 materialized
        ) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if octet_length(p_data::text) > 2000000 then
    return jsonb_build_object('status', 'too_large');
  end if;

  select * into r from public.ayyam_data where id = 'main' for update;

  select * into prev from public.ayyam_ops where op_id = p_op_id;
  if found then
    return jsonb_build_object('status', 'duplicate', 'revision', prev.revision,
                              'current_revision', coalesce(r.revision, 0), 'epoch', coalesce(r.epoch, 0));
  end if;

  perform set_config('ayyam.via_commit', 'on', true);

  if r.id is null then
    if p_expected_revision <> 0 then
      return jsonb_build_object('status', 'conflict', 'exists', false, 'revision', 0, 'epoch', 0);
    end if;
    begin
      insert into public.ayyam_data (id, data, revision, epoch, updated_at, last_op_id)
        values ('main', p_data, 1, 0, now(), p_op_id);
    exception when unique_violation then
      select * into r from public.ayyam_data where id = 'main';
      return jsonb_build_object('status', 'conflict', 'exists', true, 'revision', r.revision, 'epoch', r.epoch,
                                'updated_at', r.updated_at, 'data', r.data);
    end;
    insert into public.ayyam_ops (op_id, row_id, revision) values (p_op_id, 'main', 1);
    return jsonb_build_object('status', 'ok', 'revision', 1, 'epoch', 0);
  end if;

  if r.revision <> p_expected_revision then
    return jsonb_build_object('status', 'conflict', 'exists', true, 'revision', r.revision, 'epoch', r.epoch,
                              'updated_at', r.updated_at, 'data', r.data);
  end if;

  insert into public.ayyam_snapshots (row_id, revision, epoch, data, reason)
    values (r.id, r.revision, r.epoch, r.data, 'before:' || p_reason);

  new_rev   := r.revision + 1;
  -- Epoch is monotonic and DATA-DRIVEN: the client's enriched carries its own generation, so a reset/
  -- import bump survives even if the reason on the winning commit is 'sync' (a racing background sync).
  new_epoch := greatest(
    r.epoch + case when p_reason in ('reset', 'import', 'restore') then 1 else 0 end,
    coalesce((p_data->>'epoch')::int, 0)
  );
  update public.ayyam_data
     set data = p_data, revision = new_rev, epoch = new_epoch, updated_at = now(), last_op_id = p_op_id
   where id = 'main';
  insert into public.ayyam_ops (op_id, row_id, revision) values (p_op_id, 'main', new_rev);
  perform public.ayyam_prune();
  return jsonb_build_object('status', 'ok', 'revision', new_rev, 'epoch', new_epoch);
end $$;

revoke all on function public.ayyam_commit(text, bigint, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.ayyam_commit(text, bigint, jsonb, uuid, text) to anon;
