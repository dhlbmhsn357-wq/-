// Stage B — Private Goals Pilot: server-side allowlist (ayyam_goals_pilot) + ayyam_goals_enabled RPC + the
// ayyam_commit_v2 write-guard. Only an allow-listed account may write a goal:* register; everyone else is
// unaffected and cannot start writing goals even by calling the RPC directly.
// NOTE: Goals later went GA (migration 20261009000100) which removes this pilot write-guard. These tests
// therefore pin the schema to the pilot migration era (upTo) so they keep validating the pilot gate as it
// existed; the GA end-state is covered by goals-ga.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb as freshDbAll, createUser, asUser } from './helpers.mjs';

const PILOT_ERA = '20261006000200';
const freshDb = () => freshDbAll({ upTo: PILOT_ERA });

const goalData = { v: 2, epoch: 0, reg: { 'p:theme': { val: 'night', t: 1, by: '' }, 'goal:g1': { val: { id: 'g1', title: 'هدف' }, t: 1, by: '' } }, tomb: {} };
const plainData = { v: 2, epoch: 0, reg: { 'p:theme': { val: 'night', t: 1, by: '' } }, tomb: {} };

async function addPilot(db, uid) {
  await db.query('set role service_role');
  try { await db.query('insert into public.ayyam_goals_pilot (user_id) values ($1) on conflict do nothing', [uid]); }
  finally { await db.exec('reset role'); }
}
const enabled = async (db, uid) => (await asUser(db, uid, 'select public.ayyam_goals_enabled() as r')).rows[0].r;
const commit = async (db, uid, data, { expected = 0, ws = 3 } = {}) =>
  (await asUser(db, uid, 'select public.ayyam_commit_v2($1,$2::jsonb,$3::uuid,$4,$5) as r',
    [expected, JSON.stringify(data), randomUUID(), 'sync', ws])).rows[0].r;
const rowRev = async (db, uid) => { const r = await asUser(db, uid, 'select revision from public.ayyam_data where id=$1', ['u:' + uid]); return r.rows[0] ? r.rows[0].revision : null; };

test('ayyam_goals_enabled reflects the allowlist', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  assert.deepEqual(await enabled(db, uid), { enabled: false });
  await addPilot(db, uid);
  assert.deepEqual(await enabled(db, uid), { enabled: true });
});

test('a non-allowlisted account is REFUSED a goal: write (goals_not_enabled, nothing written)', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  const r = await commit(db, uid, goalData, { expected: 0 });
  assert.equal(r.status, 'goals_not_enabled');
  assert.equal(await rowRev(db, uid), null, 'no row was created by the refused write');
});

test('an allowlisted account CAN write goals', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  await addPilot(db, uid);
  const r = await commit(db, uid, goalData, { expected: 0 });
  assert.equal(r.status, 'ok');
  assert.equal(r.revision, 1);
});

test('a non-allowlisted account commits a NORMAL (no-goals) payload fine — unaffected', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  const r = await commit(db, uid, plainData, { expected: 0 });
  assert.equal(r.status, 'ok');
  assert.equal(r.revision, 1);
});

test('the guard also blocks ADDING a goal to an existing no-goals row for a non-pilot account', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  assert.equal((await commit(db, uid, plainData, { expected: 0 })).status, 'ok'); // rev1, no goals
  const r = await commit(db, uid, goalData, { expected: 1 });                     // tries to add a goal
  assert.equal(r.status, 'goals_not_enabled');
  assert.equal(await rowRev(db, uid), 1, 'revision unchanged by the refused write');
});

test('ayyam_goals_pilot RLS: a user can read only their OWN membership', async () => {
  const db = await freshDb(); const a = await createUser(db); const b = await createUser(db);
  await addPilot(db, a); // only A is enrolled
  const aSees = (await asUser(db, a, 'select count(*)::int c from public.ayyam_goals_pilot')).rows[0].c;
  const bSees = (await asUser(db, b, 'select count(*)::int c from public.ayyam_goals_pilot')).rows[0].c;
  assert.equal(aSees, 1, 'A sees its own membership');
  assert.equal(bSees, 0, 'B cannot see A’s membership (self-scoped RLS)');
});
