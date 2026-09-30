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

  // ---- sync backends: same shape { pull, commit }, chosen by session ----
  // v2 (authenticated): identity comes from the JWT the supabase client already attached; NO device key.
  function v2Backend(sb) {
    return {
      mode: 'account',
      pull: async () => (await sb.rpc('ayyam_pull_v2', {})).data,
      commit: async (expected, data, opId, reason) =>
        (await sb.rpc('ayyam_commit_v2', { p_expected_revision: expected, p_data: data, p_op_id: opId, p_reason: reason })).data,
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
  async function signUp(sb, email, password, displayName) {
    return sb.auth.signUp({ email, password, options: { data: displayName ? { display_name: displayName } : {} } });
  }
  async function signIn(sb, email, password) { return sb.auth.signInWithPassword({ email, password }); }
  async function signOut(sb) { try { return await sb.auth.signOut(); } catch (e) { return { error: e }; } }
  function onAuthChange(sb, cb) { try { return sb.auth.onAuthStateChange((_e, session) => cb(session)); } catch (e) { return null; } }

  global.AyyamAccount = {
    LEGACY_DB, dbNameFor,
    v2Backend, legacyBackend, migrate,
    getSession, userIdOf, signUp, signIn, signOut, onAuthChange,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
