import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as adhan from 'adhan';
import * as L from '../../supabase/functions/ayyam-reminders/logic.js';

test('localParts uses the Cairo calendar date, not UTC', () => {
  // 2026-09-30 22:30 UTC = 2026-10-01 01:30 in Cairo (UTC+3)
  const p = L.localParts(new Date('2026-09-30T22:30:00Z'), 'Africa/Cairo');
  assert.equal(p.key, '2026-10-01'); assert.equal(p.dayCode, 'thu');
});

test('prayer times for Cairo 2026-10-01 are plausible and ordered', () => {
  const t = L.prayerTimes(adhan, L.DEFAULT_LOCATION, 2026, 10, 1);
  const fmt = d => new Intl.DateTimeFormat('en-GB', {timeZone:'Africa/Cairo', hour:'2-digit', minute:'2-digit'}).format(d);
  const got = Object.fromEntries(Object.entries(t).map(([k,v])=>[k, fmt(v)]));
  const order = ['fajr','dhuhr','asr','maghrib','isha'].map(k=>t[k].getTime());
  assert.deepEqual(order, [...order].sort((a,b)=>a-b));
  // Egypt is on summer time (UTC+3) on Oct 1; published Cairo times ≈ 05:22 / 12:46 / 16:08 / 18:41 / 19:58
  assert.deepEqual(got, {fajr:'05:22', dhuhr:'12:46', asr:'16:08', maghrib:'18:41', isha:'19:58'});
});

const data = {
  template: {
    thu: [
      {id:'a', title:'ورد', period:'dhuhr'}, {id:'b', title:'مجلس', period:'asr'},
      {id:'c', title:'مخفية', period:'dhuhr'}, {id:'d', title:'قديم', period:'asr'},
    ],
  },
  logs: { '2026-10-01': {
    done: {b:true}, hidden: {c:true}, extra: [{id:'x', title:'إضافية', period:'dhuhr'}],
    overrides: { d: {title:'معدّلة', time:'', period:'dhuhr'} } } },
  tplArchive: { since: '2026-10-01', versions: [ {id:'0000-00-00', template: { thu: [{id:'old', title:'قالب قديم', period:'dhuhr'}] }} ] },
  prefs: {},
};

test('tasksForDay applies hidden/overrides/extra/done like the app', () => {
  const t = L.tasksForDay(data, '2026-10-01', 'thu');
  assert.deepEqual(t.map(x=>[x.title, x.period, x.done]), [
    ['ورد','dhuhr',false], ['مجلس','asr',true], ['معدّلة','dhuhr',false], ['إضافية','dhuhr',false]]);
});

test('tasksForDay uses the archived template for days before the edit', () => {
  const t = L.tasksForDay(data, '2026-09-24', 'thu');
  assert.deepEqual(t.map(x=>x.title), ['قالب قديم']);
});

test('tasksForDay survives garbage data', () => {
  assert.deepEqual(L.tasksForDay(null, '2026-10-01', 'thu'), []);
  assert.deepEqual(L.tasksForDay({template:'x', logs:5}, '2026-10-01', 'thu'), []);
});

test('duePeriods: only within the window after a prayer', () => {
  const times = {fajr:new Date('2026-10-01T02:00:00Z'), dhuhr:new Date('2026-10-01T08:44:00Z'), asr:new Date('2026-10-01T12:06:00Z'), maghrib:new Date('2026-10-01T14:40:00Z'), isha:new Date('2026-10-01T15:58:00Z')};
  const W = 20*60*1000;
  assert.deepEqual(L.duePeriods(times, new Date('2026-10-01T08:43:59Z'), W), []);
  assert.deepEqual(L.duePeriods(times, new Date('2026-10-01T08:44:00Z'), W), ['dhuhr']);
  assert.deepEqual(L.duePeriods(times, new Date('2026-10-01T09:03:59Z'), W), ['dhuhr']);
  assert.deepEqual(L.duePeriods(times, new Date('2026-10-01T09:04:00Z'), W), []);
});

test('buildMessage: open tasks of that period only, Arabic counts, null when all done', () => {
  const t = L.tasksForDay(data, '2026-10-01', 'thu');
  const m = L.buildMessage('dhuhr', t);
  assert.equal(m.title, 'حان وقت الظهر');
  assert.equal(m.body, 'عليك ٣ مهام: ورد، معدّلة، إضافية');
  assert.equal(L.buildMessage('asr', t), null); // the only asr task is done
  const many = Array.from({length:12}, (_,i)=>({title:'م'+i, period:'isha', done:false}));
  assert.equal(L.buildMessage('isha', many).body, 'عليك ١٢ مهمة: م0، م1، م2 و٩ غيرها');
  assert.equal(L.buildMessage('fajr', [{title:'ن', period:'fajr', done:false}]).body, 'عليك مهمة واحدة: ن');
});

test('locationFrom validates the saved location', () => {
  assert.deepEqual(L.locationFrom({prefs:{location:{lat:31.2, lng:29.92, tz:'Africa/Cairo'}}}), {lat:31.2, lng:29.92, tz:'Africa/Cairo'});
  assert.deepEqual(L.locationFrom({prefs:{location:{lat:'x', lng:1}}}), L.DEFAULT_LOCATION);
  assert.equal(L.locationFrom({prefs:{location:{lat:1, lng:1, tz:'Not/AZone'}}}).tz, 'Africa/Cairo');
});

test('materialize converts the enriched shape to the bundle the reminder logic reads', () => {
  const enriched = { v: 2, epoch: 0, tomb: {},
    reg: {
      'm:sun:def-sun-0': { t: 1, by: '', val: { title: 'ورد', time: '', period: 'dhuhr', order: 0 } },
      'g:2026-09-27:ext:x': { t: 5, by: 'A', val: { title: 'إضافية', time: '', period: 'asr', order: 0 } },
      'g:2026-09-27:done:x': { t: 6, by: 'A', val: true },
      'p:theme': { t: 1, by: '', val: 'day' },
    } };
  const m = L.materialize(enriched);
  assert.equal(m.template.sun[0].title, 'ورد');
  assert.equal(m.logs['2026-09-27'].extra[0].title, 'إضافية');
  assert.equal(m.logs['2026-09-27'].done.x, true);
  assert.equal(m.prefs.theme, 'day');
  // a plain (materialized) bundle passes through unchanged
  assert.equal(L.materialize({ template: {}, logs: {} }).template !== undefined, true);
});
