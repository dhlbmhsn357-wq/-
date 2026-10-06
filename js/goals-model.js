// Goals domain model for "أيام" (Phase 1) — pure, no I/O. Classic script: sets globalThis.AyyamGoals.
//
// The CRDT serialization gate — what actually persists and round-trips through the enriched value — lives in
// js/sync-model.js (cleanGoal/cleanGoals). THIS module owns the domain constants, the period-window math
// (a goal's [start_date, end_date] for its weekly/monthly/quarterly period — week starts Saturday, matching
// the rest of the app, via AyyamTime), and a goal factory. The Progress Engine and Pace Engine arrive in P1-B.
//
// A goal is ONE whole-object leaf (milestones and links live inside it in V1), so it rides the existing
// LWW + tombstone + epoch sync with no new machinery. parent_goal_id is a plain optional reference — no
// aggregation and no graph engine in V1.
(function (global) {
  'use strict';
  const T = global.AyyamTime;

  const PERIOD_TYPES = ['weekly', 'monthly', 'quarterly'];
  const AREAS = ['worship', 'study', 'work', 'health', 'finance', 'family', 'personal', 'custom'];
  const MEASUREMENT_TYPES = ['count', 'quantity', 'percentage', 'milestones', 'linked_activity'];
  const STATUSES = ['not_started', 'on_track', 'at_risk', 'behind', 'completed', 'paused', 'archived'];

  const pad2 = (n) => String(n).padStart(2, '0');
  // first day of month m (1-based) of year y, rolling the year when m goes out of [1,12].
  function firstOfMonth(y, m) { while (m > 12) { m -= 12; y += 1; } while (m < 1) { m += 12; y -= 1; } return `${y}-${pad2(m)}-01`; }

  // The [start_date, end_date] calendar window of a goal of this period, containing anchorKey ('YYYY-MM-DD').
  //   weekly    = Saturday..Friday (the app's week).
  //   monthly   = the whole calendar month.
  //   quarterly = the calendar quarter (Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec).
  // Pure calendar-string math on top of AyyamTime — timezone-independent once you hold the anchor key.
  function periodBounds(periodType, anchorKey) {
    if (!T || !T.isKey(anchorKey)) return { start_date: '', end_date: '' };
    if (periodType === 'weekly') { const s = T.startOfWeekKey(anchorKey); return { start_date: s, end_date: T.addDays(s, 6) }; }
    const [y, m] = anchorKey.split('-').map(Number);
    if (periodType === 'monthly') { return { start_date: `${y}-${pad2(m)}-01`, end_date: T.addDays(firstOfMonth(y, m + 1), -1) }; }
    if (periodType === 'quarterly') { const sm = Math.floor((m - 1) / 3) * 3 + 1; return { start_date: `${y}-${pad2(sm)}-01`, end_date: T.addDays(firstOfMonth(y, sm + 3), -1) }; }
    return { start_date: '', end_date: '' };
  }

  // Build a fresh goal with sane defaults and the correct period window for `anchorKey` (defaults to today).
  // The returned object is already in the exact shape sync-model's cleanGoal() keeps — a unit test asserts the
  // round-trip is a fixed point, so a new goal never mutates on its first save.
  function newGoal(partial, nowMs, anchorKey) {
    const p = (partial && typeof partial === 'object') ? partial : {};
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const period_type = PERIOD_TYPES.indexOf(p.period_type) >= 0 ? p.period_type : 'weekly';
    const anchor = (T && T.isKey(anchorKey)) ? anchorKey : (T ? T.todayKey(null, now) : '');
    const b = periodBounds(period_type, anchor);
    return {
      id: (typeof p.id === 'string' && p.id) ? p.id : ('goal-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8)),
      title: typeof p.title === 'string' ? p.title.slice(0, 200) : '',
      description: typeof p.description === 'string' ? p.description.slice(0, 2000) : '',
      why: typeof p.why === 'string' ? p.why.slice(0, 2000) : '',
      period_type,
      start_date: (typeof p.start_date === 'string' && T && T.isKey(p.start_date)) ? p.start_date : b.start_date,
      end_date: (typeof p.end_date === 'string' && T && T.isKey(p.end_date)) ? p.end_date : b.end_date,
      area: AREAS.indexOf(p.area) >= 0 ? p.area : null,
      measurement_type: MEASUREMENT_TYPES.indexOf(p.measurement_type) >= 0 ? p.measurement_type : 'count',
      target_value: Number.isFinite(p.target_value) ? p.target_value : 0,
      current_value: Number.isFinite(p.current_value) ? p.current_value : 0,
      unit: (typeof p.unit === 'string' && p.unit) ? p.unit.slice(0, 24) : null,
      status: STATUSES.indexOf(p.status) >= 0 ? p.status : 'not_started',
      parent_goal_id: (typeof p.parent_goal_id === 'string' && p.parent_goal_id) ? p.parent_goal_id : null,
      milestones: Array.isArray(p.milestones) ? p.milestones : [],
      links: Array.isArray(p.links) ? p.links : [],
      created_at: now,
      updated_at: now,
      completed_at: null,
      archived_at: null,
    };
  }

  // ---------- P1-B: Progress Engine + Pace Engine (pure, deterministic, no AI, no forecasting) ----------
  const clampPct = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0);

  // Pace tolerances — defined here, in ONE place, on purpose. pace compares how far along the goal is vs how
  // far along its time window is. Percentage-point based (not per-day) so a single day never flips the verdict,
  // and MIN_ELAPSED_PCT suppresses any verdict until enough of the window has passed (no day-1 false alarms).
  const PACE = {
    ON_TRACK_TOL: 5,     // progress may trail elapsed by up to 5 points and still count as on track
    AT_RISK_TOL: 20,     // trailing by up to 20 points = at risk; beyond that = behind
    MIN_ELAPSED_PCT: 15, // below this much of the window elapsed, we don't judge yet (always on track)
  };

  // progress(goal, opts) → { pct, current, target }. opts.linkedValue supplies the externally-derived current
  // for a linked_activity goal (computed from the bundle in P1-E); absent → falls back to the goal's own value.
  function progress(goal, opts) {
    const g = (goal && typeof goal === 'object') ? goal : {};
    const o = opts || {};
    const mt = g.measurement_type;
    if (mt === 'milestones') {
      const ms = Array.isArray(g.milestones) ? g.milestones : [];
      const total = ms.length;
      const current = ms.filter((m) => m && m.completed === true).length;
      return { pct: total > 0 ? clampPct((current / total) * 100) : 0, current, target: total };
    }
    if (mt === 'percentage') {
      const current = Number.isFinite(g.current_value) ? g.current_value : 0;
      return { pct: clampPct(current), current, target: 100 };
    }
    // count | quantity | linked_activity → current / target
    const target = Number.isFinite(g.target_value) ? g.target_value : 0;
    let current;
    if (mt === 'linked_activity') current = Number.isFinite(o.linkedValue) ? o.linkedValue : (Number.isFinite(g.current_value) ? g.current_value : 0);
    else current = Number.isFinite(g.current_value) ? g.current_value : 0;
    return { pct: target > 0 ? clampPct((current / target) * 100) : 0, current, target };
  }

  // How far through its time window the goal is, 0–100. Inclusive days: the start day is day 1, the end day is 100%.
  function timeElapsedPct(goal, todayKey) {
    const g = goal || {};
    if (!T || !T.isKey(g.start_date) || !T.isKey(g.end_date) || !T.isKey(todayKey)) return 0;
    const total = T.diffDays(g.end_date, g.start_date) + 1;
    if (total <= 0) return 0;
    const elapsed = T.diffDays(todayKey, g.start_date) + 1;
    return clampPct((elapsed / total) * 100);
  }

  // The health verdict. Terminal goal states short-circuit; completion is detected from progress; otherwise we
  // compare progress to elapsed time with the tolerances above (and never judge before MIN_ELAPSED_PCT).
  function paceStatus(progressPct, elapsedPct, goal) {
    const g = goal || {};
    if (g.status === 'paused') return 'paused';
    if (g.status === 'archived') return 'archived';
    if (progressPct >= 100) return 'completed';
    if (elapsedPct < PACE.MIN_ELAPSED_PCT) return 'on_track'; // too early to judge → no false alarms
    const gap = progressPct - elapsedPct;
    if (gap >= -PACE.ON_TRACK_TOL) return 'on_track';
    if (gap >= -PACE.AT_RISK_TOL) return 'at_risk';
    return 'behind';
  }

  // Convenience: everything the UI needs for a goal card, in one deterministic call.
  function evaluate(goal, todayKey, opts) {
    const pr = progress(goal, opts);
    const elapsed = timeElapsedPct(goal, todayKey);
    return { progress_pct: pr.pct, current: pr.current, target: pr.target, time_elapsed_pct: elapsed, pace_status: paceStatus(pr.pct, elapsed, goal) };
  }

  global.AyyamGoals = { PERIOD_TYPES, AREAS, MEASUREMENT_TYPES, STATUSES, PACE, periodBounds, firstOfMonth, newGoal, progress, timeElapsedPct, paceStatus, evaluate };
})(typeof globalThis !== 'undefined' ? globalThis : window);
