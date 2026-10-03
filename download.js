// /download page logic (external file — the page's CSP forbids inline scripts). Platform detection +
// version/size from the same-domain metadata endpoint. No GitHub UI, no secrets, no hardcoded version.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
  var isAndroid = /Android/i.test(ua);
  var isDesktop = !isAndroid && !isIOS;

  if (isIOS) {
    // No APK on iOS — show the web-only state, hide the download block + install steps.
    var ios = $('iosBlock'); if (ios) ios.style.display = 'block';
    var dl = $('dlBlock'); if (dl) dl.style.display = 'none';
    var steps = $('stepsSection'); if (steps) steps.style.display = 'none';
    var meta = $('metaRow'); if (meta) meta.style.display = 'none';
  } else if (isDesktop) {
    // Desktop: keep the download button, but nudge to open on a phone.
    var note = $('desktopNote'); if (note) note.style.display = 'block';
  }

  // Version + size (shown to the user: versionName + size only). Best-effort; the page never breaks and the
  // download button always has a working static fallback (/download/android).
  function setVersion(v) { var c = $('verChip'); if (c) c.textContent = v ? ('الإصدار ' + v) : 'أحدث إصدار'; }
  function setSize(bytes) {
    var c = $('sizeChip'); if (!c) return;
    if (typeof bytes === 'number' && bytes > 0) { c.textContent = 'الحجم: ' + (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB'; c.hidden = false; }
  }
  setVersion('');
  fetch('/api/download-info', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
    .then(function (d) { setVersion(d && d.versionName); setSize(d && d.size); })
    .catch(function () {
      // fallback: try the manifest just for the version; leave size hidden.
      fetch('/update.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function (m) { setVersion(m && m.versionName); })
        .catch(function () { setVersion(''); }); // "أحدث إصدار" — button still works
    });
})();
