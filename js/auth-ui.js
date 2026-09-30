// Premium full-screen auth experience for the public launch (P3). Classic script: sets globalThis.AyyamAuthUI.
// Purely presentational — it knows nothing about Supabase. app.js injects handlers via init() and drives the
// screen (open/close/mode/busy/message/migrating); this module only renders the Ayyam-branded RTL screens and
// reports user intent back through the handlers. Kept framework-free and DOM-based so it is e2e-testable.
(function (global) {
  'use strict';
  var VALUE_PROP = 'نظّم صلواتك وأورادك ومهامك اليومية، وتابع أيامك بثبات — على كل أجهزتك.';
  var handlers = {}, mode = 'signin', opts = {}, mounted = false;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // The five screen states share one branded shell; only the body (inputs + primary action) changes by mode.
  function bodyFor(m) {
    var email = '<input id="authEmail" class="auth-input" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="البريد الإلكتروني" />';
    var pass = function (ac, ph) { return '<input id="authPass" class="auth-input" type="password" autocomplete="' + ac + '" placeholder="' + ph + '" />'; };
    if (m === 'signup') {
      return '<h1 class="auth-title">أنشئ حسابك في أيام</h1>'
        + '<p class="auth-sub">' + VALUE_PROP + '</p>'
        + email + pass('new-password', 'كلمة المرور (٦ أحرف على الأقل)')
        + '<input id="authName" class="auth-input" type="text" autocomplete="name" placeholder="الاسم (اختياري)" />'
        + '<button class="btn primary auth-submit" id="authSubmit">إنشاء الحساب</button>'
        + '<div id="authMsg" class="auth-msg" role="status" aria-live="polite"></div>'
        + '<p class="auth-switch">لديك حساب بالفعل؟ <button type="button" class="auth-link" id="authSwitch">تسجيل الدخول</button></p>';
    }
    if (m === 'forgot') {
      return '<h1 class="auth-title">إعادة تعيين كلمة المرور</h1>'
        + '<p class="auth-sub">أدخل بريدك وسنرسل لك رابطًا لإنشاء كلمة مرور جديدة.</p>'
        + email
        + '<button class="btn primary auth-submit" id="authSubmit">إرسال رابط الاستعادة</button>'
        + '<div id="authMsg" class="auth-msg" role="status" aria-live="polite"></div>'
        + '<p class="auth-switch"><button type="button" class="auth-link" id="authSwitch">العودة لتسجيل الدخول</button></p>';
    }
    if (m === 'reset') {
      return '<h1 class="auth-title">كلمة مرور جديدة</h1>'
        + '<p class="auth-sub">اختر كلمة مرور جديدة لحسابك.</p>'
        + pass('new-password', 'كلمة المرور الجديدة (٦ أحرف على الأقل)')
        + '<button class="btn primary auth-submit" id="authSubmit">حفظ كلمة المرور</button>'
        + '<div id="authMsg" class="auth-msg" role="status" aria-live="polite"></div>';
    }
    if (m === 'migrating') {
      return '<div class="auth-migrate"><div class="loading-spinner"></div>'
        + '<h1 class="auth-title" id="authMigrateTitle">جارٍ ربط بياناتك بحسابك…</h1>'
        + '<p class="auth-sub" id="authMigrateSub">لا تُغلق التطبيق — نحفظ كل بياناتك بأمان.</p>'
        + '<div id="authMsg" class="auth-msg" role="status" aria-live="polite"></div>'
        + '<button class="btn ghost auth-retry hidden" id="authMigrateRetry">إعادة المحاولة</button></div>';
    }
    // signin (default)
    return '<h1 class="auth-title">أهلًا بك في أيام</h1>'
      + '<p class="auth-sub">' + VALUE_PROP + '</p>'
      + email + pass('current-password', 'كلمة المرور')
      + '<button class="btn primary auth-submit" id="authSubmit">تسجيل الدخول</button>'
      + '<div id="authMsg" class="auth-msg" role="status" aria-live="polite"></div>'
      + '<p class="auth-switch"><button type="button" class="auth-link" id="authForgot">نسيت كلمة المرور؟</button></p>'
      + '<p class="auth-switch">ليس لديك حساب؟ <button type="button" class="auth-link" id="authSwitch">إنشاء حساب جديد</button></p>';
  }

  function render() {
    var view = $('authView'); if (!view) return;
    var closable = mode !== 'migrating' && (opts.dismissible !== false);
    // Escapes are offered ONLY on the first-run gate (a fresh install), never mid-session, and never surface
    // the device-key concept to a genuinely new user — the key link is tucked away for returning legacy users.
    var escapes = '';
    if (opts.showEscapes && mode !== 'migrating' && mode !== 'reset') {
      escapes = '<div class="auth-escapes">'
        + '<button type="button" class="auth-escape" id="authOffline">المتابعة بدون حساب الآن</button>'
        + '<button type="button" class="auth-escape auth-escape-dim" id="authHaveKey">لديّ مفتاح مزامنة</button>'
        + '</div>';
    }
    view.innerHTML =
      '<div class="auth-scroll">'
      + '<div class="auth-card">'
      + (closable ? '<button type="button" class="auth-close" id="authClose" aria-label="إغلاق">✕</button>' : '')
      + '<div class="auth-brand">أيام</div>'
      + '<div class="auth-body">' + bodyFor(mode) + '</div>'
      + escapes
      + '</div></div>';
    bind();
    var first = $('authEmail') || $('authPass');
    if (first) { try { first.focus(); } catch (e) {} }
  }

  function currentValues() {
    var e = $('authEmail'), p = $('authPass'), n = $('authName');
    return { email: e ? (e.value || '').trim() : '', password: p ? (p.value || '') : '', name: n ? (n.value || '').trim() : '' };
  }

  function bind() {
    var submit = $('authSubmit');
    if (submit) submit.addEventListener('click', function () {
      if (typeof handlers.onSubmit === 'function') handlers.onSubmit(mode, currentValues());
    });
    // Enter submits from any input.
    ['authEmail', 'authPass', 'authName'].forEach(function (id) {
      var el = $(id); if (el) el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); if (submit) submit.click(); } });
    });
    var sw = $('authSwitch'); if (sw) sw.addEventListener('click', function () {
      setMode(mode === 'signup' || mode === 'forgot' ? 'signin' : 'signup');
    });
    var fg = $('authForgot'); if (fg) fg.addEventListener('click', function () { setMode('forgot'); });
    var cl = $('authClose'); if (cl) cl.addEventListener('click', function () { if (typeof handlers.onClose === 'function') handlers.onClose(); });
    var off = $('authOffline'); if (off) off.addEventListener('click', function () { if (typeof handlers.onOffline === 'function') handlers.onOffline(); });
    var hk = $('authHaveKey'); if (hk) hk.addEventListener('click', function () { if (typeof handlers.onHaveKey === 'function') handlers.onHaveKey(); });
    var rt = $('authMigrateRetry'); if (rt) rt.addEventListener('click', function () { if (typeof handlers.onMigrateRetry === 'function') handlers.onMigrateRetry(); });
  }

  // ---- public API ----
  function init(h) { handlers = h || {}; mounted = true; }
  function open(m, o) {
    opts = o || {};
    mode = m || 'signin';
    var view = $('authView'); if (!view) return;
    view.classList.remove('hidden');
    document.body.classList.add('auth-open');
    render();
  }
  function close() {
    var view = $('authView'); if (view) { view.classList.add('hidden'); view.innerHTML = ''; }
    document.body.classList.remove('auth-open');
  }
  function setMode(m) { mode = m; message('', ''); render(); }
  function isOpen() { var v = $('authView'); return !!(v && !v.classList.contains('hidden')); }
  // Android hardware Back: from a sub-mode return to sign-in; if dismissible, close; on the mandatory gate,
  // consume the press (never exit the app mid-auth). Returns true when it handled the press.
  function handleBack() {
    if (!isOpen()) return false;
    if (mode === 'migrating') return true;                         // don't interrupt migration
    if (mode === 'signup' || mode === 'forgot' || mode === 'reset') { setMode('signin'); return true; }
    if (opts.dismissible !== false && typeof handlers.onClose === 'function') { handlers.onClose(); return true; }
    return true;                                                   // gate: consume, stay put
  }
  function busy(b) {
    var s = $('authSubmit'); if (s) s.disabled = !!b;
    var card = $('authView'); if (card) { var c = card.querySelector('.auth-card'); if (c) c.classList.toggle('is-busy', !!b); }
  }
  function message(text, kind) {
    var m = $('authMsg'); if (!m) return;
    m.textContent = text || '';
    m.className = 'auth-msg' + (kind ? ' auth-msg-' + kind : '');
  }
  // Migration progress screen; optional { title, sub, retry } to update copy or expose a retry action.
  function migrating(o) {
    o = o || {};
    if (mode !== 'migrating') { mode = 'migrating'; render(); }
    var view = $('authView'); if (view) { view.classList.remove('hidden'); document.body.classList.add('auth-open'); }
    if (o.title) { var t = $('authMigrateTitle'); if (t) t.textContent = o.title; }
    if (o.sub != null) { var s = $('authMigrateSub'); if (s) s.textContent = o.sub; }
    var r = $('authMigrateRetry'); if (r) r.classList.toggle('hidden', !o.retry);
    if (o.message != null) message(o.message, o.messageKind || 'error');
  }

  global.AyyamAuthUI = { init: init, open: open, close: close, setMode: setMode, isOpen: isOpen, handleBack: handleBack, busy: busy, message: message, migrating: migrating, currentMode: function () { return mode; } };
})(typeof globalThis !== 'undefined' ? globalThis : window);
