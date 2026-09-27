// Integration test of the REAL reminders orchestration (supabase/functions/ayyam-reminders/orchestrate.js)
// against a PGlite-backed Supabase shim + a fake Web Push provider. Proves the cron/test flow end to end
// without a Deno runtime or real pushes. Auth (X-Cron-Secret) is a header compare in index.ts (not here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as adhan from 'adhan';
import { freshDb, setKey, DEVICE_KEY } from './helpers.mjs';
import { runCron, runTest } from '../../supabase/functions/ayyam-reminders/orchestrate.js';

// Minimal Supabase-JS shim over PGlite: the exact calls orchestrate.js makes (.from().select().eq()
// .is().maybeSingle(), .update().eq(), and .rpc()).
function sbOver(db) {
  return {
    from(table) {
      const st = { table, cols: '*', filters: [], isNull: [], op: 'select', patch: null };
      const api = {
        select(c) { st.cols = c || '*'; return api; },
        eq(k, v) { st.filters.push([k, v]); return api; },
        is(k, _v) { st.isNull.push(k); return api; },
        update(p) { st.op = 'update'; st.patch = p; return api; },
        async maybeSingle() { const r = await run(); return { data: r[0] ?? null, error: null }; },
        then(res, rej) { return run().then((rows) => res({ data: rows, error: null }), rej); },
      };
      async function run() {
        const where = [...st.filters.map(([k], i) => `${k}=$${i + 1}`), ...st.isNull.map((k) => `${k} is null`)].join(' and ');
        const params = st.filters.map(([, v]) => v);
        if (st.op === 'update') {
          const keys = Object.keys(st.patch);
          const set = keys.map((k, i) => `${k}=$${params.length + i + 1}`).join(', ');
          await db.query(`update public.${st.table} set ${set}${where ? ' where ' + where : ''}`, [...params, ...keys.map((k) => st.patch[k])]);
          return [];
        }
        const cols = st.cols === '*' ? '*' : st.cols;
        const res = await db.query(`select ${cols} from public.${st.table}${where ? ' where ' + where : ''}`, params);
        return res.rows;
      }
      return api;
    },
    async rpc(fn, args) {
      const names = Object.keys(args);
      const ph = names.map((_, i) => `$${i + 1}`).join(',');
      const res = await db.query(`select public.${fn}(${ph}) r`, names.map((n) => args[n]));
      return { data: res.rows[0].r, error: null };
    },
  };
}

async function setup(taskDone = false) {
  const db = await freshDb();
  await setKey(db);
  const sb = sbOver(db);
  // two devices
  await db.query('select public.register_push($1,$2,$3,$4)', [DEVICE_KEY, 'https://push/A', 'pA', 'aA']);
  await db.query('select public.register_push($1,$2,$3,$4)', [DEVICE_KEY, 'https://push/B', 'pB', 'aB']);
  // ayyam_data with one open task in the dhuhr period for the test day/timezone
  const data = { template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] },
    logs: { '2026-10-01': { done: taskDone ? { x: true } : {}, extra: [{ id: 'x', title: 'ورد القرآن', period: 'dhuhr', time: '' }], hidden: {}, overrides: {} } },
    prefs: {}, tplArchive: { since: '0000-00-00', versions: [] } };
  await db.query(`insert into public.ayyam_data (id, data, revision) values ('main', $1, 1)`, [JSON.stringify(data)]);
  return { db, sb };
}

// 2026-10-01, a few minutes after Cairo dhuhr (~12:46 local = 09:46 UTC)
const AT_DHUHR = new Date('2026-10-01T09:48:00Z');

test('cron: enqueues the due prayer and sends one push per device (N), no duplicate on re-run (I,M)', async () => {
  const { db, sb } = await setup();
  const sends = [];
  const send = async (item) => { sends.push(item.endpoint); };
  const r1 = await runCron(sb, adhan, send, AT_DHUHR);
  assert.equal(r1.enqueued.dhuhr, 'created');
  assert.equal(r1.totals.sent, 2);                     // both devices, once each
  assert.deepEqual(sends.sort(), ['https://push/A', 'https://push/B']);
  // the very next 5-min cron run: reminder already exists, deliveries already sent → nothing re-sent
  const before = sends.length;
  const r2 = await runCron(sb, adhan, send, new Date(AT_DHUHR.getTime() + 5 * 60000));
  assert.equal(r2.enqueued.dhuhr, 'exists');
  assert.equal(sends.length, before);                  // no duplicate send
});

test('cron: no open tasks → skipped, nothing sent (H)', async () => {
  const { db, sb } = await setup(true); // task already done
  const sends = [];
  const r = await runCron(sb, adhan, async (i) => sends.push(i.endpoint), AT_DHUHR);
  assert.equal(r.enqueued.dhuhr, 'skipped');
  assert.equal(sends.length, 0);
  assert.equal((await db.query(`select count(*)::int n from public.push_deliveries`)).rows[0].n, 0);
});

