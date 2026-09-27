// Browser-side stand-in for @supabase/supabase-js used in E2E. createClient().rpc(fn,args) forwards to
// the E2E server's /rpc (real PGlite functions). Direct table access (.from) hits /rest which the server
// denies (security). Real network offline is simulated by Playwright's setOffline — fetches then reject,
// which the app treats as "unreachable" exactly like a real outage.
(function () {
  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const err = new Error('http ' + res.status); err.status = res.status; throw err; }
    return res.json();
  }
  function makeQuery(table) {
    // Any direct table read/write is denied by the server (browsers must use RPCs only).
    const denied = async () => { const r = await fetch('/rest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table }) }); return { data: null, error: { message: 'denied', status: r.status } }; };
    const api = { select() { return api; }, eq() { return api; }, is() { return api; }, insert() { return denied(); },
      update() { return { eq: denied, then: (r) => denied().then(r) }; }, delete() { return { eq: denied }; },
      maybeSingle: denied, then(res, rej) { return denied().then(res, rej); } };
    return api;
  }
  window.supabase = {
    createClient() {
      return {
        rpc: async (fn, args) => {
          try { return await post('/rpc', { fn, args }); }
          catch (e) { return { data: null, error: { message: String(e.message || e) } }; }
        },
        from: makeQuery,
      };
    },
  };
})();
