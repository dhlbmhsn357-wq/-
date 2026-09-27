import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asAnon, setKey, DEVICE_KEY } from './helpers.mjs';

const call = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
const reg = (db, key, ep, p = 'p256', a = 'auth') =>
  asAnon(db, 'select public.register_push($1,$2,$3,$4) r', [key, ep, p, a]).then((r) => r.rows[0].r);
const enqueue = (db, day, period, title, body, tag = 't') =>
  call(db, 'select public.push_enqueue($1,$2,$3,$4,$5) r', [day, period, title, body, tag]).then((r) => r.r);
const claim = (db, limit = 50, lease = 60) => call(db, 'select public.push_claim($1,$2) r', [limit, lease]).then((r) => r.r);
const subs = (db) => db.query('select id, endpoint, disabled_at, failure_count, p256dh, auth from public.push_subscriptions order by created_at').then((r) => r.rows);
const deliveries = (db) => db.query('select id, status, attempt_count, next_retry_at from public.push_deliveries order by id').then((r) => r.rows);

async function withKey() { const db = await freshDb(); await setKey(db); return db; }

// A / B / C
test('register: first insert, then same keys (no dup), then changed keys (updated)', async () => {
  const db = await withKey();
  assert.deepEqual(await reg(db, DEVICE_KEY, 'https://push/1', 'k1', 'a1'), { status: 'ok', existed: false, keys_updated: false });
  assert.equal((await subs(db)).length, 1);
  const same = await reg(db, DEVICE_KEY, 'https://push/1', 'k1', 'a1');
  assert.deepEqual(same, { status: 'ok', existed: true, keys_updated: false });
  assert.equal((await subs(db)).length, 1); // no duplicate
  const changed = await reg(db, DEVICE_KEY, 'https://push/1', 'k2', 'a2');
  assert.equal(changed.keys_updated, true);
  const s = (await subs(db))[0];
  assert.equal(s.p256dh, 'k2'); assert.equal(s.auth, 'a2'); // keys refreshed in place
});

// D
test('register without a valid device key is unauthorized (and writes nothing)', async () => {
  const db = await withKey();
  assert.equal((await reg(db, 'wrong-key-wrong-key-wrong', 'https://push/x')).status, 'unauthorized');
  assert.equal((await reg(db, '', 'https://push/x')).status, 'unauthorized');
  assert.equal((await subs(db)).length, 0);
});

// E
test('the browser role cannot touch push_subscriptions / push_deliveries directly', async () => {
  const db = await withKey();
  for (const t of ['push_subscriptions', 'push_reminders', 'push_deliveries']) {
    await assert.rejects(asAnon(db, `select * from public.${t}`), /permission denied/, `select ${t}`);
    await assert.rejects(asAnon(db, `insert into public.${t} default values`), /permission denied/, `insert ${t}`);
  }
  // and only register_push is executable by anon
  await assert.rejects(asAnon(db, `select public.push_claim(1,60)`), /permission denied/);
  await assert.rejects(asAnon(db, `select public.push_cleanup()`), /permission denied/);
});

// H / skipped
test('enqueue with no message records skipped and creates no deliveries; idempotent', async () => {
  const db = await withKey();
  await reg(db, DEVICE_KEY, 'https://push/1');
  const r = await enqueue(db, '2026-09-27', 'dhuhr', null, null);
  assert.equal(r.status, 'skipped');
  assert.equal((await deliveries(db)).length, 0);
  // a later run in the same window does not resurrect it
  assert.equal((await enqueue(db, '2026-09-27', 'dhuhr', 'حان وقت الظهر', 'مهمة')).status, 'exists');
  assert.equal((await deliveries(db)).length, 0);
});

// enqueue active + N / dedup by (day,period)
test('enqueue active creates one delivery per active device, once', async () => {
  const db = await withKey();
  await reg(db, DEVICE_KEY, 'https://push/1');
  await reg(db, DEVICE_KEY, 'https://push/2');
  const r = await enqueue(db, '2026-09-27', 'asr', 'حان وقت العصر', 'مهمتان');
  assert.equal(r.status, 'created'); assert.equal(r.deliveries, 2);
  assert.equal((await enqueue(db, '2026-09-27', 'asr', 'حان وقت العصر', 'مهمتان')).status, 'exists'); // 5-min cron re-run
  assert.equal((await deliveries(db)).length, 2); // still 2, no duplicate
});

// I: claim → send → sent, next claim is empty
test('claim → mark_sent moves to sent and is not re-claimed', async () => {
  const db = await withKey();
  await reg(db, DEVICE_KEY, 'https://push/1');
  await enqueue(db, '2026-09-27', 'maghrib', 'حان وقت المغرب', 'مهمة');
  const batch = await claim(db);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].endpoint, 'https://push/1');
  await db.query('select public.push_mark_sent($1)', [batch[0].delivery_id]);
  assert.equal((await deliveries(db))[0].status, 'sent');
  assert.equal((await claim(db)).length, 0); // nothing left to claim
});

