// Demo interactivity for design-system.html (external so it works under the app's CSP: script-src 'self').
(function () {
  var themeBtn = document.getElementById('themeBtn');
  if (themeBtn) themeBtn.addEventListener('click', function () {
    var h = document.documentElement;
    h.setAttribute('data-theme', h.getAttribute('data-theme') === 'day' ? 'night' : 'day');
  });
  var reveal = document.getElementById('reveal');
  if (reveal) reveal.addEventListener('click', function () {
    var i = document.getElementById('f2'); if (i) i.type = i.type === 'password' ? 'text' : 'password';
  });
  var colors = ['bg', 'surface', 'elevated', 'primary', 'primary-hover', 'secondary', 'accent', 'text',
    'text-secondary', 'muted', 'border', 'success', 'warning', 'danger', 'overdue', 'excused', 'replaced',
    'fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  var sw = document.getElementById('swatches');
  if (sw) sw.innerHTML = colors.map(function (c) {
    return '<div class="swatch"><div class="chip" style="background:var(--color-' + c + ')"></div><div class="name">' + c + '</div></div>';
  }).join('');
  var spaces = [['xs', '4'], ['sm', '8'], ['md', '12'], ['lg', '16'], ['xl', '20'], ['2xl', '24'], ['3xl', '32'], ['4xl', '40']];
  var sp = document.getElementById('spaces');
  if (sp) sp.innerHTML = spaces.map(function (s) {
    return '<div style="display:flex;align-items:center;gap:12px"><span class="ds-caption" style="width:70px">' + s[0] + ' · ' + s[1] + '</span>'
      + '<div class="space-demo" style="width:var(--space-' + s[0] + ')"></div></div>';
  }).join('');
})();
