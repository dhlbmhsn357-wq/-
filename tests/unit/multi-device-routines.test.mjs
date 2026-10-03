// Multi-device routine hardening (public-launch blocker). Proves that two devices on the SAME account
// can migrate the legacy template → routines independently and still CONVERGE, and that a late independent
// migrator can never duplicate, re-inject, or clobber the other device's genuine routine edits/deletes.
//
// It exercises the real pieces together: AyyamRoutines.migrate (legacy→routines) + AyyamModel.migrateGeneration
// (the baseline-stamped epoch generation the app persists on 'routines-migrate') + AyyamModel.merge (the LWW
// + tombstone + epoch-fence merge the sync engine runs on every pull). No I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/time-model.js', import.meta.url), 'utf8'), { filename: 'js/time-model.js' });
vm.runInThisContext(readFileSync(new URL('../../js/routines-model.js', import.meta.url), 'utf8'), { filename: 'js/routines-model.js' });
vm.runInThisContext(readFileSync(new URL('../../js/sync-model.js', import.meta.url), 'utf8'), { filename: 'js/sync-model.js' });
const R = globalThis.AyyamRoutines;
const M = globalThis.AyyamModel;
const clone = (o) => JSON.parse(JSON.stringify(o));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const emptyDays = () => ({ sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] });
const log = (o) => Object.assign({ done: {}, extra: [], hidden: {}, overrides: {} }, o);
const TODAY = '2026-09-28', TZ = 'Africa/Cairo';

// A realistic shared pre-migration dataset (both devices hold this synced legacy state before upgrading).
function preBundle() {
  const template = Object.assign(emptyDays(), {
    mon: [{ id: 'm1', title: 'ورد الاثنين', time: 'الظهر', period: 'dhuhr', _order: 0 }],
    wed: [{ id: 'w1', title: 'مجلس علم', time: 'بعد العصر', period: 'asr', _order: 0 }],
  });
  return {
    template,
    tplArchive: { since: '2026-09-20', versions: [] },
    logs: { '2026-09-21': log({ done: { m1: true } }) },
    prefs: { theme: 'night', bgOn: true, bgOpacity: 72, bgBlur: 0, location: null, dayTimezone: '' },
    routines: {}, migrationDate: '',
  };
}
// What the app does on 'routines-migrate': migrate the legacy bundle, then persist it as the baseline epoch.
function deviceMigrates(pre) {
  const mat = R.migrate(clone(pre), TODAY, TZ);
  return { mat, en: M.migrateGeneration(M.empty(0), mat) };
}
// Simulate a genuine routine edit/delete on a device AFTER it migrated (stamped at a real wall-clock `now`).
function edit(en, mat, mutate, now, by) {
  const next = clone(mat);
  mutate(next);
  return M.enrich(en, next, now, by);
}

test('migration is deterministic: two devices derive BYTE-IDENTICAL migrated generations', () => {
  const a = deviceMigrates(preBundle());
  const b = deviceMigrates(preBundle());
  assert.ok(a.en.epoch === 1 && b.en.epoch === 1, 'migration bumps to epoch 1 (fences a pre-routines device)');
  assert.ok(eq(a.en, b.en), 'independent migrations of the same legacy template are identical (no divergence)');
  // every migrated register is baseline-stamped (t:1, by:'') — this is what lets a real edit always win later
  for (const k of Object.keys(a.en.reg)) assert.ok(a.en.reg[k].t === 1 && a.en.reg[k].by === '', `register ${k} is baseline-stamped`);
});

test('CONVERGENCE: merging two independent migrations is a fixed point — no duplication / re-injection', () => {
  const a = deviceMigrates(preBundle());
  const b = deviceMigrates(preBundle());
  const { merged, outcome } = M.merge(M.empty(0), a.en, b.en);
  assert.equal(outcome, 'merge');                       // same epoch → LWW, not an epoch-fence
  assert.ok(eq(merged, a.en), 'merged state equals a single migration (converged)');
  const routines = M.materialize(merged).routines;
  const ids = Object.keys(routines);
  assert.ok(ids.length >= 2, 'both template series migrated to routines');
  assert.equal(ids.length, new Set(ids).size, 'no duplicate routine ids after merge');
});

test('LOST-UPDATE GUARD: a late independent migrator can NOT clobber the other device\'s real routine edit', () => {
  // A migrates, then genuinely renames routine m1 at a real time. B migrates independently (baseline only).
  const a = deviceMigrates(preBundle());
  const rid = 'm1';
  assert.ok(a.mat.routines[rid], 'routine m1 exists after migration');
  const aEdited = edit(a.en, a.mat, (m) => { m.routines[rid].title = 'ورد الاثنين (معدّل)'; }, 5_000_000, 'devA');
  const b = deviceMigrates(preBundle());                // B migrates AFTER, but baseline-stamped (t:1)
  const { merged } = M.merge(M.empty(0), aEdited, b.en);
  const routines = M.materialize(merged).routines;
  assert.equal(routines[rid].title, 'ورد الاثنين (معدّل)', 'A\'s real edit (t≫1) beats B\'s baseline migration');
  // order-independent: merging the other way round gives the same winner
  const { merged: merged2 } = M.merge(M.empty(0), b.en, aEdited);
  assert.equal(M.materialize(merged2).routines[rid].title, 'ورد الاثنين (معدّل)', 'merge is commutative on the edit');
});

test('DELETE GUARD: a re-migrating device can NOT revive a routine the other device deleted', () => {
  const a = deviceMigrates(preBundle());
  const rid = 'w1';
  assert.ok(a.mat.routines[rid], 'routine w1 exists after migration');
  const aDeleted = edit(a.en, a.mat, (m) => { delete m.routines[rid]; }, 5_000_000, 'devA'); // real delete → tombstone t≫1
  const b = deviceMigrates(preBundle());                // B re-creates r:w1 at baseline t:1
  const { merged } = M.merge(M.empty(0), aDeleted, b.en);
  assert.ok(!M.materialize(merged).routines[rid], 'the deletion (tombstone t≫1) wins over the baseline re-add');
});

test('EPOCH FENCE still protects the ordered online path: a migrated device fences a not-yet-migrated one', () => {
  const a = deviceMigrates(preBundle());                      // migrated → epoch 1
  const stale = M.toEnriched(clone(preBundle()), 1);          // a device still on the legacy template → epoch 0
  const { merged, outcome, parked } = M.merge(M.empty(0), stale, a.en);
  assert.equal(outcome, 'adopt-newer-epoch');
  assert.equal(merged.epoch, 1);
  assert.ok(Object.keys(M.materialize(merged).routines).length >= 2, 'the migrated routines are kept, not overwritten by the legacy template');
  assert.ok(parked && parked.epoch === 0, 'the stale pre-migration state is parked for recovery, never silently merged over the routines');
});
