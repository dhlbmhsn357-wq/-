// Durable local database for "أيام" — the local source of truth (not memory, not raw localStorage).
// Classic browser script: sets globalThis.AyyamStore. No build step, no framework.
//
// Guarantees (rule: DATA MUST NEVER BE SILENTLY LOST):
//  * Every app edit writes { state, outbox record } in ONE IndexedDB transaction — both commit or
//    neither. A method resolves only after the transaction's `complete` event, and REJECTS on any
//    error/abort (e.g. QuotaExceededError). The caller must therefore never claim "saved" on a reject.
//  * Migration from the old localStorage keys is atomic and NON-destructive: the localStorage copy is
//    kept as a fallback until a later phase confirms IndexedDB is healthy.
//
// Stores:
//   kv       (keyPath 'k')      singletons: 'state', 'sync_base' {data,revision,epoch}, 'meta'
//   outbox   (keyPath 'op_id')  pending mutations, ordered by 'seq' index
//   diag     (autoIncrement)    capped ring buffer of non-sensitive diagnostic events
(function (global) {
  'use strict';

  const DB_NAME = 'ayyam';
  const DB_VERSION = 1;
  const SCHEMA_VERSION = 1;
  const DIAG_CAP = 200;

  const idb = () => global.indexedDB || (global.window && global.window.indexedDB);

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb request failed'));
    });
  }

  // Resolves on the transaction's own 'complete' event so a caller knows the data is durable.
  // Rejects (never silently) on error or abort. `body` may return a value to resolve with.
  function txP(tx, body) {
    return new Promise((resolve, reject) => {
      let out;
      let bodyFailed = false;
      tx.oncomplete = () => { if (!bodyFailed) resolve(out); };
      tx.onerror = () => reject(tx.error || new Error('idb transaction error'));
      tx.onabort = () => reject(tx.error || new Error('idb transaction aborted'));
      try {
        out = body(tx);
      } catch (e) {
        bodyFailed = true;
        try { tx.abort(); } catch (_) { /* already aborting */ }
        reject(e);
      }
    });
  }

  function randomId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    // RFC4122-ish fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  class AyyamStore {
    constructor(db) { this.db = db; this._seq = 0; }

    static available() { return !!idb(); }

    static async open() {
      const factory = idb();
      if (!factory) throw new Error('IndexedDB unavailable');
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('outbox')) {
          const ob = db.createObjectStore('outbox', { keyPath: 'op_id' });
          ob.createIndex('seq', 'seq', { unique: false });
        }
        if (!db.objectStoreNames.contains('diag')) db.createObjectStore('diag', { autoIncrement: true });
      };
      const db = await reqP(req);
      db.onversionchange = () => db.close(); // let another tab upgrade
      const store = new AyyamStore(db);
      const meta = await store.getMeta();
      store._seq = (meta && meta.lastSeq) || 0;
      // If the data was written by a NEWER app schema, do not touch it — surface it so the app can show a
      // recovery-safe message instead of wiping anything.
      store.newerSchema = !!(meta && meta.schemaVersion > SCHEMA_VERSION);
      store.schemaVersion = SCHEMA_VERSION; // app schema (for diagnostics)
      store.dbVersion = DB_VERSION;
      return store;
    }

    _get(storeName, key) {
      const tx = this.db.transaction(storeName, 'readonly');
      return reqP(tx.objectStore(storeName).get(key));
    }

    async getState() { const r = await this._get('kv', 'state'); return r ? r.v : null; }
    async getBase() { const r = await this._get('kv', 'sync_base'); return r ? r.v : null; }
    async getMeta() { const r = await this._get('kv', 'meta'); return r ? r.v : null; }

    async _patchMetaIn(tx, patch) {
      const kv = tx.objectStore('kv');
      const cur = (await reqP(kv.get('meta'))) || { k: 'meta', v: {} };
      cur.v = Object.assign({ schemaVersion: SCHEMA_VERSION }, cur.v, patch);
      kv.put(cur);
      return cur.v;
    }

    async putMeta(patch) {
      return txP(this.db.transaction('kv', 'readwrite'), (tx) => this._patchMetaIn(tx, patch));
    }

    async putBase(base) {
      return txP(this.db.transaction('kv', 'readwrite'), (tx) => {
        tx.objectStore('kv').put({ k: 'sync_base', v: base });
      });
    }

    // ATOMIC: write the new app state AND enqueue/replace the outbox mutation in one transaction.
    // Resolves with the stored mutation only after it is durable; rejects (no false success) otherwise.
    async saveStateAndEnqueue(state, mutation) {
      const seq = ++this._seq;
      const rec = Object.assign(
        { op_id: (mutation && mutation.op_id) || randomId(), seq, created_at: Date.now(),
          type: 'bundle', reason: 'sync', base_revision: null, retry_count: 0, state: 'pending', last_error: null },
        mutation || {},
      );
      rec.seq = seq;
      return txP(this.db.transaction(['kv', 'outbox'], 'readwrite'), (tx) => {
        tx.objectStore('kv').put({ k: 'state', v: state });
        tx.objectStore('outbox').put(rec);
        this._patchMetaIn(tx, { lastSeq: seq, updatedAt: Date.now() });
        return rec;
      });
    }

    // ATOMIC coalesced edit: write the new state and REPLACE the outbox with exactly one pending
    // record (fresh op_id per changeset). Used by the v2 sync engine. Resolves only when durable.
    async saveEdit(state, opId, meta) {
      const seq = ++this._seq;
      const rec = Object.assign(
        { op_id: opId, seq, created_at: Date.now(), type: 'bundle', reason: 'sync', base_revision: null,
          retry_count: 0, state: 'pending', last_error: null }, meta || {},
      );
      rec.op_id = opId; rec.seq = seq;
      return txP(this.db.transaction(['kv', 'outbox'], 'readwrite'), (tx) => {
        tx.objectStore('kv').put({ k: 'state', v: state });
        const ob = tx.objectStore('outbox');
        ob.clear();          // coalesce: only the latest changeset is pending
        ob.put(rec);
        this._patchMetaIn(tx, { lastSeq: seq, updatedAt: Date.now() });
        return rec;
      });
    }

    async pendingOp() {
      const box = await this.listOutbox();
      return box.length ? box[box.length - 1] : null;
    }

    // Append-only recovery store for state fenced by a newer epoch (a stale device's pre-reset data).
    async saveRecovery(entry) {
      try {
        await txP(this.db.transaction('kv', 'readwrite'), async (tx) => {
          const kv = tx.objectStore('kv');
          const cur = (await reqP(kv.get('recovery'))) || { k: 'recovery', v: [] };
          cur.v.push(Object.assign({ at: Date.now() }, entry));
          if (cur.v.length > 20) cur.v = cur.v.slice(-20);
          kv.put(cur);
        });
      } catch (_) { /* recovery is best-effort */ }
    }
    async getRecovery() { const r = await this._get('kv', 'recovery'); return r ? r.v : []; }

    // Save state locally WITHOUT enqueuing (e.g. adopting a server-merged result). Atomic.
    async saveState(state) {
      return txP(this.db.transaction('kv', 'readwrite'), (tx) => {
        tx.objectStore('kv').put({ k: 'state', v: state });
      });
    }

    async listOutbox() {
      const tx = this.db.transaction('outbox', 'readonly');
      const all = await reqP(tx.objectStore('outbox').index('seq').getAll());
      return all;
    }
    async outboxCount() {
      const tx = this.db.transaction('outbox', 'readonly');
      return reqP(tx.objectStore('outbox').count());
    }

    async setOutbox(op_id, patch) {
      return txP(this.db.transaction('outbox', 'readwrite'), async (tx) => {
        const ob = tx.objectStore('outbox');
        const rec = await reqP(ob.get(op_id));
        if (!rec) return null;
        Object.assign(rec, patch);
        ob.put(rec);
        return rec;
      });
    }

    // A mutation was confirmed by the server: drop it from the outbox and update the confirmed base
    // (and optionally the visible state) in ONE transaction.
    async confirmOutbox(op_id, base, state) {
      return txP(this.db.transaction(['kv', 'outbox'], 'readwrite'), (tx) => {
        tx.objectStore('outbox').delete(op_id);
        if (base !== undefined) tx.objectStore('kv').put({ k: 'sync_base', v: base });
        if (state !== undefined) tx.objectStore('kv').put({ k: 'state', v: state });
        this._patchMetaIn(tx, { lastSyncAt: Date.now() });
      });
    }

    async logDiag(event) {
      try {
        await txP(this.db.transaction('diag', 'readwrite'), async (tx) => {
          const ds = tx.objectStore('diag');
          ds.add(Object.assign({ at: Date.now() }, event));
          const count = await reqP(ds.count());
          if (count > DIAG_CAP) {
            const cursorReq = ds.openCursor();
            let toDelete = count - DIAG_CAP;
            cursorReq.onsuccess = () => {
              const cur = cursorReq.result;
              if (cur && toDelete > 0) { cur.delete(); toDelete--; cur.continue(); }
            };
          }
        });
      } catch (_) { /* diagnostics must never break the app */ }
    }
    async getDiag() {
      const tx = this.db.transaction('diag', 'readonly');
      return reqP(tx.objectStore('diag').getAll());
    }

    // One-time, NON-destructive migration from the old localStorage keys.
    // reader(key) returns the raw string (or null). sanitize(bundle) validates it.
    // Returns { migrated, source }. The localStorage copy is intentionally left in place.
    async migrateFromLocalStorage(reader, sanitize) {
      const meta = (await this.getMeta()) || {};
      if (meta.migratedFromLS) return { migrated: false, source: 'already' };
      if (await this.getState()) {
        await this.putMeta({ migratedFromLS: true });
        return { migrated: false, source: 'idb-had-state' };
      }
      let bundle = null;
      let base = null;
      try {
        const cache = reader('ayyam_cloud_cache_v1');
        if (cache) bundle = sanitize(JSON.parse(cache));
      } catch (_) { /* fall through to per-key */ }
      if (!bundle) {
        try {
          const t = reader('ayyam_template_v1');
          const l = reader('ayyam_logs_v1');
          const p = reader('ayyam_prefs_v1');
          if (t || l || p) {
            bundle = sanitize({
              template: t ? JSON.parse(t) : undefined,
              logs: l ? JSON.parse(l) : undefined,
              prefs: p ? JSON.parse(p) : undefined,
            });
          }
        } catch (_) { /* nothing usable */ }
      }
      try {
        const b = reader('ayyam_sync_base_v1');
        if (b) base = sanitize(JSON.parse(b));
      } catch (_) { /* no base */ }
      const hadPending = reader('ayyam_sync_pending_v1') === '1';

      if (!bundle) {
        await this.putMeta({ migratedFromLS: true });
        return { migrated: false, source: 'nothing-in-ls' };
      }
      await txP(this.db.transaction('kv', 'readwrite'), (tx) => {
        const kv = tx.objectStore('kv');
        kv.put({ k: 'state', v: bundle });
        if (base) kv.put({ k: 'sync_base', v: { data: base, revision: null, epoch: null } });
      });
      await this.putMeta({ migratedFromLS: true, migratedAt: Date.now(), hadPendingAtMigration: hadPending });
      return { migrated: true, source: 'localStorage', hadPending };
    }

    close() { this.db.close(); }
  }

  AyyamStore.randomId = randomId;
  AyyamStore.SCHEMA_VERSION = SCHEMA_VERSION;
  global.AyyamStore = AyyamStore;
})(typeof globalThis !== 'undefined' ? globalThis : window);
