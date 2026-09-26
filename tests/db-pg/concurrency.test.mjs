// Real concurrency against a real PostgreSQL server (separate connections, truly simultaneous
// transactions). Runs when DATABASE_URL is set — in CI a postgres service container provides it.
// PGlite (tests/db) is single-connection, so it can only simulate interleavings; this proves the
// row lock + revision check under real parallelism.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const URL = process.env.DATABASE_URL;
const KEY = 'ci-device-key-0123456789abcdef';
const skip = !URL && 'DATABASE_URL not set (runs in CI)';
let admin;

const SHIM = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create schema if not exists extensions;
  grant usage on schema public, extensions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`;

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: URL });
  await admin.connect();
  await admin.query('drop schema if exists public cascade; create schema public; grant all on schema public to public;');
  await admin.query(SHIM);
  const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await admin.query(readFileSync(join(dir, f), 'utf8'));
  }
  await admin.query('select public.ayyam_set_device_key($1)', [KEY]);
});
after(async () => { if (admin) await admin.end(); });

// Each "device" is its own connection acting as the anon role, like PostgREST.
async function device() {
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  await c.query('set role anon');
  return {
    pull: async () => (await c.query('select public.ayyam_pull($1) r', [KEY])).rows[0].r,
    commit: async (expected, data, opId = randomUUID()) =>
      (await c.query('select public.ayyam_commit($1,$2,$3::jsonb,$4::uuid,$5) r',
        [KEY, expected, JSON.stringify(data), opId, 'sync'])).rows[0].r,
    end: () => c.end(),
  };
}
const empty = () => ({ template: {}, logs: {}, prefs: {}, tplArchive: { since: '0000-00-00', versions: [] } });

test('N simultaneous commits on the same revision: exactly one wins, the rest get conflict', { skip }, async () => {
  const d0 = await device();
  const init = await d0.pull();
  if (!init.exists) assert.equal((await d0.commit(0, empty())).status, 'ok');
  const base = await d0.pull();
  const devices = await Promise.all(Array.from({ length: 12 }, device));
  const results = await Promise.all(devices.map((d, i) =>
    d.commit(base.revision, { ...base.data, logs: { [`2026-10-${String(i + 1).padStart(2, '0')}`]: { done: { [`t${i}`]: true } } } })));
  assert.equal(results.filter((r) => r.status === 'ok').length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.status === 'conflict').length, 11);
  assert.equal((await d0.pull()).revision, base.revision + 1);
  await Promise.all([...devices, d0].map((d) => d.end()));
});

test('N devices with pull → merge → commit retry loops: every device\'s change survives', { skip }, async () => {
  const devices = await Promise.all(Array.from({ length: 10 }, device));
  // Each device adds its own day; merge = union of logs (what merge3 does for disjoint edits).
  await Promise.all(devices.map(async (d, i) => {
    const mine = { [`2026-11-${String(i + 1).padStart(2, '0')}`]: { done: { [`dev${i}`]: true } } };
    const opId = randomUUID(); // one logical operation, retried until applied
    for (let attempt = 0; attempt < 50; attempt++) {
      const cur = await d.pull();
      const merged = { ...cur.data, logs: { ...cur.data.logs, ...mine } };
      const r = await d.commit(cur.revision, merged, opId);
      if (r.status === 'ok' || r.status === 'duplicate') return;
      assert.equal(r.status, 'conflict');
    }
    assert.fail(`device ${i} never committed`);
  }));
  const final = await devices[0].pull();
  for (let i = 0; i < 10; i++) {
    assert.ok(final.data.logs[`2026-11-${String(i + 1).padStart(2, '0')}`], `lost update from device ${i}`);
  }
  await Promise.all(devices.map((d) => d.end()));
});

test('the same op_id sent concurrently from two connections is applied exactly once', { skip }, async () => {
  const [a, b] = await Promise.all([device(), device()]);
  const cur = await a.pull();
  const opId = randomUUID();
  const data = { ...cur.data, logs: { ...cur.data.logs, '2026-12-01': { done: { dup: true } } } };
  const [ra, rb] = await Promise.all([a.commit(cur.revision, data, opId), b.commit(cur.revision, data, opId)]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, ['duplicate', 'ok']);
  assert.equal((await a.pull()).revision, cur.revision + 1);
  await Promise.all([a.end(), b.end()]);
});