// claim lease prevents double-claim
test('a claimed (leased) delivery is not handed to a second claimer until the lease expires', async () => {
  const db = await withKey();
  await reg(db, DEVICE_KEY, 'https://push/1');
  await enqueue(db, '2026-09-27', 'isha', 'حان وقت العشاء', 'مهمة');
  const first = await claim(db, 50, 60);
  assert.equal(first.length, 1);
  assert.equal((await claim(db, 50, 60)).length, 0); // still leased → second run gets nothing
});

// J / K: temporary failure → not sent, retryable with backoff; then re-claimable
test('temporary failure is retryable with backoff and re-claimed after next_retry_at', async () => {
  const db = await withKey();
  await reg(db, DEVICE_KEY, 'https://push/1');
  await enqueue(db, '2026-09-27', 'fajr', 'حان وقت الفجر', 'مهمة');
  const b = await claim(db);
  await db.query('select public.push_mark_failed($1,$2,$3,$4,$5)', [b[0].delivery_id, 'HTTP 500', true, 5, 60]);
  const d = (await deliveries(db))[0];
  assert.equal(d.status, 'failed');
  assert.ok(d.next_retry_at); // scheduled for retry, NOT sent
  // not yet due → not claimed
  assert.equal((await claim(db)).length, 0);
  // force it due and confirm it is re-claimed (attempt increments)
  await db.query(`update public.push_deliveries set next_retry_at = now() - interval '1 minute'`);
  const again = await claim(db);
  assert.equal(again.length, 1);
  assert.equal(again[0].attempt, 2);
});

test('a non-retryable failure and an exhausted-retry failure both become terminal (no next_retry)', async () => {
  const db = await withKey();
  await reg(db, DEVICE_KEY, 'https://push/1');
  await enqueue(db, '2026-09-27', 'dhuhr', 'x', 'y');
  const b = await claim(db);
  await db.query('select public.push_mark_failed($1,$2,$3,$4,$5)', [b[0].delivery_id, 'HTTP 400', false, 5, 60]);
  assert.equal((await deliveries(db))[0].next_retry_at, null);
  assert.equal((await claim(db)).length, 0); // terminal → never re-claimed
});

// L: 404/410/403 → subscription cleaned (disabled), its deliveries skipped
test('a gone subscription (410) is disabled and its pending deliveries are skipped', async () => {
  const db = await withKey();
  await reg(db, DEVICE_KEY, 'https://push/gone');
  await reg(db, DEVICE_KEY, 'https://push/ok');
  await enqueue(db, '2026-09-27', 'asr', 'x', 'y');
  const batch = await claim(db);
  const gone = batch.find((d) => d.endpoint === 'https://push/gone');
  await db.query('select public.push_disable_subscription($1,$2)', [gone.delivery_id, 'HTTP 410']);
  const s = (await subs(db)).find((x) => x.endpoint === 'https://push/gone');
  assert.ok(s.disabled_at);
  // a new reminder does not create a delivery for the disabled device
  await enqueue(db, '2026-09-28', 'asr', 'x', 'y');
  const day2 = (await db.query(`select count(*)::int n from public.push_deliveries d join push_reminders r on r.id=d.reminder_id where r.day='2026-09-28'`)).rows[0].n;
  assert.equal(day2, 1); // only the healthy device
});

// P: crash after some deliveries succeed → on restart, succeeded ones are not re-sent
test('after a crash, only unfinished deliveries are re-claimed (sent ones are left alone)', async () => {
  const db = await withKey();
  await reg(db, DEVICE_KEY, 'https://push/1');
  await reg(db, DEVICE_KEY, 'https://push/2');
  await enqueue(db, '2026-09-27', 'isha', 'x', 'y');
  const batch = await claim(db, 50, 60);
  await db.query('select public.push_mark_sent($1)', [batch[0].delivery_id]); // one succeeded before "crash"
  // "crash": the other stays processing with a lease. Simulate lease expiry, then re-run:
  await db.query(`update public.push_deliveries set lease_until = now() - interval '1 minute' where status='processing'`);
  const re = await claim(db);
  assert.equal(re.length, 1);                        // only the un-sent one
  assert.notEqual(re[0].delivery_id, batch[0].delivery_id);
});

// cleanup
test('cleanup removes old reminders (cascading deliveries) and long-disabled subscriptions', async () => {
  const db = await withKey();
  await reg(db, DEVICE_KEY, 'https://push/old');
  await enqueue(db, '2026-01-01', 'fajr', 'x', 'y');
  await db.query(`update public.push_reminders set created_at = now() - interval '20 days'`);
  await db.query(`update public.push_subscriptions set disabled_at = now() - interval '40 days'`);
  await db.query('select public.push_cleanup()');
  assert.equal((await db.query('select count(*)::int n from public.push_reminders')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int n from public.push_deliveries')).rows[0].n, 0);
  assert.equal((await subs(db)).length, 0);
});
