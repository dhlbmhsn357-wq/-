import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, pool, processBatch } from '../../supabase/functions/ayyam-reminders/delivery.js';

test('classifyError maps provider responses correctly', () => {
  assert.equal(classifyError({ statusCode: 410 }), 'gone');
  assert.equal(classifyError({ statusCode: 404 }), 'gone');
  assert.equal(classifyError({ statusCode: 403 }), 'gone');
  assert.equal(classifyError({ statusCode: 429 }), 'retryable');
  assert.equal(classifyError({ statusCode: 500 }), 'retryable');
  assert.equal(classifyError({ statusCode: 503 }), 'retryable');
  assert.equal(classifyError({ statusCode: 400 }), 'terminal');
  assert.equal(classifyError(new Error('network down')), 'retryable'); // no status → retry
});

test('pool never exceeds the concurrency limit', async () => {
  let inFlight = 0, peak = 0;
  const items = Array.from({ length: 50 }, (_, i) => i);
  await pool(items, 6, async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
  });
  assert.ok(peak <= 6, `peak concurrency was ${peak}`);
});

// A fake Web Push provider + fake DB ops that record transitions.
function harness(behaviour) {
  const state = {}; // delivery_id -> final op
  const ops = {
    send: async (item) => { const b = behaviour[item.endpoint]; if (b === 'ok') return; const e = new Error('fail'); e.statusCode = b; throw e; },
    markSent: async (id) => { state[id] = 'sent'; },
    markFailed: async (id, msg, retryable) => { state[id] = retryable ? 'failed-retry' : 'failed-terminal'; },
    disable: async (id) => { state[id] = 'disabled'; },
  };
  return { ops, state };
}

test('processBatch: mixed results each end in exactly one correct terminal op', async () => {
  const batch = [
    { delivery_id: 1, endpoint: 'ok1' },
    { delivery_id: 2, endpoint: 'ok2' },
    { delivery_id: 3, endpoint: 'gone' },
    { delivery_id: 4, endpoint: 'server' },
    { delivery_id: 5, endpoint: 'bad' },
  ];
  const { ops, state } = harness({ ok1: 'ok', ok2: 'ok', gone: 410, server: 500, bad: 400 });
  const counts = await processBatch(batch, ops, { concurrency: 3 });
  assert.deepEqual(state, { 1: 'sent', 2: 'sent', 3: 'disabled', 4: 'failed-retry', 5: 'failed-terminal' });
  assert.deepEqual(counts, { sent: 2, retryable: 1, terminal: 1, gone: 1 });
});

test('processBatch: a device that failed then succeeds on retry is sent (no double handling)', async () => {
  // simulate two runs: run1 the server device 500s (retry), run2 it succeeds
  let b = { dev: 500 };
  const mk = () => harness(b);
  const item = [{ delivery_id: 9, endpoint: 'dev' }];
  const h1 = mk(); await processBatch(item, h1.ops, {});
  assert.equal(h1.state[9], 'failed-retry');
  b = { dev: 'ok' };
  const h2 = harness(b); await processBatch(item, h2.ops, {});
  assert.equal(h2.state[9], 'sent');
});
