// Phase G — the "other device" for the Android WebView↔backend sync E2E. A headless client that talks
// to the SAME isolated backend (tests/e2e/server.mjs) as the Android WebView, using the SAME real
// conflict engine (js/sync-model.js) the app uses — so it is a faithful stand-in for a Web/PWA device.
// It mirrors the app's syncNow: pull → merge(base, mine, server) → compare-and-swap commit (retry on
// conflict). Stateless: each run pulls current server state, applies one edit, commits. Runs on the CI
// host (reaches the backend at localhost); the WebView reaches the same backend at 10.0.2.2.
//
// Usage: node scripts/e2e-peer.mjs <cmd> [arg] [--base http://localhost:8799]
//   pull                 print {status, revision, epoch, titles:[...]}
//   add "<title>"        add a template task titled <title>
//   delete "<title>"     remove every task titled <title>
//   reset                new generation (epoch+1), wipes to a single RESET-MARKER task
//   import "<title>"     new generation (epoch+1) containing a single task titled <title>
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../js/sync-model.js', import.meta.url), 'utf8'), { filename: 'js/sync-model.js' });
const M = globalThis.AyyamModel;

const KEY = 'e2e-device-key-0123456789abcdef'; // fixed E2E device key (matches tests/e2e/server.mjs)
const PEER = 'web-peer-device';                 // stable device id for LWW tie-breaks
const argv = process.argv.slice(2);
const baseIx = argv.indexOf('--base');
const BASE = baseIx >= 0 ? argv[baseIx + 1] : (process.env.E2E_BASE || 'http://localhost:8799');
const cmd = argv[0];
const arg = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;

async function rpc(fn, args) {
  const res = await fetch(BASE + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) });
  const j = await res.json();
  if (j.error) throw new Error(fn + ' failed: ' + (j.error.message || 'error'));
  return j.data;
}

function titles(en) {
  const m = M.materialize(en); const out = [];
  for (const dc of M.DAY_CODES) for (const t of m.template[dc]) out.push(t.title);
  for (const k of Object.keys(m.logs)) for (const t of (m.logs[k].extra || [])) out.push(t.title);
  return out.sort();
}

async function pull() {
  const p = await rpc('ayyam_pull', { p_key: KEY });
  if (p.status === 'unauthorized') throw new Error('unauthorized (wrong device key)');
  const serverEn = p.exists ? M.toEnriched(p.data, 1) : M.empty(0);
  const serverRev = p.exists ? p.revision : 0;
  return { serverEn, serverRev, epoch: p.exists ? p.epoch : 0, exists: !!p.exists };
}

// Pull, apply `mutate` to the materialized bundle, commit via CAS (retry on conflict). newGeneration
// (reset/import) bumps the epoch so it fences older devices. Returns the final commit result.
async function commitEdit(reason, mutate, newGeneration) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { serverEn, serverRev } = await pull();
    const mat = M.materialize(serverEn);
    const next = mutate(mat) || mat;
    const now = Date.now();
    const mine = newGeneration ? M.bumpEpoch(serverEn, next, now, PEER) : M.enrich(serverEn, next, now, PEER);
    const res = M.merge(serverEn, mine, serverEn);
    const merged = M.pruneTombstones(res.merged, now);
    const c = await rpc('ayyam_commit', {
      p_key: KEY, p_expected_revision: serverRev, p_data: merged,
      p_op_id: crypto.randomUUID(), p_reason: reason,
    });
    if (c.status === 'conflict') { await new Promise((r) => setTimeout(r, 120 * (attempt + 1))); continue; }
    if (c.status === 'ok' || c.status === 'duplicate') return c;
    throw new Error('commit rejected: ' + JSON.stringify(c));
  }
  throw new Error('commit exhausted retries (conflict)');
}

function addTask(mat, title) {
  mat.template.sat = mat.template.sat.concat([{ id: 'peer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), title, time: '', period: 'dhuhr' }]);
  return mat;
}
function deleteTask(mat, title) {
  for (const dc of M.DAY_CODES) mat.template[dc] = mat.template[dc].filter((t) => t.title !== title);
  for (const k of Object.keys(mat.logs)) mat.logs[k].extra = (mat.logs[k].extra || []).filter((t) => t.title !== title);
  return mat;
}
function freshWith(title) {
  const m = M.sanitizeMaterialized({});
  m.template.sat = [{ id: 'gen-' + Date.now().toString(36), title, time: '', period: 'dhuhr' }];
  return m;
}

async function main() {
  if (cmd === 'pull') {
    const { serverEn, serverRev, epoch, exists } = await pull();
    console.log(JSON.stringify({ status: 'ok', exists, revision: serverRev, epoch, titles: titles(serverEn) }));
    return;
  }
  if (cmd === 'add') { if (!arg) throw new Error('add needs a title'); const c = await commitEdit('sync', (m) => addTask(m, arg), false); console.log('ADD ok rev=' + c.revision + ' epoch=' + c.epoch); return; }
  if (cmd === 'delete') { if (!arg) throw new Error('delete needs a title'); const c = await commitEdit('sync', (m) => deleteTask(m, arg), false); console.log('DELETE ok rev=' + c.revision + ' epoch=' + c.epoch); return; }
  if (cmd === 'reset') { const c = await commitEdit('reset', () => freshWith('RESET-MARKER'), true); console.log('RESET ok rev=' + c.revision + ' epoch=' + c.epoch); return; }
  if (cmd === 'import') { if (!arg) throw new Error('import needs a title'); const c = await commitEdit('import', () => freshWith(arg), true); console.log('IMPORT ok rev=' + c.revision + ' epoch=' + c.epoch); return; }
  throw new Error('unknown command: ' + cmd);
}
main().catch((e) => { console.error('PEER-ERROR ' + (e && e.message || e)); process.exit(1); });
