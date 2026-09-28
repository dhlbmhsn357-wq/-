// E2E-ONLY Supabase stand-in for the Android WebView. Injected into the www build ONLY when
// scripts/build-webdir.mjs runs with AYYAM_E2E=1 — it is NEVER part of the PWA bundle nor the real
// release/debug APK. It forwards createClient().rpc(fn,args) to the isolated E2E backend
// (tests/e2e/server.mjs) running on the CI host, reached from the emulator at 10.0.2.2. Direct table
// access is denied by the backend (browsers use RPCs only), mirroring tests/e2e/mock-supabase.js.
//
// The base URL is absolute (cross-origin) because the app itself is served from the bundled assets
// (http://localhost) so the real Android device-key path (Keystore → AyyamNative.getKeyCached) runs
// unchanged; only the network target is swapped. The E2E build uses androidScheme=http so this
// cleartext call to 10.0.2.2 is same-scheme (no mixed-content block); CORS is open on the backend.
(function () {
  var BASE = 'http://10.0.2.2:8799';
  async function post(path, body) {
    var res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { var e = new Error('http ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }
  function denied(table) {
    return fetch(BASE + '/rest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: table }) })
      .then(function (r) { return { data: null, error: { message: 'denied', status: r.status } }; });
  }
  function makeQuery(table) {
    var api = {
      select: function () { return api; }, eq: function () { return api; }, is: function () { return api; },
      insert: function () { return denied(table); },
      update: function () { return { eq: function () { return denied(table); }, then: function (r) { return denied(table).then(r); } }; },
      delete: function () { return { eq: function () { return denied(table); } }; },
      maybeSingle: function () { return denied(table); },
      then: function (res, rej) { return denied(table).then(res, rej); },
    };
    return api;
  }
  window.supabase = {
    createClient: function () {
      return {
        rpc: async function (fn, args) {
          try { return await post('/rpc', { fn: fn, args: args }); }
          catch (e) { return { data: null, error: { message: String(e.message || e) } }; }
        },
        from: makeQuery,
      };
    },
  };
})();
