import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, setKey, asAnon, asUser, createUser, rpc, rpc2, bundle, activeLog, DEVICE_KEY } from './helpers.mjs';

// P1 = strictly additive/dormant. These tests are the BLOCKING gates for the auth foundation.

// ---------------------------------------------------------------- LEGACY compatibility (must not regress)
test('legacy v1.1.2 client keeps working after P1: pull + commit on id=main via device key/anon', async () => {
  const db = await freshDb(); await setKey(db);
  assert.equal((await rpc.pull(db)).exists, false);
  const c = await rpc.commit(db, { expected: 0, data: bundle(activeLog('a')), reason: 'init' });
  assert.equal(c.status, 'ok'); assert.equal(c.revision, 1);
  const p = await rpc.pull(db);
  assert.equal(p.exists, true); assert.equal(p.revision, 1);
  // a second commit at the right revision still works (unchanged CAS behaviour)
  const c2 = await rpc.commit(db, { expected: 1, data: bundle(activeLog('b')), reason: 'sync' });
  assert.equal(c2.status, 'ok'); assert.equal(c2.revision, 2);
});

test('legacy RPCs are hard-scoped to id=main and can NEVER touch a user row', async () => {
  const db = await freshDb(); await setKey(db);
  const A = await createUser(db, 'a@t.test');
  // A writes their own row via v2
  await rpc2.commit(db, A, { expected: 0, data: bundle({ '2026-01-01': activeLog('x') }, { marker: 'A' }), reason: 'init' });
  // legacy pull (device key/anon) sees only 'main' (which does not exist yet) — never A's row
  const p = await rpc.pull(db);
  assert.equal(p.exists, false);                       // A's row is invisible to the legacy path
  const rowCount = (await asAnon(db, "select count(*)::int n from public.ayyam_data where id <> 'main'")).rows[0].n;
  assert.equal(rowCount, 0);                           // anon cannot even SELECT the user row directly (RLS)
  // legacy commit only ever creates/updates 'main' — A's row stays exactly as A wrote it
  await rpc.commit(db, { expected: 0, data: bundle({ '2026-01-01': activeLog('m') }, { marker: 'M' }), reason: 'init' });
  const aRow = (await db.query("select data from public.ayyam_data where id = 'u:' || $1::text", [A])).rows[0];
  assert.equal(aRow.data.marker, 'A', "A's data untouched by the legacy commit");
  const mainRow = (await db.query("select data from public.ayyam_data where id = 'main'")).rows[0];
  assert.equal(mainRow.data.marker, 'M', "legacy commit landed on 'main'");
});

// ---------------------------------------------------------------- cross-user isolation (A cannot touch B)
test('A/B isolation: neither v2 RPCs nor direct table access leak across users', async () => {
  const db = await freshDb();
  const A = await createUser(db, 'a@t.test'), B = await createUser(db, 'b@t.test');
  await rpc2.commit(db, A, { expected: 0, data: bundle({}, { marker: 'A' }), reason: 'init' });
  await rpc2.commit(db, B, { expected: 0, data: bundle({}, { marker: 'B' }), reason: 'init' });
  // B pulling gets ONLY B's data
  const pB = await rpc2.pull(db, B);
  assert.equal(pB.data.marker, 'B');
  // B cannot read A's row directly (RLS user_id = auth.uid())
  const seen = (await asUser(db, B, 'select count(*)::int n from public.ayyam_data where user_id = $1', [A])).rows[0].n;
  assert.equal(seen, 0);
  // B cannot UPDATE A's row directly
  const upd = (await asUser(db, B, "update public.ayyam_data set data = '{}'::jsonb where user_id = $1 returning id", [A])).rows.length;
  assert.equal(upd, 0);
  // B cannot DELETE A's row directly
  const del = (await asUser(db, B, 'delete from public.ayyam_data where user_id = $1 returning id', [A])).rows.length;
  assert.equal(del, 0);
  // B cannot INSERT a row owned by A (check constraint id='u:'||auth.uid() + user_id=auth.uid())
  await assert.rejects(asUser(db, B, "insert into public.ayyam_data (id, user_id, data) values ('u:' || $1::text, $1, '{}'::jsonb)", [A]));
  // A's data is intact
  assert.equal((await rpc2.pull(db, A)).data.marker, 'A');
});

test('a SECURITY DEFINER RPC derives identity from auth.uid() only — cannot be aimed at another user', async () => {
  const db = await freshDb();
  const A = await createUser(db, 'a@t.test'), B = await createUser(db, 'b@t.test');
  await rpc2.commit(db, A, { expected: 0, data: bundle(activeLog('a')), reason: 'init' });
  const snaps = await rpc2.listSnapshots(db, A); // A has no snapshots yet (init only) → []
  // B restoring A's snapshot id is impossible: restore_v2 filters by user_id = auth.uid()
  const r = await rpc2.restore(db, B, { snapshotId: 999999, expected: 0 });
  assert.equal(r.status, 'not_found');
  // B's list is independent of A
  assert.deepEqual(await rpc2.listSnapshots(db, B), { status: 'ok', snapshots: [] });
});

