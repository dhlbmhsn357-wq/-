// P1-A — Goals ride the existing enriched CRDT (LWW + tombstones + epoch) with ZERO new sync machinery, and
// land additively with NO migration and NO data loss. These tests prove:
//   • goals default to {} for every existing user; adding goals didn't change the existing round-trip,
//   • an old (v1 plain) bundle upgrades with all old data intact + goals:{},
//   • a goal is one whole-object leaf register (add / edit / delete behave; delete tombstones, never silent),
//   • LWW is order-independent and a later delete beats a stale edit (multi-device safety),
//   • the forward-compat hardening PRESERVES a register family this version doesn't know (what protects Goals
//     when a lagging client, whose flatten() doesn't emit `goal:`, re-saves the same account).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/time-model.js', import.meta.url), 'utf8'), { filename: 'js/time-model.js' });
vm.runInThisContext(readFileSync(new URL('../../js/goals-model.js', import.meta.url), 'utf8'), { filename: 'js/goals-model.js' });
vm.runInThisContext(readFileSync(new URL('../../js/sync-model.js', import.meta.url), 'utf8'), { filename: 'js/sync-model.js' });
const M = globalThis.AyyamModel;
const G = globalThis.AyyamGoals;

// An "old" bundle exactly as a pre-Goals client produces it — note: NO `goals` key.
function oldBundle() {
  return {
    template: { sat: [{ id: 't1', title: 'مهمة', time: '', timeValue: null, period: 'fajr' }], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] },
    logs: { '2026-10-03': { done: { t1: true }, extra: [], hidden: {}, overrides: {}, excused: {}, replacements: {} } },
    prefs: { theme: 'day', bgOn: false, bgOpacity: 72, bgBlur: 0, location: null, dayTimezone: '' },
    tplArchive: { since: '2026-01-01', versions: [] },
    routines: {}, migrationDate: '', migrationVersion: 0,
  };
}

test('goals default to {} everywhere (sanitize + materialize of empty)', () => {
  assert.deepEqual(M.sanitizeMaterialized({}).goals, {});
  assert.deepEqual(M.materialize(M.empty(0)).goals, {});
  assert.deepEqual(M.sanitizeMaterialized(oldBundle()).goals, {}); // existing user → empty goals, no migration
});

test('backward-compatible: adding goals did NOT change the existing round-trip (old data intact)', () => {
  const b = oldBundle();
  const san = M.sanitizeMaterialized(b);
  const mat = M.materialize(M.enrich(M.empty(0), b, 1000, 'devA'));
  assert.deepEqual(mat, san);          // round-trip is a fixed point; goals:{} included
  assert.deepEqual(mat.goals, {});
  assert.equal(mat.template.sat[0].title, 'مهمة'); // nothing lost
  assert.equal(mat.logs['2026-10-03'].done.t1, true);
});

test('old-user upgrade: a v1 plain bundle → enriched keeps all old data and gains goals:{}', () => {
  const en = M.toEnriched(oldBundle(), 1); // plain (no v:2) → baseline-stamped registers
  const mat = M.materialize(en);
  assert.deepEqual(mat.goals, {});
  assert.equal(mat.template.sat[0].title, 'مهمة');
  assert.equal(mat.logs['2026-10-03'].done.t1, true);
});

