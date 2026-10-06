// Goals UI for "أيام" (Phase 1, P1-C). Classic script: sets globalThis.AyyamGoalsUI.
//
// Simple, flexible, effortless — a user can create a goal without understanding the system. The create flow is
// 5 short steps (name → period → how you measure → target → save); everything else hides under «خيارات إضافية».
// This module owns only the DOM: it reads/writes goals through injected callbacks (the app owns state + sync),
// and computes progress/pace via AyyamGoals (P1-B). No dashboard, charts, reviews, AI, social, or notifications.
(function (global) {
  'use strict';
  var GM = function () { return global.AyyamGoals; };
  var cb = {};                 // { getGoals, saveGoals, now, todayKey }
  var editingId = null;        // goal id being edited in the create/edit sheet (null = create)
  var detailId = null;         // goal id open in the detail sheet
  var showAdvanced = false;
  var draftMeasure = 'count';  // live measurement selection in the sheet (drives the milestones field)
  var draftPeriod = 'weekly';

  function $(id) { return document.getElementById(id); }
  function elc(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  var PERIOD_TAB = { weekly: 'الأسبوع', monthly: 'الشهر', quarterly: 'الربع' };
  var PERIOD_PICK = { weekly: 'هذا الأسبوع', monthly: 'هذا الشهر', quarterly: 'هذا الربع' };
  var MEASURE = { count: 'عدد مرات', quantity: 'كمية', percentage: 'نسبة مئوية', milestones: 'مراحل', linked_activity: 'نشاط مرتبط' };
  var AREA = { worship: 'عبادة', study: 'دراسة', work: 'عمل', health: 'صحة', finance: 'مال', family: 'أسرة', personal: 'شخصي', custom: 'أخرى' };
  var PACE = { on_track: 'يسير جيدًا', at_risk: 'يحتاج انتباهًا', behind: 'متأخر عن الخطة', completed: 'مكتمل', paused: 'متوقف مؤقتًا', archived: 'مؤرشف', not_started: 'لم يبدأ' };
  var PACE_CLASS = { on_track: 'ok', at_risk: 'warn', behind: 'bad', completed: 'done', paused: 'muted', archived: 'muted', not_started: 'muted' };

  function init(callbacks) { cb = callbacks || {}; }

  function goalsList() { try { return cb.getGoals() || {}; } catch (e) { return {}; } }
  function todayKey() { try { return cb.todayKey(); } catch (e) { return ''; } }
  function nowMs() { try { return cb.now(); } catch (e) { return Date.now(); } }
  function persist(map) { try { cb.saveGoals(map); } catch (e) {} }

  // the health label shown on a card: explicit lifecycle (completed/paused/archived) wins, else the pace verdict.
  function healthOf(g) {
    if (g.status === 'completed') return 'completed';
    if (g.status === 'paused') return 'paused';
    if (g.status === 'archived') return 'archived';
    var e = GM().evaluate(g, todayKey());
    return e.pace_status;
  }
  function daysLeft(g) {
    var T = global.AyyamTime; if (!T || !T.isKey(g.end_date)) return null;
    var d = T.diffDays(g.end_date, todayKey());
    return d;
  }

  // ---------------- list with period tabs (P1-D) ----------------
  // One screen, three plain tabs (week / month / quarter). Each shows ONLY that period's CURRENT goals by
  // default (window contains today). Past windows and archived goals move to a collapsed secondary section, so
  // the main view never fills with history. The chosen tab is remembered; default is the week.
  var TAB_LABEL = { weekly: 'الأسبوع', monthly: 'الشهر', quarterly: 'الربع' };
  var EMPTY_MSG = { weekly: 'حدّد ما تريد تحقيقه هذا الأسبوع', monthly: 'ما النتيجة التي تريد الوصول إليها هذا الشهر؟', quarterly: 'ما الذي تريد تغييره خلال الـ٩٠ يومًا القادمة؟' };
  var selectedTab = (function () { try { var t = localStorage.getItem('ayyam_goals_tab'); return (t === 'weekly' || t === 'monthly' || t === 'quarterly') ? t : 'weekly'; } catch (e) { return 'weekly'; } })();
  var showPast = false;

  function setTab(t) { selectedTab = t; showPast = false; try { localStorage.setItem('ayyam_goals_tab', t); } catch (e) {} render(); }
  function inCurrentPeriod(g) {
    var T = global.AyyamTime; if (!T || !T.isKey(g.start_date) || !T.isKey(g.end_date)) return true;
    var tk = todayKey(); return T.cmpKey(g.start_date, tk) <= 0 && T.cmpKey(tk, g.end_date) <= 0;
  }

  function render() {
    var root = $('goalsView'); if (!root) return;
    root.innerHTML = '';
    var head = elc('header', 'top');
    head.appendChild(elc('span', 'brand', 'أهدافي'));
    var add = elc('button', 'btn primary goals-add', 'هدف جديد'); add.id = 'goalNewBtn';
    add.addEventListener('click', function () { openSheet(null); });
    head.appendChild(add);
    root.appendChild(head);

    // plain period tabs
    var tabs = elc('div', 'goal-tabs');
    ['weekly', 'monthly', 'quarterly'].forEach(function (t) {
      var b = elc('button', 'goal-tab' + (t === selectedTab ? ' on' : ''), TAB_LABEL[t]);
      b.setAttribute('data-tab', t); b.addEventListener('click', function () { setTab(t); });
      tabs.appendChild(b);
    });
    root.appendChild(tabs);

    // split this tab's goals into current vs past/archived
    var all = goalsList(); var current = [], past = [];
    Object.keys(all).forEach(function (id) {
      var g = all[id]; if (!g || g.period_type !== selectedTab) return;
      if (g.status === 'archived') { past.push(g); return; }   // archived never fills the main view
      if (inCurrentPeriod(g)) current.push(g); else past.push(g); // completed stays in its period; ended windows move to past
    });
    var byUpdated = function (a, b) { return (b.updated_at || 0) - (a.updated_at || 0); };
    current.sort(byUpdated); past.sort(byUpdated);

    var wrap = elc('div', 'goals-wrap');
    if (!current.length) {
      var empty = elc('div', 'goals-empty');
      empty.appendChild(elc('div', 'goals-empty-title', EMPTY_MSG[selectedTab]));
      var cta = elc('button', 'btn primary', 'أنشئ أول هدف'); cta.addEventListener('click', function () { openSheet(null); });
      empty.appendChild(cta);
      wrap.appendChild(empty);
    } else {
      current.forEach(function (g) { wrap.appendChild(card(g)); });
    }
    root.appendChild(wrap);

    // secondary, collapsed: past windows + archived (out of the main view)
    if (past.length) {
      var sec = elc('div', 'goals-past');
      var toggle = elc('button', 'goals-past-toggle', (showPast ? 'إخفاء' : 'عرض') + ' السابقة والمؤرشفة (' + past.length + ')');
      toggle.addEventListener('click', function () { showPast = !showPast; render(); });
      sec.appendChild(toggle);
      if (showPast) { var pw = elc('div', 'goals-wrap goals-wrap-past'); past.forEach(function (g) { pw.appendChild(card(g)); }); sec.appendChild(pw); }
      root.appendChild(sec);
    }
  }

  function card(g) {
    var e = GM().evaluate(g, todayKey());
    var h = healthOf(g);
    var c = elc('button', 'goal-card'); c.setAttribute('data-goal', g.id);
    c.addEventListener('click', function () { openDetail(g.id); });

    var topRow = elc('div', 'goal-card-top');
    topRow.appendChild(elc('span', 'goal-card-title', g.title || 'هدف بلا اسم'));
    topRow.appendChild(badge(h));
    c.appendChild(topRow);

    var bar = elc('div', 'goal-bar'); var fill = elc('div', 'goal-bar-fill ' + PACE_CLASS[h]); fill.style.width = Math.round(e.progress_pct) + '%'; bar.appendChild(fill);
    c.appendChild(bar);

    var meta = elc('div', 'goal-card-meta');
    meta.appendChild(elc('span', 'goal-pct', Math.round(e.progress_pct) + '%'));
    if (g.measurement_type !== 'percentage') meta.appendChild(elc('span', 'goal-ct', fmtNum(e.current) + ' / ' + fmtNum(e.target) + (g.unit ? ' ' + g.unit : '')));
    var dl = daysLeft(g);
    if (dl != null && g.status !== 'completed') meta.appendChild(elc('span', 'goal-left', dl >= 0 ? (dl + ' يومًا متبقيًا') : 'انتهت المدة'));
    c.appendChild(meta);
    return c;
  }

  function badge(h) { var b = elc('span', 'goal-badge ' + PACE_CLASS[h], PACE[h] || ''); return b; }
  function fmtNum(n) { return (Math.round((Number(n) || 0) * 100) / 100).toString(); }

  // ---------------- create / edit sheet ----------------
  function overlay(id) {
    var ov = $(id);
    if (!ov) { ov = elc('div', 'overlay'); ov.id = id; document.body.appendChild(ov); }
    return ov;
  }
  function closeOverlay(id) { var ov = $(id); if (ov) { ov.classList.remove('show'); ov.innerHTML = ''; } }

  function seg(groupCls, options, current, onPick) {
    var g = elc('div', 'goal-seg ' + (groupCls || ''));
    Object.keys(options).forEach(function (k) {
      var chip = elc('button', 'goal-seg-chip' + (k === current ? ' on' : ''), options[k]);
      chip.setAttribute('data-val', k);
      chip.addEventListener('click', function () {
        g.querySelectorAll('.goal-seg-chip').forEach(function (x) { x.classList.remove('on'); });
        chip.classList.add('on'); onPick(k);
      });
      g.appendChild(chip);
    });
    return g;
  }

  function field(labelText) { var f = elc('div', 'field'); if (labelText) f.appendChild(elc('label', null, labelText)); return f; }

  function openSheet(id) {
    editingId = id; showAdvanced = false;
    var existing = id ? goalsList()[id] : null;
    draftMeasure = existing ? existing.measurement_type : 'count';
    draftPeriod = existing ? existing.period_type : selectedTab; // a new goal defaults to the tab you're on
    var ov = overlay('goalSheetOverlay'); ov.innerHTML = '';
    var sheet = elc('div', 'sheet goal-sheet'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
    sheet.appendChild(elc('h2', null, id ? 'تعديل الهدف' : 'هدف جديد'));

    // 1) name
    var fName = field('اسم الهدف');
    var name = elc('input'); name.id = 'goalName'; name.type = 'text'; name.placeholder = 'مثال: ختم جزء هذا الأسبوع'; name.value = existing ? existing.title : '';
    fName.appendChild(name); sheet.appendChild(fName);

    // 2) period
    var fPeriod = field('الفترة');
    fPeriod.appendChild(seg('goal-seg-period', PERIOD_PICK, draftPeriod, function (k) { draftPeriod = k; }));
    sheet.appendChild(fPeriod);

    // 3) measurement
    var fMeasure = field('طريقة القياس');
    fMeasure.appendChild(seg('goal-seg-measure', MEASURE, draftMeasure, function (k) { draftMeasure = k; syncMeasureUI(sheet); }));
    sheet.appendChild(fMeasure);

    // 4) target (+ unit shortcut for quantity shown inline in advanced; here just the number)
    var fTarget = field('القيمة المستهدفة'); fTarget.id = 'goalTargetField';
    var target = elc('input'); target.id = 'goalTarget'; target.type = 'number'; target.min = '0'; target.inputMode = 'numeric';
    target.placeholder = draftMeasure === 'percentage' ? '100' : 'مثال: 12'; target.value = existing ? String(existing.target_value || '') : '';
    fTarget.appendChild(target); sheet.appendChild(fTarget);

    // milestones field (only when measurement = milestones)
    var fMs = field('المراحل'); fMs.id = 'goalMsField';
    var msList = elc('div', 'goal-ms-edit'); msList.id = 'goalMsList'; fMs.appendChild(msList);
    var addMs = elc('button', 'btn ghost goal-ms-add', '+ إضافة مرحلة'); addMs.addEventListener('click', function () { addMsRow(''); });
    fMs.appendChild(addMs); sheet.appendChild(fMs);
    (existing && Array.isArray(existing.milestones) ? existing.milestones : []).forEach(function (m) { addMsRow(m.label); });

    // advanced toggle
    var advBtn = elc('button', 'btn ghost goal-adv-toggle', showAdvanced ? 'إخفاء الخيارات الإضافية' : 'خيارات إضافية');
    advBtn.id = 'goalAdvToggle'; advBtn.addEventListener('click', function () { showAdvanced = !showAdvanced; $('goalAdv').classList.toggle('hidden', !showAdvanced); advBtn.textContent = showAdvanced ? 'إخفاء الخيارات الإضافية' : 'خيارات إضافية'; });
    sheet.appendChild(advBtn);

    var adv = elc('div', 'goal-adv' + (showAdvanced ? '' : ' hidden')); adv.id = 'goalAdv';
    // area
    var fArea = field('المجال');
    var areaOpts = { '': 'بدون' }; Object.keys(AREA).forEach(function (k) { areaOpts[k] = AREA[k]; });
    var areaSeg = seg('goal-seg-area', areaOpts, existing && existing.area ? existing.area : '', function (k) { adv.setAttribute('data-area', k); });
    adv.setAttribute('data-area', existing && existing.area ? existing.area : '');
    fArea.appendChild(areaSeg); adv.appendChild(fArea);
    // why
    var fWhy = field('لماذا هذا الهدف؟');
    var why = elc('textarea'); why.id = 'goalWhy'; why.rows = 2; why.maxLength = 2000; why.placeholder = 'يذكّرك بسبب اختياره'; why.value = existing ? (existing.why || '') : '';
    fWhy.appendChild(why); adv.appendChild(fWhy);
    // unit
    var fUnit = field('الوحدة (اختياري)');
    var unit = elc('input'); unit.id = 'goalUnit'; unit.type = 'text'; unit.maxLength = 24; unit.placeholder = 'صفحة / ساعة / جلسة'; unit.value = existing ? (existing.unit || '') : '';
    fUnit.appendChild(unit); adv.appendChild(fUnit);
    // parent goal
    var fParent = field('هدف أعلى (اختياري)');
    var parent = elc('select'); parent.id = 'goalParent';
    var none = elc('option', null, 'بدون'); none.value = ''; parent.appendChild(none);
    var all = goalsList();
    Object.keys(all).forEach(function (pid) {
      if (pid === id) return; var pg = all[pid];
      if (pg.status === 'archived') return;
      // a weekly can sit under monthly/quarterly, a monthly under quarterly; quarterly has no parent.
      var ok = (draftPeriod === 'weekly' && (pg.period_type === 'monthly' || pg.period_type === 'quarterly')) || (draftPeriod === 'monthly' && pg.period_type === 'quarterly');
      if (!ok) return;
      var o = elc('option', null, pg.title || 'هدف'); o.value = pid; if (existing && existing.parent_goal_id === pid) o.selected = true; parent.appendChild(o);
    });
    fParent.appendChild(parent); adv.appendChild(fParent);
    sheet.appendChild(adv);

    var msg = elc('p', 'goal-sheet-msg'); msg.id = 'goalSheetMsg'; sheet.appendChild(msg);
    var actions = elc('div', 'sheet-actions');
    var cancel = elc('button', 'btn ghost', 'إلغاء'); cancel.addEventListener('click', function () { closeOverlay('goalSheetOverlay'); });
    var save = elc('button', 'btn primary', id ? 'حفظ' : 'إنشاء'); save.id = 'goalSave'; save.addEventListener('click', function () { saveSheet(); });
    actions.appendChild(cancel); actions.appendChild(save);
    sheet.appendChild(actions);

    ov.appendChild(sheet); ov.classList.add('show');
    syncMeasureUI(sheet);
    try { name.focus(); } catch (e) {}
  }

  function addMsRow(label) {
    var list = $('goalMsList'); if (!list) return;
    var row = elc('div', 'goal-ms-row');
    var inp = elc('input'); inp.type = 'text'; inp.className = 'goal-ms-input'; inp.maxLength = 200; inp.placeholder = 'عنوان المرحلة'; inp.value = label || '';
    var del = elc('button', 'goal-ms-del', '×'); del.addEventListener('click', function () { list.removeChild(row); });
    row.appendChild(inp); row.appendChild(del); list.appendChild(row);
  }

  function syncMeasureUI(sheet) {
    var isMs = draftMeasure === 'milestones';
    var ms = $('goalMsField'); if (ms) ms.classList.toggle('hidden', !isMs);
    var tf = $('goalTargetField'); if (tf) tf.classList.toggle('hidden', isMs); // milestones derive their own target (count)
    var t = $('goalTarget'); if (t) t.placeholder = draftMeasure === 'percentage' ? '100' : 'مثال: 12';
  }

  function saveSheet() {
    var name = ($('goalName').value || '').trim();
    var msg = $('goalSheetMsg');
    if (name.length < 2) { if (msg) msg.textContent = 'اكتب اسمًا واضحًا للهدف (حرفان على الأقل).'; return; }
    var measure = draftMeasure, period = draftPeriod;
    var milestones = [];
    if (measure === 'milestones') {
      var rows = $('goalMsList').querySelectorAll('.goal-ms-input');
      rows.forEach(function (inp, i) { var l = (inp.value || '').trim(); if (l) milestones.push({ id: 'ms-' + nowMs().toString(36) + '-' + i, label: l, order: i, completed: false, completed_at: null }); });
      if (!milestones.length) { if (msg) msg.textContent = 'أضف مرحلة واحدة على الأقل، أو اختر طريقة قياس أخرى.'; return; }
    }
    var targetRaw = measure === 'milestones' ? milestones.length : Number($('goalTarget').value);
    var target = Number.isFinite(targetRaw) ? targetRaw : (measure === 'percentage' ? 100 : 0);
    var area = $('goalAdv') ? ($('goalAdv').getAttribute('data-area') || '') : '';
    var why = $('goalWhy') ? $('goalWhy').value : '';
    var unit = $('goalUnit') ? $('goalUnit').value : '';
    var parent = $('goalParent') ? $('goalParent').value : '';

    var all = Object.assign({}, goalsList());
    var now = nowMs();
    if (editingId && all[editingId]) {
      var prev = all[editingId];
      // keep completed state of existing milestones by label match (edit is light-touch in V1)
      if (measure === 'milestones') {
        var byLabel = {}; (prev.milestones || []).forEach(function (m) { byLabel[m.label] = m; });
        milestones = milestones.map(function (m) { var old = byLabel[m.label]; return old ? Object.assign({}, m, { id: old.id, completed: old.completed, completed_at: old.completed_at }) : m; });
      }
      // if the period type changed on edit, recompute the window so the goal lands in the right tab's CURRENT period.
      var win = (period !== prev.period_type) ? GM().periodBounds(period, todayKey()) : { start_date: prev.start_date, end_date: prev.end_date };
      all[editingId] = Object.assign({}, prev, {
        title: name, period_type: period, measurement_type: measure, target_value: target,
        start_date: win.start_date, end_date: win.end_date,
        unit: unit || null, area: area || null, why: why || '', parent_goal_id: parent || null,
        milestones: measure === 'milestones' ? milestones : [], updated_at: now,
      });
    } else {
      var g = GM().newGoal({ title: name, period_type: period, measurement_type: measure, target_value: target, unit: unit || null, area: area || null, why: why || '', parent_goal_id: parent || null, milestones: milestones }, now, todayKey());
      all[g.id] = g;
    }
    persist(all);
    closeOverlay('goalSheetOverlay');
    render();
  }

  // ---------------- detail sheet ----------------
  function openDetail(id) {
    detailId = id;
    var g = goalsList()[id]; if (!g) return;
    var ov = overlay('goalDetailOverlay'); ov.innerHTML = '';
    var sheet = elc('div', 'sheet goal-detail'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
    var e = GM().evaluate(g, todayKey()); var h = healthOf(g);

    var hd = elc('div', 'goal-detail-head');
    hd.appendChild(elc('h2', null, g.title || 'هدف'));
    hd.appendChild(badge(h));
    sheet.appendChild(hd);
    if (g.why) sheet.appendChild(elc('p', 'goal-why', g.why));

    var bar = elc('div', 'goal-bar big'); var fill = elc('div', 'goal-bar-fill ' + PACE_CLASS[h]); fill.style.width = Math.round(e.progress_pct) + '%'; bar.appendChild(fill); sheet.appendChild(bar);

    var stats = elc('div', 'goal-stats');
    stats.appendChild(stat(Math.round(e.progress_pct) + '%', 'التقدّم'));
    if (g.measurement_type !== 'percentage') stats.appendChild(stat(fmtNum(e.current) + ' / ' + fmtNum(e.target) + (g.unit ? ' ' + g.unit : ''), 'الإنجاز'));
    var dl = daysLeft(g); if (dl != null) stats.appendChild(stat(dl >= 0 ? (dl + ' يومًا') : 'انتهت', 'المتبقي'));
    stats.appendChild(stat(MEASURE[g.measurement_type] || '', 'طريقة القياس'));
    sheet.appendChild(stats);

    // quick progress update
    sheet.appendChild(progressControl(g));

    // milestones checklist
    if (g.measurement_type === 'milestones' && Array.isArray(g.milestones) && g.milestones.length) {
      var ms = elc('div', 'goal-ms-view');
      g.milestones.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); }).forEach(function (m) {
        var row = elc('label', 'goal-ms-view-row');
        var chk = elc('input'); chk.type = 'checkbox'; chk.checked = m.completed === true;
        chk.addEventListener('change', function () { toggleMilestone(g.id, m.id, chk.checked); });
        row.appendChild(chk); row.appendChild(elc('span', null, m.label));
        ms.appendChild(row);
      });
      sheet.appendChild(ms);
    }

    // actions
    var acts = elc('div', 'goal-actions');
    if (g.status !== 'completed') acts.appendChild(actBtn('تحديد كمكتمل', 'primary', function () { setStatus(g.id, 'completed'); }));
    else acts.appendChild(actBtn('إلغاء الإكمال', 'ghost', function () { setStatus(g.id, 'not_started'); }));
    if (g.status === 'paused') acts.appendChild(actBtn('استئناف', 'ghost', function () { setStatus(g.id, 'not_started'); }));
    else if (g.status !== 'completed') acts.appendChild(actBtn('إيقاف مؤقت', 'ghost', function () { setStatus(g.id, 'paused'); }));
    acts.appendChild(actBtn('تعديل', 'ghost', function () { closeOverlay('goalDetailOverlay'); openSheet(g.id); }));
    acts.appendChild(actBtn('أرشفة', 'ghost', function () { setStatus(g.id, 'archived'); closeOverlay('goalDetailOverlay'); }));
    acts.appendChild(actBtn('حذف', 'danger', function () { delGoal(g.id); }));
    sheet.appendChild(acts);

    var close = elc('div', 'sheet-actions'); var cb2 = elc('button', 'btn ghost', 'إغلاق'); cb2.addEventListener('click', function () { closeOverlay('goalDetailOverlay'); }); close.appendChild(cb2); sheet.appendChild(close);

    ov.appendChild(sheet); ov.classList.add('show');
  }

  function stat(v, l) { var s = elc('div', 'goal-stat'); s.appendChild(elc('div', 'goal-stat-v', v)); s.appendChild(elc('div', 'goal-stat-l', l)); return s; }
  function actBtn(label, kind, fn) { var b = elc('button', 'btn ' + kind + ' goal-act', label); b.addEventListener('click', fn); return b; }

  function progressControl(g) {
    var wrap = elc('div', 'goal-progress-ctl');
    if (g.measurement_type === 'milestones') { return wrap; } // handled by the checklist
    if (g.measurement_type === 'linked_activity') { wrap.appendChild(elc('p', 'goal-linked-note', 'يُحسب تلقائيًا من المهام والروتين المرتبط (قريبًا).')); return wrap; }
    wrap.appendChild(elc('label', 'field-label', g.measurement_type === 'percentage' ? 'نسبة الإنجاز (٠–١٠٠)' : 'الإنجاز الحالي'));
    var row = elc('div', 'goal-progress-row');
    var inp = elc('input'); inp.id = 'goalProgInput'; inp.type = 'number'; inp.min = '0'; inp.inputMode = 'numeric'; inp.value = String(g.current_value || 0);
    var save = elc('button', 'btn primary', 'حفظ'); save.addEventListener('click', function () { setCurrent(g.id, Number($('goalProgInput').value)); });
    row.appendChild(inp); row.appendChild(save); wrap.appendChild(row);
    return wrap;
  }

  // ---------------- mutations ----------------
  function mutate(id, fn) {
    var all = Object.assign({}, goalsList()); var g = all[id]; if (!g) return;
    var ng = Object.assign({}, g); fn(ng); ng.updated_at = nowMs(); all[id] = ng; persist(all);
  }
  function setCurrent(id, val) {
    if (!Number.isFinite(val)) val = 0;
    mutate(id, function (g) { g.current_value = Math.max(0, val); });
    render(); openDetail(id);
  }
  function toggleMilestone(id, msId, on) {
    mutate(id, function (g) { g.milestones = (g.milestones || []).map(function (m) { return m.id === msId ? Object.assign({}, m, { completed: !!on, completed_at: on ? nowMs() : null }) : m; }); });
    render(); openDetail(id);
  }
  function setStatus(id, status) {
    mutate(id, function (g) { g.status = status; g.completed_at = status === 'completed' ? nowMs() : null; g.archived_at = status === 'archived' ? nowMs() : null; });
    render(); if (status !== 'archived' && $('goalDetailOverlay') && $('goalDetailOverlay').classList.contains('show')) openDetail(id);
  }
  function delGoal(id) {
    var g = goalsList()[id]; var name = g ? (g.title || 'هذا الهدف') : 'هذا الهدف';
    if (!global.confirm('حذف «' + name + '»؟ لا يمكن التراجع.')) return;
    var all = Object.assign({}, goalsList()); delete all[id]; persist(all);
    closeOverlay('goalDetailOverlay'); render();
  }

  global.AyyamGoalsUI = { init: init, render: render, openCreate: function () { openSheet(null); }, _peek: function () { return goalsList(); } };
})(typeof globalThis !== 'undefined' ? globalThis : window);
