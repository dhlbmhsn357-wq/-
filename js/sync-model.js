// Conflict-free sync model for "أيام" (LWW registers + tombstones + epoch generations).
// Pure functions, no I/O. Classic script: sets globalThis.AyyamModel. Also the source of truth for
// the merge rules — heavily unit-tested (tests/unit/sync-model.test.mjs).
//
// The app still renders the familiar "materialized" bundle { template, logs, prefs, tplArchive }.
// Alongside it we keep an "enriched" value that carries, for every leaf that can conflict, a
// last-writer stamp [t, by] and, for deletions, a tombstone. Merging is deterministic:
//   winner per key = max stamp (t, then device id) among both sides' register/tombstone.
// A tombstone with a later stamp than any re-add keeps the item deleted — so a STALE device can
// never revive deleted data. A newer `epoch` (reset/import generation) fences an older device
// entirely: its pre-reset changes are parked for recovery, never merged back in.
(function (global) {
  'use strict';

  const DAY_CODES = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
  const PERIODS = new Set(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);
  const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000; // keep deletions 180 days (offline-device safety)
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // structured 24h "HH:MM" (R2 time picker)
  const cleanTimeValue = (v) => (typeof v === 'string' && TIME_RE.test(v)) ? v : null;

  // ---------- materialized bundle sanitize (shape the app renders) ----------
  function cleanTask(t, order) {
    if (!isObj(t) || typeof t.id !== 'string' || !t.id) return null;
    return { id: t.id, title: typeof t.title === 'string' ? t.title : String(t.title == null ? '' : t.title),
             time: typeof t.time === 'string' ? t.time : '', timeValue: cleanTimeValue(t.timeValue),
             period: PERIODS.has(t.period) ? t.period : null,
             _order: Number.isFinite(order) ? order : 0 };
  }
  function cleanList(a) { return Array.isArray(a) ? a.map((t, i) => cleanTask(t, i)).filter(Boolean) : []; }
  function cleanFlags(o) { const r = {}; if (isObj(o)) for (const k of Object.keys(o)) if (o[k] === true) r[k] = true; return r; }
  function cleanOverrides(o) {
    const r = {};
    if (isObj(o)) for (const k of Object.keys(o)) {
      const v = o[k];
      if (isObj(v) && typeof v.title === 'string' && v.title)
        r[k] = { title: v.title, time: typeof v.time === 'string' ? v.time : '', timeValue: cleanTimeValue(v.timeValue), period: PERIODS.has(v.period) ? v.period : null };
    }
    return r;
  }
  // Per-day "excused" markers: { <occurrenceId>: { reason?, note? } }. An excused occurrence is neither
  // completed nor missed (analytics excludes it from the actionable denominator). Empty by default.
  const EXCUSE_REASONS = new Set(['emergency', 'illness', 'travel', 'commitment', 'other']);
  function cleanExcused(o) {
    const r = {};
    if (isObj(o)) for (const k of Object.keys(o)) {
      const v = o[k];
      if (v === true) { r[k] = {}; continue; } // tolerate a bare flag
      if (isObj(v)) r[k] = { reason: EXCUSE_REASONS.has(v.reason) ? v.reason : '', note: typeof v.note === 'string' ? v.note.slice(0, 500) : '' };
    }
    return r;
  }
  // Per-day "replacements": { <originalOccurrenceId>: { task:{title,period,time,timeValue}, reason? } }.
  // The original becomes `replaced` (not missed); the replacement task is a real actionable occurrence
  // for THAT day only (its completion lives under done[<originalId>#repl]). Empty by default.
  function cleanReplacements(o) {
    const r = {};
    if (isObj(o)) for (const k of Object.keys(o)) {
      const v = o[k];
      if (!isObj(v) || !isObj(v.task) || typeof v.task.title !== 'string' || !v.task.title) continue;
      const t = v.task;
      r[k] = { task: { title: t.title, time: typeof t.time === 'string' ? t.time : '', timeValue: cleanTimeValue(t.timeValue), period: PERIODS.has(t.period) ? t.period : null },
               reason: EXCUSE_REASONS.has(v.reason) ? v.reason : '' };
    }
    return r;
  }
  function defaultPrefs() { return { theme: 'night', bgOn: true, bgOpacity: 72, bgBlur: 0, location: null, dayTimezone: '' }; }

  // Recurring-routine segment record (see js/routines-model.js). Sanitized here too so it survives the
  // flatten/enrich/materialize round-trip; empty by default so existing data is untouched.
  function cleanRoutine(raw, id) {
    if (!isObj(raw)) return null;
    const rid = typeof raw.id === 'string' && raw.id ? raw.id : (typeof id === 'string' ? id : '');
    if (!rid) return null;
    const r = isObj(raw.rec) ? raw.rec : {};
    const freq = (r.freq === 'once' || r.freq === 'daily' || r.freq === 'weekly') ? r.freq : 'weekly';
    const rec = { freq, from: DATE_KEY_RE.test(r.from) ? r.from : '0000-00-00', to: DATE_KEY_RE.test(r.to) ? r.to : null };
    if (freq === 'weekly') rec.days = Array.from(new Set(Array.isArray(r.days) ? r.days.filter((x) => DAY_CODES.includes(x)) : []));
    else if (freq === 'once') rec.on = DATE_KEY_RE.test(r.on) ? r.on : null;
    return { id: rid, seriesId: typeof raw.seriesId === 'string' && raw.seriesId ? raw.seriesId : rid,
      title: typeof raw.title === 'string' ? raw.title : String(raw.title == null ? '' : raw.title),
      time: typeof raw.time === 'string' ? raw.time : '', timeValue: cleanTimeValue(raw.timeValue),
      period: PERIODS.has(raw.period) ? raw.period : null,
      order: Number.isFinite(raw.order) ? raw.order : 0, rec };
  }
  function cleanRoutines(map) { const out = {}; if (isObj(map)) for (const k of Object.keys(map)) { const r = cleanRoutine(map[k], k); if (r) out[r.id] = r; } return out; }
  function emptyTemplate() { const t = {}; DAY_CODES.forEach((c) => (t[c] = [])); return t; }

  function cleanLocation(l) {
    if (!isObj(l)) return null;
    const lat = Number(l.lat), lng = Number(l.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng, tz: typeof l.tz === 'string' && l.tz ? l.tz : 'Africa/Cairo' };
  }

  function sanitizeMaterialized(raw) {
    const src = isObj(raw) ? raw : {};
    const template = {};
    DAY_CODES.forEach((c) => (template[c] = cleanList(isObj(src.template) ? src.template[c] : null)));
    const logs = {};
    if (isObj(src.logs)) for (const k of Object.keys(src.logs)) {
      const l = src.logs[k];
      if (!DATE_KEY_RE.test(k) || !isObj(l)) continue;
      logs[k] = { done: cleanFlags(l.done), extra: cleanList(l.extra), hidden: cleanFlags(l.hidden), overrides: cleanOverrides(l.overrides),
                  excused: cleanExcused(l.excused), replacements: cleanReplacements(l.replacements) };
    }
    const p = isObj(src.prefs) ? src.prefs : {};
    const d = defaultPrefs();
    const num = (v, min, max, def) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);
    const prefs = { theme: p.theme === 'day' ? 'day' : 'night', bgOn: typeof p.bgOn === 'boolean' ? p.bgOn : d.bgOn,
                    bgOpacity: num(p.bgOpacity, 30, 95, d.bgOpacity), bgBlur: num(p.bgBlur, 0, 10, d.bgBlur), location: cleanLocation(p.location),
                    dayTimezone: typeof p.dayTimezone === 'string' ? p.dayTimezone : '' };
    const a = isObj(src.tplArchive) ? src.tplArchive : {};
    const tplArchive = { since: typeof a.since === 'string' && DATE_KEY_RE.test(a.since) ? a.since : '0000-00-00',
      versions: Array.isArray(a.versions) ? a.versions.filter((v) => isObj(v) && typeof v.id === 'string' && DATE_KEY_RE.test(v.id))
        .map((v) => ({ id: v.id, template: (function () { const t = {}; DAY_CODES.forEach((c) => (t[c] = cleanList(isObj(v.template) ? v.template[c] : null).map(strip))); return t; })() })) : [] };
    const routines = cleanRoutines(src.routines);
    const migrationDate = DATE_KEY_RE.test(src.migrationDate) ? src.migrationDate : '';
    const migrationVersion = (typeof src.migrationVersion === 'number' && src.migrationVersion >= 1) ? 1 : 0;
    return { template, logs, prefs, tplArchive, routines, migrationDate, migrationVersion };
  }
  const strip = (t) => ({ id: t.id, title: t.title, time: t.time, timeValue: t.timeValue || null, period: t.period }); // drop _order for archive equality

  // ---------- flatten materialized → leaf registers ----------
  // key kinds: p:<field> | g:<day>:done:<id> | g:<day>:hide:<id> | g:<day>:ovr:<id>
  //            g:<day>:ext:<id> | m:<dayCode>:<id> | arch
  function flatten(mat) {
    const out = {}; // key -> value
    const p = mat.prefs;
    out['p:theme'] = p.theme; out['p:bgOn'] = p.bgOn; out['p:bgOpacity'] = p.bgOpacity; out['p:bgBlur'] = p.bgBlur; out['p:location'] = p.location; out['p:dayTimezone'] = p.dayTimezone;
    for (const day of Object.keys(mat.logs)) {
      const l = mat.logs[day];
      for (const id of Object.keys(l.done)) if (l.done[id] === true) out[`g:${day}:done:${id}`] = true;
      for (const id of Object.keys(l.hidden)) if (l.hidden[id] === true) out[`g:${day}:hide:${id}`] = true;
      for (const id of Object.keys(l.overrides)) out[`g:${day}:ovr:${id}`] = l.overrides[id];
      l.extra.forEach((t, i) => (out[`g:${day}:ext:${t.id}`] = { title: t.title, time: t.time, timeValue: t.timeValue || null, period: t.period, order: i }));
      for (const id of Object.keys(l.excused || {})) out[`g:${day}:exc:${id}`] = l.excused[id];
      for (const id of Object.keys(l.replacements || {})) out[`g:${day}:repl:${id}`] = l.replacements[id];
    }
    for (const dc of DAY_CODES) mat.template[dc].forEach((t, i) => (out[`m:${dc}:${t.id}`] = { title: t.title, time: t.time, timeValue: t.timeValue || null, period: t.period, order: i }));
    out['arch'] = mat.tplArchive;
    // routine segments (r:<id>, whole-object leaf) + migration fence date (migd). Empty by default.
    for (const id of Object.keys(mat.routines || {})) out[`r:${id}`] = mat.routines[id];
    if (mat.migrationDate) out['migd'] = mat.migrationDate;
    // migrationVersion register (migv): persists the one-time-migration signal so a reload/pull never re-derives
    // routines from the retained legacy template. Without this the migration could silently re-run.
    if (mat.migrationVersion >= 1) out['migv'] = mat.migrationVersion;
    return out;
  }

  // Booleans (done/hide) are flags: a flip to false is a stamped register (val:false), not a tombstone.
  const isFlagKey = (k) => k.startsWith('p:bgOn') || /:done:|:hide:/.test(k);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Effective live value of a key in an enriched value (tombstone with >= stamp means "gone/false").
  function liveVal(en, key) {
    const r = en.reg[key], t = en.tomb[key];
    if (t && (!r || cmp(t, r) >= 0)) return undefined;
    return r ? r.val : undefined;
  }
  // compare stamps: by time, then device id (deterministic tie-break)
  function cmp(a, b) { if (a.t !== b.t) return a.t < b.t ? -1 : 1; const x = a.by || '', y = b.by || ''; return x < y ? -1 : x > y ? 1 : 0; }

  // ---------- enrich: fold a new materialized state into the enriched value by diffing ----------
  function empty(epoch) { return { v: 2, epoch: epoch || 0, reg: {}, tomb: {} }; }

  function enrich(prev, newMat, now, by) {
    const en = { v: 2, epoch: prev ? prev.epoch : 0, reg: clone(prev ? prev.reg : {}), tomb: clone(prev ? prev.tomb : {}) };
    const flat = flatten(sanitizeMaterialized(newMat));
    const prevKeys = new Set([...Object.keys(en.reg), ...Object.keys(en.tomb)]);
    const newKeys = new Set(Object.keys(flat));
    const stamp = { t: now, by: by || '' };
    // additions / edits
    for (const key of newKeys) {
      const val = flat[key];
      const cur = liveVal(en, key);
      if (cur === undefined || !eq(cur, val)) {
        en.reg[key] = { val, t: now, by: by || '' };
        delete en.tomb[key];
      }
    }
    // removals
    for (const key of prevKeys) {
      if (newKeys.has(key)) continue;
      if (liveVal(en, key) === undefined) continue; // already gone
      if (isFlagKey(key)) { en.reg[key] = { val: false, t: now, by: by || '' }; } // flip flag to false (stamped)
      else { en.tomb[key] = stamp; delete en.reg[key]; }
    }
    return en;
  }

  // ---------- materialize: enriched → bundle the app renders ----------
  function materialize(en) {
    const mat = { template: emptyTemplate(), logs: {}, prefs: defaultPrefs(), tplArchive: { since: '0000-00-00', versions: [] }, routines: {}, migrationDate: '', migrationVersion: 0 };
    const ensureDay = (d) => (mat.logs[d] || (mat.logs[d] = { done: {}, extra: [], hidden: {}, overrides: {}, excused: {}, replacements: {} }));
    const extras = {}; // day -> [{order, task}]
    const tpl = {};    // dayCode -> [{order, task}]
    for (const key of Object.keys(en.reg)) {
      if (liveVal(en, key) === undefined) continue;
      const val = en.reg[key].val;
      if (key.startsWith('p:')) { const f = key.slice(2); mat.prefs[f] = val; continue; }
      if (key === 'arch') { mat.tplArchive = val; continue; }
      if (key === 'migd') { mat.migrationDate = val; continue; }
      if (key === 'migv') { mat.migrationVersion = val; continue; }
      if (key.startsWith('r:')) { mat.routines[key.slice(2)] = val; continue; }
      const parts = key.split(':');
      if (parts[0] === 'g') {
        const [, day, kind, id] = parts;
        const L = ensureDay(day);
        if (kind === 'done') { if (val === true) L.done[id] = true; }
        else if (kind === 'hide') { if (val === true) L.hidden[id] = true; }
        else if (kind === 'ovr') { L.overrides[id] = { title: val.title, time: val.time || '', timeValue: val.timeValue || null, period: val.period || null }; }
        else if (kind === 'ext') { (extras[day] || (extras[day] = [])).push({ order: val.order || 0, task: { id, title: val.title, time: val.time || '', timeValue: val.timeValue || null, period: val.period || null } }); }
        else if (kind === 'exc') { L.excused[id] = { reason: (val && val.reason) || '', note: (val && val.note) || '' }; }
        else if (kind === 'repl') { if (val && isObj(val.task)) L.replacements[id] = { task: { title: val.task.title, time: val.task.time || '', timeValue: val.task.timeValue || null, period: val.task.period || null }, reason: (val && val.reason) || '' }; }
      } else if (parts[0] === 'm') {
        const [, dc, id] = parts;
        (tpl[dc] || (tpl[dc] = [])).push({ order: val.order || 0, task: { id, title: val.title, time: val.time || '', timeValue: val.timeValue || null, period: val.period || null } });
      }
    }
    for (const day of Object.keys(extras)) ensureDay(day).extra = extras[day].sort((a, b) => a.order - b.order).map((x) => x.task);
    for (const dc of DAY_CODES) if (tpl[dc]) mat.template[dc] = tpl[dc].sort((a, b) => a.order - b.order).map((x) => x.task);
    return sanitizeMaterialized(mat);
  }

  // ---------- upgrade a plain (v1) bundle to enriched, stamped at a baseline (loses to real v2 edits) ----------
  function toEnriched(value, baselineStamp) {
    if (isObj(value) && value.v === 2 && isObj(value.reg)) {
      return { v: 2, epoch: value.epoch || 0, reg: clone(value.reg), tomb: clone(value.tomb || {}) };
    }
    // plain materialized bundle from a v1 client: every leaf becomes a register at the baseline time.
    const en = empty(0);
    const flat = flatten(sanitizeMaterialized(value));
    const t = Number.isFinite(baselineStamp) ? baselineStamp : 1;
    for (const key of Object.keys(flat)) en.reg[key] = { val: flat[key], t, by: '' };
    return en;
  }

  // ---------- merge: deterministic LWW + tombstones + epoch fence ----------
  // Returns { merged, outcome, parked } where parked (if set) is the local value fenced by a newer epoch.
  // Merge NEVER prunes — dropping a tombstone here would let a stale device revive a deleted item on
  // a later merge. Garbage collection is a separate, time-based step (compact) the sync engine runs.
  function merge(base, mine, theirs) {
    mine = toEnriched(mine); theirs = toEnriched(theirs);
    if (theirs.epoch > mine.epoch) return { merged: theirs, outcome: 'adopt-newer-epoch', parked: mine };
    if (mine.epoch > theirs.epoch) return { merged: mine, outcome: 'push-newer-epoch' };
    const out = { v: 2, epoch: mine.epoch, reg: {}, tomb: {} };
    const keys = new Set([...Object.keys(mine.reg), ...Object.keys(mine.tomb), ...Object.keys(theirs.reg), ...Object.keys(theirs.tomb)]);
    for (const key of keys) {
      const cands = [];
      if (mine.reg[key]) cands.push({ kind: 'reg', s: mine.reg[key] });
      if (mine.tomb[key]) cands.push({ kind: 'tomb', s: mine.tomb[key] });
      if (theirs.reg[key]) cands.push({ kind: 'reg', s: theirs.reg[key] });
      if (theirs.tomb[key]) cands.push({ kind: 'tomb', s: theirs.tomb[key] });
      let win = cands[0];
      for (const c of cands) if (cmp(c.s, win.s) > 0 || (cmp(c.s, win.s) === 0 && c.kind === 'tomb')) win = c; // tie → tombstone wins (safer)
      if (win.kind === 'reg') out.reg[key] = clone(win.s); else out.tomb[key] = clone(win.s);
    }
    return { merged: out, outcome: 'merge' };
  }

  // GC: drop tombstones older than the TTL, measured against the newest stamp in the data (not wall
  // clock — so it is stable regardless of when it runs). A device offline longer than the TTL is the
  // only case where a revived delete is possible; the TTL (180d) makes that unrealistic for a personal app.
  function pruneTombstones(en, now) {
    let newest = 0;
    for (const k of Object.keys(en.reg)) newest = Math.max(newest, en.reg[k].t);
    for (const k of Object.keys(en.tomb)) newest = Math.max(newest, en.tomb[k].t);
    const ref = Math.max(Number.isFinite(now) ? now : 0, newest);
    const cutoff = ref - TOMBSTONE_TTL_MS;
    const tomb = {};
    for (const k of Object.keys(en.tomb)) if (en.tomb[k].t >= cutoff) tomb[k] = en.tomb[k];
    return { v: 2, epoch: en.epoch, reg: en.reg, tomb };
  }

  // ---------- reset / import: new generation ----------
  function bumpEpoch(prev, newMat, now, by) {
    const fresh = enrich(empty((prev ? prev.epoch : 0) + 1), newMat, now, by);
    return fresh; // registers all stamped `now`, no tombstones, epoch+1 → fences older devices
  }

  global.AyyamModel = {
    DAY_CODES, TOMBSTONE_TTL_MS,
    sanitizeMaterialized, flatten, empty, enrich, materialize, toEnriched, merge, pruneTombstones, bumpEpoch,
    defaultPrefs, emptyTemplate,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