test('a goal is one whole-object leaf register: add → edit → delete (delete tombstones, never silent)', () => {
  const g1 = G.newGoal({ id: 'g1', title: 'هدف', period_type: 'weekly', measurement_type: 'count', target_value: 12 }, 1700000000000, '2026-10-06');

  const en1 = M.enrich(M.empty(0), { ...oldBundle(), goals: { g1 } }, 2000, 'devA');
  const mat1 = M.materialize(en1);
  assert.ok(mat1.goals.g1, 'goal persisted');
  assert.deepEqual(mat1.goals.g1, g1, 'newGoal is a cleanGoal fixed point — no mutation on first save');
  assert.ok(en1.reg['goal:g1'], 'stored as a whole-object leaf (goal:<id>)');

  const en2 = M.enrich(en1, { ...oldBundle(), goals: { g1: { ...g1, current_value: 5, status: 'on_track', updated_at: 1700000005000 } } }, 3000, 'devA');
  assert.equal(M.materialize(en2).goals.g1.current_value, 5);
  assert.equal(en2.reg['goal:g1'].t, 3000, 'register re-stamped on edit');

  const en3 = M.enrich(en2, { ...oldBundle(), goals: {} }, 4000, 'devA');
  assert.deepEqual(M.materialize(en3).goals, {});
  assert.ok(en3.tomb['goal:g1'], 'deletion leaves a tombstone (no silent loss; a stale device cannot revive it)');
  assert.ok(!en3.reg['goal:g1']);
});

test('multi-device: current_value conflict is LWW (later wins), order-independent', () => {
  const g1 = G.newGoal({ id: 'g1', title: 'هدف', measurement_type: 'count', target_value: 12 }, 1700000000000, '2026-10-06');
  const base = M.enrich(M.empty(0), { ...oldBundle(), goals: { g1: { ...g1, current_value: 5 } } }, 3000, 'devA');
  const enA = M.enrich(base, { ...oldBundle(), goals: { g1: { ...g1, current_value: 6, updated_at: 3500 } } }, 3500, 'devA');
  const enB = M.enrich(base, { ...oldBundle(), goals: { g1: { ...g1, current_value: 7, updated_at: 4000 } } }, 4000, 'devB');
  assert.equal(M.materialize(M.merge(base, enA, enB).merged).goals.g1.current_value, 7, 'later write (B) wins');
  assert.equal(M.materialize(M.merge(base, enB, enA).merged).goals.g1.current_value, 7, 'LWW is order-independent');
});

test('multi-device: a later delete beats a stale edit (goal stays deleted)', () => {
  const g1 = G.newGoal({ id: 'g1', title: 'هدف', measurement_type: 'count', target_value: 12 }, 1700000000000, '2026-10-06');
  const base = M.enrich(M.empty(0), { ...oldBundle(), goals: { g1: { ...g1, current_value: 5 } } }, 3000, 'devA');
  const del = M.enrich(base, { ...oldBundle(), goals: {} }, 5000, 'devA');                                           // delete @5000
  const staleEdit = M.enrich(base, { ...oldBundle(), goals: { g1: { ...g1, current_value: 9, updated_at: 4500 } } }, 4500, 'devB'); // edit @4500
  assert.deepEqual(M.materialize(M.merge(base, del, staleEdit).merged).goals, {}, 'stale edit cannot revive a later-deleted goal');
});

test('forward-compat hardening: a register family this version does NOT know is PRESERVED, not tombstoned', () => {
  // This is exactly the shape of the risk: a lagging client whose flatten() cannot emit a newer key must not
  // delete it on a re-save. (`future:*` here stands in for what `goal:*` is to a pre-Goals client.)
  const base = M.enrich(M.empty(0), oldBundle(), 1000, 'devA');
  base.reg['future:xyz'] = { val: { feature: 'not-born-yet', n: 42 }, t: 5000, by: 'newdev' };

  const after = M.enrich(base, M.materialize(base), 6000, 'olddev'); // olddev re-saves; materialize drops the unknown key
  assert.ok(after.reg['future:xyz'], 'unknown-family register preserved');
  assert.deepEqual(after.reg['future:xyz'].val, { feature: 'not-born-yet', n: 42 }, 'value untouched');
  assert.ok(!after.tomb['future:xyz'], 'no tombstone created for the unknown key');

  // control: the hardening must NOT break real deletions of keys this version DOES manage.
  const removed = M.enrich(base, { ...oldBundle(), template: { ...oldBundle().template, sat: [] } }, 7000, 'devA');
  assert.ok(removed.tomb['m:sat:t1'], 'a genuine removal of a managed key still tombstones');
});
