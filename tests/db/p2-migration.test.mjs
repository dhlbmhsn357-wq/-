import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { freshDb, setKey, createUser, migrationBackend, rpc, rpc2, DEVICE_KEY } from './helpers.mjs';

// Load the real client models into this process (they set globalThis.*).
for (const f of ['js/sync-model.js', 'js/account.js'])
  vm.runInThisContext(readFileSync(new URL('../../' + f, import.meta.url), 'utf8'), { filename: f });
const M = globalThis.AyyamModel, AC = globalThis.AyyamAccount;

// A realistic legacy bundle: tasks + recurrence + logs + excused + replaced.
function legacyBundle() {
  return {
    template: { sat: [{ id: 't1', title: 'قديم', time: '', timeValue: null, period: 'fajr' }], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] },
    logs: {
      '2026-09-10': { done: { t1: true }, extra: [{ id: 'e1', title: 'إضافي', time: '', timeValue: '05:30', period: 'fajr' }], hidden: {}, overrides: {}, excused: { gym: { reason: 'illness' } }, replacements: { r1: { task: { title: 'بديل', period: 'asr' }, reason: '' } } },
    },
    prefs: { theme: 'night', dayTimezone: 'Africa/Cairo' },
    tplArchive: { since: '0000-00-00', versions: [] },
    routines: { r1: { id: 'r1', seriesId: 'r1', title: 'روتين', time: '', timeValue: null, period: 'asr', order: 0, rec: { freq: 'daily', from: '2026-09-01', to: null } } },
    migrationDate: '2026-09-01',
  };
}
// Seed the legacy 'main' row exactly as the shipped v1.1.2 client would (an enriched value committed by key).
async function seedLegacyMain(db, mat) {
  const en = M.enrich(null, mat, 1000, 'legacy-device');
  const c = await rpc.commit(db, { expected: 0, data: en, reason: 'init' });
  assert.equal(c.status, 'ok');
  return en;
}
const hasLog = (bundle, day) => bundle.logs && bundle.logs[day];

test('full migration: legacy (tasks+recurrence+logs+excused+replaced) → account, verified + completed', async () => {
  const db = await freshDb(); await setKey(db);
  await seedLegacyMain(db, legacyBundle());
  const A = await createUser(db, 'a@t.test');
  const backend = migrationBackend(db, A);
  // local enriched on this device == what it has (here: same as legacy 'main', the common case)
  const localEnriched = M.enrich(null, legacyBundle(), 1000, 'legacy-device');
  const res = await AC.migrate(backend, { localEnriched, migrationOpId: randomUUID(), now: 2000 });
  assert.equal(res.status, 'ok');
  // account row now holds the migrated data, materialized identically
  const acct = M.materialize(res.merged);
  assert.ok(hasLog(acct, '2026-09-10'));
  assert.equal(acct.logs['2026-09-10'].excused.gym.reason, 'illness');
  assert.equal(acct.logs['2026-09-10'].replacements.r1.task.title, 'بديل');
  assert.ok(acct.routines.r1 && acct.routines.r1.title === 'روتين');
  // server-recorded completion
  assert.equal((await rpc2.accountState(db, A)).migration_status, 'completed');
  // legacy 'main' still exists (never deleted) and remains claimed by A
  assert.equal((await db.query("select 1 from public.ayyam_data where id='main'")).rows.length, 1);
  assert.equal((await db.query('select claimed_by from public.ayyam_legacy_claim')).rows[0].claimed_by, A);
});

