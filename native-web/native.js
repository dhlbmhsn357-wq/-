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
    // Deep links (ayyam://today[?task=<id>]) from the widget.
    async getLaunchUrl() {
      if (!isNativeAndroid()) return null;
      const App = plugin('App');
      if (!App || !App.getLaunchUrl) return null;
      try { const r = await App.getLaunchUrl(); return (r && r.url) || null; } catch (e) { return null; }
    },
    onDeepLink(fn) {
      if (!isNativeAndroid() || typeof fn !== 'function') return;
      const App = plugin('App');
      if (App && App.addListener) {
        try { App.addListener('appUrlOpen', (e) => { if (e && e.url) fn(e.url); }); } catch (_) {}
      }
    },
    // Hardware/system Back. The handler decides what to close; only exits when nothing is left.
    onBack(fn) {
      if (!isNativeAndroid() || typeof fn !== 'function') return;
      const App = plugin('App');
      if (App && App.addListener) {
        try { App.addListener('backButton', () => fn()); } catch (_) {}
      }
    },
    exitApp() {
      const App = plugin('App');
      try { if (App && App.exitApp) App.exitApp(); } catch (_) {}
    },
    // Non-sensitive native info for diagnostics.
    async appInfo() {
      if (!isNativeAndroid()) return null;
      const App = plugin('App');
      if (!App || !App.getInfo) return null;
      try { const i = await App.getInfo(); return { version: i && i.version, build: i && i.build }; } catch (e) { return null; }
    },
    async widgetStatus() {
      if (!isNativeAndroid()) return null;
      const WB = plugin('WidgetBridge');
      if (!WB || !WB.getStatus) return null;
      try { return await WB.getStatus(); } catch (e) { return null; }
    },
    secureState() { return { backing: _backing, degraded: _degraded }; },
    // ---- Local (on-device) reminders: JS builds the plan, native schedules inexact alarms ----
    notifConfigured() { return isNativeAndroid() && !!plugin('NotifBridge'); },
    async setNotifPlan(plan) {
      if (!isNativeAndroid()) return { skipped: true };
      const NB = plugin('NotifBridge'); if (!NB) return { skipped: true };
      try { return await NB.setPlan({ plan }); } catch (e) { return { error: true }; }
    },
    async clearNotif() {
      const NB = plugin('NotifBridge'); if (!isNativeAndroid() || !NB) return { skipped: true };
      try { await NB.clear(); return { ok: true }; } catch (e) { return { error: true }; }
    },
    async notifStatus() {
      if (!isNativeAndroid()) return null;
      const NB = plugin('NotifBridge'); if (!NB) return null;
      try { return await NB.getStatus(); } catch (e) { return null; }
    },
    async checkNotifPermission() {
      const NB = plugin('NotifBridge'); if (!isNativeAndroid() || !NB) return { permission: 'unsupported' };
      try { return await NB.checkPermission(); } catch (e) { return { permission: 'unknown' }; }
    },
    async requestNotifPermission() {
      const NB = plugin('NotifBridge'); if (!isNativeAndroid() || !NB) return { permission: 'unsupported' };
      try { return await NB.requestPermission(); } catch (e) { return { permission: 'unknown' }; }
    },
    // Opens the OS notification settings for Ayyam (used when notifications are blocked at the system level).
    async openNotifSettings() {
      const NB = plugin('NotifBridge'); if (!isNativeAndroid() || !NB || typeof NB.openSettings !== 'function') return { ok: false };
      try { await NB.openSettings(); return { ok: true }; } catch (e) { return { ok: false }; }
    },
    // ---- One-shot device location (prayer-time reminders). Native path via LocationBridge; never at startup. ----
    hasNativeLocation() { return isNativeAndroid() && !!plugin('LocationBridge'); },
    location: {
      async checkStatus() {
        const LB = plugin('LocationBridge'); if (!isNativeAndroid() || !LB) return { permission: 'unsupported' };
        try { return await LB.checkStatus(); } catch (e) { return { permission: 'unknown' }; }
      },
      async requestPermission() {
        const LB = plugin('LocationBridge'); if (!isNativeAndroid() || !LB) return { permission: 'unsupported' };
        try { return await LB.requestPermission(); } catch (e) { return { permission: 'unknown' }; }
      },
      // Resolves { lat, lng, precise } or throws with a reason: 'permission' | 'services' | 'timeout' | 'no_fix'.
      async getCurrent() {
        const LB = plugin('LocationBridge'); if (!isNativeAndroid() || !LB) throw new Error('unsupported');
        return await LB.getCurrent();
      },
      async openSettings() {
        const LB = plugin('LocationBridge'); if (!isNativeAndroid() || !LB) return { skipped: true };
        try { await LB.openSettings(); return { ok: true }; } catch (e) { return { error: true }; }
      },
    },
    // ---- Direct-APK in-app updater (native only; absent in a Play build). Decisions live in AyyamUpdate. ----
    updaterConfigured() { return isNativeAndroid() && !!plugin('UpdaterBridge'); },
    updater: {
      async canInstall() {
        const UB = plugin('UpdaterBridge'); if (!isNativeAndroid() || !UB) return { canInstall: false };
        try { return await UB.canInstall(); } catch (e) { return { canInstall: false }; }
      },
      async openInstallSettings() {
        const UB = plugin('UpdaterBridge'); if (!isNativeAndroid() || !UB) return;
        try { await UB.openInstallSettings(); } catch (e) {}
      },
      async download(url, sha256) {
        const UB = plugin('UpdaterBridge'); if (!isNativeAndroid() || !UB) throw new Error('unsupported');
        return await UB.download({ url, sha256 });
      },
      async install(path) {
        const UB = plugin('UpdaterBridge'); if (!isNativeAndroid() || !UB) throw new Error('unsupported');
        return await UB.install({ path });
      },
      onProgress(fn) {
        const UB = plugin('UpdaterBridge'); if (!isNativeAndroid() || !UB || typeof fn !== 'function') return;
        try { UB.addListener('downloadProgress', fn); } catch (e) {}
      },
    },
  };
  global.AyyamNative = AyyamNative;
})(typeof globalThis !== 'undefined' ? globalThis : window);
