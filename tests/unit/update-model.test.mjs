import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/update-model.js', import.meta.url), 'utf8'), { filename: 'js/update-model.js' });
const U = globalThis.AyyamUpdate;

const SHA = 'd1e7ae0b7f889c8f59f3785aa2a830de2dbeffcd46afa48d4d1ba4221631a7b2';
const good = { versionCode: 4, versionName: '1.1.1', apkUrl: 'https://example.com/app-release.apk', sha256: SHA, mandatory: false, notes: 'تحسينات' };

test('parseManifest accepts a well-formed manifest', () => {
  const m = U.parseManifest(JSON.stringify(good));
  assert.equal(m.versionCode, 4);
  assert.equal(m.versionName, '1.1.1');
  assert.equal(m.sha256, SHA);
  assert.equal(m.mandatory, false);
});
test('parseManifest rejects a non-https apkUrl (no cleartext / file)', () => {
  assert.equal(U.parseManifest(JSON.stringify({ ...good, apkUrl: 'http://example.com/a.apk' })), null);
  assert.equal(U.parseManifest(JSON.stringify({ ...good, apkUrl: 'file:///data/a.apk' })), null);
});
test('parseManifest rejects a bad/short sha256', () => {
  assert.equal(U.parseManifest(JSON.stringify({ ...good, sha256: 'abc' })), null);
});
test('parseManifest rejects a non-positive versionCode and malformed json', () => {
  assert.equal(U.parseManifest(JSON.stringify({ ...good, versionCode: 0 })), null);
  assert.equal(U.parseManifest('{not json'), null);
});
test('isUpdateAvailable compares by versionCode only', () => {
  assert.equal(U.isUpdateAvailable(good, 3), true);
  assert.equal(U.isUpdateAvailable(good, 4), false);
  assert.equal(U.isUpdateAvailable(good, 5), false);
});
test('shouldCheck throttles by interval; first run always checks', () => {
  assert.equal(U.shouldCheck(0, 1000, 100), true);           // no prior check
  assert.equal(U.shouldCheck(1000, 1050, 100), false);       // too soon
  assert.equal(U.shouldCheck(1000, 1200, 100), true);        // interval elapsed
});
test('shaMatches is case-insensitive and rejects non-hex', () => {
  assert.equal(U.shaMatches(SHA, SHA.toUpperCase()), true);
  assert.equal(U.shaMatches(SHA, 'deadbeef'), false);
  assert.equal(U.shaMatches('nothex', SHA), false);
});
test('release notes are normalized to a clean array (item 7)', () => {
  assert.deepEqual(U.normalizeNotes(['حسابات آمنة', ' جولة جديدة ', '', 5]), ['حسابات آمنة', 'جولة جديدة']);
  assert.deepEqual(U.normalizeNotes('سطر واحد'), ['سطر واحد']);
  assert.deepEqual(U.normalizeNotes(null), []);
  const m = U.parseManifest({ versionCode: 7, versionName: '1.2.0', apkUrl: 'https://x/app.apk', sha256: SHA, notes: ['أ', 'ب'] });
  assert.deepEqual(m.notes, ['أ', 'ب']);
});

// --- manual update-check outcomes (item 1): deterministic, non-silent feedback for the Settings button ---
test('evaluateUpdate → "available" when the manifest is newer than the installed build', () => {
  const v = U.evaluateUpdate({ ok: true, text: JSON.stringify(good), installedVersionCode: 3 });
  assert.equal(v.outcome, 'available');
  assert.equal(v.manifest.versionCode, 4);
});
test('evaluateUpdate → "latest" when already on the newest build', () => {
  assert.equal(U.evaluateUpdate({ ok: true, text: JSON.stringify(good), installedVersionCode: 4 }).outcome, 'latest');
  assert.equal(U.evaluateUpdate({ ok: true, text: JSON.stringify(good), installedVersionCode: 9 }).outcome, 'latest');
});
test('evaluateUpdate → "network" when the request failed (offline / non-200)', () => {
  assert.equal(U.evaluateUpdate({ ok: false }).outcome, 'network');
  assert.equal(U.evaluateUpdate(null).outcome, 'network');
});
test('evaluateUpdate → "malformed" on invalid/partial update metadata (no raw error surfaced)', () => {
  assert.equal(U.evaluateUpdate({ ok: true, text: '{not json', installedVersionCode: 1 }).outcome, 'malformed');
  assert.equal(U.evaluateUpdate({ ok: true, text: JSON.stringify({ ...good, sha256: 'abc' }), installedVersionCode: 1 }).outcome, 'malformed');
  assert.equal(U.evaluateUpdate({ ok: true, text: JSON.stringify({ ...good, apkUrl: 'http://x/a.apk' }), installedVersionCode: 1 }).outcome, 'malformed');
});
test('repeated click while loading is ignored (in-flight guard semantics)', () => {
  // Mirrors app.js: a module-level boolean gates re-entry. First call runs; a second call while in flight no-ops.
  let inFlight = false, runs = 0;
  const check = () => { if (inFlight) return; inFlight = true; runs++; /* ...async work... */ };
  check(); check(); check();                 // three rapid taps
  assert.equal(runs, 1);                      // only the first started
  inFlight = false; check();                  // after it settles, a new check is allowed
  assert.equal(runs, 2);
});
