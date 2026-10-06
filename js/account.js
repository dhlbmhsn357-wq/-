// Account + sync-identity layer for the public launch (P2). Classic script: sets globalThis.AyyamAccount.
// Depends on globalThis.AyyamModel (enriched merge). Pure where it matters: the legacy→account MIGRATION
// engine takes an injected `backend` (the *_v2 RPCs) + `model`, so it is deterministic and unit/DB-tested
// without a browser. Thin browser wrappers (auth session, per-user DB name) live here too.
//
// Two runtime modes:
//   * legacy  : no auth session → the shipped v1.1.2 path (device key, id='main', ayyam_pull/commit). UNCHANGED.
//   * account : an authenticated session → per-user row id='u:'||uid via the authenticated *_v2 RPCs.
// A legacy install with real data migrates ONCE into its account (recovery → claim → pull → deterministic
// merge with local+pending → CAS commit → verify → mark complete); the flow is idempotent and resumable
// (safe after a mid-migration crash: a stable op_id makes the commit a no-op 'duplicate' on retry).
(function (global) {
  'use strict';
  const M = () => global.AyyamModel;
  const LEGACY_DB = 'ayyam';
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Per-user IndexedDB name — a DIFFERENT database per account, so switching accounts on one device can
  // never expose another account's cache/outbox/recovery/diag. The legacy pre-auth DB stays 'ayyam'.
  function dbNameFor(uid) { return (typeof uid === 'string' && uid) ? ('ayyam::u:' + uid) : LEGACY_DB; }

  // Classify a Supabase/PostgREST RPC error into a SAFE reason (never contains tokens/passwords). Used so the
  // app can tell "the account schema/RPCs aren't deployed on this backend" apart from a network failure, an
  // expired session, or RLS — for honest, non-leaking diagnostics.
  function classifyRpcError(error) {
    if (!error) return null;
    var code = String(error.code || ''); var msg = String(error.message || '').toLowerCase();
    if (code === 'PGRST202' || code === 'PGRST205' || code === '42883' || code === '42P01' ||
        msg.indexOf('could not find the function') >= 0 || msg.indexOf('does not exist') >= 0 ||
        msg.indexOf('schema cache') >= 0 || msg.indexOf('not find the table') >= 0) return 'schema_missing';
    if (code === '401' || code === 'PGRST301' || msg.indexOf('jwt') >= 0 || msg.indexOf('not authenticated') >= 0 || msg.indexOf('unauthorized') >= 0) return 'unauthorized';
    if (code === '42501' || msg.indexOf('permission denied') >= 0) return 'forbidden';
    if (msg.indexOf('failed to fetch') >= 0 || msg.indexOf('network') >= 0 || msg.indexOf('timeout') >= 0) return 'network';
    return 'error';
  }
  async function rpcRes(sb, fn, args) { try { var r = await sb.rpc(fn, args || {}); return r || { data: null, error: { message: 'no response' } }; } catch (e) { return { data: null, error: e }; } }

  // The writer-schema this client guarantees: 3 = "Goals-safe" (preserves unknown register families in enrich(),
  // so it never tombstones a newer feature's records). The commit RPC refuses a writer below the configured
  // minimum when the row already holds goal:* data, which is what lets Goals launch safely. Older signatures
  // (4 args) resolve to the server default (2); passing it explicitly is additive and backward-compatible.
  var WRITER_SCHEMA = 3;

  // ---- sync backends: same shape { pull, commit }, chosen by session ----
  // v2 (authenticated): identity comes from the JWT the supabase client already attached; NO device key.
  function v2Backend(sb) {
    return {
      mode: 'account',
      pull: async () => { var r = await rpcRes(sb, 'ayyam_pull_v2', {}); if (r.error) return { status: 'error', reason: classifyRpcError(r.error) }; return r.data; },
      commit: async (expected, data, opId, reason) => {
        var r = await rpcRes(sb, 'ayyam_commit_v2', { p_expected_revision: expected, p_data: data, p_op_id: opId, p_reason: reason, p_writer_schema: WRITER_SCHEMA });
        if (r.error) return { status: 'error', reason: classifyRpcError(r.error) };
        return r.data;
      },
      claim: async (deviceKey) => (await sb.rpc('ayyam_claim', { p_key: deviceKey })).data,
      begin: async () => (await sb.rpc('ayyam_migration_begin_v2', {})).data,
      complete: async () => (await sb.rpc('ayyam_migration_complete_v2', {})).data,
      accountState: async () => (await sb.rpc('ayyam_account_state_v2', {})).data,
    };
  }
  // legacy (device key): the shipped path, unchanged. Kept so a signed-out user still works exactly as before.
  function legacyBackend(sb, key) {
    return {
      mode: 'legacy',
      pull: async () => (await sb.rpc('ayyam_pull', { p_key: key })).data,
      commit: async (expected, data, opId, reason) =>
        (await sb.rpc('ayyam_commit', { p_key: key, p_expected_revision: expected, p_data: data, p_op_id: opId, p_reason: reason })).data,
    };
  }

  // ---- the migration engine (pure orchestration over an injected backend) ----
  // opts: { localEnriched, migrationOpId (stable UUID persisted before first commit), now, maxAttempts }
  // Returns { status, merged?, revision? }. status: 'ok' | 'already_claimed' | 'unauthorized' | 'verify_failed'
  //  | 'exhausted' | 'invalid' | 'too_large'. Never throws for a normal backend response.
  async function migrate(backend, opts) {
    const model = M();
    opts = opts || {};
    const local = opts.localEnriched || model.empty(0);
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const opId = opts.migrationOpId;
    const maxAttempts = opts.maxAttempts || 6;

    const claim = await backend.claim(opts.deviceKey);
    if (!claim || claim.status !== 'ok') return { status: (claim && claim.status) || 'error' };
    await backend.begin(); // server: in_progress (idempotent; never regresses a completed migration)

    const legacyEn = claim.legacy && claim.legacy.exists ? model.toEnriched(claim.legacy.data, 1) : model.empty(0);
    let acctEn = claim.account && claim.account.exists ? model.toEnriched(claim.account.data, 1) : model.empty(0);
    let expected = claim.account && claim.account.exists ? claim.account.revision : 0;
    // deterministic merge: (legacy ⊕ local+pending) computed once; the account side is re-merged per attempt.
    const base = model.merge(model.empty(0), legacyEn, local).merged;

    let final = null, committedRev = null;
    for (let a = 0; a < maxAttempts; a++) {
      const merged = model.pruneTombstones(model.merge(model.empty(0), base, acctEn).merged, now);
      // Resume case: the account row already equals the merge (a prior run committed) → nothing to push.
      if (expected > 0 && eq(merged, acctEn)) { final = merged; committedRev = expected; break; }
      const c = await backend.commit(expected, merged, opId, 'import');
      if (c && (c.status === 'ok' || c.status === 'duplicate')) { final = merged; committedRev = c.revision; break; }
      if (c && c.status === 'conflict') { acctEn = c.data ? model.toEnriched(c.data, 1) : model.empty(0); expected = c.revision; continue; }
      return { status: (c && c.status) || 'error' }; // invalid | too_large | unauthorized
    }
    if (final === null) return { status: 'exhausted' };

    // verify: read the account row back and trust the server's truth (a concurrent legit edit is fine).
    const v = await backend.pull();
    if (!v || !v.exists) return { status: 'verify_failed' };
    const vEn = model.toEnriched(v.data, 1);
    if (!eq(vEn, final)) { final = vEn; committedRev = v.revision; }

    await backend.complete(); // server: migration_status = completed (idempotent)
    return { status: 'ok', merged: final, revision: committedRev };
  }

  // ---- thin auth-session wrappers (browser). Defensive: sb.auth may be a mock. ----
  async function getSession(sb) {
    try { const r = await sb.auth.getSession(); return (r && r.data && r.data.session) || null; } catch (e) { return null; }
  }
  function userIdOf(session) { return (session && session.user && session.user.id) || null; }
  async function signUp(sb, email, password, displayName, emailRedirectTo) {
    const options = { data: displayName ? { display_name: displayName } : {} };
    if (emailRedirectTo) options.emailRedirectTo = emailRedirectTo;   // native: email-confirm link returns to the app
    return sb.auth.signUp({ email, password, options });
  }
  // Establish a session from a recovery / email-verification DEEP LINK (Android/Capacitor: the link opens the
  // app via appUrlOpen instead of reloading the page, so supabase-js can't auto-detect it). Supports both the
  // implicit flow (tokens in the URL fragment) and PKCE (?code=...). Returns { ok, type } — never throws.
  async function setSessionFromUrl(sb, rawUrl) {
    try {
      const hash = (String(rawUrl).split('#')[1] || '');
      const hp = new URLSearchParams(hash);
      const at = hp.get('access_token'), rt = hp.get('refresh_token');
      if (at && rt) { const r = await sb.auth.setSession({ access_token: at, refresh_token: rt }); return { ok: !(r && r.error), type: hp.get('type') || 'recovery' }; }
      let code = null, qtype = null;
      try { const q = new URL(rawUrl).searchParams; code = q.get('code'); qtype = q.get('type'); } catch (e) {}
      if (code && sb.auth.exchangeCodeForSession) { const r = await sb.auth.exchangeCodeForSession(code); return { ok: !(r && r.error), type: qtype || 'recovery' }; }
      return { ok: false };
    } catch (e) { return { ok: false, error: e }; }
  }
  async function signIn(sb, email, password) { return sb.auth.signInWithPassword({ email, password }); }
  async function signOut(sb) { try { return await sb.auth.signOut(); } catch (e) { return { error: e }; } }
  // Send a password-reset email. The link returns to `redirectTo`; supabase-js (detectSessionInUrl) then
  // establishes a short recovery session and fires a PASSWORD_RECOVERY event → the app opens the reset screen.
  async function resetPassword(sb, email, redirectTo) {
    try { return await sb.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined); }
    catch (e) { return { error: e }; }
  }
  // Set a new password for the currently-authenticated (recovery) session.
  async function updatePassword(sb, password) {
    try { return await sb.auth.updateUser({ password }); }
    catch (e) { return { error: e }; }
  }
  // Raised as its own event ('PASSWORD_RECOVERY') AND on the initial load when the URL carried a recovery
  // token; cb(session) receives the recovery session so the app can prompt for a new password.
  function onAuthChange(sb, cb) {
    try { return sb.auth.onAuthStateChange((event, session) => cb(session, event)); } catch (e) { return null; }
  }

  global.AyyamAccount = {
    LEGACY_DB, dbNameFor,
    v2Backend, legacyBackend, migrate,
    getSession, userIdOf, signUp, signIn, signOut, resetPassword, updatePassword, setSessionFromUrl, onAuthChange,
    classifyRpcError,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
