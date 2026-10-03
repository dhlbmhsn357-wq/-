// P4 — admin dashboard + product analytics: blocking security + correctness.
// Proves: analytics carry NO personal content; identity is derived server-side (no spoofing); admin RPCs are
// backend-gated (non-admin forbidden, anon denied); role cannot be forged; events/presence not directly
// readable; overview aggregates + users-table pagination/search/sort are correct and identity-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, createUser, asUser, asAnon, rpc2, grantAdmin } from './helpers.mjs';

const DAY = 86400000;
async function backdate(db, uid, { createdMs, lastSeenMs }) {
  await db.query('set role service_role');
  try {
    if (createdMs != null) await db.query('update public.profiles set created_at = $2 where id = $1', [uid, new Date(Date.now() - createdMs).toISOString()]);
    if (lastSeenMs != null) await db.query('update public.profiles set last_seen_at = $2 where id = $1', [uid, new Date(Date.now() - lastSeenMs).toISOString()]);
  } finally { await db.exec('reset role'); }
}
async function seedUser(db, email, { name, platform = 'web', ver = '5.3.0', onboarded = false } = {}) {
  const id = await createUser(db, email);
  await rpc2.track(db, id, { name: 'app_open', platform, appVersion: ver, displayName: name || email });
  if (onboarded) await rpc2.track(db, id, { name: 'onboarding_completed', platform, appVersion: ver });
  return id;
}

test('track records a whitelisted event + refreshes presence, deriving identity from auth.uid()', async () => {
  const db = await freshDb();
  const a = await createUser(db, 'a@t.test');
  const r = await rpc2.track(db, a, { name: 'app_open', platform: 'android', appVersion: '5.3.0', displayName: 'أحمد' });
  assert.equal(r.status, 'ok');
  const p = (await db.query('select * from public.profiles where id = $1', [a])).rows[0];
  assert.equal(p.platform_last_seen, 'android');
  assert.equal(p.app_version_last_seen, '5.3.0');
  assert.equal(p.display_name, 'أحمد');
  assert.ok(p.created_at && p.last_seen_at);
  const ev = (await db.query('select name, platform from public.ayyam_events where user_id = $1', [a])).rows;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].name, 'app_open');
});

test('track ignores unknown (non-whitelisted) event names — no row is written', async () => {
  const db = await freshDb();
  const a = await createUser(db, 'a@t.test');
  const r = await rpc2.track(db, a, { name: 'dump_all_tasks', platform: 'android' });
  assert.equal(r.status, 'ignored');
  const n = (await db.query('select count(*)::int c from public.ayyam_events')).rows[0].c;
  assert.equal(n, 0);
});

test('onboarding_completed stamps the profile once; presence is per-user (A cannot affect B)', async () => {
  const db = await freshDb();
  const a = await createUser(db, 'a@t.test');
  const b = await createUser(db, 'b@t.test');
  await rpc2.track(db, a, { name: 'app_open', platform: 'android', appVersion: '5.3.0' });
  await rpc2.track(db, b, { name: 'app_open', platform: 'web', appVersion: '5.3.0' });
  await rpc2.track(db, a, { name: 'onboarding_completed' });
  const pa = (await db.query('select platform_last_seen, onboarding_completed_at from public.profiles where id=$1', [a])).rows[0];
  const pb = (await db.query('select platform_last_seen, onboarding_completed_at from public.profiles where id=$1', [b])).rows[0];
  assert.equal(pa.platform_last_seen, 'android');
  assert.ok(pa.onboarding_completed_at);
  assert.equal(pb.platform_last_seen, 'web');   // untouched by A's activity
  assert.equal(pb.onboarding_completed_at, null);
});

test('product events + presence are NOT directly readable by anon or authenticated', async () => {
  const db = await freshDb();
  const a = await createUser(db, 'a@t.test');
  await rpc2.track(db, a, { name: 'app_open', platform: 'web' });
  await assert.rejects(asUser(db, a, 'select * from public.ayyam_events'), /permission denied/);
  await assert.rejects(asAnon(db, 'select * from public.ayyam_events'), /permission denied/);
});

test('a normal user cannot forge the admin role (user_roles is not writable), so is_admin stays false', async () => {
  const db = await freshDb();
  const a = await createUser(db, 'a@t.test');
  await assert.rejects(
    asUser(db, a, "insert into public.user_roles (user_id, role) values ($1,'admin')", [a]),
    /permission denied/);
  assert.equal(await rpc2.isAdmin(db, a), false);
});

test('admin RPCs are backend-gated: non-admin gets forbidden, anon is denied outright', async () => {
  const db = await freshDb();
  const a = await createUser(db, 'a@t.test');
  await rpc2.track(db, a, { name: 'app_open', platform: 'web' });
  assert.equal((await rpc2.adminOverview(db, a)).status, 'forbidden');
  assert.equal((await rpc2.adminUsers(db, a)).status, 'forbidden');
  await assert.rejects(asAnon(db, 'select public.ayyam_admin_overview()'), /permission denied/);
  await assert.rejects(asAnon(db, 'select public.ayyam_admin_users()'), /permission denied/);
});

