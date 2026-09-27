import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, asAnon, setKey, rpc, bundle, activeLog } from './helpers.mjs';

async function dbWithRow(data = bundle({ '2026-09-01': activeLog('seed') })) {
  const db = await freshDb();
  await setKey(db);
  const r = await rpc.commit(db, { expected: 0, data, reason: 'init' });
  assert.equal(r.status, 'ok');
  return db;
}

test('wrong or missing key is rejected', async () => {
  const db = await dbWithRow();
  for (const key of ['wrong-key-wrong-key-wrong', '', null, 'short']) {
    assert.equal((await rpc.pull(db, key)).status, 'unauthorized');
    assert.equal((await rpc.commit(db, { key, expected: 1, data: bundle() })).status, 'unauthorized');
  }
  assert.equal((await rpc.pull(db)).status, 'ok');
});

test('pull returns data, revision and epoch', async () => {
  const db = await dbWithRow();
  const p = await rpc.pull(db);
  assert.equal(p.exists, true);
  assert.equal(p.revision, 1);
  assert.equal(p.epoch, 0);
  assert.deepEqual(Object.keys(p.data.logs), ['2026-09-01']);
});

test('pull on an empty server says exists=false (distinguishable from unreachable)', async () => {
  const db = await freshDb();
  await setKey(db);
  assert.deepEqual(await rpc.pull(db), { status: 'ok', exists: false, revision: 0, epoch: 0 });
});

test('commit with the current revision succeeds, bumps revision and snapshots the old data', async () => {
  const db = await dbWithRow();
  const next = bundle({ '2026-09-01': activeLog('seed'), '2026-09-02': activeLog('b') });
  const r = await rpc.commit(db, { expected: 1, data: next });
  assert.deepEqual(r, { status: 'ok', revision: 2, epoch: 0 });
  assert.deepEqual((await rpc.pull(db)).data, next);
  const snaps = (await db.query(`select revision, reason from public.ayyam_snapshots order by id`)).rows;
  assert.deepEqual(snaps.map((s) => [Number(s.revision), s.reason]), [[1, 'before:sync']]);
});

test('LOST UPDATE prevented: two devices from the same revision → second gets conflict, then merges', async () => {
  const db = await dbWithRow();
  const A = await rpc.pull(db); // both read revision 1
  const B = await rpc.pull(db);
  const aData = { ...A.data, logs: { ...A.data.logs, '2026-09-10': activeLog('fromA') } };
  const bData = { ...B.data, logs: { ...B.data.logs, '2026-09-11': activeLog('fromB') } };

  assert.equal((await rpc.commit(db, { expected: A.revision, data: aData })).status, 'ok');
  const bTry = await rpc.commit(db, { expected: B.revision, data: bData });
  assert.equal(bTry.status, 'conflict');               // B's stale write is REFUSED, not applied
  assert.equal(bTry.revision, 2);
  assert.deepEqual(bTry.data, aData);                  // and B receives A's version to merge with

  // B merges (union of logs here — the client's merge3 does this) and retries on the new revision
  const merged = { ...bData, logs: { ...bTry.data.logs, ...bData.logs } };
  assert.equal((await rpc.commit(db, { expected: bTry.revision, data: merged })).status, 'ok');
  const final = await rpc.pull(db);
  assert.equal(final.revision, 3);
  assert.deepEqual(Object.keys(final.data.logs).sort(), ['2026-09-01', '2026-09-10', '2026-09-11']);
});

test('idempotent retry: same op_id is applied once (lost response / timeout)', async () => {
  const db = await dbWithRow();
  const opId = randomUUID();
  const data = bundle({ '2026-09-05': activeLog('c') });
  const first = await rpc.commit(db, { expected: 1, data, opId });
  assert.equal(first.status, 'ok');
  // network dropped the response; the client retries with the SAME op and the OLD expected revision
  const retry = await rpc.commit(db, { expected: 1, data, opId });
  assert.deepEqual(retry, { status: 'duplicate', revision: 2, current_revision: 2, epoch: 0 });
  assert.equal((await rpc.pull(db)).revision, 2);
  assert.equal((await db.query(`select count(*)::int as n from public.ayyam_snapshots`)).rows[0].n, 1);
});

test('a v1 direct write is seen by v2 as a concurrent change (conflict, not overwrite)', async () => {
  const db = await dbWithRow();
  const v2 = await rpc.pull(db);
  const v1 = bundle({ '2026-09-20': activeLog('v1') });
  await asAnon(db, `update public.ayyam_data set data = $1 where id = 'main'`, [JSON.stringify(v1)]);
  const r = await rpc.commit(db, { expected: v2.revision, data: bundle({ '2026-09-21': activeLog('v2') }) });
  assert.equal(r.status, 'conflict');
  assert.deepEqual(r.data, v1);
});

