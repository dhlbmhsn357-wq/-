-- Stage B — Private Goals Pilot. A server-side allowlist so goals_v1 is visible AND writable ONLY for an
-- authorized account (the owner, for the pilot). No feature-flag platform. Other users are entirely unaffected:
-- their normal payloads carry no goal:* register, so nothing changes for them, and a non-authorized account
-- cannot start writing goals even by calling the API directly.

-- (1) the allowlist. Membership is managed by service_role / SQL only; a client can at most read its OWN row.
create table if not exists public.ayyam_goals_pilot (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.ayyam_goals_pilot enable row level security;
drop policy if exists "goals_pilot self select" on public.ayyam_goals_pilot;
create policy "goals_pilot self select" on public.ayyam_goals_pilot for select to authenticated using (user_id = auth.uid());
revoke all on public.ayyam_goals_pilot from public, anon, authenticated;
grant select on public.ayyam_goals_pilot to authenticated;

-- (2) is the current user authorized for the goals pilot? (client reads this after auth to decide whether to show Goals)
create or replace function public.ayyam_goals_enabled() returns jsonb
  language sql security definer set search_path to '' stable as $$
  select jsonb_build_object('enabled', exists(select 1 from public.ayyam_goals_pilot where user_id = auth.uid()));
$$;
revoke all on function public.ayyam_goals_enabled() from public, anon;
grant execute on function public.ayyam_goals_enabled() to authenticated;

-- (3) ayyam_commit_v2 gains the PILOT WRITE GUARD (keeps the writer_schema gate). A commit whose payload CONTAINS
-- a goal:* register is refused unless the caller is on the allowlist — this is the backend enforcement the UI
-- flag can never substitute for. Rows without goal:* (every non-pilot user) are never affected.
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

  select * into prev from public.ayyam_ops where op_id = p_op_id and user_id = uid;
  if found then
    return jsonb_build_object('status','duplicate','revision',prev.revision,
      'current_revision',coalesce(r.revision,0),'epoch',coalesce(r.epoch,0));
  end if;

  -- writer_schema gate: refuse an under-capable writer when the stored row already holds a live goal:* register.
  if coalesce(p_writer_schema, 2) < 3
     and r.id is not null and r.data ? 'reg'
     and exists (select 1 from jsonb_object_keys(r.data->'reg') k where k like 'goal:%') then
    return jsonb_build_object('status','client_too_old','revision',r.revision,'epoch',r.epoch);
  end if;

  -- GOALS PILOT GUARD: only an allow-listed account may commit a payload that CONTAINS a goal:* register.
  -- No revision change, no snapshot, no write.
  if p_data ? 'reg' and exists (select 1 from jsonb_object_keys(p_data->'reg') k where k like 'goal:%')
     and not exists (select 1 from public.ayyam_goals_pilot gp where gp.user_id = uid) then
    return jsonb_build_object('status','goals_not_enabled','revision',coalesce(r.revision,0),'epoch',coalesce(r.epoch,0));
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
