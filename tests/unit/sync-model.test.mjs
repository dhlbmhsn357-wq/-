import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/sync-model.js', import.meta.url), 'utf8'), { filename: 'js/sync-model.js' });
const M = globalThis.AyyamModel;

// ----- helpers -----
const base = () => M.sanitizeMaterialized({});
function withExtra(day, tasks) { const m = base(); m.logs[day] = { done: {}, extra: tasks, hidden: {}, overrides: {} }; return m; }
function withDone(day, id, on) { const m = base(); m.logs[day] = { done: on ? { [id]: true } : {}, extra: [{ id, title: 'مهمة', period: null, time: '' }], hidden: {}, overrides: {} }; return m; }
const enrich = (prev, mat, t, by) => M.enrich(prev, mat, t, by);
const mat = (en) => M.materialize(en);
// simulate: device starts from `start` enriched, edits to newMat at (t,by)
const edit = (startEn, newMat, t, by) => enrich(startEn, newMat, t, by);
const extraTitles = (m, day) => (m.logs[day] ? m.logs[day].extra.map((x) => x.title).sort() : []);

test('add vs add (different tasks, same day): both survive', () => {
  const b = enrich(M.empty(), base(), 1, 'srv');
  const a = edit(b, withExtra('2026-09-10', [{ id: 'a', title: 'من أ', period: null, time: '' }]), 10, 'A');
  const c = edit(b, withExtra('2026-09-10', [{ id: 'z', title: 'من ب', period: null, time: '' }]), 11, 'B');
  const merged = M.merge(b, a, c).merged;
  assert.deepEqual(extraTitles(mat(merged), '2026-09-10'), ['من أ', 'من ب']);
});

test('edit vs edit same field: later stamp wins; ties are deterministic by device id', () => {
  const seed = enrich(M.empty(), withExtra('2026-09-10', [{ id: 't', title: 'أصل', period: null, time: '' }]), 1, 'srv');
  const a = edit(seed, withExtra('2026-09-10', [{ id: 't', title: 'عنوان أ', period: null, time: '' }]), 20, 'A');
  const c = edit(seed, withExtra('2026-09-10', [{ id: 't', title: 'عنوان ب', period: null, time: '' }]), 30, 'B');
  assert.equal(mat(M.merge(seed, a, c).merged).logs['2026-09-10'].extra[0].title, 'عنوان ب'); // t=30 wins
  // tie on time → higher device id wins, and BOTH merge orders agree (deterministic + commutative)
  const a2 = edit(seed, withExtra('2026-09-10', [{ id: 't', title: 'تعادل-أ', period: null, time: '' }]), 40, 'A');
  const c2 = edit(seed, withExtra('2026-09-10', [{ id: 't', title: 'تعادل-ب', period: null, time: '' }]), 40, 'B');
  const m1 = mat(M.merge(seed, a2, c2).merged).logs['2026-09-10'].extra[0].title;
  const m2 = mat(M.merge(seed, c2, a2).merged).logs['2026-09-10'].extra[0].title;
  assert.equal(m1, 'تعادل-ب');
  assert.equal(m1, m2);
});

test('edit vs delete: the later action wins, both directions', () => {
  const seed = enrich(M.empty(), withExtra('2026-09-10', [{ id: 't', title: 'أصل', period: null, time: '' }]), 1, 'srv');
  const edited = edit(seed, withExtra('2026-09-10', [{ id: 't', title: 'معدّل', period: null, time: '' }]), 50, 'A');
  const deleted = edit(seed, withExtra('2026-09-10', []), 40, 'B'); // delete earlier
  assert.equal(mat(M.merge(seed, edited, deleted).merged).logs['2026-09-10'].extra.length, 1); // edit (t50) wins
  const deletedLater = edit(seed, withExtra('2026-09-10', []), 60, 'B');
  assert.equal(mat(M.merge(seed, edited, deletedLater).merged).logs['2026-09-10'] === undefined ||
    mat(M.merge(seed, edited, deletedLater).merged).logs['2026-09-10'].extra.length === 0, true); // delete (t60) wins
});

