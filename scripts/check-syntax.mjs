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

const html = readFileSync('index.html', 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!inline.length) { console.error('FAIL index.html: no inline <script> found'); failed++; }
// the app script is an async IIFE with top-level awaits inside the function body — valid as a script
inline.forEach((code, i) => check(`index.html <script #${i + 1}>`, code));
check('sw.js', readFileSync('sw.js', 'utf8'));
for (const f of ['js/storage.js','js/sync-model.js']) check(f, readFileSync(f, 'utf8'));
JSON.parse(readFileSync('manifest.webmanifest', 'utf8')); console.log('ok   manifest.webmanifest');

process.exit(failed ? 1 : 0);
