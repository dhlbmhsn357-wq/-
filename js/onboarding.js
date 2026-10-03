// First-time onboarding (P5). Classic script: sets globalThis.AyyamOnboarding. Presentational only —
// app.js supplies the steps + persistence callbacks (server-side completion lives there). Two surfaces:
//   startTour(...)    — a calm spotlight/overlay tour (prev/next/skip, step counter, RTL, mobile-first).
//   startStarter(...) — an OPTIONAL "prepare your day" screen; nothing is added unless the user ticks it.
// Ayyam's own identity (no copy of another app). Never blocks the app: any positioning error falls back to a
// centered card, and closing always hands control back.
(function (global) {
  'use strict';
  var steps = [], idx = 0, cbProgress = null, cbDone = null, cbPrepare = null, mode = null;

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
    var card = '<div class="onb-card" id="onbCard" role="dialog" aria-modal="true" aria-label="' + esc(s.title || 'جولة تعريفية') + '" tabindex="-1">'
      + '<div class="onb-card-top">' + counter + '<button class="onb-skip" id="onbSkip">تخطّي</button></div>'
      + (s.icon ? '<div class="onb-icon">' + s.icon + '</div>' : '')
      + '<h2 class="onb-title">' + esc(s.title) + '</h2>'
      + '<p class="onb-body">' + esc(s.body) + '</p>'
      + '<div class="onb-dots">' + dots + '</div>'
      + '<div class="onb-nav">' + prev + next + '</div>'
      + '</div>';
    v.innerHTML = '<div class="onb-scrim"' + (r ? '' : ' data-center="1"') + '>' + holeHtml + '</div>'
      + '<div class="onb-cardwrap" id="onbCardWrap">' + card + '</div>';
    bindStep();
    ensureVisibleThenLayout(s);
    if (typeof cbProgress === 'function') { try { cbProgress(idx); } catch (e) {} }
  }

  // If the target is off-screen, bring it into view first (controlled), then measure + position after layout.
  function ensureVisibleThenLayout(s) {
    var el = s && s.target ? document.querySelector(s.target) : null;
    if (el) {
      var r = el.getBoundingClientRect();
      var vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
      if (r.bottom < 0 || r.top > vh || r.top < 0) {
        try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); }
        catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
      }
    }
    // measure + place after the browser has applied any scroll/layout (double rAF = post-layout)
    requestAnimationFrame(function () { layout(); requestAnimationFrame(layout); });
    focusCard();
  }

  function focusCard() {
    var card = $('onbCard'); if (!card) return;
    try { card.focus({ preventScroll: true }); } catch (e) { try { card.focus(); } catch (e2) {} }
  }

  // Robust placement: keep the card FULLY inside the (visual) viewport. Measure the card, then try to seat it
  // below → above → right → left of the target, choosing the first side with enough room; if none fit (or the
  // target is off-screen / absent), fall back to a centered modal. Everything is clamped to safe margins +
  // safe-area insets on every axis, so Next/Prev/Skip are ALWAYS visible and tappable.
  function layout() {
    if (mode !== 'tour') return;
    var v = view(); if (!v) return;
    var wrap = $('onbCardWrap'); var card = $('onbCard'); if (!wrap || !card) return;
    var s = steps[idx] || {};
    var r = targetRect(s.target);
    // keep the spotlight hole aligned with the (possibly scrolled) target
    var hole = v.querySelector('.onb-hole');
    if (hole && r) { hole.style.top = (r.top - 8) + 'px'; hole.style.left = (r.left - 8) + 'px'; hole.style.width = (r.width + 16) + 'px'; hole.style.height = (r.height + 16) + 'px'; }
    if (!r) { centerCard(wrap); return; }

    var vv = window.visualViewport;
    var vpTop = vv ? vv.offsetTop : 0, vpLeft = vv ? vv.offsetLeft : 0;
    var vw = vv ? vv.width : window.innerWidth, vh = vv ? vv.height : window.innerHeight;
    var M = 14, safeTop = safeInset('top'), safeBottom = safeInset('bottom');
    var minX = vpLeft + M, maxX = vpLeft + vw - M;
    var minY = vpTop + M + safeTop, maxY = vpTop + vh - M - safeBottom;
    var cw = card.offsetWidth, ch = card.offsetHeight;
    function clampX(x) { return Math.max(minX, Math.min(x, maxX - cw)); }
    function clampY(y) { return Math.max(minY, Math.min(y, maxY - ch)); }

    // target essentially outside the usable viewport → center (keeps the card reachable)
    if (r.bottom < minY || r.top > maxY) { centerCard(wrap); return; }

    var spaceBelow = maxY - r.bottom, spaceAbove = r.top - minY;
    var spaceRight = maxX - r.right, spaceLeft = r.left - minX;
    var place = null;
    if (spaceBelow >= ch + M) place = { top: r.bottom + M, left: clampX(r.left + r.width / 2 - cw / 2) };
    else if (spaceAbove >= ch + M) place = { top: r.top - M - ch, left: clampX(r.left + r.width / 2 - cw / 2) };
    else if (spaceRight >= cw + M) place = { left: r.right + M, top: clampY(r.top + r.height / 2 - ch / 2) };
    else if (spaceLeft >= cw + M) place = { left: r.left - M - cw, top: clampY(r.top + r.height / 2 - ch / 2) };
    if (!place) { centerCard(wrap); return; }

    wrap.classList.remove('center');
    wrap.classList.add('pos');
    wrap.style.width = cw + 'px';
    wrap.style.left = clampX(place.left) + 'px';
    wrap.style.top = clampY(place.top) + 'px';
    wrap.style.right = 'auto'; wrap.style.bottom = 'auto';
  }
  function centerCard(wrap) {
    wrap.classList.remove('pos');
    wrap.classList.add('center');
    wrap.style.top = ''; wrap.style.left = ''; wrap.style.right = ''; wrap.style.bottom = ''; wrap.style.width = '';
  }
  // Read a CSS env(safe-area-inset-*) value in px (0 when unsupported) — notch / status / nav insets.
  function safeInset(side) {
    try {
      var probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;height:env(safe-area-inset-' + side + ',0px);width:0;visibility:hidden;pointer-events:none;';
      document.body.appendChild(probe);
      var px = probe.getBoundingClientRect().height || 0;
      document.body.removeChild(probe);
      return px;
    } catch (e) { return 0; }
  }

  // Move to step i: run the app-supplied per-step prepare hook FIRST (navigate to the right screen / open the
  // relevant UI so the step can spotlight a REAL element), then render + position. The hook may be async.
  function goToStep(i) {
    idx = Math.min(Math.max(i, 0), steps.length - 1);
    if (mode !== 'tour') return;
    var s = steps[idx] || {};
    if (typeof cbPrepare === 'function') {
      var p; try { p = cbPrepare(s, idx); } catch (e) { p = null; }
      if (p && typeof p.then === 'function') { p.then(function () { if (mode === 'tour') renderStep(); }, function () { if (mode === 'tour') renderStep(); }); return; }
    }
    renderStep();
  }

  function bindStep() {
    var next = $('onbNext'); if (next) next.addEventListener('click', function () {
      if (idx >= steps.length - 1) { finish('finished'); } else { goToStep(idx + 1); }
    });
    var prev = $('onbPrev'); if (prev) prev.addEventListener('click', function () { if (idx > 0) { goToStep(idx - 1); } });
    var skip = $('onbSkip'); if (skip) skip.addEventListener('click', function () { finish('skipped'); });
  }

  var onResize = function () { if (mode === 'tour') layout(); };
  var onKey = function (e) {
    if (mode !== 'tour') return;
    if (e.key === 'Escape') { e.preventDefault(); finish('skipped'); return; }
    if (e.key === 'Tab') { trapTab(e); }
  };
  // Simple focus trap: keep keyboard focus inside the card (a11y).
  function trapTab(e) {
    var card = $('onbCard'); if (!card) return;
    var f = card.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function addListeners() {
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.addEventListener('scroll', onResize, true);
    document.addEventListener('keydown', onKey, true);
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', onResize); window.visualViewport.addEventListener('scroll', onResize); }
  }
  function removeListeners() {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    window.removeEventListener('scroll', onResize, true);
    document.removeEventListener('keydown', onKey, true);
    if (window.visualViewport) { window.visualViewport.removeEventListener('resize', onResize); window.visualViewport.removeEventListener('scroll', onResize); }
  }

  function finish(via) {
    removeListeners();
    var done = cbDone; mode = null;
    hideView();
    if (typeof done === 'function') { try { done(via); } catch (e) {} }
  }

  function startTour(opts) {
    opts = opts || {};
    steps = opts.steps || []; if (!steps.length) return;
    idx = Math.min(Math.max(opts.startStep || 0, 0), steps.length - 1);
    cbProgress = opts.onProgress; cbDone = opts.onDone; cbPrepare = opts.onBeforeStep; mode = 'tour';
    show();
    addListeners();
    goToStep(idx);
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
  function close() { removeListeners(); mode = null; hideView(); }
  // Android hardware Back: in the tour, step back if possible, else exit (counts as skip); on the starter, skip.
  function back() {
    if (mode === 'tour') { if (idx > 0) { goToStep(idx - 1); } else { finish('skipped'); } return true; }
    if (mode === 'starter') { close(); return true; }
    return false;
  }

  global.AyyamOnboarding = { startTour: startTour, startStarter: startStarter, isOpen: isOpen, close: close, back: back };
})(typeof globalThis !== 'undefined' ? globalThis : window);
