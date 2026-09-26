// Tests the real browser file js/storage.js against fake-indexeddb (same code the app loads).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';

// Load the classic script once; it attaches AyyamStore to globalThis.
vm.runInThisContext(readFileSync(new URL('../../js/storage.js', import.meta.url), 'utf8'), { filename: 'js/storage.js' });
const { AyyamStore } = globalThis;

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); }); // fresh empty DB per test

const sanitize = (b) => ({
  template: (b && b.template) || {},
  logs: (b && b.logs) || {},
  prefs: (b && b.prefs) || {},
  tplArchive: (b && b.tplArchive) || { since: '0000-00-00', versions: [] },
});
const bundle = (logs = {}) => sanitize({ logs, prefs: { theme: 'night' } });

// A localStorage-like reader backed by a plain map.
const lsReader = (map) => (k) => (k in map ? map[k] : null);

test('state persists across a reopen', async () => {
  let s = await AyyamStore.open();
  await s.saveState(bundle({ d1: { done: { a: true }, extra: [], hidden: {}, overrides: {} } }));
  s.close();
  s = await AyyamStore.open();
  const st = await s.getState();
  assert.deepEqual(Object.keys(st.logs), ['d1']);
});

test('saveStateAndEnqueue writes state AND an outbox record atomically', async () => {
  const s = await AyyamStore.open();
  const rec = await s.saveStateAndEnqueue(bundle({ d1: {} }), { reason: 'sync', base_revision: 5 });
  assert.equal(rec.state, 'pending');
  assert.equal(rec.base_revision, 5);
  assert.ok(rec.op_id && rec.seq === 1);
  const box = await s.listOutbox();
  assert.equal(box.length, 1);
  assert.equal((await s.getState()).logs.d1 !== undefined, true);
  assert.equal((await s.getMeta()).lastSeq, 1);
});

test('a failed write REJECTS and leaves the previous state unchanged (no false save)', async () => {
  const s = await AyyamStore.open();
  const good = bundle({ ok: { done: { a: true }, extra: [], hidden: {}, overrides: {} } });
  await s.saveStateAndEnqueue(good, {});
  // a value containing a function cannot be structured-cloned → put throws → tx aborts → reject
  const poison = { ...bundle({ bad: {} }), fn: () => 1 };
  await assert.rejects(s.saveStateAndEnqueue(poison, {}), (e) => e instanceof Error);
  // previous state and outbox are intact; the poisoned mutation did not slip in
  const st = await s.getState();
  assert.deepEqual(Object.keys(st.logs), ['ok']);
  assert.equal(await s.outboxCount(), 1);
});

test('outbox seq keeps increasing across reopens (ordering preserved)', async () => {
  let s = await AyyamStore.open();
  await s.saveStateAndEnqueue(bundle({ a: {} }), {});
  await s.saveStateAndEnqueue(bundle({ b: {} }), {});
  s.close();
  s = await AyyamStore.open();
  const rec = await s.saveStateAndEnqueue(bundle({ c: {} }), {});
  assert.equal(rec.seq, 3);
  const box = await s.listOutbox();
  assert.deepEqual(box.map((r) => r.seq), [1, 2, 3]);
});

test('confirmOutbox removes the mutation and sets the base atomically', async () => {
  const s = await AyyamStore.open();
  const rec = await s.saveStateAndEnqueue(bundle({ a: {} }), {});
  await s.saveStateAndEnqueue(bundle({ a: {}, b: {} }), {}); // a second pending op
  const confirmedState = bundle({ a: {}, b: {} });
  await s.confirmOutbox(rec.op_id, { data: confirmedState, revision: 7, epoch: 0 }, confirmedState);
  const box = await s.listOutbox();
  assert.equal(box.length, 1);
  assert.equal(box[0].seq, 2);
  assert.equal((await s.getBase()).revision, 7);
});

