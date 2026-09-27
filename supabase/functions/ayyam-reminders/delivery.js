// Pure delivery orchestration for the reminders function: bounded-concurrency sending + error
// classification + state transitions via injected DB ops. No I/O of its own, so it is unit-tested
// with a fake Web Push provider (tests/unit/push-delivery.test.mjs) instead of sending real pushes.

// Classify a push send failure. Works for BOTH channels by HTTP status:
//   gone      → 404/410/403: the target is dead (Web Push subscription gone, or FCM UNREGISTERED/
//               sender-mismatch); disable + clean it.
//   retryable → 429, 5xx, or a network/timeout error: try again later with backoff (NOT sent).
//   terminal  → other 4xx (e.g. 400 malformed payload): give up on this delivery, keep the target.
// (FCM HTTP v1: 404 NOT_FOUND=unregistered→gone, 403=SenderId mismatch→gone, 400=INVALID_ARGUMENT→
//  terminal, 429/500/503→retryable — matches this mapping.)
export function classifyError(err) {
  const code = err && (err.statusCode || err.status);
  if (code === 404 || code === 410 || code === 403) return 'gone';
  if (code === 429 || (code >= 500 && code <= 599)) return 'retryable';
  if (code >= 400 && code <= 499) return 'terminal';
  return 'retryable'; // no HTTP status → network/timeout → retry
}

// Run an async worker over items with a bounded number in flight (never an unbounded Promise.all).
export async function pool(items, concurrency, worker) {
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  let i = 0;
  const runners = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

// Send one claimed batch. `ops` = { send, markSent, markFailed, disable }. Each send resolves on
// success or throws an error carrying statusCode. Every delivery ends in exactly one terminal DB op.
export async function processBatch(batch, ops, opts = {}) {
  const concurrency = opts.concurrency || 6;
  const maxAttempts = opts.maxAttempts || 5;
  const backoffBase = opts.backoffBase || 60;
  const counts = { sent: 0, retryable: 0, terminal: 0, gone: 0 };
  await pool(batch, concurrency, async (item) => {
    try {
      await ops.send(item);
      await ops.markSent(item.delivery_id);
      counts.sent++;
    } catch (err) {
      const kind = classifyError(err);
      const msg = String((err && (err.statusCode || err.status)) || (err && err.message) || 'error').slice(0, 300);
      if (kind === 'gone') { await ops.disable(item.delivery_id, msg, item.channel); counts.gone++; }
      else if (kind === 'terminal') { await ops.markFailed(item.delivery_id, msg, false, maxAttempts, backoffBase); counts.terminal++; }
      else { await ops.markFailed(item.delivery_id, msg, true, maxAttempts, backoffBase); counts.retryable++; }
    }
  });
  return counts;
}
