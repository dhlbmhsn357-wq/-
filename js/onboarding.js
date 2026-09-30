// First-time onboarding (P5). Classic script: sets globalThis.AyyamOnboarding. Presentational only —
// app.js supplies the steps + persistence callbacks (server-side completion lives there). Two surfaces:
//   startTour(...)    — a calm spotlight/overlay tour (prev/next/skip, step counter, RTL, mobile-first).
//   startStarter(...) — an OPTIONAL "prepare your day" screen; nothing is added unless the user ticks it.
// Ayyam's own identity (no copy of another app). Never blocks the app: any positioning error falls back to a
// centered card, and closing always hands control back.
(function (global) {
  'use strict';
  var steps = [], idx = 0, cbProgress = null, cbDone = null, mode = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ar(nu) { return String(nu).replace(/[0-9]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'[+d]; }); }
  function view() { return $('onbView'); }
  function show() { var v = view(); if (v) { v.classList.remove('hidden'); document.body.classList.add('onb-open'); } }
  function hideView() { var v = view(); if (v) { v.classList.add('hidden'); v.innerHTML = ''; } document.body.classList.remove('onb-open'); }

  // ---- spotlight tour ----
  function targetRect(sel) {
    if (!sel) return null;
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return null;
    return r;
  }

  function renderStep() {
    var v = view(); if (!v) return;
    var s = steps[idx] || {};
    var r = targetRect(s.target);
    var pad = 8;
    var holeHtml = '';
    if (r) {
      // getBoundingClientRect gives PHYSICAL coordinates → use physical left (not inset-inline-start, which
      // flips to the right edge in RTL and would misplace the cutout).
      holeHtml = '<div class="onb-hole" style="top:' + (r.top - pad) + 'px;left:' + (r.left - pad)
        + 'px;width:' + (r.width + pad * 2) + 'px;height:' + (r.height + pad * 2) + 'px;"></div>';
    }
    var isLast = idx === steps.length - 1;
    var counter = '<div class="onb-count">' + ar(idx + 1) + ' / ' + ar(steps.length) + '</div>';
    var dots = steps.map(function (_, i) { return '<i class="onb-dot' + (i === idx ? ' on' : '') + '"></i>'; }).join('');
    var prev = idx > 0 ? '<button class="onb-btn ghost" id="onbPrev">السابق</button>' : '<span></span>';
    var next = '<button class="onb-btn primary" id="onbNext">' + (isLast ? (s.cta || 'ابدأ يومك') : 'التالي') + '</button>';
    var card = '<div class="onb-card" id="onbCard">'
      + '<div class="onb-card-top">' + counter + '<button class="onb-skip" id="onbSkip">تخطّي</button></div>'
      + (s.icon ? '<div class="onb-icon">' + s.icon + '</div>' : '')
      + '<h2 class="onb-title">' + esc(s.title) + '</h2>'
      + '<p class="onb-body">' + esc(s.body) + '</p>'
      + '<div class="onb-dots">' + dots + '</div>'
      + '<div class="onb-nav">' + prev + next + '</div>'
      + '</div>';
    v.innerHTML = '<div class="onb-scrim"' + (r ? '' : ' data-center="1"') + '>' + holeHtml + '</div>'
      + '<div class="onb-cardwrap" id="onbCardWrap">' + card + '</div>';
    positionCard(r);
    bindStep();
    if (typeof cbProgress === 'function') { try { cbProgress(idx); } catch (e) {} }
  }

  // Place the card near the target (below if the target is in the top half, else above); centered if no target.
  function positionCard(r) {
    var wrap = $('onbCardWrap'); if (!wrap) return;
    if (!r) { wrap.classList.add('center'); return; }
    wrap.classList.remove('center');
    var vh = window.innerHeight, below = r.bottom + 14, above = r.top - 14;
    if (r.top < vh * 0.5) { wrap.style.top = below + 'px'; wrap.style.bottom = 'auto'; }
    else { wrap.style.top = 'auto'; wrap.style.bottom = (vh - above) + 'px'; }
  }

  function bindStep() {
    var next = $('onbNext'); if (next) next.addEventListener('click', function () {
      if (idx >= steps.length - 1) { finish('finished'); } else { idx++; renderStep(); }
    });
    var prev = $('onbPrev'); if (prev) prev.addEventListener('click', function () { if (idx > 0) { idx--; renderStep(); } });
    var skip = $('onbSkip'); if (skip) skip.addEventListener('click', function () { finish('skipped'); });
  }

  var onResize = function () { if (mode === 'tour') { var s = steps[idx] || {}; positionCard(targetRect(s.target)); var v = view(); if (v) { var hole = v.querySelector('.onb-hole'); var r = targetRect(s.target); if (hole && r) { hole.style.top = (r.top - 8) + 'px'; hole.style.left = (r.left - 8) + 'px'; hole.style.width = (r.width + 16) + 'px'; hole.style.height = (r.height + 16) + 'px'; } } } };

  function finish(via) {
    window.removeEventListener('resize', onResize);
    var done = cbDone; mode = null;
    hideView();
    if (typeof done === 'function') { try { done(via); } catch (e) {} }
  }

  function startTour(opts) {
    opts = opts || {};
    steps = opts.steps || []; if (!steps.length) return;
    idx = Math.min(Math.max(opts.startStep || 0, 0), steps.length - 1);
    cbProgress = opts.onProgress; cbDone = opts.onDone; mode = 'tour';
    show();
    window.addEventListener('resize', onResize);
    renderStep();
  }

  // ---- optional starter setup (explicit selection ONLY — nothing is added without a tick) ----
  function startStarter(opts) {
    opts = opts || {};
    var items = opts.suggestions || [];
    var onApply = opts.onApply, onSkip = opts.onSkip;
    mode = 'starter'; show();
    var v = view(); if (!v) return;
    var picked = {};
    function rowsHtml() {
      return items.map(function (it) {
        return '<label class="starter-item"><input type="checkbox" data-id="' + esc(it.id) + '"' + (picked[it.id] ? ' checked' : '') + '/>'
          + '<span class="starter-item-title">' + esc(it.title) + '</span></label>';
      }).join('');
    }
    function render() {
      var count = Object.keys(picked).filter(function (k) { return picked[k]; }).length;
      v.innerHTML = '<div class="onb-scrim" data-center="1"></div>'
        + '<div class="onb-cardwrap center"><div class="onb-card starter-card">'
        + '<div class="onb-icon">🌱</div>'
        + '<h2 class="onb-title">هل تريد تجهيز يومك بسرعة؟</h2>'
        + '<p class="onb-body">اختر ما تريد المحافظة عليه — ويمكنك تعديله لاحقًا. لن نضيف شيئًا دون اختيارك.</p>'
        + '<div class="starter-list">' + rowsHtml() + '</div>'
        + '<div class="onb-nav"><button class="onb-btn ghost" id="starterSkip">تخطّي</button>'
        + '<button class="onb-btn primary" id="starterApply"' + (count ? '' : ' disabled') + '>إضافة المختار'
        + (count ? ' (' + ar(count) + ')' : '') + '</button></div>'
        + '</div></div>';
      Array.prototype.forEach.call(v.querySelectorAll('.starter-item input'), function (cb) {
        cb.addEventListener('change', function () { picked[cb.getAttribute('data-id')] = cb.checked; render(); });
      });
      var apply = $('starterApply'); if (apply) apply.addEventListener('click', function () {
        var ids = items.filter(function (it) { return picked[it.id]; }).map(function (it) { return it.id; });
        mode = null; hideView(); if (typeof onApply === 'function') { try { onApply(ids); } catch (e) {} }
      });
      var skip = $('starterSkip'); if (skip) skip.addEventListener('click', function () {
        mode = null; hideView(); if (typeof onSkip === 'function') { try { onSkip(); } catch (e) {} }
      });
    }
    render();
  }

  function isOpen() { var v = view(); return !!(v && !v.classList.contains('hidden')); }
  function close() { window.removeEventListener('resize', onResize); mode = null; hideView(); }
  // Android hardware Back: in the tour, step back if possible, else exit (counts as skip); on the starter, skip.
  function back() {
    if (mode === 'tour') { if (idx > 0) { idx--; renderStep(); } else { finish('skipped'); } return true; }
    if (mode === 'starter') { close(); return true; }
    return false;
  }

  global.AyyamOnboarding = { startTour: startTour, startStarter: startStarter, isOpen: isOpen, close: close, back: back };
})(typeof globalThis !== 'undefined' ? globalThis : window);
