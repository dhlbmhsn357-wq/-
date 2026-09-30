// Admin dashboard (P4). Classic script: sets globalThis.AyyamAdmin. Presentational + data-fetching only —
// ALL authority is backend-side (the RPCs return 'forbidden' to non-admins). This UI is never in normal
// navigation; app.js reveals its entry only when is_admin() is true. Product analytics ONLY: it renders
// aggregates + an identity/presence users table, never any task/prayer/log content (the RPCs can't return it).
(function (global) {
  'use strict';
  var call = null, state = { search: '', offset: 0, limit: 25, sort: 'last_seen_at', dir: 'desc' }, overview = null;
  var searchTimer = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n(x) { return (x == null ? 0 : Number(x)).toLocaleString('en-US'); }
  function fmtDate(iso) { if (!iso) return '—'; try { return new Intl.DateTimeFormat('ar', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso)); } catch (e) { return '—'; } }
  function ago(iso) {
    if (!iso) return '—';
    var d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return 'الآن';
    if (d < 3600) return 'قبل ' + Math.floor(d / 60) + ' د';
    if (d < 86400) return 'قبل ' + Math.floor(d / 3600) + ' س';
    if (d < 2592000) return 'قبل ' + Math.floor(d / 86400) + ' يوم';
    return fmtDate(iso);
  }
  var STATUS_AR = { none: 'نشط', completed: 'نشط', in_progress: 'قيد الترحيل' };

  function metricCard(label, value, sub) {
    return '<div class="adm-card"><div class="adm-card-val">' + n(value) + '</div>'
      + '<div class="adm-card-lbl">' + esc(label) + '</div>'
      + (sub ? '<div class="adm-card-sub">' + esc(sub) + '</div>' : '') + '</div>';
  }
  // A calm trend: three bars (today / 7d / 30d) scaled to the largest of the three.
  function trendRow(label, a, b, c) {
    var max = Math.max(a, b, c, 1);
    var bar = function (v, t) { return '<div class="adm-bar"><span class="adm-bar-fill" style="width:' + Math.round(100 * v / max) + '%"></span><i>' + t + '</i><b>' + n(v) + '</b></div>'; };
    return '<div class="adm-trend"><div class="adm-trend-lbl">' + esc(label) + '</div>'
      + bar(a, 'اليوم') + bar(b, '٧ أيام') + bar(c, '٣٠ يوم') + '</div>';
  }

  function renderOverview() {
    var el = $('admOverview'); if (!el) return;
    if (!overview) { el.innerHTML = '<div class="adm-empty">جارٍ التحميل…</div>'; return; }
    if (overview.status !== 'ok') { el.innerHTML = '<div class="adm-empty">لا صلاحية لعرض هذه اللوحة.</div>'; return; }
    var u = overview.users, ac = overview.active, pf = overview.platform, ob = overview.onboarding;
    var versions = (overview.versions || []).map(function (v) {
      return '<li><span>' + esc(v.version) + '</span><b>' + n(v.count) + '</b></li>'; }).join('') || '<li class="adm-muted">—</li>';
    el.innerHTML =
      '<div class="adm-grid">'
      + metricCard('إجمالي المستخدمين', u.total)
      + metricCard('مكتملو onboarding', ob.completed, ob.pct + '٪ من الكل')
      + metricCard('Android', pf.android)
      + metricCard('Web / PWA', pf.web)
      + '</div>'
      + '<div class="adm-2col">'
      + '<div class="adm-panel">' + trendRow('مستخدمون جدد', u.new_today, u.new_7d, u.new_30d) + '</div>'
      + '<div class="adm-panel">' + trendRow('النشطون', ac.today, ac.d7, ac.d30) + '</div>'
      + '</div>'
      + '<div class="adm-panel adm-versions"><div class="adm-panel-lbl">توزيع الإصدارات</div><ul>' + versions + '</ul></div>';
  }

  function sortIndicator(col) { return state.sort === col ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''; }
  function th(col, label) { return '<th data-sort="' + col + '" class="adm-th' + (state.sort === col ? ' active' : '') + '">' + esc(label) + sortIndicator(col) + '</th>'; }

  function renderUsers(res) {
    var el = $('admUsers'); if (!el) return;
    if (!res || res.status !== 'ok') { el.innerHTML = '<div class="adm-empty">تعذّر تحميل المستخدمين.</div>'; return; }
    var rows = res.rows || [];
    var body = rows.map(function (r) {
      return '<tr>'
        + '<td>' + esc(r.name || '—') + '</td>'
        + '<td class="adm-email">' + esc(r.email || '—') + '</td>'
        + '<td>' + fmtDate(r.created_at) + '</td>'
        + '<td>' + ago(r.last_seen_at) + '</td>'
        + '<td>' + esc(r.platform || '—') + '</td>'
        + '<td>' + esc(r.app_version || '—') + '</td>'
        + '<td><span class="adm-status">' + esc(STATUS_AR[r.status] || r.status || '—') + '</span></td>'
        + '</tr>';
    }).join('');
    var from = res.total ? res.offset + 1 : 0, to = Math.min(res.offset + res.limit, res.total);
    el.innerHTML =
      '<table class="adm-table"><thead><tr>'
      + th('name', 'الاسم') + th('email', 'البريد') + th('created_at', 'التسجيل')
      + th('last_seen_at', 'آخر نشاط') + '<th>المنصة</th><th>الإصدار</th><th>الحالة</th>'
      + '</tr></thead><tbody>' + (body || '<tr><td colspan="7" class="adm-empty">لا مستخدمين.</td></tr>') + '</tbody></table>'
      + '<div class="adm-pager">'
      + '<button class="btn ghost" id="admPrev"' + (res.offset <= 0 ? ' disabled' : '') + '>السابق</button>'
      + '<span class="adm-range">' + n(from) + '–' + n(to) + ' من ' + n(res.total) + '</span>'
      + '<button class="btn ghost" id="admNext"' + (res.offset + res.limit >= res.total ? ' disabled' : '') + '>التالي</button>'
      + '</div>';
    // wire pager + sortable headers
    var prev = $('admPrev'); if (prev) prev.addEventListener('click', function () { state.offset = Math.max(0, state.offset - state.limit); reloadUsers(); });
    var next = $('admNext'); if (next) next.addEventListener('click', function () { state.offset += state.limit; reloadUsers(); });
    Array.prototype.forEach.call(el.querySelectorAll('.adm-th'), function (h) {
      h.addEventListener('click', function () {
        var col = h.getAttribute('data-sort');
        if (state.sort === col) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort = col; state.dir = 'desc'; }
        state.offset = 0; reloadUsers();
      });
    });
  }

  async function reloadUsers() {
    var el = $('admUsers'); if (el && !el.querySelector('table')) el.innerHTML = '<div class="adm-empty">جارٍ التحميل…</div>';
    var res = null;
    try { res = await call('ayyam_admin_users', { p_search: state.search || null, p_limit: state.limit, p_offset: state.offset, p_sort: state.sort, p_dir: state.dir }); }
    catch (e) { res = { status: 'error' }; }
    renderUsers(res);
  }
  async function loadOverview() { try { overview = await call('ayyam_admin_overview', {}); } catch (e) { overview = { status: 'error' }; } renderOverview(); }

  function shell() {
    return '<div class="adm-head">'
      + '<button class="back-btn" id="admClose">› رجوع</button>'
      + '<span class="brand brand-strong">لوحة التحكم</span>'
      + '<button class="icon-btn" id="admRefresh" aria-label="تحديث">⟳</button>'
      + '</div>'
      + '<div class="adm-wrap">'
      + '<section id="admOverview" class="adm-section"></section>'
      + '<section class="adm-section"><div class="adm-users-head"><h3>المستخدمون</h3>'
      + '<input id="admSearch" class="adm-search" type="search" placeholder="بحث بالاسم أو البريد" autocomplete="off" /></div>'
      + '<div id="admUsers" class="adm-users"></div></section>'
      + '</div>';
  }

  function init(opts) { call = opts.call; }
  function open() {
    var view = $('adminView'); if (!view || !call) return;
    state = { search: '', offset: 0, limit: 25, sort: 'last_seen_at', dir: 'desc' }; overview = null;
    view.classList.remove('hidden'); document.body.classList.add('admin-open');
    view.innerHTML = shell();
    $('admClose').addEventListener('click', close);
    $('admRefresh').addEventListener('click', function () { loadOverview(); reloadUsers(); });
    var s = $('admSearch'); if (s) s.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { state.search = s.value.trim(); state.offset = 0; reloadUsers(); }, 300);
    });
    if (location.hash !== '#admin') { try { history.replaceState(null, '', '#admin'); } catch (e) {} }
    loadOverview(); reloadUsers();
  }
  function close() {
    var view = $('adminView'); if (view) { view.classList.add('hidden'); view.innerHTML = ''; }
    document.body.classList.remove('admin-open');
    if (location.hash === '#admin') { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
  }
  function isOpen() { var v = $('adminView'); return !!(v && !v.classList.contains('hidden')); }

  global.AyyamAdmin = { init: init, open: open, close: close, isOpen: isOpen };
})(typeof globalThis !== 'undefined' ? globalThis : window);
