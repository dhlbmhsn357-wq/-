import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/time-model.js', import.meta.url), 'utf8'), { filename: 'js/time-model.js' });
vm.runInThisContext(readFileSync(new URL('../../js/routines-model.js', import.meta.url), 'utf8'), { filename: 'js/routines-model.js' });
const R = globalThis.AyyamRoutines;
const clone = (o) => JSON.parse(JSON.stringify(o));
const emptyDays = () => ({ sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] });
const log = (o) => Object.assign({ done: {}, extra: [], hidden: {}, overrides: {} }, o);

// A realistic pre-migration bundle: a current template + one archived version + real completion logs.
function preBundle() {
  const template = Object.assign(emptyDays(), { mon: [{ id: 'm1', title: 'الحالي', time: 'الظهر', period: 'dhuhr', _order: 0 }] });
  const oldTpl = Object.assign(emptyDays(), { mon: [{ id: 'm0', title: 'القديم', time: '', period: null, _order: 0 }] });
  return {
    template,
    tplArchive: { since: '2026-09-20', versions: [{ id: '0000-00-00', template: oldTpl }] },
    logs: {
      '2026-09-14': log({ done: { m0: true } }),   // archived Monday, task completed
      '2026-09-21': log({ overrides: { m1: { title: 'معدّل ذلك اليوم', time: '', period: 'dhuhr' } } }),
      '2026-10-05': log({ done: { m1: true } }),    // future-of-migration Monday
    },
    prefs: { theme: 'night', bgOn: true, bgOpacity: 72, bgBlur: 0, location: null, dayTimezone: '' },
    routines: {}, migrationDate: '',
  };
}

const PAST = ['2026-09-14', '2026-09-15', '2026-09-20', '2026-09-21', '2026-09-27']; // all < migration day (2026-09-28)

test('FIDELITY: every pre-migration day is logically identical after migration', () => {
  const pre = preBundle();
  const legacyBefore = {};                       // snapshot with migrationDate:'' => pure legacy path
  for (const d of PAST) legacyBefore[d] = R.tasksForDate(pre, d);

  const migrated = R.migrate(pre, '2026-09-28', 'Africa/Cairo');
  assert.equal(migrated.migrationDate, '2026-09-28');

  for (const d of PAST) {
    assert.deepEqual(R.tasksForDate(migrated, d), legacyBefore[d], `day ${d} changed after migration`);
  }
});

test('migration retains template + tplArchive untouched (compatibility / recovery source)', () => {
  const pre = preBundle();
  const migrated = R.migrate(pre, '2026-09-28', 'Africa/Cairo');
  assert.deepEqual(migrated.template, pre.template);
  assert.deepEqual(migrated.tplArchive, pre.tplArchive);
});

test('migration builds weekly routines from the current template, id == original task id', () => {
  const migrated = R.migrate(preBundle(), '2026-09-28', 'Africa/Cairo');
  assert.ok(migrated.routines['m1']);
  assert.equal(migrated.routines['m1'].seriesId, 'm1');
  assert.equal(migrated.routines['m1'].rec.freq, 'weekly');
  assert.deepEqual(migrated.routines['m1'].rec.days, ['mon']);
  assert.equal(migrated.routines['m1'].rec.from, '2026-09-28');
  assert.equal(migrated.routines['m1'].rec.to, null);
  assert.equal(migrated.prefs.dayTimezone, 'Africa/Cairo');
  // archived-only task (m0) is NOT promoted to a routine — its history stays with the legacy path
  assert.equal(migrated.routines['m0'], undefined);
});

test('completion keys still resolve to the correct task, past AND future of migration', () => {
  const migrated = R.migrate(preBundle(), '2026-09-28', 'Africa/Cairo');
  // past (archived) completion, served by legacy
  const past = R.tasksForDate(migrated, '2026-09-14');
  assert.equal(past[0].title, 'القديم');
  assert.equal(past[0].done, true);
  // today-only override in the past, served by legacy
  assert.equal(R.tasksForDate(migrated, '2026-09-21')[0].title, 'معدّل ذلك اليوم');
  // future-of-migration completion, served by the routine (same id m1)
  const fut = R.tasksForDate(migrated, '2026-10-05');
  assert.equal(fut[0].title, 'الحالي');
  assert.equal(fut[0].done, true);
});

test('migration is idempotent', () => {
  const once = R.migrate(preBundle(), '2026-09-28', 'Africa/Cairo');
  const twice = R.migrate(once, '2026-10-10', 'Etc/UTC'); // different args must not re-migrate
  assert.deepEqual(twice.routines, once.routines);
  assert.equal(twice.migrationDate, once.migrationDate);
  assert.equal(twice.prefs.dayTimezone, 'Africa/Cairo');
});

test('un-migrated bundle behaves exactly like today (pure legacy)', () => {
  const pre = preBundle();
  assert.equal(pre.migrationDate, '');
  assert.deepEqual(R.tasksForDate(pre, '2026-09-28').map((t) => t.title), ['الحالي']); // legacy current template
});
