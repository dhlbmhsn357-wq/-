// Recurring-routine engine for "أيام" — pure, no I/O. Classic script: sets globalThis.AyyamRoutines.
// Depends on globalThis.AyyamTime (load js/time-model.js first).
//
// MODEL (see design addendum):
//  * A "routine" record IS one immutable time-SEGMENT: it has a stable `id` (= segmentId = the
//    occurrence identity used in completion keys) and a `seriesId` (the logical task across time).
//    A future edit CLOSES the current segment (rec.to = day-1) and APPENDS a NEW segment (new id,
//    same seriesId, rec.from = change day). Closed segments are never mutated -> history is immutable.
//  * Segments of one series have DISJOINT [from,to] ranges, so any date resolves to exactly one
//    segment -> exactly one occurrence -> no double-counting.
//  * Completion / per-day exception state lives in the EXISTING logs structure, keyed by the segment
//    id: logs[date].done[id] / .hidden[id] (delete-this-day) / .overrides[id] (edit-this-day), and
//    logs[date].extra for one-off ("this week only") tasks. Migration keeps id == original template
//    task id, so all historical done/hidden/override keys keep pointing at the same task.
//  * Materialization is SAFE-hybrid: routines cover dates >= migrationDate; earlier dates fall back to
//    the legacy template + tplArchive path verbatim (so pre-migration days are byte/logically identical).
(function (global) {
  'use strict';

  const T = () => global.AyyamTime;
  const DAY_CODES = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
  const PERIODS = new Set(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);
  const FREQS = new Set(['once', 'daily', 'weekly']);
  const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const OPEN = '9999-12-31'; // sentinel upper bound for an open-ended segment (rec.to === null)
  const FROM0 = '0000-00-00';
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const isKey = (k) => typeof k === 'string' && DATE_KEY_RE.test(k);

  // ---------- sanitize ----------
  function cleanRec(rec) {
    const r = isObj(rec) ? rec : {};
    const freq = FREQS.has(r.freq) ? r.freq : 'weekly';
    const out = { freq, from: isKey(r.from) ? r.from : FROM0, to: isKey(r.to) ? r.to : null };
    if (freq === 'weekly') {
      const days = Array.isArray(r.days) ? r.days.filter((d) => DAY_CODES.includes(d)) : [];
      out.days = Array.from(new Set(days));
    } else if (freq === 'once') {
      out.on = isKey(r.on) ? r.on : null;
    }
    return out;
  }
  function cleanRoutine(raw, id) {
    if (!isObj(raw)) return null;
    const rid = str(raw.id) || str(id);
    if (!rid) return null;
    return {
      id: rid,
      seriesId: str(raw.seriesId) || rid,
      title: str(raw.title),
      time: str(raw.time),
      period: PERIODS.has(raw.period) ? raw.period : null,
      order: Number.isFinite(raw.order) ? raw.order : 0,
      rec: cleanRec(raw.rec),
    };
  }
  function cleanRoutines(map) {
    const out = {};
    if (isObj(map)) for (const k of Object.keys(map)) {
      const r = cleanRoutine(map[k], k);
      if (r) out[r.id] = r; // key is always the routine's own id
    }
    return out;
  }

  // ---------- recurrence resolution ----------
  function recAppliesOn(rec, dateKey, dayCode) {
    if (!isObj(rec) || !isKey(dateKey)) return false;
    const from = isKey(rec.from) ? rec.from : FROM0;
    const to = isKey(rec.to) ? rec.to : OPEN;
    if (dateKey < from || dateKey > to) return false;
    if (rec.freq === 'once') return rec.on === dateKey;
    if (rec.freq === 'daily') return true;
    if (rec.freq === 'weekly') return Array.isArray(rec.days) && rec.days.includes(dayCode);
    return false;
  }

  // All routine occurrences that apply on a date, ONE per seriesId (disjoint ranges guarantee a single
  // active segment; if data ever overlaps, resolve deterministically: latest `from`, then greatest id).
  function occurrencesForDate(routines, dateKey, dayCode) {
    const bySeries = {};
    if (isObj(routines)) for (const id of Object.keys(routines)) {
      const r = routines[id];
      if (!recAppliesOn(r.rec, dateKey, dayCode)) continue;
      const cur = bySeries[r.seriesId];
      if (!cur || r.rec.from > cur.rec.from || (r.rec.from === cur.rec.from && r.id > cur.id)) bySeries[r.seriesId] = r;
    }
    return Object.keys(bySeries)
      .map((s) => bySeries[s])
      .sort((a, b) => (a.order - b.order) || (a.id < b.id ? -1 : 1))
      .map((r) => ({ id: r.id, title: r.title, time: r.time, period: r.period, _order: r.order }));
  }

  // ---------- legacy (pre-migration) base: template + tplArchive, verbatim with app.js semantics ----------
  function legacyTemplateFor(template, tplArchive, dateKey) {
    const tpl = isObj(template) ? template : {};
    const arch = isObj(tplArchive) ? tplArchive : { since: FROM0, versions: [] };
    if (dateKey >= arch.since) return tpl;
    const versions = (Array.isArray(arch.versions) ? arch.versions : [])
      .filter((v) => isObj(v) && v.id < arch.since)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (!versions.length) return tpl;
    let pick = versions[0];
    versions.forEach((v) => { if (v.id <= dateKey) pick = v; });
    return pick.template || {};
  }
  function legacyBase(template, tplArchive, dateKey, dayCode) {
    const t = legacyTemplateFor(template, tplArchive, dateKey);
    const arr = (isObj(t) && Array.isArray(t[dayCode])) ? t[dayCode] : [];
    return arr.map((x) => clone(x)); // whole task object (preserves _order etc.), matching app.js tasksForDate
  }

  // ---------- apply per-day log (hidden / overrides / done / extra) — identical to legacy tasksForDate ----------
  function emptyLog() { return { done: {}, extra: [], hidden: {}, overrides: {} }; }
  function readLog(logs, key) {
    const l = isObj(logs) && isObj(logs[key]) ? logs[key] : null;
    if (!l) return emptyLog();
    return { done: l.done || {}, extra: Array.isArray(l.extra) ? l.extra : [], hidden: l.hidden || {}, overrides: l.overrides || {} };
  }
  function applyLog(base, log) {
    const out = base.filter((t) => !log.hidden[t.id]).map((t) => {
      const ov = log.overrides[t.id];
      const merged = ov ? Object.assign({}, t, ov) : t;
      return Object.assign({}, merged, { done: !!log.done[t.id], fromTemplate: true, origId: t.id });
    });
    const extra = log.extra.map((t) => Object.assign({}, t, { done: !!log.done[t.id], fromTemplate: false }));
    return out.concat(extra);
  }

  // The single materialization entry point. bundle = { routines, template, tplArchive, logs, migrationDate }.
  // Returns the same task shape the app renders today.
  function tasksForDate(bundle, dateKey) {
    const b = isObj(bundle) ? bundle : {};
    const dayCode = T().dayCode(dateKey);
    const log = readLog(b.logs, dateKey);
    const migrated = isKey(b.migrationDate) && dateKey >= b.migrationDate;
    const base = migrated
      ? occurrencesForDate(b.routines, dateKey, dayCode)
      : legacyBase(b.template, b.tplArchive, dateKey, dayCode);
    return applyLog(base, log);
  }

  // ---------- routine mutations (pure; R2 wires the UI) ----------
  // Deterministic new-segment id so two devices splitting identically converge to the same id.
  function segId(seriesId, fromKey) { return `${seriesId}#${fromKey}`; }

  // "This and future" EDIT at `atDate`: close the active segment at atDate-1, append a new segment
  // carrying `changes` from atDate onward (same seriesId). Returns a NEW routines map.
  function splitRoutine(routines, id, atDate, changes) {
    const map = cleanRoutines(routines);
    const cur = map[id];
    if (!cur || !isKey(atDate)) return map;
    const prevTo = T().addDays(atDate, -1);
    // If the split point is at/at-or-before the segment start, the closed part is empty -> drop it.
    const dropOld = prevTo < (isKey(cur.rec.from) ? cur.rec.from : FROM0);
    if (!dropOld) { map[id] = Object.assign({}, cur, { rec: Object.assign({}, cur.rec, { to: prevTo }) }); }
    else { delete map[id]; }
    const ch = isObj(changes) ? changes : {};
    const nid = segId(cur.seriesId, atDate);
    map[nid] = cleanRoutine({
      id: nid, seriesId: cur.seriesId,
      title: 'title' in ch ? ch.title : cur.title,
      time: 'time' in ch ? ch.time : cur.time,
      period: 'period' in ch ? ch.period : cur.period,
      order: 'order' in ch ? ch.order : cur.order,
      rec: Object.assign({}, cur.rec, (ch.rec || {}), { from: atDate, to: null }),
    });
    return map;
  }

  // "This and future" DELETE at `atDate`: end the active segment at atDate-1. If that empties the
  // segment (delete starts at/before its from), remove it entirely (sync layer tombstones the r:<id>).
  // Returns { routines, removed:[ids] }.
  function endRoutine(routines, id, atDate) {
    const map = cleanRoutines(routines);
    const cur = map[id];
    if (!cur || !isKey(atDate)) return { routines: map, removed: [] };
    const prevTo = T().addDays(atDate, -1);
    if (prevTo < (isKey(cur.rec.from) ? cur.rec.from : FROM0)) { delete map[id]; return { routines: map, removed: [id] }; }
    map[id] = Object.assign({}, cur, { rec: Object.assign({}, cur.rec, { to: prevTo }) });
    return { routines: map, removed: [] };
  }

  // ---------- migration: current weekly template -> routines (safe-hybrid) ----------
  // Idempotent. RETAINS template/tplArchive (compatibility + recovery + source of pre-migration history).
  // `today` is the canonical day key (caller computes via AyyamTime.todayKey(dayTimezone)).
  // `dayTimezone` is stored into prefs (never auto-changed later).
  function migrate(bundle, today, dayTimezone) {
    const b = isObj(bundle) ? bundle : {};
    if (b.migrationVersion >= 1 || (isObj(b.routines) && Object.keys(b.routines).length && isKey(b.migrationDate))) {
      return clone(b); // already migrated -> no-op
    }
    const migrationDate = isKey(today) ? today : (isKey(b.migrationDate) ? b.migrationDate : FROM0);
    const routines = {};
    const template = isObj(b.template) ? b.template : {};
    for (const code of DAY_CODES) {
      const arr = Array.isArray(template[code]) ? template[code] : [];
      arr.forEach((t, i) => {
        if (!t || typeof t.id !== 'string' || !t.id) return;
        let rid = t.id;
        if (routines[rid]) rid = `${t.id}~${code}`; // defensive: template ids are unique in practice
        routines[rid] = {
          id: rid, seriesId: rid,
          title: str(t.title), time: str(t.time), period: PERIODS.has(t.period) ? t.period : null,
          order: i,
          rec: { freq: 'weekly', days: [code], from: migrationDate, to: null },
        };
      });
    }
    const out = clone(b);
    out.routines = routines;
    out.migrationDate = migrationDate;
    out.migrationVersion = 1;
    out.prefs = isObj(out.prefs) ? out.prefs : {};
    if (!out.prefs.dayTimezone && typeof dayTimezone === 'string' && dayTimezone) out.prefs.dayTimezone = dayTimezone;
    // template + tplArchive intentionally retained as-is.
    return out;
  }

  global.AyyamRoutines = {
    DAY_CODES, PERIODS, FREQS, OPEN,
    cleanRec, cleanRoutine, cleanRoutines,
    recAppliesOn, occurrencesForDate, legacyTemplateFor, legacyBase, applyLog, readLog, tasksForDate,
    segId, splitRoutine, endRoutine, migrate,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
