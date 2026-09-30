// Browser-side stand-in for @supabase/supabase-js used in E2E. createClient().rpc(fn,args) forwards to
// the E2E server's /rpc (real PGlite functions). Direct table access (.from) hits /rest which the server
// denies (security). Real network offline is simulated by Playwright's setOffline — fetches then reject.
//
// P2: adds a minimal .auth (signUp / signInWithPassword / signOut / getSession / onAuthStateChange) backed
// by the server's /__auth/* endpoints, persists the session in localStorage, and attaches the session
// token to every rpc so the authenticated *_v2 functions run with the user's identity (auth.uid()).
(function () {
  var SESSION_KEY = 'ayyam_e2e_session_v1';
  async function post(path, body) {
    var res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { var err = new Error('http ' + res.status); err.status = res.status; throw err; }
    return res.json();
  }
  function loadSession() { try { var v = localStorage.getItem(SESSION_KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function saveSession(s) { try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch (e) {} }
  function makeQuery(table) {
    var denied = async function () { var r = await fetch('/rest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: table }) }); return { data: null, error: { message: 'denied', status: r.status } }; };
    var api = { select: function () { return api; }, eq: function () { return api; }, is: function () { return api; }, insert: denied,
      update: function () { return { eq: denied, then: function (r) { return denied().then(r); } }; }, delete: function () { return { eq: denied }; },
      maybeSingle: denied, then: function (res, rej) { return denied().then(res, rej); } };
    return api;
  }
  function makeAuth() {
    var listeners = [];
    function emit(session) { listeners.forEach(function (cb) { try { cb('SIGNED_' + (session ? 'IN' : 'OUT'), session); } catch (e) {} }); }
    return {
      getSession: async function () { return { data: { session: loadSession() }, error: null }; },
      signUp: async function (creds) {
        try { var r = await post('/__auth/signup', { email: creds.email, password: creds.password, data: (creds.options && creds.options.data) || {} });
          if (r.error) return { data: { session: null }, error: r.error };
          saveSession(r.session); emit(r.session); return { data: { session: r.session, user: r.session.user }, error: null };
        } catch (e) { return { data: { session: null }, error: { message: String(e.message || e) } }; }
      },
      signInWithPassword: async function (creds) {
        try { var r = await post('/__auth/signin', { email: creds.email, password: creds.password });
          if (r.error) return { data: { session: null }, error: r.error };
          saveSession(r.session); emit(r.session); return { data: { session: r.session, user: r.session.user }, error: null };
        } catch (e) { return { data: { session: null }, error: { message: String(e.message || e) } }; }
      },
      signOut: async function () { saveSession(null); emit(null); return { error: null }; },
      onAuthStateChange: function (cb) { listeners.push(cb); return { data: { subscription: { unsubscribe: function () {} } } }; },
    };
  }
  window.supabase = {
    createClient: function () {
      var auth = makeAuth();
      return {
        auth: auth,
        rpc: async function (fn, args) {
          try { var s = loadSession(); return await post('/rpc', { fn: fn, args: args, token: s && s.access_token }); }
          catch (e) { return { data: null, error: { message: String(e.message || e) } }; }
        },
        from: makeQuery,
      };
    },
  };
})();
