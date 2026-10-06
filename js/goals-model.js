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

  global.AyyamGoals = { PERIOD_TYPES, AREAS, MEASUREMENT_TYPES, STATUSES, periodBounds, firstOfMonth, newGoal };
})(typeof globalThis !== 'undefined' ? globalThis : window);
