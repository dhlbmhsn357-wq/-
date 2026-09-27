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
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`;

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
};
const JSON_ARG = new Set(['p_data']);

let outage = null;      // null | 'down' (503) | 'hang'
let swVersion = null;   // when set, sw.js is served with SW_VERSION overridden (to test updates)
let swBreak = false;    // when true, sw.js precache references a missing asset (to test failed install)

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  if (Buffer.isBuffer(body) || typeof body === 'string') res.end(body);
  else res.end(JSON.stringify(body));
}
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

async function callRpc(fn, args) {
  const order = RPC[fn];
  if (!order) return { error: { message: 'not allowed' } };
  const params = order.map((k) => (JSON_ARG.has(k) ? JSON.stringify(args[k]) : args[k]));
  const casts = order.map((k, i) => `$${i + 1}${JSON_ARG.has(k) ? '::jsonb' : (k.includes('revision') || k.includes('snapshot') ? '::bigint' : (k.includes('op_id') ? '::uuid' : ''))}`);
  return tx(async () => {
    await db.exec('set role anon');
    try { const r = await db.query(`select public.${fn}(${casts.join(',')}) as d`, params); return { data: r.rows[0].d }; }
    catch (e) { return { error: { message: String(e.message || e) } }; }
    finally { await db.exec('reset role'); }
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
  if (p === '/__ctl/reset') { failEndpoints = new Set(); sentPushes.length = 0; outage = null;
    return tx(async () => { await db.exec(`truncate public.ayyam_data, public.ayyam_snapshots, public.ayyam_ops, public.push_subscriptions, public.push_reminders, public.push_deliveries restart identity cascade;`);
      send(res, 200, { ok: true }); }); }
  if (p === '/__ctl/outage') { outage = url.searchParams.get('mode') || null; return send(res, 200, { outage }); }
  if (p === '/__ctl/sw-version') { swVersion = url.searchParams.get('v') || null; swBreak = url.searchParams.get('break') === '1'; return send(res, 200, { swVersion, swBreak }); }
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
    const { fn, args } = JSON.parse(await readBody(req) || '{}');
    return send(res, 200, await callRpc(fn, args || {}));
  }
  // ---- direct table access is NOT exposed (security): always denied ----
  if (p === '/rest' && req.method === 'POST') return send(res, 403, { error: 'direct table access denied' });

  // ---- the browser-side Supabase mock ----
  if (p === '/mock-supabase.js') return send(res, 200, readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'mock-supabase.js')), MIME['.js']);

  // ---- static app files (index.html has its Supabase CDN script swapped for the mock) ----
  let file = p === '/' ? 'index.html' : p.replace(/^\//, '');
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
  send(res, 200, body, MIME[extname(full)] || 'application/octet-stream');
});

await initDb();
server.listen(PORT, () => console.log(`e2e server on http://localhost:${PORT} (device key + cron secret fixed)`));
