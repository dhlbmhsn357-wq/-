import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, applyMigration, asAnon, setKey, rpc, bundle, activeLog, migrationFiles } from './helpers.mjs';

const LEGACY_DATA = bundle({ '2026-08-06': activeLog('x1'), '2026-08-18': activeLog('x2') },
  { prefs: { theme: 'day', location: { lat: 31.03, lng: 31.37, tz: 'Africa/Cairo' } } });

test('migrations are ordered and named <timestamp>_<name>.sql', () => {
  const files = migrationFiles();
  assert.ok(files.length >= 2);
  files.forEach((f) => assert.match(f, /^\d{14}_[a-z0-9_]+\.sql$/));
});

test('schema can be recreated from scratch', async () => {
  const db = await freshDb();
  const tables = (await db.query(`select table_name from information_schema.tables where table_schema='public' order by 1`))
    .rows.map((r) => r.table_name);
  for (const t of ['ayyam_data', 'ayyam_snapshots', 'ayyam_ops', 'ayyam_config', 'ayyam_recovery_points', 'push_subscriptions', 'push_log']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const cols = (await db.query(`select column_name from information_schema.columns where table_name='ayyam_data'`)).rows.map((r) => r.column_name);
  assert.deepEqual(cols.sort(), ['data', 'epoch', 'id', 'last_op_id', 'revision', 'updated_at']);
});

test('upgrade keeps the existing row byte-for-byte and starts it at revision 1', async () => {
  const db = await freshDb({ upTo: '20260927000100' });
  await db.query(`insert into public.ayyam_data (id, data, updated_at) values ('main', $1, '2026-09-26T20:46:58Z')`, [JSON.stringify(LEGACY_DATA)]);
  const before = (await db.query(`select data::text as d from public.ayyam_data`)).rows[0].d;
  await applyMigration(db, '20260927000200');
  const r = (await db.query(`select data::text as d, revision, epoch, updated_at from public.ayyam_data`)).rows[0];
  assert.equal(r.d, before);
  assert.equal(Number(r.revision), 1);
  assert.equal(r.epoch, 0);
  assert.equal(new Date(r.updated_at).toISOString(), '2026-09-26T20:46:58.000Z');
});

test('migrations are idempotent (re-running changes nothing)', async () => {
  const db = await freshDb();
  await db.query(`insert into public.ayyam_data (id, data) values ('main', $1)`, [JSON.stringify(LEGACY_DATA)]);
  const snap = async () => (await db.query(`select data::text as d, revision, epoch from public.ayyam_data`)).rows[0];
  const before = await snap();
  for (const f of migrationFiles()) await applyMigration(db, f.slice(0, 14));
  for (const f of migrationFiles()) await applyMigration(db, f.slice(0, 14));
  assert.deepEqual(await snap(), before);
  assert.equal((await db.query(`select count(*)::int as n from public.ayyam_config`)).rows[0].n, 1);
});

test('the browser role cannot read internal tables or call admin functions', async () => {
  const db = await freshDb();
  for (const t of ['ayyam_snapshots', 'ayyam_ops', 'ayyam_config', 'ayyam_recovery_points']) {
    await assert.rejects(asAnon(db, `select * from public.${t}`), /permission denied/, t);
  }
  for (const call of [`select public.ayyam_set_device_key('aaaaaaaaaaaaaaaaaaaa')`, `select public.ayyam_prune()`,
                      `select public.ayyam_key_ok('x')`]) {
    await assert.rejects(asAnon(db, call), /permission denied/, call);
  }
});

test('while no device key is configured every RPC answers unauthorized (v1 client unaffected)', async () => {
  const db = await freshDb();
  assert.equal((await rpc.pull(db)).status, 'unauthorized');
  assert.equal((await rpc.commit(db, { expected: 0, data: bundle() })).status, 'unauthorized');
  // v1 direct access still works exactly as before
  await asAnon(db, `insert into public.ayyam_data (id, data) values ('main', $1)`, [JSON.stringify(LEGACY_DATA)]);
  const r = await asAnon(db, `select data from public.ayyam_data where id='main'`);
  assert.equal(r.rows.length, 1);
});

test('a v1 (direct upsert) write bumps the revision and snapshots the previous data', async () => {
  const db = await freshDb();
  await setKey(db);
  await asAnon(db, `insert into public.ayyam_data (id, data) values ('main', $1)`, [JSON.stringify(LEGACY_DATA)]);
  const v1 = bundle({ '2026-09-27': activeLog('new') });
  // what supabase-js upsert (resolution=merge-duplicates) sends
  await asAnon(db, `insert into public.ayyam_data (id, data, updated_at) values ('main', $1, now())
                    on conflict (id) do update set data = excluded.data, updated_at = excluded.updated_at`, [JSON.stringify(v1)]);
  const row = (await db.query(`select revision, data from public.ayyam_data`)).rows[0];
  assert.equal(Number(row.revision), 2);
  assert.deepEqual(row.data, v1);
  const snaps = (await db.query(`select revision, reason, data from public.ayyam_snapshots`)).rows;
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].reason, 'before:legacy-write');
  assert.deepEqual(snaps[0].data, LEGACY_DATA);
});

test('v1 first-insert guard still refuses an empty default seed', async () => {
  const db = await freshDb();
  await assert.rejects(asAnon(db, `insert into public.ayyam_data (id, data) values ('main', $1)`, [JSON.stringify(bundle())]),
    /first upload must come from a device with activity/);
});

test('rollback script restores the v1 schema, keeps the data and archives every snapshot', async () => {
  const { readFileSync } = await import('node:fs');
  const db = await freshDb();
  await setKey(db);
  const r1 = await rpc.commit(db, { expected: 0, data: LEGACY_DATA, reason: 'init' });
  const latest = bundle({ '2026-09-27': activeLog('latest') });
  await rpc.commit(db, { expected: r1.revision, data: latest });
  const down = readFileSync(new URL('../../supabase/rollback/20260927000200_down.sql', import.meta.url), 'utf8');
  await db.exec(down);
  const row = (await db.query(`select * from public.ayyam_data`)).rows[0];
  assert.deepEqual(row.data, latest);                       // live data untouched
  assert.equal('revision' in row, false);                   // v1 schema again
  const archived = (await db.query(`select data from public.ayyam_recovery_points where reason like 'rollback-archive%'`)).rows;
  assert.equal(archived.length, 1);
  assert.deepEqual(archived[0].data, LEGACY_DATA);          // history preserved
  // v1 client still works after rollback
  await asAnon(db, `update public.ayyam_data set data = $1 where id = 'main'`, [JSON.stringify(LEGACY_DATA)]);
});
