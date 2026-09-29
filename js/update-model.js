// Pure helpers for the in-app updater — no I/O. Classic script: sets globalThis.AyyamUpdate.
// Used by BOTH the web PWA path (only shouldCheck/interval helpers) and the Android direct-APK path
// (manifest parse/validate + version compare + sha normalize). All network/file/install work is done
// elsewhere (SW on web; the native UpdaterBridge on Android) — this module just makes the DECISIONS,
// so they are deterministic and unit-tested.
(function (global) {
  'use strict';
  const SHA256_RE = /^[0-9a-f]{64}$/i;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const posInt = (v) => Number.isInteger(v) && v > 0;

  // Parse + STRICTLY validate an update manifest. Returns a normalized object or null (never throws).
  // Security: apkUrl MUST be https (no cleartext, no file://); sha256 MUST be 64-hex (verified after
  // download before install). A malformed field ⇒ null ⇒ the app simply shows "no update".
  function parseManifest(text) {
    let m;
    try { m = (typeof text === 'string') ? JSON.parse(text) : text; } catch (e) { return null; }
    if (!isObj(m)) return null;
    const versionCode = m.versionCode;
    const apkUrl = m.apkUrl;
    const sha256 = typeof m.sha256 === 'string' ? m.sha256.trim().toLowerCase() : '';
    if (!posInt(versionCode)) return null;
    if (typeof apkUrl !== 'string' || !/^https:\/\//i.test(apkUrl)) return null; // https only
    if (!SHA256_RE.test(sha256)) return null;
    return {
      versionCode,
      versionName: typeof m.versionName === 'string' ? m.versionName : '',
      apkUrl,
      sha256,
      mandatory: m.mandatory === true,
      notes: typeof m.notes === 'string' ? m.notes : '',
    };
  }

  // Is `manifest` newer than what is installed? (versionCode is the single source of truth.)
  function isUpdateAvailable(manifest, installedVersionCode) {
    if (!isObj(manifest) || !posInt(manifest.versionCode)) return false;
    const inst = Number(installedVersionCode);
    if (!Number.isFinite(inst)) return false;
    return manifest.versionCode > inst;
  }

  // Throttle: only re-check after `minIntervalMs` has elapsed (default 6h). First run (no last) → true.
  const DEFAULT_INTERVAL = 6 * 60 * 60 * 1000;
  function shouldCheck(lastCheckMs, nowMs, minIntervalMs) {
    const iv = Number.isFinite(minIntervalMs) ? minIntervalMs : DEFAULT_INTERVAL;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (!Number.isFinite(lastCheckMs) || lastCheckMs <= 0) return true;
    return (now - lastCheckMs) >= iv;
  }

  // Constant-time-ish sha compare (both already hex strings).
  function shaMatches(a, b) {
    return typeof a === 'string' && typeof b === 'string' && SHA256_RE.test(a) && a.toLowerCase() === String(b).toLowerCase();
  }

  global.AyyamUpdate = { parseManifest, isUpdateAvailable, shouldCheck, shaMatches, DEFAULT_INTERVAL };
})(typeof globalThis !== 'undefined' ? globalThis : window);
