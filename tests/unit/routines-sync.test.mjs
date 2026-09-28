import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/sync-model.js', import.meta.url), 'utf8'), { filename: 'js/sync-model.js' });
const M = globalThis.AyyamModel;

const rt = (id, days) => ({ id, seriesId: id, title: id, time: '', period: null, order: 0, rec: { freq: 'weekly', days, from: '2026-09-28', to: null } });
const withRoutines = (rmap, migd) => M.sanitizeMaterialized({ routines: rmap, migrationDate: migd || '2026-09-28' });
const en = (prev, mat, t, by) => M.enrich(prev, mat, t, by);
const mat = (e) => M.materialize(e);

test('routines + migrationDate survive flatten -> enrich -> materialize (stable round-trip)', () => {
  const m = withRoutines({ r: rt('r', ['mon']) });
  const e = en(M.empty(), m, 10, 'A');
  const round = mat(e);
  assert.deepEqual(round.routines, m.routines);
  assert.equal(round.migrationDate, '2026-09-28');
  assert.deepEqual(mat(en(e, round, 11, 'A')), round); // idempotent
});

test('merge: edits to different routines both survive', () => {
  const seed = en(M.empty(), withRoutines({ r: rt('r', ['mon']) }), 1, 'srv');
  const a = en(seed, withRoutines({ r: rt('r', ['mon']), a: rt('a', ['tue']) }), 10, 'A');
  const c = en(seed, withRoutines({ r: rt('r', ['mon']), b: rt('b', ['wed']) }), 11, 'B');
  const merged = mat(M.merge(seed, a, c).merged);
  assert.deepEqual(Object.keys(merged.routines).sort(), ['a', 'b', 'r']);
});

test('merge: same routine edited on both -> later stamp wins (LWW)', () => {
  const seed = en(M.empty(), withRoutines({ r: rt('r', ['mon']) }), 1, 'srv');
  const a = en(seed, withRoutines({ r: rt('r', ['tue']) }), 20, 'A');
  const c = en(seed, withRoutines({ r: rt('r', ['wed']) }), 30, 'B');
  assert.deepEqual(mat(M.merge(seed, a, c).merged).routines['r'].rec.days, ['wed']); // t=30 wins
});

test('stale device cannot revive a routine that was deleted (future-delete / hard-delete)', () => {
  const seed = en(M.empty(), withRoutines({ r: rt('r', ['mon']), x: rt('x', ['tue']) }), 5, 'srv');
  const deleted = en(seed, withRoutines({ r: rt('r', ['mon']) }), 100, 'A'); // x removed -> tombstone r:x
  const staleReadd = withRoutines({ r: rt('r', ['mon']), x: rt('x', ['tue']) }); // plain baseline bundle
  const merged = mat(M.merge(seed, deleted, staleReadd).merged);
  assert.equal(merged.routines['x'], undefined);
});

test('reset/import (bumpEpoch) carries routines and fences an older-epoch device', () => {
  const seed = en(M.empty(), withRoutines({ r: rt('r', ['mon']) }), 1, 'srv');
  const reset = M.bumpEpoch(seed, withRoutines({ z: rt('z', ['fri']) }), 100, 'A');
  assert.ok(reset.epoch > seed.epoch);
  assert.deepEqual(Object.keys(mat(reset).routines), ['z']);
  const staleEdit = en(seed, withRoutines({ r: rt('r', ['mon']), q: rt('q', ['sat']) }), 150, 'B'); // old epoch
  const res = M.merge(reset, reset, staleEdit);
  assert.equal(res.outcome, 'push-newer-epoch');
  assert.deepEqual(Object.keys(mat(res.merged).routines), ['z']); // stale additions fenced out
});
