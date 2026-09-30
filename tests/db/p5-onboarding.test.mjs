// P5 — onboarding completion + resume: blocking correctness/security.
// Proves: completion is REAL server state (not inferred), step is monotonic/resumable, completion (finish or
// skip) is marked exactly ONCE and records the event once (replay-safe), per-user, and denied to anon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, createUser, asAnon, rpc2 } from './helpers.mjs';

async function eventCount(db, uid, name) {
  return (await db.query('select count(*)::int c from public.ayyam_events where user_id=$1 and name=$2', [uid, name])).rows[0].c;
}

test('a fresh user is not onboarded and starts at step 0', async () => {
  const db = await freshDb();
  const a = await createUser(db, 'a@t.test');
  const s = await rpc2.onbGet(db, a);
  assert.equal(s.status, 'ok');
  assert.equal(s.step, 0);
  assert.equal(s.completed, false);
});

test('step is monotonic (resume never regresses) and persists across reads', async () => {
  const db = await freshDb();
  const a = await createUser(db, 'a@t.test');
  await rpc2.onbProgress(db, a, { step: 3 });
  assert.equal((await rpc2.onbGet(db, a)).step, 3);
  await rpc2.onbProgress(db, a, { step: 1 });          // going back must NOT lower the saved resume point
  assert.equal((await rpc2.onbGet(db, a)).step, 3);
  await rpc2.onbProgress(db, a, { step: 5 });
  assert.equal((await rpc2.onbGet(db, a)).step, 5);
});

test('completion is real server state and the event is recorded exactly once (replay-safe)', async () => {
  const db = await freshDb();
  const a = await createUser(db, 'a@t.test');
  assert.equal((await rpc2.onbGet(db, a)).completed, false);
  const r = await rpc2.onbProgress(db, a, { step: 7, done: true, via: 'finished' });
  assert.equal(r.completed, true);
  assert.equal((await rpc2.onbGet(db, a)).completed, true);
  assert.equal(await eventCount(db, a, 'onboarding_completed'), 1);
  // a Settings "replay" that finishes again must NOT double-count or change the flag
  await rpc2.onbProgress(db, a, { step: 7, done: true, via: 'finished' });
  await rpc2.onbProgress(db, a, { step: 7, done: true, via: 'skipped' });
  assert.equal(await eventCount(db, a, 'onboarding_completed'), 1);
  assert.equal((await rpc2.onbGet(db, a)).completed, true);
});

test('skipping also completes onboarding (real end)', async () => {
  const db = await freshDb();
  const a = await createUser(db, 'a@t.test');
  const r = await rpc2.onbProgress(db, a, { step: 2, done: true, via: 'skipped' });
  assert.equal(r.completed, true);
  assert.equal(await eventCount(db, a, 'onboarding_completed'), 1);
});

test('onboarding state is per-user; anon cannot read or advance it', async () => {
  const db = await freshDb();
  const a = await createUser(db, 'a@t.test');
  const b = await createUser(db, 'b@t.test');
  await rpc2.onbProgress(db, a, { step: 4, done: true, via: 'finished' });
  assert.equal((await rpc2.onbGet(db, b)).completed, false);   // B unaffected by A
  assert.equal((await rpc2.onbGet(db, b)).step, 0);
  await assert.rejects(asAnon(db, 'select public.ayyam_onboarding_get()'), /permission denied/);
  await assert.rejects(asAnon(db, 'select public.ayyam_onboarding_progress(1, false, null)'), /permission denied/);
});
