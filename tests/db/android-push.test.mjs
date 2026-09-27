import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asAnon, setKey, DEVICE_KEY } from './helpers.mjs';

const call = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
const regA = (db, key, token, dev = 'devA') =>
  asAnon(db, 'select public.register_android_push($1,$2,$3) r', [key, token, dev]).then((r) => r.rows[0].r);
const regWeb = (db, key, ep) =>
  asAnon(db, 'select public.register_push($1,$2,$3,$4) r', [key, ep, 'p', 'a']).then((r) => r.rows[0].r);
const enqueue = (db, day, period, title, body, tag = 't') =>
  call(db, 'select public.push_enqueue($1,$2,$3,$4,$5) r', [day, period, title, body, tag]).then((r) => r.r);
const claim = (db, limit = 50, lease = 60) => call(db, 'select public.push_claim($1,$2) r', [limit, lease]).then((r) => r.r);
const androidRows = (db) => db.query('select id, token, device_id, disabled_at, failure_count from public.android_push_subscriptions order by id').then((r) => r.rows);

async function withKey() { const db = await freshDb(); await setKey(db); return db; }
const TOKEN = 'fcm-token-abcdefghijklmnop-0001';

test('register_android_push: first insert, same token no dup, rotated token = new row', async () => {
  const db = await withKey();
  assert.deepEqual(await regA(db, DEVICE_KEY, TOKEN), { status: 'ok', existed: false });
  assert.equal((await androidRows(db)).length, 1);
  assert.deepEqual(await regA(db, DEVICE_KEY, TOKEN), { status: 'ok', existed: true }); // idempotent
  assert.equal((await androidRows(db)).length, 1);
  await regA(db, DEVICE_KEY, 'fcm-token-rotated-xxxxxxxx-0002');                         // token refresh → new row
  assert.equal((await androidRows(db)).length, 2);
});

test('register_android_push: wrong device key is unauthorized, no row written', async () => {
  const db = await withKey();
  assert.equal((await regA(db, 'wrong-key-wrong-key-wrong', TOKEN)).status, 'unauthorized');
  assert.equal((await androidRows(db)).length, 0);
});

test('register_android_push: too-short token is invalid', async () => {
  const db = await withKey();
  assert.equal((await regA(db, DEVICE_KEY, 'short')).status, 'invalid');
  assert.equal((await androidRows(db)).length, 0);
});

test('the browser (anon) cannot read or write the android token table directly', async () => {
  const db = await withKey();
  await regA(db, DEVICE_KEY, TOKEN);
  const read = await asAnon(db, 'select * from public.android_push_subscriptions', []);
  assert.equal(read.rows.length, 0, 'RLS must hide rows from anon');
  await assert.rejects(
    asAnon(db, "insert into public.android_push_subscriptions(token) values ('x-direct')", []),
    'anon must not insert directly',
  );
});

test('enqueue fans out to BOTH web and android; claim returns channel-aware targets', async () => {
  const db = await withKey();
  await regWeb(db, DEVICE_KEY, 'https://push/web1');
  await regA(db, DEVICE_KEY, TOKEN);
  const r = await enqueue(db, '2026-09-28', 'fajr', 'أيام', 'ذكّر', 'tag1');
  assert.equal(r.status, 'created');
  assert.equal(r.web, 1);
  assert.equal(r.fcm, 1);
  const batch = await claim(db);
  assert.equal(batch.length, 2);
  const web = batch.find((b) => b.channel === 'webpush');
  const fcm = batch.find((b) => b.channel === 'fcm');
  assert.ok(web && web.endpoint === 'https://push/web1' && !web.token);
  assert.ok(fcm && fcm.token === TOKEN && !fcm.endpoint);
  assert.equal(fcm.title, 'أيام');
});

test('push_disable_android disables the token and skips its open deliveries', async () => {
  const db = await withKey();
  await regA(db, DEVICE_KEY, TOKEN);
  await enqueue(db, '2026-09-28', 'asr', 'أيام', 'ذكّر');
  const batch = await claim(db);
  const fcm = batch.find((b) => b.channel === 'fcm');
  await call(db, 'select public.push_disable_android($1,$2)', [fcm.delivery_id, 'UNREGISTERED']);
  const rows = await androidRows(db);
  assert.ok(rows[0].disabled_at, 'token should be disabled');
  assert.equal(rows[0].failure_count, 1);
  // a fresh enqueue must NOT create a delivery for the disabled token
  const r2 = await enqueue(db, '2026-09-29', 'asr', 'أيام', 'ذكّر');
  assert.equal(r2.fcm, 0);
});
