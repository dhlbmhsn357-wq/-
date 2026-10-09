// Goals V1 — General Availability (migration 20261009000100). With ALL migrations applied (the GA end-state):
//  - ayyam_goals_enabled returns {enabled:true} for ANY authenticated user (no allowlist needed).
//  - any authenticated account may write its own goal:* registers (pilot write-guard removed).
//  - the writer_schema gate is STILL enforced: a schema<3 writer cannot tombstone a row that holds goal:*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, createUser, asUser } from './helpers.mjs';

const goalData = { v: 2, epoch: 0, reg: { 'p:theme': { val: 'night', t: 1, by: '' }, 'goal:g1': { val: { id: 'g1', title: 'هدف' }, t: 1, by: '' } }, tomb: {} };
const plain = { v: 2, epoch: 0, reg: { 'p:theme': { val: 'night', t: 1, by: '' } }, tomb: {} };
const enabled = async (db, uid) => (await asUser(db, uid, 'select public.ayyam_goals_enabled() as r')).rows[0].r;
const commit = async (db, uid, data, { expected = 0, ws = 3 } = {}) =>
  (await asUser(db, uid, 'select public.ayyam_commit_v2($1,$2::jsonb,$3::uuid,$4,$5) as r',
    [expected, JSON.stringify(data), randomUUID(), 'sync', ws])).rows[0].r;
const rowRev = async (db, uid) => { const r = await asUser(db, uid, 'select revision, data from public.ayyam_data where id=$1', ['u:' + uid]); return r.rows[0] || null; };

test('GA: ayyam_goals_enabled is true for any authenticated user (no allowlist membership needed)', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  assert.deepEqual(await enabled(db, uid), { enabled: true });
});

test('GA: a normal (non-allowlisted) account CAN create a goal', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  const r = await commit(db, uid, goalData, { expected: 0 });
  assert.equal(r.status, 'ok');
  assert.equal(r.revision, 1);
  assert.ok((await rowRev(db, uid)).data.reg['goal:g1'], 'goal register persisted');
});

test('GA: writer_schema gate STILL blocks a schema<3 writer from tombstoning a goal row', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  assert.equal((await commit(db, uid, goalData, { expected: 0, ws: 3 })).status, 'ok'); // rev1 has a goal
  const r = await commit(db, uid, plain, { expected: 1, ws: 2 });                       // old client tries to save
  assert.equal(r.status, 'client_too_old');
  assert.ok((await rowRev(db, uid)).data.reg['goal:g1'], 'the goal survived the rejected under-capable write');
});

test('GA: a normal account still commits a no-goals payload fine', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  assert.equal((await commit(db, uid, plain, { expected: 0 })).status, 'ok');
});
