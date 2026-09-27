// Assemble the Capacitor web directory (www/) for the Android APK from the SAME web assets the
// PWA ships — WITHOUT modifying any web source file. Native-only scripts (widget-model.js, native.js)
// are injected ONLY into this APK copy of index.html, so the web/PWA production bundle is byte-identical.
//
// Run: node scripts/build-webdir.mjs   (invoked by `cap sync` via capacitor config, and in CI)
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'www');

// The exact web asset set (mirrors the SW precache list + the app's static assets).
const FILES = ['index.html', 'manifest.webmanifest', 'sw.js',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'bg.jpg'];
const DIRS = ['css', 'js'];
// Native-only modules, copied from native-web/ into www/js and injected into index.html (before app.js).
// widget-model.js must load before native.js/app.js so AyyamWidget exists when app.js builds snapshots.
const NATIVE_JS = ['widget-model.js', 'native.js'];

rmSync(WWW, { recursive: true, force: true });
mkdirSync(join(WWW, 'js'), { recursive: true });

for (const d of DIRS) cpSync(join(ROOT, d), join(WWW, d), { recursive: true });
for (const f of FILES) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(WWW, f));

// Copy native-only JS into www/js (source of truth: android/native-web/)
const NATIVE_SRC = join(ROOT, 'native-web');
for (const f of NATIVE_JS) {
  const src = join(NATIVE_SRC, f);
  if (!existsSync(src)) throw new Error(`missing native web module: ${src}`);
  cpSync(src, join(WWW, 'js', f));
}

// Inject the native-only scripts BEFORE js/app.js so their globals (AyyamWidget/AyyamNative) exist
// when app.js runs. Only touches the www copy.
const indexPath = join(WWW, 'index.html');
let html = readFileSync(indexPath, 'utf8');
const appTag = '<script src="js/app.js"></script>';
if (!html.includes(appTag)) throw new Error('index.html: app.js script tag not found for injection');
const inject = NATIVE_JS.map((f) => `<script src="js/${f}"></script>`).join('\n') + '\n' + appTag;
html = html.replace(appTag, inject);
writeFileSync(indexPath, html);

console.log(`www/ assembled: ${FILES.length} files + ${DIRS.join(',')} + native(${NATIVE_JS.join(',')})`);
