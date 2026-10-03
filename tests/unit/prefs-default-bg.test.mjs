// New users must start with NO background image (clean themed background). bgOn defaults OFF, while an
// explicit saved preference is still honoured by sanitize (existing users who enabled it keep it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/sync-model.js', import.meta.url), 'utf8'), { filename: 'js/sync-model.js' });
const M = globalThis.AyyamModel;

test('defaultPrefs().bgOn is false (new users start with no background image)', () => {
  assert.equal(M.defaultPrefs().bgOn, false);
});

test('a fresh (empty) materialized bundle has bgOn=false → applyPrefs will not load bg.jpg', () => {
  const mat = M.materialize(M.empty(0));
  assert.equal(mat.prefs.bgOn, false);
});

test('sanitize preserves an explicit bgOn=true (old users who enabled it are NOT force-changed)', () => {
  const mat = M.sanitizeMaterialized({ prefs: { bgOn: true } });
  assert.equal(mat.prefs.bgOn, true);
});

test('sanitize with no bgOn falls back to the new OFF default', () => {
  const mat = M.sanitizeMaterialized({ prefs: {} });
  assert.equal(mat.prefs.bgOn, false);
});

test('a brand-new account seeded from defaults flattens bgOn=false (no background register turns it on)', () => {
  const en = M.toEnriched({ template: M.emptyTemplate(), logs: {}, prefs: M.defaultPrefs(), tplArchive: { since: '0000-00-00', versions: [] } }, 1);
  assert.equal(M.materialize(en).prefs.bgOn, false);
});
