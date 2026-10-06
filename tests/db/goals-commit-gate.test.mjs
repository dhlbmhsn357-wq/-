// Goals launch gate — ayyam_commit_v2 refuses an under-capable writer (schema < 3) when the stored row already
// holds a live goal:* register, so a pre-Goals client can never tombstone goal records. Rows without goals are
// unaffected. The old 4-arg signature still works (resolves to the new function with p_writer_schema default 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, createUser, asUser, rpc2 } from './helpers.mjs';

const enriched = (reg) => ({ v: 2, epoch: 0, reg, tomb: {} });
const PLAIN = { 'p:theme': { val: 'night', t: 1, by: '' } };
const WITH_GOAL = {
  'p:theme': { val: 'night', t: 1, by: '' },
  'goal:g1': { val: { id: 'g1', title: 'هدف', period_type: 'weekly', measurement_type: 'count', target_value: 12, current_value: 0, status: 'not_started' }, t: 1, by: '' },
};

// new writer (5-arg, declares its schema). old writer = the existing 4-arg rpc2.commit (server default = 2).
async function commitAs(db, uid, { expected, data, opId = randomUUID(), reason = 'sync', writerSchema }) {
  if (writerSchema === undefined) return rpc2.commit(db, uid, { expected, data, opId, reason }); // 4-arg = old client
  return (await asUser(db, uid, 'select public.ayyam_commit_v2($1,$2::jsonb,$3::uuid,$4,$5) as r',
    [expected, JSON.stringify(data), opId, reason, writerSchema])).rows[0].r;
}
const rowOf = async (db, uid) => (await asUser(db, uid, 'select revision, data from public.ayyam_data where id = $1', ['u:' + uid])).rows[0];

test('1+8. OLD writer (4-arg signature) + no goals on the row → commit succeeds', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  const r = await commitAs(db, uid, { expected: 0, data: enriched(PLAIN) }); // 4-arg → server default schema 2
  assert.equal(r.status, 'ok');
  assert.equal(r.revision, 1);
});

test('2. NEW writer (schema 3) + no goals → commit succeeds', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  const r = await commitAs(db, uid, { expected: 0, data: enriched(PLAIN), writerSchema: 3 });
  assert.equal(r.status, 'ok');
  assert.equal(r.revision, 1);
});

test('3+5. OLD writer + the row already holds a goal → rejected (client_too_old), revision/data unchanged', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  const created = await commitAs(db, uid, { expected: 0, data: enriched(WITH_GOAL), writerSchema: 3 }); // goals client creates the goal
  assert.equal(created.status, 'ok'); assert.equal(created.revision, 1);

  const before = await rowOf(db, uid);
  const r = await commitAs(db, uid, { expected: 1, data: enriched(PLAIN) }); // old client tries to save (would tombstone goal:g1)
  assert.equal(r.status, 'client_too_old');
  assert.equal(r.revision, 1, 'rejection reports the unchanged revision');

  const after = await rowOf(db, uid);
  assert.equal(after.revision, 1, 'revision NOT advanced by a rejected write');
  assert.deepEqual(after.data, before.data, 'row data left exactly as it was (goal:g1 intact, no tombstone)');
  assert.ok(after.data.reg['goal:g1'], 'the goal register survived');
});

test('4. NEW writer (schema 3) + existing goal → commit succeeds', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  await commitAs(db, uid, { expected: 0, data: enriched(WITH_GOAL), writerSchema: 3 });
  const r = await commitAs(db, uid, { expected: 1, data: enriched({ ...WITH_GOAL, 'goal:g1': { val: { id: 'g1', title: 'هدف', period_type: 'weekly', measurement_type: 'count', target_value: 12, current_value: 5, status: 'on_track' }, t: 2, by: 'dev' } }), writerSchema: 3 });
  assert.equal(r.status, 'ok');
  assert.equal(r.revision, 2);
});

test('6. idempotency/retries: a duplicate op is replayed safely; a rejected op leaves no state', async () => {
  const db = await freshDb(); const uid = await createUser(db);
  await commitAs(db, uid, { expected: 0, data: enriched(WITH_GOAL), writerSchema: 3 }); // rev1, has goal

  // new writer applies op X once → ok; retry op X → duplicate (NOT applied twice)
  const opX = randomUUID();
  const first = await commitAs(db, uid, { expected: 1, data: enriched(WITH_GOAL), opId: opX, writerSchema: 3 });
  assert.equal(first.status, 'ok'); assert.equal(first.revision, 2);
  const retry = await commitAs(db, uid, { expected: 1, data: enriched(WITH_GOAL), opId: opX, writerSchema: 3 });
  assert.equal(retry.status, 'duplicate'); assert.equal(retry.revision, 2);
  assert.equal((await rowOf(db, uid)).revision, 2, 'duplicate did not advance revision');

  // old writer rejected op Y → client_too_old; retry op Y → still rejected, no ops row, no state change
  const opY = randomUUID();
  const rej1 = await commitAs(db, uid, { expected: 2, data: enriched(PLAIN), opId: opY });
  assert.equal(rej1.status, 'client_too_old');
  const rej2 = await commitAs(db, uid, { expected: 2, data: enriched(PLAIN), opId: opY });
  assert.equal(rej2.status, 'client_too_old', 'a rejected op is not recorded, so a retry is rejected the same way');
  assert.equal((await rowOf(db, uid)).revision, 2, 'no revision change across rejected retries');
});