test('admin overview returns correct aggregates (totals, active, platform split, onboarding %)', async () => {
  const db = await freshDb();
  const admin = await createUser(db, 'admin@t.test');
  await rpc2.track(db, admin, { name: 'app_open', platform: 'android', appVersion: '5.3.0', displayName: 'المشرف' });
  await grantAdmin(db, admin);
  assert.equal(await rpc2.isAdmin(db, admin), true);
  await seedUser(db, 'u1@t.test', { platform: 'android', ver: '5.3.0', onboarded: true });
  await seedUser(db, 'u2@t.test', { platform: 'web', ver: '5.3.0' });
  await seedUser(db, 'u3@t.test', { platform: 'pwa', ver: '5.2.0' });
  await seedUser(db, 'u4@t.test', { platform: 'android', ver: '5.2.0' });

  const ov = await rpc2.adminOverview(db, admin);
  assert.equal(ov.status, 'ok');
  assert.equal(ov.users.total, 5);
  assert.equal(ov.users.new_today, 5);
  assert.equal(ov.active.today, 5);
  assert.equal(ov.platform.android, 3);          // admin + u1 + u4
  assert.equal(ov.platform.web, 2);              // u2(web) + u3(pwa)
  assert.equal(ov.platform.unknown, 0);
  const verTotal = ov.versions.reduce((s, v) => s + Number(v.count), 0);
  assert.equal(verTotal, 5);                      // distribution partitions every user
  assert.equal(ov.onboarding.completed, 1);       // u1 only
  assert.equal(ov.onboarding.total, 5);
  assert.equal(Number(ov.onboarding.pct), 20);
});

test('overview new/active windows respect created_at and last_seen_at', async () => {
  const db = await freshDb();
  const admin = await createUser(db, 'admin@t.test');
  await rpc2.track(db, admin, { name: 'app_open', platform: 'web' });
  await grantAdmin(db, admin);
  const old = await seedUser(db, 'old@t.test', { platform: 'web' });
  await backdate(db, old, { createdMs: 10 * DAY, lastSeenMs: 10 * DAY }); // 10 days ago

  const ov = await rpc2.adminOverview(db, admin);
  assert.equal(ov.users.total, 2);
  assert.equal(ov.users.new_today, 1);   // only admin
  assert.equal(ov.users.new_7d, 1);      // old is 10d → excluded
  assert.equal(ov.users.new_30d, 2);     // both within 30d
  assert.equal(ov.active.today, 1);
  assert.equal(ov.active.d7, 1);
  assert.equal(ov.active.d30, 2);
});

test('admin users table: server-side pagination + total, and rows carry ONLY identity/presence (no content)', async () => {
  const db = await freshDb();
  const admin = await createUser(db, 'admin@t.test');
  await rpc2.track(db, admin, { name: 'app_open', platform: 'web', displayName: 'Zaid' });
  await grantAdmin(db, admin);
  for (let i = 0; i < 6; i++) await seedUser(db, `p${i}@t.test`, { name: `User${i}`, platform: i % 2 ? 'android' : 'web' });

  const page = await rpc2.adminUsers(db, admin, { limit: 3, offset: 0, sort: 'created_at', dir: 'asc' });
  assert.equal(page.status, 'ok');
  assert.equal(page.total, 7);            // admin + 6
  assert.equal(page.rows.length, 3);      // page size honoured
  // privacy: every row exposes ONLY the allowed identity/presence keys — never task/log content.
  const allowed = new Set(['user_id', 'name', 'email', 'created_at', 'last_seen_at', 'platform', 'app_version', 'status']);
  for (const r of page.rows) {
    for (const k of Object.keys(r)) assert.ok(allowed.has(k), `unexpected key leaked: ${k}`);
    assert.ok(!('data' in r) && !('logs' in r) && !('template' in r));
  }
  const page2 = await rpc2.adminUsers(db, admin, { limit: 3, offset: 3, sort: 'created_at', dir: 'asc' });
  assert.equal(page2.rows.length, 3);
  const seen = new Set([...page.rows, ...page2.rows].map((r) => r.user_id));
  assert.equal(seen.size, 6);             // no overlap between consecutive pages
});

test('admin users table: search by name/email and whitelisted sort', async () => {
  const db = await freshDb();
  const admin = await createUser(db, 'admin@t.test');
  await rpc2.track(db, admin, { name: 'app_open', platform: 'web', displayName: 'Admin' });
  await grantAdmin(db, admin);
  await seedUser(db, 'salma@t.test', { name: 'سلمى' });
  await seedUser(db, 'khaled@t.test', { name: 'خالد' });

  const byName = await rpc2.adminUsers(db, admin, { search: 'سلمى' });
  assert.equal(byName.total, 1);
  assert.equal(byName.rows[0].email, 'salma@t.test');
  const byEmail = await rpc2.adminUsers(db, admin, { search: 'khaled@' });
  assert.equal(byEmail.total, 1);
  assert.equal(byEmail.rows[0].name, 'خالد');
  // sort direction works (independent of DB collation): desc is the exact reverse of asc (no null names here)
  const asc = (await rpc2.adminUsers(db, admin, { sort: 'name', dir: 'asc' })).rows.map((r) => r.name);
  const desc = (await rpc2.adminUsers(db, admin, { sort: 'name', dir: 'desc' })).rows.map((r) => r.name);
  assert.equal(asc.length, 3);
  assert.deepEqual(desc, [...asc].reverse());
});