test('setOutbox records a failed attempt without dropping the mutation', async () => {
  const s = await AyyamStore.open();
  const rec = await s.saveStateAndEnqueue(bundle({ a: {} }), {});
  await s.setOutbox(rec.op_id, { state: 'failed', retry_count: 2, last_error: 'network' });
  const box = await s.listOutbox();
  assert.equal(box[0].state, 'failed');
  assert.equal(box[0].retry_count, 2);
});

test('migration from the cloud-cache key: copies into IndexedDB and KEEPS localStorage', async () => {
  const map = {
    ayyam_cloud_cache_v1: JSON.stringify(bundle({ '2026-08-18': { done: { x: true }, extra: [], hidden: {}, overrides: {} } })),
    ayyam_sync_base_v1: JSON.stringify(bundle({ '2026-08-18': { done: { x: true }, extra: [], hidden: {}, overrides: {} } })),
    ayyam_sync_pending_v1: '1',
  };
  const s = await AyyamStore.open();
  const res = await s.migrateFromLocalStorage(lsReader(map), sanitize);
  assert.equal(res.migrated, true);
  assert.equal(res.hadPending, true);
  assert.ok((await s.getState()).logs['2026-08-18']);
  assert.equal((await s.getBase()).data.logs['2026-08-18'] !== undefined, true);
  assert.equal((await s.getMeta()).migratedFromLS, true);
  // localStorage copy is intentionally still there (fallback)
  assert.equal(map.ayyam_cloud_cache_v1 !== null, true);
});

test('migration is idempotent and never runs twice', async () => {
  const map = { ayyam_cloud_cache_v1: JSON.stringify(bundle({ d: {} })) };
  const s = await AyyamStore.open();
  assert.equal((await s.migrateFromLocalStorage(lsReader(map), sanitize)).migrated, true);
  // even if LS later changes, a second migration is a no-op
  map.ayyam_cloud_cache_v1 = JSON.stringify(bundle({ other: {} }));
  const second = await s.migrateFromLocalStorage(lsReader(map), sanitize);
  assert.equal(second.migrated, false);
  assert.equal(second.source, 'already');
  assert.ok((await s.getState()).logs.d !== undefined);
});

test('migration from legacy per-key storage', async () => {
  const map = {
    ayyam_template_v1: JSON.stringify({ sat: [{ id: 't1', title: 'x', period: null, time: '' }] }),
    ayyam_logs_v1: JSON.stringify({ '2026-09-06': { done: { a: true }, extra: [], hidden: {}, overrides: {} } }),
    ayyam_prefs_v1: JSON.stringify({ theme: 'day' }),
  };
  const s = await AyyamStore.open();
  const res = await s.migrateFromLocalStorage(lsReader(map), sanitize);
  assert.equal(res.migrated, true);
  const st = await s.getState();
  assert.equal(st.prefs.theme, 'day');
  assert.ok(st.logs['2026-09-06']);
});

test('migration when localStorage is empty is a safe no-op', async () => {
  const s = await AyyamStore.open();
  const res = await s.migrateFromLocalStorage(lsReader({}), sanitize);
  assert.equal(res.migrated, false);
  assert.equal(res.source, 'nothing-in-ls');
  assert.equal(await s.getState(), null);
  assert.equal((await s.getMeta()).migratedFromLS, true);
});

test('migration does not run if IndexedDB already has state', async () => {
  const s = await AyyamStore.open();
  await s.saveState(bundle({ existing: {} }));
  const res = await s.migrateFromLocalStorage(lsReader({ ayyam_cloud_cache_v1: JSON.stringify(bundle({ ls: {} })) }), sanitize);
  assert.equal(res.migrated, false);
  assert.equal(res.source, 'idb-had-state');
  assert.ok((await s.getState()).logs.existing !== undefined);
});

test('diagnostics ring buffer stays capped', async () => {
  const s = await AyyamStore.open();
  for (let i = 0; i < 230; i++) await s.logDiag({ type: 'x', i });
  const all = await s.getDiag();
  assert.ok(all.length <= 200, `diag length ${all.length}`);
});
