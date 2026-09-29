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
