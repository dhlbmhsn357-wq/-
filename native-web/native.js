// Native bridge glue for the Capacitor Android shell. Loaded ONLY inside the APK (injected by
// scripts/build-webdir.mjs); NEVER part of the web/PWA bundle. Sets globalThis.AyyamNative.
//
// Responsibilities (Phase B):
//  * isNativeAndroid() — the single guard the shared app.js consults for native-only behavior.
//  * Device key in Android Keystore-backed secure storage (custom SecureStore plugin), with an
//    EXPLICIT fallback chain and a surfaced "degraded" state — the key is NEVER silently lost and
//    NEVER logged. The in-memory cache is set synchronously so the existing sync/first-load code
//    (which reads the key synchronously) keeps working unchanged.
//  * App lifecycle (resume) → a bounded sync trigger, reusing the app's own debounce.
(function (global) {
  'use strict';
  const Cap = global.Capacitor;
  function isNativeAndroid() {
    try { return !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.getPlatform && Cap.getPlatform() === 'android'); }
    catch (e) { return false; }
  }
  const KEY_NAME = 'ayyam_device_key_v1';
  const plugin = (n) => (Cap && Cap.Plugins && Cap.Plugins[n]) || null;

  let _key = '';                 // in-memory cache — never logged, never surfaced
  let _hydrated = false;
  let _backing = 'unknown';      // 'keystore' | 'preferences-fallback' | 'memory-only'
  let _degraded = false;         // true when the key could not reach persistent secure storage

  async function secureGet() {
    const SS = plugin('SecureStore');
    if (SS) { try { const r = await SS.get({ key: KEY_NAME }); _backing = 'keystore'; _degraded = false; return (r && typeof r.value === 'string') ? r.value : ''; } catch (e) { /* fall through */ } }
    const P = plugin('Preferences');
    if (P) { try { const r = await P.get({ key: KEY_NAME }); _backing = 'preferences-fallback'; _degraded = true; return (r && r.value) || ''; } catch (e) { /* fall through */ } }
    _backing = 'memory-only'; _degraded = true; return _key;
  }
  async function secureSet(v) {
    const SS = plugin('SecureStore');
    if (SS) { try { if (v) await SS.set({ key: KEY_NAME, value: v }); else await SS.remove({ key: KEY_NAME }); _backing = 'keystore'; _degraded = false; return true; } catch (e) { /* fall through */ } }
    const P = plugin('Preferences');
    if (P) { try { if (v) await P.set({ key: KEY_NAME, value: v }); else await P.remove({ key: KEY_NAME }); _backing = 'preferences-fallback'; _degraded = true; return true; } catch (e) { /* fall through */ } }
    _backing = 'memory-only'; _degraded = true; return false; // persisted nowhere → degraded, surfaced (never silent)
  }

  const resumeCbs = [];
  const AyyamNative = {
    isNativeAndroid,
    // Load the secure device key into memory BEFORE the app reads it, and wire lifecycle.
    async hydrate() {
      if (!isNativeAndroid()) { _hydrated = true; return; }
      try { _key = await secureGet(); } catch (e) { _key = ''; _backing = 'memory-only'; _degraded = true; }
      _hydrated = true;
      try {
        const App = plugin('App');
        if (App && App.addListener) {
          App.addListener('appStateChange', (s) => { if (s && s.isActive) resumeCbs.forEach((fn) => { try { fn(); } catch (_) {} }); });
          App.addListener('resume', () => resumeCbs.forEach((fn) => { try { fn(); } catch (_) {} }));
        }
      } catch (_) { /* lifecycle is best-effort */ }
    },
    hydrated() { return _hydrated; },
    getKeyCached() { return _key || ''; },
    // Sets the in-memory cache SYNCHRONOUSLY (so sync code sees it immediately), then persists.
    async setKey(k) { _key = k || ''; const ok = await secureSet(_key); return { ok, backing: _backing, degraded: _degraded }; },
    secureBacking() { return _backing; },
    isDegraded() { return _degraded; },
    onResume(fn) { if (typeof fn === 'function') resumeCbs.push(fn); },
    // Push a derived widget view-model to native storage. Best-effort: NEVER throws, so a widget
    // failure can never affect the app's own (already-completed) save. Returns {ok|skipped|error}.
    async updateWidgetSnapshot(snapshot) {
      if (!isNativeAndroid()) return { ok: false, skipped: true };
      const WB = plugin('WidgetBridge');
      if (!WB) return { ok: false, skipped: true };
      try { const r = await WB.updateSnapshot({ snapshot }); return { ok: !!(r && r.ok) }; }
      catch (e) { return { ok: false, error: true }; }
    },
  };
  global.AyyamNative = AyyamNative;
})(typeof globalThis !== 'undefined' ? globalThis : window);
