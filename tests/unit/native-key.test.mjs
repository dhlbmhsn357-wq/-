import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load the native bridge (native-web/native.js) as a classic script with a minimal Capacitor stub that
// reports the Android platform but exposes NO SecureStore/Preferences plugins — so the key falls back to
// the in-memory cache. This isolates the ONE property the Android re-prompt bug hinged on: setKey must
// update the cache SYNCHRONOUSLY so getDeviceKey()/getKeyCached() sees it immediately after entry.
globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} };
vm.runInThisContext(readFileSync(new URL('../../native-web/native.js', import.meta.url), 'utf8'), { filename: 'native-web/native.js' });
const N = globalThis.AyyamNative;

test('setKey updates the in-memory cache synchronously → immediate getKeyCached', () => {
  const KEY = 'device-key-0123456789abcdef';
  const p = N.setKey(KEY);            // do NOT await: the cache must be set during the synchronous prefix
  assert.equal(N.getKeyCached(), KEY, 'getKeyCached must return the key immediately after setKey is called');
  return p;                            // let the async persist settle (memory fallback here)
});

test('setKey("") clears the cache immediately', () => {
  const p = N.setKey('');
  assert.equal(N.getKeyCached(), '', 'empty key clears the cache synchronously');
  return p;
});

test('no persistent secure backing → degraded is surfaced (never silent)', async () => {
  const r = await N.setKey('device-key-0123456789abcdef');
  assert.equal(r.backing, 'memory-only', 'with no SecureStore/Preferences plugin the backing is memory-only');
  assert.equal(r.degraded, true, 'degraded must be true so the app can warn instead of silently losing the key');
});
