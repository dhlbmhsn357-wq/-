// Optional LOCAL app PIN (P-batch item 5). Classic script: sets globalThis.AyyamPinLock.
// This is a CONVENIENCE unlock for opening أيام quickly on a trusted device — NOT a server credential and
// NOT a replacement for the account password (which stays a proper password, enforced server-side). The PIN
// never leaves the device and is never sent anywhere.
//
// Security within its (convenience) scope:
//  * Stored only as a PBKDF2-SHA256 hash (150k iters) with a random per-device salt — never the PIN itself.
//  * Wrong-attempt backoff (grows with failures) to blunt on-device brute force of a 4-digit PIN.
//  * If Web Crypto is unavailable, the PIN feature simply refuses to enable (fails closed, never plaintext).
(function (global) {
  'use strict';
  var LS = 'ayyam_pin_v1';        // { salt, hash, iter, fails, lockedUntil }
  var LS_OK = 'ayyam_pin_ok_v1';  // session flag: unlocked this run (sessionStorage)
  var subtle = (global.crypto && global.crypto.subtle) || null;

  function load() { try { var v = localStorage.getItem(LS); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function save(o) { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) {} }
  function toHex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function randHex(n) { var a = new Uint8Array(n); (global.crypto || {}).getRandomValues && global.crypto.getRandomValues(a); return toHex(a); }

  async function derive(pin, saltHex, iter) {
    if (!subtle) throw new Error('nocrypto');
    var enc = new TextEncoder();
    var salt = enc.encode(saltHex);
    var key = await subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
    var bits = await subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' }, key, 256);
    return toHex(bits);
  }

  function supported() { return !!subtle; }
  function isEnabled() { return !!load(); }
  function isUnlocked() { try { return sessionStorage.getItem(LS_OK) === '1'; } catch (e) { return false; } }
  function markUnlocked() { try { sessionStorage.setItem(LS_OK, '1'); } catch (e) {} }
  function relock() { try { sessionStorage.removeItem(LS_OK); } catch (e) {} }

  function validPin(pin) { return typeof pin === 'string' && /^[0-9]{4}$/.test(pin); }

  async function setPin(pin) {
    if (!supported()) return { ok: false, reason: 'unsupported' };
    if (!validPin(pin)) return { ok: false, reason: 'invalid' };
    var salt = randHex(16), iter = 150000;
    var hash = await derive(pin, salt, iter);
    save({ salt: salt, hash: hash, iter: iter, fails: 0, lockedUntil: 0 });
    markUnlocked();
    return { ok: true };
  }
  function clearPin() { try { localStorage.removeItem(LS); } catch (e) {} markUnlocked(); return { ok: true }; }

  // Backoff after wrong attempts: 0-2 free, then grows (3→5s, 4→15s, 5→60s, 6+→300s).
  function lockDelayMs(fails) {
    if (fails <= 2) return 0;
    return [0, 0, 0, 5000, 15000, 60000][Math.min(fails, 5)] || 300000;
  }
  function lockedFor() { var o = load(); if (!o) return 0; var rem = (o.lockedUntil || 0) - Date.now(); return rem > 0 ? rem : 0; }

  async function verify(pin) {
    var o = load(); if (!o) return { ok: false, reason: 'notset' };
    if (lockedFor() > 0) return { ok: false, reason: 'locked', waitMs: lockedFor() };
    if (!validPin(pin)) return { ok: false, reason: 'invalid' };
    var h; try { h = await derive(pin, o.salt, o.iter || 150000); } catch (e) { return { ok: false, reason: 'error' }; }
    if (h === o.hash) { o.fails = 0; o.lockedUntil = 0; save(o); markUnlocked(); return { ok: true }; }
    o.fails = (o.fails || 0) + 1;
    var d = lockDelayMs(o.fails);
    o.lockedUntil = d ? (Date.now() + d) : 0;
    save(o);
    return { ok: false, reason: 'wrong', fails: o.fails, waitMs: d };
  }

  global.AyyamPinLock = {
    supported: supported, isEnabled: isEnabled, isUnlocked: isUnlocked, relock: relock, markUnlocked: markUnlocked,
    validPin: validPin, setPin: setPin, clearPin: clearPin, verify: verify, lockedFor: lockedFor,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
