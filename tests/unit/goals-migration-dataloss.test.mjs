// REGRESSION: a goal must never be silently lost by the one-time routines migration generation.
//
// The reported Stage-B data loss: a goal created in account mode vanished after reload. Root cause was
// app.js `sanitizeBundle` rebuilding the bundle field-by-field and omitting `goals`, so the reload path
//   setState(sanitizeBundle(AyyamRoutines.migrate(currentBundle())))  →  saveBundle('routines-migrate')
// committed a goal-LESS `migrateGeneration`, fencing the goal behind a new epoch (data loss, no user delete).
//
// This suite locks the invariants the fix relies on, at the two importable layers:
//   • AyyamRoutines.migrate must carry `goals` through untouched (both the fresh-migrate and already-migrated
//     no-op paths) — it clones the whole bundle, and this test prevents a future field-by-field refactor
//     (the exact mistake sanitizeBundle made) from dropping goals again.
//   • The full reload→migrate→migrateGeneration→materialize compose keeps the goal register, adds NO goal
//     tombstone, and a later revision/epoch bump still retains it.
// The end-to-end app.js sanitizeBundle path itself is additionally guarded by the Goals e2e reload-persistence spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/time-model.js', import.meta.url), 'utf8'), { filename: 'js/time-model.js' });
vm.runInThisContext(readFileSync(new URL('../../js/routines-model.js', import.meta.url), 'utf8'), { filename: 'js/routines-model.js' });
vm.runInThisContext(readFileSync(new URL('../../js/sync-model.js', import.meta.url), 'utf8'), { filename: 'js/sync-model.js' });
const R = globalThis.AyyamRoutines;
const M = globalThis.AyyamModel;

const emptyDays = () => ({ sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] });
const GOAL = {
  id: 'g1', title: 'ختم القرآن', period_type: 'weekly', measurement_type: 'count',
  target_value: 12, current_value: 3, status: 'on_track', created_at: 1000, updated_at: 2000,
};
// A realistic PRE-migration bundle (legacy template + logs) that ALSO already carries a goal, exactly as a
// pilot user's reloaded bundle would right before the one-time routines migration runs.
function preBundleWithGoal() {
  const template = Object.assign(emptyDays(), { mon: [{ id: 'm1', title: 'الحالي', time: 'الظهر', period: 'dhuhr' }] });
  return {
    template,
    tplArchive: { since: '2026-09-20', versions: [] },
    logs: { '2026-10-05': { done: { m1: true }, extra: [], hidden: {}, overrides: {} } },
    prefs: { theme: 'night', bgOn: false, bgOpacity: 72, bgBlur: 0, location: null, dayTimezone: '' },
    routines: {}, migrationDate: '', goals: { g1: { ...GOAL } },
  };
}

test('migrate (fresh): carries goals through untouched while building routines', () => {
  const pre = preBundleWithGoal();
  const out = R.migrate(pre, '2026-09-28', 'Africa/Cairo');
  assert.ok(out.routines['m1'], 'routine still built from the template');
  assert.deepEqual(out.goals, pre.goals, 'goals survived the migration generation');
  assert.equal(out.migrationVersion, 1);
});

test('migrate (already-migrated no-op): still returns goals intact', () => {
  const migrated = Object.assign(preBundleWithGoal(), { routines: { m1: { id: 'm1', seriesId: 'm1', title: 'x', time: '', timeValue: null, period: null, order: 0, rec: { freq: 'weekly', days: ['mon'], from: '2026-09-28', to: null } } }, migrationDate: '2026-09-28', migrationVersion: 1 });
  const out = R.migrate(migrated, '2026-10-10', 'Africa/Cairo');
  assert.deepEqual(out.goals, migrated.goals, 'no-op path preserves goals');
});

test('migrate: a bundle with NO goals yields an output with no goals (additive, no phantom goal)', () => {
  const pre = preBundleWithGoal(); delete pre.goals;
  const out = R.migrate(pre, '2026-09-28', 'Africa/Cairo');
  assert.ok(!out.goals || Object.keys(out.goals).length === 0, 'no goals in, no goals out');
});

test('FULL COMPOSE: reload → migrate → migrateGeneration keeps the goal register, adds NO tombstone', () => {
  // 1) Account already holds a goal on the server: build the enriched value the client pulls.
  const seeded = M.sanitizeMaterialized(preBundleWithGoal());
  assert.ok(seeded.goals && seeded.goals.g1, 'precondition: the seeded materialized bundle has the goal');
  const serverEnriched = M.toEnriched(seeded, 1);
  assert.ok(serverEnriched.reg['goal:g1'], 'precondition: goal is a managed register on the server state');

  // 2) Reload: materialize the pulled state → the bundle the app feeds into the routines migration.
  const reloaded = M.materialize(serverEnriched);
  assert.ok(reloaded.goals && reloaded.goals.g1, 'reloaded bundle carries the goal');

  // 3) The migration path: AyyamRoutines.migrate (predates goals) then the app re-affirms goals (defense),
  //    and the result is committed as a baseline-stamped migrate generation on a NEW epoch.
  const migratedBundle = R.migrate(reloaded, '2026-09-28', 'Africa/Cairo');
  migratedBundle.goals = reloaded.goals; // app.js defense-in-depth (redundant with migrate's clone, kept)
  const gen = M.migrateGeneration(serverEnriched, migratedBundle);

  // 4) Invariants: the new generation still has the goal register, NO goal tombstone, epoch bumped.
  assert.ok(gen.reg['goal:g1'], 'goal register survived the migration generation');
  assert.ok(!gen.tomb['goal:g1'], 'NO goal tombstone was produced (goal not deleted)');
  assert.equal(gen.epoch, serverEnriched.epoch + 1, 'epoch bumped exactly once');
  assert.ok(M.materialize(gen).goals.g1, 'goal still visible after materialize');
});

test('FULL COMPOSE: a later revision/edit after migration does NOT remove the goal', () => {
  const serverEnriched = M.toEnriched(M.sanitizeMaterialized(preBundleWithGoal()), 1);
  const migratedBundle = R.migrate(M.materialize(serverEnriched), '2026-09-28', 'Africa/Cairo');
  const gen = M.migrateGeneration(serverEnriched, migratedBundle);

  // An unrelated later edit (e.g. a routine completion) within the migrated bundle.
  const afterEdit = M.materialize(gen);
  afterEdit.logs['2026-10-06'] = { done: { m1: true }, extra: [], hidden: {}, overrides: {} };
  const next = M.enrich(gen, afterEdit, 5000, 'devB');

  assert.ok(next.reg['goal:g1'], 'goal register still present after a subsequent edit/revision');
  assert.ok(!next.tomb['goal:g1'], 'still no goal tombstone');
  assert.ok(M.materialize(next).goals.g1, 'goal still materializes after the revision change');
});