test('cron: a temporary 500 is NOT marked sent and is retried on the next run (J)', async () => {
  const { db, sb } = await setup();
  let failB = true;
  const send = async (item) => { if (item.endpoint === 'https://push/B' && failB) { const e = new Error('x'); e.statusCode = 500; throw e; } };
  const r1 = await runCron(sb, adhan, send, AT_DHUHR);
  assert.equal(r1.totals.sent, 1); assert.equal(r1.totals.retryable, 1);
  const bStatus = (await db.query(`select d.status from public.push_deliveries d join push_subscriptions s on s.id=d.subscription_id where s.endpoint='https://push/B'`)).rows[0].status;
  assert.equal(bStatus, 'failed'); // NOT sent
  // make it due and let B succeed now → only B is retried (A stays sent), so exactly one more send
  await db.query(`update public.push_deliveries set next_retry_at = now() - interval '1 minute' where status='failed'`);
  failB = false;
  const sends2 = [];
  await runCron(sb, adhan, async (i) => sends2.push(i.endpoint), new Date(AT_DHUHR.getTime() + 6 * 60000));
  assert.deepEqual(sends2, ['https://push/B']);        // O: only the failed device is retried
});

test('cron: a 410 disables the device and cleans it from future reminders (L)', async () => {
  const { db, sb } = await setup();
  const send = async (item) => { if (item.endpoint === 'https://push/A') { const e = new Error('gone'); e.statusCode = 410; throw e; } };
  const r = await runCron(sb, adhan, send, AT_DHUHR);
  assert.equal(r.totals.gone, 1);
  const a = (await db.query(`select disabled_at from public.push_subscriptions where endpoint='https://push/A'`)).rows[0];
  assert.ok(a.disabled_at);
});

test('test mode does NOT touch reminder/delivery/prayer state (Q)', async () => {
  const { db, sb } = await setup();
  const sends = [];
  const r = await runTest(sb, async (i) => sends.push(i.endpoint));
  assert.equal(r.mode, 'test'); assert.equal(r.sent, 2);
  assert.equal((await db.query(`select count(*)::int n from public.push_reminders`)).rows[0].n, 0);
  assert.equal((await db.query(`select count(*)::int n from public.push_deliveries`)).rows[0].n, 0);
  // a subsequent real cron still works normally (state was untouched)
  assert.equal((await runCron(sb, adhan, async () => {}, AT_DHUHR)).enqueued.dhuhr, 'created');
});

// ---------------- Android FCM channel (Phase F): web + fcm are independent channels ----------------
const regAndroid = (db, token) => db.query('select public.register_android_push($1,$2,$3)', [DEVICE_KEY, token, 'devA']);

test('cron: delivers to BOTH web and fcm; fcm uses its token; no duplicate on re-run', async () => {
  const { db, sb } = await setup();
  await regAndroid(db, 'fcm-tok-integration-0001');
  const web = [], fcm = [];
  const r = await runCron(sb, adhan, async (i) => web.push(i.endpoint), AT_DHUHR, async (i) => fcm.push(i.token));
  assert.equal(r.totals.sent, 3);                          // 2 web + 1 fcm
  assert.deepEqual(web.sort(), ['https://push/A', 'https://push/B']);
  assert.deepEqual(fcm, ['fcm-tok-integration-0001']);
  const before = web.length + fcm.length;
  await runCron(sb, adhan, async (i) => web.push(i.endpoint), new Date(AT_DHUHR.getTime() + 5 * 60000), async (i) => fcm.push(i.token));
  assert.equal(web.length + fcm.length, before);           // nothing re-sent
});

test('cron: fcm fails temporarily → web still sent, only fcm retried next run', async () => {
  const { db, sb } = await setup();
  await regAndroid(db, 'fcm-tok-integration-0002');
  let failFcm = true;
  const sendFcm = async () => { if (failFcm) { const e = new Error('x'); e.statusCode = 503; throw e; } };
  const r1 = await runCron(sb, adhan, async () => {}, AT_DHUHR, sendFcm);
  assert.equal(r1.totals.sent, 2);                         // both web
  assert.equal(r1.totals.retryable, 1);                    // fcm deferred
  await db.query(`update public.push_deliveries set next_retry_at = now() - interval '1 minute' where status='failed'`);
  failFcm = false;
  const fcm2 = [];
  await runCron(sb, adhan, async () => {}, new Date(AT_DHUHR.getTime() + 6 * 60000), async (i) => fcm2.push(i.token));
  assert.deepEqual(fcm2, ['fcm-tok-integration-0002']);    // only the failed fcm delivery retried
});

test('cron: fcm 404 UNREGISTERED disables the token (push_disable_android)', async () => {
  const { db, sb } = await setup();
  await regAndroid(db, 'fcm-tok-integration-0003');
  const sendFcm = async () => { const e = new Error('unregistered'); e.statusCode = 404; throw e; };
  const r = await runCron(sb, adhan, async () => {}, AT_DHUHR, sendFcm);
  assert.equal(r.totals.gone, 1);
  const a = (await db.query(`select disabled_at from public.android_push_subscriptions where token='fcm-tok-integration-0003'`)).rows[0];
  assert.ok(a.disabled_at, 'the FCM token must be disabled');
});

test('cron: with FCM not configured (no sendFcm), web is still delivered and fcm is deferred', async () => {
  const { db, sb } = await setup();
  await regAndroid(db, 'fcm-tok-integration-0004');
  const web = [];
  const r = await runCron(sb, adhan, async (i) => web.push(i.endpoint), AT_DHUHR); // no sendFcm
  assert.equal(r.totals.sent, 2);                          // web unaffected
  assert.equal(r.totals.retryable, 1);                     // fcm deferred (503), never lost
  assert.deepEqual(web.sort(), ['https://push/A', 'https://push/B']);
});