test('invalid payloads are refused and change nothing', async () => {
  const db = await dbWithRow();
  const bad = [
    { expected: 1, data: [] },
    { expected: 1, data: { logs: {} } },                      // no template
    { expected: 1, data: { template: {}, logs: [] } },        // logs not an object
    { expected: 1, data: bundle(), reason: 'wipe' },          // unknown reason
    { expected: -1, data: bundle() },
  ];
  for (const b of bad) assert.equal((await rpc.commit(db, b)).status, 'invalid', JSON.stringify(b));
  const huge = bundle({}, { junk: 'x'.repeat(2_100_000) });
  assert.equal((await rpc.commit(db, { expected: 1, data: huge })).status, 'too_large');
  assert.equal((await rpc.pull(db)).revision, 1);
});

test('reset / import / restore bump the epoch; normal sync keeps it', async () => {
  const db = await dbWithRow();
  assert.equal((await rpc.commit(db, { expected: 1, data: bundle() })).epoch, 0);
  assert.equal((await rpc.commit(db, { expected: 2, data: bundle(), reason: 'reset' })).epoch, 1);
  assert.equal((await rpc.commit(db, { expected: 3, data: bundle(), reason: 'import' })).epoch, 2);
});

test('recovery: a reset can be undone from its snapshot, and the restore is itself undoable', async () => {
  const original = bundle({ '2026-08-18': activeLog('precious') });
  const db = await dbWithRow(original);
  await rpc.commit(db, { expected: 1, data: bundle(), reason: 'reset' });  // oops
  const list = await rpc.listSnapshots(db);
  assert.equal(list.status, 'ok');
  const beforeReset = list.snapshots.find((s) => s.reason === 'before:reset');
  assert.equal(beforeReset.log_days, 1);
  const res = await rpc.restore(db, { snapshotId: beforeReset.id, expected: 2 });
  assert.equal(res.status, 'ok');
  const now = await rpc.pull(db);
  assert.deepEqual(now.data, original);
  assert.equal(now.epoch, 2);
  assert.ok((await rpc.listSnapshots(db)).snapshots.some((s) => s.reason === 'before:restore'));
});

test('first commit on an empty server; a second device initialising at the same time gets conflict', async () => {
  const db = await freshDb();
  await setKey(db);
  assert.equal((await rpc.commit(db, { expected: 0, data: bundle(), reason: 'init' })).status, 'ok'); // fresh start allowed
  const second = await rpc.commit(db, { expected: 0, data: bundle({ '2026-09-01': activeLog() }), reason: 'init' });
  assert.equal(second.status, 'conflict');
  assert.equal(second.revision, 1);
});

test('retention: at most 50 recent snapshots, but pre-reset snapshots are always kept', async () => {
  const db = await dbWithRow();
  let rev = 1;
  const r0 = await rpc.commit(db, { expected: rev, data: bundle({ '2026-01-01': activeLog() }), reason: 'reset' });
  rev = r0.revision;
  for (let i = 0; i < 70; i++) {
    const r = await rpc.commit(db, { expected: rev, data: bundle({ [`2026-02-${String((i % 28) + 1).padStart(2, '0')}`]: activeLog(`t${i}`) }) });
    assert.equal(r.status, 'ok');
    rev = r.revision;
  }
  const snaps = (await db.query(`select reason from public.ayyam_snapshots`)).rows;
  assert.ok(snaps.length <= 51, `kept ${snaps.length}`);
  assert.ok(snaps.some((s) => s.reason === 'before:reset'), 'pre-reset snapshot must survive pruning');
});

test('commit accepts the v2 enriched shape (reg/tomb/epoch), not only materialized', async () => {
  const db = await freshDb();
  await setKey(db);
  const enriched = { v: 2, epoch: 0, reg: { 'g:2026-09-10:ext:t': { val: { title: 'x', time: '', period: null }, t: 5, by: 'A' } }, tomb: {} };
  const r = await rpc.commit(db, { expected: 0, data: enriched, reason: 'init' });
  assert.equal(r.status, 'ok');
  assert.deepEqual((await rpc.pull(db)).data, enriched);
  // a plain object with neither reg nor template+logs is still rejected
  assert.equal((await rpc.commit(db, { expected: 1, data: { foo: 1 } })).status, 'invalid');
});
