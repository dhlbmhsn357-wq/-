// Static check: every script the browser runs must at least parse (the app has no build step).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let failed = 0;
const check = (name, code) => {
  try {
    new vm.Script(code, { filename: name });
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
};

// CSP hardening (Phase 7): the app has no inline <script> anymore — everything is external.
// Guard that no inline script sneaks back in (would force script-src 'unsafe-inline').
const html = readFileSync('index.html', 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (inline.length) { console.error(`FAIL index.html: ${inline.length} inline <script> block(s) present — CSP requires external scripts only`); failed++; }
check('sw.js', readFileSync('sw.js', 'utf8'));
for (const f of ['js/app.js','js/storage.js','js/sync-model.js','js/account.js','js/auth-ui.js','js/time-model.js','js/routines-model.js','js/analytics-model.js','js/overdue-model.js','js/update-model.js','native-web/native.js','native-web/widget-model.js','native-web/notif-plan.js']) check(f, readFileSync(f, 'utf8'));
JSON.parse(readFileSync('manifest.webmanifest', 'utf8')); console.log('ok   manifest.webmanifest');

process.exit(failed ? 1 : 0);
