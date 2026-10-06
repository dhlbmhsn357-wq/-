// E2E backend: serves the real app and a mock Supabase backed by PGlite running the REAL migrations,
// so end-to-end tests exercise the actual SQL/RLS/CAS + the real reminder orchestration. Single DB
// connection guarded by a mutex (fine for tests). Control endpoints simulate outages and inspect state.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdirSync } from 'node:fs';
import * as adhan from 'adhan';
import { runCron, runTest } from '../../supabase/functions/ayyam-reminders/orchestrate.js';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEVICE_KEY = 'e2e-device-key-0123456789abcdef';
const CRON_SECRET = 'e2e-cron-secret';
const PORT = Number(process.env.E2E_PORT || 8799);

const SHIM = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create schema if not exists extensions;
  grant usage on schema public, extensions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text);
  grant usage on schema auth to anon, authenticated, service_role;
  create or replace function auth.uid() returns uuid language sql stable as $sql$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid; $sql$;
  grant execute on function auth.uid() to anon, authenticated, service_role;`;

const db = new PGlite({ extensions: { pgcrypto } });
let queue = Promise.resolve();
const tx = (fn) => (queue = queue.then(fn, fn)); // serialize all DB access

async function initDb() {
  await db.exec(SHIM);
  const dir = join(ROOT, 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));
  await db.query('select public.ayyam_set_device_key($1)', [DEVICE_KEY]);
}

// RPCs the browser is allowed to call, with their positional parameter order (run as the anon role).
const RPC = {
  ayyam_pull: ['p_key'],
  ayyam_commit: ['p_key', 'p_expected_revision', 'p_data', 'p_op_id', 'p_reason'],
  ayyam_list_snapshots: ['p_key'],
  ayyam_restore: ['p_key', 'p_snapshot_id', 'p_expected_revision', 'p_op_id'],
  register_push: ['p_key', 'p_endpoint', 'p_p256dh', 'p_auth'],
  // P2 authenticated (v2) RPCs — identity comes from the JWT (token), not a param.
  ayyam_pull_v2: [],
  ayyam_commit_v2: ['p_expected_revision', 'p_data', 'p_op_id', 'p_reason', 'p_writer_schema'],
  ayyam_goals_enabled: [],
  ayyam_list_snapshots_v2: [],
  ayyam_restore_v2: ['p_snapshot_id', 'p_expected_revision', 'p_op_id'],
  register_push_v2: ['p_endpoint', 'p_p256dh', 'p_auth'],
  ayyam_account_state_v2: [],
  ayyam_migration_begin_v2: [],
  ayyam_migration_complete_v2: [],
  ayyam_claim: ['p_key'],
  ayyam_freeze_legacy: ['p_key'],
  // P4 admin/analytics — is_admin + track (authenticated), admin read RPCs (backend-gated on is_admin()).
  is_admin: [],
  ayyam_track: ['p_name', 'p_platform', 'p_app_version', 'p_display_name'],
  ayyam_admin_overview: [],
  ayyam_admin_users: ['p_search', 'p_limit', 'p_offset', 'p_sort', 'p_dir'],
  // P5 onboarding
  ayyam_onboarding_get: [],
  ayyam_onboarding_progress: ['p_step', 'p_done', 'p_via'],
};
const JSON_ARG = new Set(['p_data']);
const authUsers = new Map();  // email → { id, password } (mock GoTrue)

let outage = null;      // null | 'down' (503) | 'hang'
let swVersion = null;   // when set, sw.js is served with SW_VERSION overridden (to test updates)
let swBreak = false;    // when true, sw.js precache references a missing asset (to test failed install)

function send(res, code, body, type = 'application/json', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', ...extra });
  if (Buffer.isBuffer(body) || typeof body === 'string') res.end(body);
  else res.end(JSON.stringify(body));
}

// Phase 7: serve the app under the SAME CSP as production (parsed from vercel.json) so E2E catches
// real policy violations. upgrade-insecure-requests is stripped — it would break the http localhost harness.
const PROD_CSP = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'))
  .headers.find((h) => h.source === '/(.*)').headers.find((h) => h.key === 'Content-Security-Policy').value;
const E2E_CSP = PROD_CSP.split(';').map((s) => s.trim()).filter((s) => s && !/^upgrade-insecure-requests$/.test(s)).join('; ');
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

async function callRpc(fn, args, token) {
  const order = RPC[fn];
  if (!order) return { error: { message: 'not allowed' } };
  const params = order.map((k) => (JSON_ARG.has(k) ? JSON.stringify(args[k]) : args[k]));
  const casts = order.map((k, i) => `$${i + 1}${JSON_ARG.has(k) ? '::jsonb' : (k.includes('revision') || k.includes('snapshot') ? '::bigint' : (k.includes('op_id') ? '::uuid' : (k === 'p_limit' || k === 'p_offset' || k === 'p_step' ? '::int' : '')))}`);
  // A token (mock JWT = the user's uid) runs the call as the `authenticated` role with auth.uid()=token,
  // exactly as PostgREST does for a signed-in supabase-js client. No token → the legacy `anon` path.
  return tx(async () => {
    if (token) { await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: token, role: 'authenticated' })]); await db.exec('set role authenticated'); }
    else { await db.exec('set role anon'); }
    try { const r = await db.query(`select public.${fn}(${casts.join(',')}) as d`, params); return { data: r.rows[0].d }; }
    catch (e) { return { error: { message: String(e.message || e) } }; }
    finally { await db.exec('reset role'); if (token) await db.query("select set_config('request.jwt.claims', '', false)"); }
  });
}

// A Supabase-JS shim (service role, bypasses RLS) over PGlite for the reminder orchestration.
function serviceSb() {
  return {
    from(table) {
      const st = { table, cols: '*', filters: [], isNull: [], op: 'select', patch: null };
      const api = { select(c) { st.cols = c || '*'; return api; }, eq(k, v) { st.filters.push([k, v]); return api; },
        is(k) { st.isNull.push(k); return api; }, update(p) { st.op = 'update'; st.patch = p; return api; },
        async maybeSingle() { const rows = await run(); return { data: rows[0] ?? null, error: null }; },
        then(res, rej) { return run().then((rows) => res({ data: rows, error: null }), rej); } };
      async function run() {
        return tx(async () => {
          const where = [...st.filters.map(([k], i) => `${k}=$${i + 1}`), ...st.isNull.map((k) => `${k} is null`)].join(' and ');
          const params = st.filters.map(([, v]) => v);
          if (st.op === 'update') { const keys = Object.keys(st.patch); const set = keys.map((k, i) => `${k}=$${params.length + i + 1}`).join(', ');
            await db.query(`update public.${st.table} set ${set}${where ? ' where ' + where : ''}`, [...params, ...keys.map((k) => st.patch[k])]); return []; }
          const r = await db.query(`select ${st.cols} from public.${st.table}${where ? ' where ' + where : ''}`, params); return r.rows;
        });
      }
      return api;
    },
    async rpc(fn, args) {
      const names = Object.keys(args);
      return tx(async () => {
        const r = await db.query(`select public.${fn}(${names.map((_, i) => `$${i + 1}`).join(',')}) as d`, names.map((n) => (typeof args[n] === 'object' && args[n] !== null ? JSON.stringify(args[n]) : args[n])));
        return { data: r.rows[0].d, error: null };
      });
    },
  };
}
const sentPushes = []; // captured "sends" for assertions
let failEndpoints = new Set(); // endpoints the fake provider should fail (statusCode)
const fakeSend = async (item) => {
  const code = failEndpoints.get ? failEndpoints.get(item.endpoint) : (failEndpoints.has(item.endpoint) ? 410 : null);
  if (code) { const e = new Error('fail'); e.statusCode = code; throw e; }
  sentPushes.push(item.endpoint);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '');

  // ---- control endpoints (tests only) ----
  if (p === '/__ctl/reset') { failEndpoints = new Set(); sentPushes.length = 0; outage = null; authUsers.clear();
    return tx(async () => {
      await db.exec(`truncate public.ayyam_data, public.ayyam_snapshots, public.ayyam_ops, public.push_subscriptions, public.push_reminders, public.push_deliveries restart identity cascade;`);
      // P1/P2/P4 account state (best-effort — present only after those migrations): reset for test isolation.
      await db.exec(`truncate public.profiles, public.user_roles, public.user_account_state cascade;`).catch(() => {});
      await db.exec(`truncate public.ayyam_events restart identity;`).catch(() => {});
      await db.exec(`delete from auth.users;`).catch(() => {});
      await db.exec(`update public.ayyam_legacy_claim set claimed_by=null, claimed_at=null, frozen=false, frozen_at=null where row_id='main';`).catch(() => {});
      send(res, 200, { ok: true }); }); }
  if (p === '/__ctl/outage') { outage = url.searchParams.get('mode') || null; return send(res, 200, { outage }); }
  // Grant admin the ONLY legitimate way (service_role, like the SQL editor). Tests use this to become admin.
  if (p === '/__ctl/make-admin') { const email = url.searchParams.get('email') || '';
    const u = authUsers.get(email); if (!u) return send(res, 404, { error: 'no such user' });
    return tx(async () => { await db.exec('set role service_role');
      try { await db.query("insert into public.user_roles (user_id, role) values ($1,'admin') on conflict (user_id) do update set role='admin'", [u.id]); }
      finally { await db.exec('reset role'); }
      send(res, 200, { ok: true, uid: u.id }); }); }
  if (p === '/__ctl/goals-pilot') { const email = url.searchParams.get('email') || '';
    const u = authUsers.get(email); if (!u) return send(res, 404, { error: 'no such user' });
    return tx(async () => { await db.exec('set role service_role');
      try { await db.query('insert into public.ayyam_goals_pilot (user_id) values ($1) on conflict do nothing', [u.id]); }
      finally { await db.exec('reset role'); }
      send(res, 200, { ok: true, uid: u.id }); }); }
  if (p === '/__ctl/sw-version') { swVersion = url.searchParams.get('v') || null; swBreak = url.searchParams.get('break') === '1'; return send(res, 200, { swVersion, swBreak }); }
  if (p === '/__ctl/account-row') return tx(async () => { // the single account (u:*) row, for account-mode sync assertions
    const row = (await db.query(`select id, revision, epoch, data from public.ayyam_data where id like 'u:%' order by updated_at desc limit 1`)).rows[0] || null;
    send(res, 200, { row });
  });
  if (p === '/__ctl/db') return tx(async () => {
    const main = (await db.query(`select revision, epoch, data from public.ayyam_data where id='main'`)).rows[0] || null;
    const subs = (await db.query(`select endpoint, disabled_at, p256dh, auth from public.push_subscriptions order by created_at`)).rows;
    const snaps = (await db.query(`select reason from public.ayyam_snapshots order by id`)).rows.map((r) => r.reason);
    send(res, 200, { main, subs, snaps, sent: sentPushes.slice() });
  });
  if (p === '/__ctl/fail-endpoint') { const ep = url.searchParams.get('endpoint'); const code = Number(url.searchParams.get('code') || 410);
    failEndpoints = new Map([[ep, code]]); return send(res, 200, { ok: true }); }
  if (p === '/__ctl/run-cron') {
    const now = new Date(url.searchParams.get('now') || Date.now());
    if ((url.searchParams.get('secret') || '') !== CRON_SECRET) return send(res, 401, { error: 'unauthorized' });
    const before = sentPushes.length;
    const r = await runCron(serviceSb(), adhan, fakeSend, now);
    return send(res, 200, { ...r, sent_now: sentPushes.slice(before) });
  }
  if (p === '/__ctl/run-test') { // test-mode reminder (isolated)
    if ((url.searchParams.get('key') || '') !== 'e2e-test-key') return send(res, 401, { error: 'unauthorized' });
    const before = sentPushes.length; const r = await runTest(serviceSb(), fakeSend); return send(res, 200, { ...r, sent_now: sentPushes.slice(before) });
  }

  // ---- mock Supabase RPC (as the browser calls it) ----
  if (p === '/rpc' && req.method === 'POST') {
    if (outage === 'down') return send(res, 503, { error: 'unreachable' });
    if (outage === 'hang') return; // never responds → client timeout
    const { fn, args, token } = JSON.parse(await readBody(req) || '{}');
    return send(res, 200, await callRpc(fn, args || {}, token));
  }
  // ---- direct table access is NOT exposed (security): always denied ----
  if (p === '/rest' && req.method === 'POST') return send(res, 403, { error: 'direct table access denied' });

  // ---- mock GoTrue auth (E2E only): create/lookup auth.users, issue a session whose token IS the uid ----
  if (p === '/__auth/signup' && req.method === 'POST') {
    const { email, password, data } = JSON.parse(await readBody(req) || '{}');
    if (!email || !password || password.length < 6) return send(res, 200, { error: { message: 'password should be at least 6 characters' } });
    if (authUsers.has(email)) return send(res, 200, { error: { message: 'already registered' } });
    const id = randomUUID();
    const display_name = (data && data.display_name) || null;
    authUsers.set(email, { id, password, display_name });
    await tx(async () => { await db.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [id, email]); });
    return send(res, 200, { session: { access_token: id, user: { id, email, user_metadata: { display_name } } } });
  }
  if (p === '/__auth/signin' && req.method === 'POST') {
    const { email, password } = JSON.parse(await readBody(req) || '{}');
    const u = authUsers.get(email);
    if (!u || u.password !== password) return send(res, 200, { error: { message: 'invalid login credentials' } });
    return send(res, 200, { session: { access_token: u.id, user: { id: u.id, email, user_metadata: { display_name: u.display_name || null } } } });
  }
  // Password reset: request-email is always a 200 (no account enumeration); update sets a new password for
  // the recovery-session user (token = uid).
  if (p === '/__auth/reset' && req.method === 'POST') { return send(res, 200, { ok: true }); }
  if (p === '/__auth/update' && req.method === 'POST') {
    const { token, password } = JSON.parse(await readBody(req) || '{}');
    if (!token || !password || password.length < 6) return send(res, 200, { error: { message: 'password should be at least 6 characters' } });
    let hit = null; for (const [email, u] of authUsers) { if (u.id === token) { u.password = password; hit = { id: u.id, email }; break; } }
    if (!hit) return send(res, 200, { error: { message: 'no recovery session' } });
    return send(res, 200, { user: hit });
  }

  // ---- the browser-side Supabase mock ----
  if (p === '/mock-supabase.js') return send(res, 200, readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'mock-supabase.js')), MIME['.js']);

  // ---- static app files (index.html has its Supabase CDN script swapped for the mock) ----
  // mirror the production vercel.json rewrite so /download serves the download landing page in E2E too
  const servePath = (p === '/download') ? '/download.html' : p;
  let file = servePath === '/' ? 'index.html' : servePath.replace(/^\//, '');
  const full = join(ROOT, file);
  if (!full.startsWith(ROOT) || !existsSync(full)) return send(res, 404, 'not found', 'text/plain');
  let body = readFileSync(full);
  if (file === 'index.html') {
    body = body.toString('utf8').replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase[^>]*><\/script>/, '<script src="/mock-supabase.js"></script>');
  } else if (file === 'sw.js') {
    let s = body.toString('utf8');
    if (swVersion) s = s.replace(/const SW_VERSION = '[^']*';/, `const SW_VERSION = '${swVersion}';`);
    if (swBreak) s = s.replace("'manifest.webmanifest',", "'manifest.webmanifest', 'missing-asset-xyz.js',");
    body = s;
  }
  send(res, 200, body, MIME[extname(full)] || 'application/octet-stream',
    file === 'index.html' ? { 'Content-Security-Policy': E2E_CSP } : {});
});

await initDb();
server.listen(PORT, () => console.log(`e2e server on http://localhost:${PORT} (device key + cron secret fixed)`));