test('anon (device-key path) cannot read user rows or user snapshots directly', async () => {
  const db = await freshDb();
  const A = await createUser(db, 'a@t.test');
  await rpc2.commit(db, A, { expected: 0, data: bundle(activeLog('x')), reason: 'init' });
  await rpc2.commit(db, A, { expected: 1, data: bundle(activeLog('y')), reason: 'sync' }); // makes a snapshot
  const rows = (await asAnon(db, 'select count(*)::int n from public.ayyam_data')).rows[0].n; // only 'main' visible (0 here)
  assert.equal(rows, 0);
  await assert.rejects(asAnon(db, 'select count(*) from public.ayyam_snapshots')); // snapshots revoked from anon
});

// ---------------------------------------------------------------- admin escalation (must fail)
test('a normal user cannot promote themselves to admin', async () => {
  const db = await freshDb();
  const A = await createUser(db, 'a@t.test');
  assert.equal((await asUser(db, A, 'select public.is_admin() a')).rows[0].a, false);
  await assert.rejects(asUser(db, A, "insert into public.user_roles (user_id, role) values ($1, 'admin')", [A]));
  await assert.rejects(asUser(db, A, "update public.user_roles set role = 'admin' where user_id = $1", [A]));
  assert.equal((await asUser(db, A, 'select public.is_admin() a')).rows[0].a, false);
  // granted only via service_role / SQL editor:
  await db.query("insert into public.user_roles (user_id, role) values ($1, 'admin')", [A]);
  assert.equal((await asUser(db, A, 'select public.is_admin() a')).rows[0].a, true);
});

// ---------------------------------------------------------------- migration/security state not user-editable
test('server-controlled account/migration state is not user-writable (and not in profiles)', async () => {
  const db = await freshDb();
  const A = await createUser(db, 'a@t.test');
  // profiles has NO privileged columns
  const pcols = (await db.query("select column_name from information_schema.columns where table_name='profiles'")).rows.map((r) => r.column_name);
  assert.ok(!pcols.includes('role') && !pcols.includes('migration_status') && !pcols.includes('migrated_from_legacy_at'));
  // user cannot write user_account_state
  await assert.rejects(asUser(db, A, "insert into public.user_account_state (user_id, migration_status) values ($1, 'completed')", [A]));
  await assert.rejects(asUser(db, A, "update public.user_account_state set migration_status='completed' where user_id=$1", [A]));
  // user CAN read their (default) state via the definer RPC
  assert.equal((await rpc2.accountState(db, A)).migration_status, 'none');
});

// ---------------------------------------------------------------- claim state machine (dormant but complete)
test('claim is exclusive + one-time: a second account cannot claim already-claimed legacy data', async () => {
  const db = await freshDb(); await setKey(db);
  // owner seeds the legacy 'main' row (as the current app would)
  await rpc.commit(db, { expected: 0, data: bundle({ '2026-01-01': activeLog('legacy') }, { marker: 'L' }), reason: 'init' });
  const A = await createUser(db, 'a@t.test'), B = await createUser(db, 'b@t.test');
  const c1 = await rpc2.claim(db, A, DEVICE_KEY);
  assert.equal(c1.status, 'ok'); assert.equal(c1.legacy.exists, true); assert.equal(c1.legacy.data.marker, 'L');
  // A claiming again is idempotent
  assert.equal((await rpc2.claim(db, A, DEVICE_KEY)).status, 'ok');
  // B — even WITH the real device key — cannot claim it now
  assert.equal((await rpc2.claim(db, B, DEVICE_KEY)).status, 'already_claimed');
  // recorded server-side
  const rec = (await db.query('select claimed_by from public.ayyam_legacy_claim where row_id=$1', ['main'])).rows[0];
  assert.equal(rec.claimed_by, A);
});

test('freeze requires the claimant; a stolen/old device key cannot claim or freeze after claim', async () => {
  const db = await freshDb(); await setKey(db);
  await rpc.commit(db, { expected: 0, data: bundle(activeLog('legacy')), reason: 'init' });
  const A = await createUser(db, 'a@t.test'), B = await createUser(db, 'b@t.test');
  await rpc2.claim(db, A, DEVICE_KEY);
  assert.equal((await rpc2.freeze(db, B, DEVICE_KEY)).status, 'not_claimant'); // B holds the key but is not claimant
  assert.equal((await rpc2.freeze(db, A, DEVICE_KEY)).status, 'ok');
  assert.equal((await db.query('select frozen from public.ayyam_legacy_claim where row_id=$1', ['main'])).rows[0].frozen, true);
  // an unauthenticated caller (anon / device key only, no JWT) cannot even CALL claim (no grant to anon)
  await assert.rejects(asAnon(db, 'select public.ayyam_claim($1) r', [DEVICE_KEY]), /permission denied/);
});

// ---------------------------------------------------------------- v2 engine parity (CAS still deterministic)
test('v2 commit keeps CAS + op_id idempotency, per user', async () => {
  const db = await freshDb();
  const A = await createUser(db, 'a@t.test');
  const op = randomUUID();
  const c1 = await rpc2.commit(db, A, { expected: 0, data: bundle(activeLog('a')), opId: op, reason: 'init' });
  assert.equal(c1.status, 'ok');
  const dup = await rpc2.commit(db, A, { expected: 0, data: bundle(activeLog('a')), opId: op, reason: 'init' });
  assert.equal(dup.status, 'duplicate');               // same op replayed → idempotent
  const conflict = await rpc2.commit(db, A, { expected: 0, data: bundle(activeLog('c')), reason: 'sync' });
  assert.equal(conflict.status, 'conflict');           // stale expected revision → conflict
});
