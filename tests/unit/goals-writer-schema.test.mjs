// Case 7 — the new Web/Android client declares writer_schema = 3 on every account commit (so the server gate
// can tell it apart from a pre-Goals client). Loads the real js/account.js and captures the RPC payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/account.js', import.meta.url), 'utf8'), { filename: 'js/account.js' });
const AC = globalThis.AyyamAccount;

test('v2Backend.commit sends p_writer_schema = 3 to ayyam_commit_v2', async () => {
  const calls = [];
  const sb = { rpc: async (fn, args) => { calls.push({ fn, args }); return { data: { status: 'ok', revision: 1, epoch: 0 }, error: null }; } };
  const be = AC.v2Backend(sb);
  const r = await be.commit(0, { v: 2, epoch: 0, reg: {}, tomb: {} }, '00000000-0000-0000-0000-000000000001', 'sync');
  assert.equal(r.status, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'ayyam_commit_v2');
  assert.equal(calls[0].args.p_writer_schema, 3, 'the Goals-safe writer schema is declared on every commit');
  // the existing params are still passed unchanged (additive, no signature break)
  assert.equal(calls[0].args.p_expected_revision, 0);
  assert.equal(calls[0].args.p_reason, 'sync');
  assert.ok(calls[0].args.p_op_id && calls[0].args.p_data);
});