test('non-empty pending outbox: local edits NOT in legacy are merged in (no loss)', async () => {
  const db = await freshDb(); await setKey(db);
  await seedLegacyMain(db, legacyBundle());
  const A = await createUser(db, 'a@t.test');
  // local device has an extra pending edit on top of legacy (as if the outbox had an unsynced change)
  const withEdit = legacyBundle();
  withEdit.logs['2026-09-11'] = { done: { t1: true }, extra: [], hidden: {}, overrides: {}, excused: {}, replacements: {} };
  const localEnriched = M.enrich(M.enrich(null, legacyBundle(), 1000, 'dev'), withEdit, 3000, 'dev'); // pending edit at t=3000
  const res = await AC.migrate(migrationBackend(db, A), { localEnriched, migrationOpId: randomUUID(), now: 4000 });
  assert.equal(res.status, 'ok');
  const acct = M.materialize(res.merged);
  assert.ok(acct.logs['2026-09-10'] && acct.logs['2026-09-11'], 'both the legacy day and the pending local edit survive');
});

test('resume after interruption/process death: re-running migration is idempotent (no dup/loss)', async () => {
  const db = await freshDb(); await setKey(db);
  await seedLegacyMain(db, legacyBundle());
  const A = await createUser(db, 'a@t.test');
  const localEnriched = M.enrich(null, legacyBundle(), 1000, 'dev');
  const opId = randomUUID();               // STABLE op id (persisted before first commit) → resume-safe
  // First attempt "crashes" right after the CAS commit (before complete): simulate by a backend whose
  // complete() throws once.
  const raw = migrationBackend(db, A);
  let crashed = false;
  const crashing = Object.assign({}, raw, { complete: async () => { if (!crashed) { crashed = true; throw new Error('process died'); } return raw.complete(); } });
  await assert.rejects(AC.migrate(crashing, { localEnriched, migrationOpId: opId, now: 2000 }));
  const before = await rpc2.pull(db, A);
  assert.equal(before.exists, true); assert.equal(before.revision, 1); // committed once
  assert.notEqual((await rpc2.accountState(db, A)).migration_status, 'completed'); // not completed yet
  // Re-run with the SAME opId → claim ok(mine), commit is a 'duplicate'/no-op, verify, complete.
  const res = await AC.migrate(raw, { localEnriched, migrationOpId: opId, now: 2500 });
  assert.equal(res.status, 'ok');
  const after = await rpc2.pull(db, A);
  assert.equal(after.revision, 1);          // NO second row / NO duplicate commit
  assert.equal((await rpc2.accountState(db, A)).migration_status, 'completed');
});

test('two different accounts on the same legacy dataset: the second is refused (already_claimed)', async () => {
  const db = await freshDb(); await setKey(db);
  await seedLegacyMain(db, legacyBundle());
  const A = await createUser(db, 'a@t.test'), B = await createUser(db, 'b@t.test');
  const local = M.enrich(null, legacyBundle(), 1000, 'dev');
  assert.equal((await AC.migrate(migrationBackend(db, A), { localEnriched: local, migrationOpId: randomUUID(), now: 2000 })).status, 'ok');
  const rB = await AC.migrate(migrationBackend(db, B), { localEnriched: local, migrationOpId: randomUUID(), now: 2000 });
  assert.equal(rB.status, 'already_claimed');    // B cannot claim A's legacy data
  assert.equal((await rpc2.pull(db, B)).exists, false); // B's account stays empty — no leak
});

test('two accounts each migrate their OWN device (isolated rows, no cross-contamination)', async () => {
  // Two separate legacy datasets don't exist in this single-row model, but two accounts writing v2 are isolated.
  const db = await freshDb();
  const A = await createUser(db, 'a@t.test'), B = await createUser(db, 'b@t.test');
  await rpc2.commit(db, A, { expected: 0, data: M.enrich(null, legacyBundle(), 1, 'a'), reason: 'init' });
  const bBundle = legacyBundle(); bBundle.prefs.theme = 'day';
  await rpc2.commit(db, B, { expected: 0, data: M.enrich(null, bBundle, 1, 'b'), reason: 'init' });
  assert.equal(M.materialize(M.toEnriched((await rpc2.pull(db, A)).data, 1)).prefs.theme, 'night');
  assert.equal(M.materialize(M.toEnriched((await rpc2.pull(db, B)).data, 1)).prefs.theme, 'day');
});