test('delete vs STALE copy: a stale device can NOT revive a deleted task', () => {
  const seed = enrich(M.empty(), withExtra('2026-09-10', [{ id: 't', title: 'قديم', period: null, time: '' }]), 5, 'srv');
  // device A deletes at t=100
  const deleted = edit(seed, withExtra('2026-09-10', []), 100, 'A');
  // device B was offline since t=5 (its copy == seed, never re-edited) → it still "has" the task
  const stale = seed;
  const merged = M.merge(seed, stale, deleted).merged;      // B syncs its stale copy against A's delete
  assert.equal(mat(merged).logs['2026-09-10'] === undefined || mat(merged).logs['2026-09-10'].extra.length === 0, true);
  // even if B re-edits the task with an OLD-ish clock (its clock lags), the tombstone still wins
  const staleReadd = edit(seed, withExtra('2026-09-10', [{ id: 't', title: 'أعادها الجهاز القديم', period: null, time: '' }]), 40, 'B');
  const merged2 = M.merge(seed, staleReadd, deleted).merged; // readd t=40 < delete t=100
  assert.equal(mat(merged2).logs['2026-09-10'] === undefined || mat(merged2).logs['2026-09-10'].extra.length === 0, true);
});

test('done vs undone: latest stamp decides', () => {
  const seed = enrich(M.empty(), withDone('2026-09-10', 't', false), 1, 'srv');
  const doneA = edit(seed, withDone('2026-09-10', 't', true), 20, 'A');          // A: done@20
  // B checks then unchecks → a real undone stamp at t=30
  const undoneB = edit(edit(seed, withDone('2026-09-10', 't', true), 25, 'B'), withDone('2026-09-10', 't', false), 30, 'B');
  assert.equal(!!mat(M.merge(seed, doneA, undoneB).merged).logs['2026-09-10']?.done?.t, false); // undone (t30) wins
  const doneLater = edit(undoneB, withDone('2026-09-10', 't', true), 40, 'A');   // done@40 > undone@30
  assert.equal(!!mat(M.merge(seed, doneLater, undoneB).merged).logs['2026-09-10']?.done?.t, true);
});

test('template edit vs task-log edit: independent, both kept', () => {
  const seed = enrich(M.empty(), base(), 1, 'srv');
  const tpl = base(); tpl.template.sat = [{ id: 's1', title: 'قالب', period: 'fajr', time: '' }];
  const a = edit(seed, tpl, 20, 'A');
  const b = edit(seed, withExtra('2026-09-10', [{ id: 'x', title: 'سجل', period: null, time: '' }]), 21, 'B');
  const merged = mat(M.merge(seed, a, b).merged);
  assert.equal(merged.template.sat[0].title, 'قالب');
  assert.equal(merged.logs['2026-09-10'].extra[0].title, 'سجل');
});

test('reset vs stale device: epoch fences the stale device, its state is parked for recovery', () => {
  const seed = enrich(M.empty(), withExtra('2026-08-01', [{ id: 'old', title: 'قديم مهم', period: null, time: '' }]), 5, 'srv');
  const reset = M.bumpEpoch(seed, base(), 100, 'A'); // phone resets
  assert.equal(reset.epoch, 1);
  // stale laptop (epoch 0) reconnects with its old data
  const res = M.merge(seed, seed, reset);
  assert.equal(res.outcome, 'adopt-newer-epoch');
  assert.equal(mat(res.merged).logs['2026-08-01'], undefined);       // old data does NOT come back
  assert.ok(res.parked && mat(res.parked).logs['2026-08-01']);       // but it is preserved for recovery
});

test('import vs stale device: newer epoch wins, stale cannot overwrite', () => {
  const seed = enrich(M.empty(), base(), 5, 'srv');
  const imported = M.bumpEpoch(seed, withExtra('2026-07-01', [{ id: 'imp', title: 'مستورد', period: null, time: '' }]), 100, 'A');
  const staleEdit = edit(seed, withExtra('2026-09-09', [{ id: 'late', title: 'من الجهاز القديم', period: null, time: '' }]), 90, 'B');
  const res = M.merge(seed, staleEdit, imported);
  assert.equal(res.outcome, 'adopt-newer-epoch');
  assert.ok(mat(res.merged).logs['2026-07-01']);              // imported content present
  assert.equal(mat(res.merged).logs['2026-09-09'], undefined); // stale content fenced
});

test('convergence: two offline devices, reconnect in EITHER order → identical final state', () => {
  const seed = enrich(M.empty(), withExtra('2026-09-10', [{ id: 't', title: 'أصل', period: null, time: '' }]), 1, 'srv');
  const A = edit(seed, withExtra('2026-09-10', [{ id: 't', title: 'أصل', period: null, time: '' }, { id: 'a', title: 'أ', period: null, time: '' }]), 20, 'A');
  const B = edit(seed, withExtra('2026-09-10', [{ id: 'b', title: 'ب', period: null, time: '' }]), 30, 'B'); // B also deletes 't'
  // order 1: server gets A then B
  let srv = seed;
  srv = M.merge(srv, A, srv).merged;      // A commits
  srv = M.merge(srv, B, srv).merged;      // B commits against A's result
  const order1 = mat(srv);
  // order 2: server gets B then A
  let srv2 = seed;
  srv2 = M.merge(srv2, B, srv2).merged;
  srv2 = M.merge(srv2, A, srv2).merged;
  const order2 = mat(srv2);
  assert.deepEqual(order1, order2);
});

test('v1 plain bundle: v2 edit wins over untouched v1; a genuine v1 change is preserved', () => {
  const v1plain = withExtra('2026-09-10', [{ id: 't', title: 'من v1', period: null, time: '' }]); // no epoch/reg
  const v2 = edit(enrich(M.empty(), base(), 1, 'srv'), withExtra('2026-09-11', [{ id: 'q', title: 'من v2', period: null, time: '' }]), 100, 'A');
  const merged = mat(M.merge(base(), v2, v1plain).merged);
  assert.equal(merged.logs['2026-09-10'].extra[0].title, 'من v1');   // v1 data kept
  assert.equal(merged.logs['2026-09-11'].extra[0].title, 'من v2');   // v2 data kept
});

test('v1 stale re-add cannot revive a v2-deleted task', () => {
  const seed = enrich(M.empty(), withExtra('2026-09-10', [{ id: 't', title: 'x', period: null, time: '' }]), 5, 'srv');
  const deleted = edit(seed, withExtra('2026-09-10', []), 100, 'A');   // v2 delete
  const v1plainStillHasIt = withExtra('2026-09-10', [{ id: 't', title: 'x', period: null, time: '' }]);
  const merged = mat(M.merge(seed, deleted, v1plainStillHasIt).merged);
  assert.equal(merged.logs['2026-09-10'] === undefined || merged.logs['2026-09-10'].extra.length === 0, true);
});

test('materialize ∘ enrich is stable (round-trip)', () => {
  const m = withExtra('2026-09-10', [{ id: 't', title: 'ت', period: 'asr', time: 'العصر' }]);
  m.prefs.theme = 'day'; m.template.sat = [{ id: 's', title: 'ق', period: 'fajr', time: '' }];
  const en = enrich(M.empty(), m, 10, 'A');
  const round = mat(en);
  assert.deepEqual(round, M.sanitizeMaterialized(m));
  assert.deepEqual(mat(enrich(en, round, 11, 'A')), round);
});

test('tombstone pruning drops old deletions but keeps recent ones', () => {
  const now = 1_000_000_000_000;
  const seed = enrich(M.empty(), withExtra('2026-09-10', [{ id: 'old', title: 'o', period: null, time: '' }, { id: 'new', title: 'n', period: null, time: '' }]), now - 10, 'A');
  let en = edit(seed, withExtra('2026-09-10', [{ id: 'new', title: 'n', period: null, time: '' }]), now - M.TOMBSTONE_TTL_MS - 1000, 'A'); // delete 'old' long ago
  en = edit(en, withExtra('2026-09-10', []), now - 1000, 'A'); // delete 'new' recently
  const pruned = M.pruneTombstones(en, now);
  assert.equal(pruned.tomb['g:2026-09-10:ext:old'], undefined); // old tombstone gone
  assert.ok(pruned.tomb['g:2026-09-10:ext:new']);               // recent tombstone kept
});

test('prefs and location conflicts resolve by latest stamp', () => {
  const seed = enrich(M.empty(), base(), 1, 'srv');
  const a = base(); a.prefs.bgOpacity = 50; a.prefs.location = { lat: 31.03, lng: 31.37, tz: 'Africa/Cairo' };
  const b = base(); b.prefs.bgOpacity = 80; // B only changes opacity, later
  const enA = edit(seed, a, 20, 'A');
  const enB = edit(seed, b, 30, 'B');
  const merged = mat(M.merge(seed, enA, enB).merged);
  assert.equal(merged.prefs.bgOpacity, 80);                  // B later wins the field it touched
  assert.deepEqual(merged.prefs.location, { lat: 31.03, lng: 31.37, tz: 'Africa/Cairo' }); // A's location kept (B never set it)
});
