// Same-domain update manifest endpoint for the in-app updater (Vercel Serverless Function).
//
// WHY THIS EXISTS: the Android app runs in a Capacitor WebView at origin `https://localhost` and checks
// for updates with a cross-origin `fetch()`. GitHub's `releases/latest/download/update.json` 302-redirects
// to release-assets.githubusercontent.com, whose response carries NO `Access-Control-Allow-Origin`, so the
// WebView blocks it as a CORS failure and the app wrongly reports "no connection". This function fetches
// the SAME GitHub manifest SERVER-SIDE (where CORS does not apply), then re-serves it to the app WITH
// `Access-Control-Allow-Origin: *`, so the WebView fetch succeeds. It always tracks the latest published
// release (no manual step per release). The APK itself is still downloaded by the native updater directly
// from GitHub (native HTTP is CORS-exempt), so apkUrl stays a GitHub link.
//
// Distinct outcomes for the app's 4-state classifier:
//   200 + valid JSON  → the manifest (app decides latest/available)
//   502               → GitHub reachable from us but errored / returned non-JSON  → app shows 'unavailable'
//   504               → GitHub unreachable from us                                 → app shows 'unavailable'
//   (device offline → the app can't reach THIS endpoint → its fetch throws → 'network')
const SOURCE = 'https://github.com/dhlbmhsn357-wq/-/releases/latest/download/update.json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Short edge cache so a fresh release is picked up quickly, but we don't hammer GitHub per check.
  res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=300');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  let upstream;
  try {
    upstream = await fetch(SOURCE, { redirect: 'follow', headers: { Accept: 'application/json' } });
  } catch (e) {
    res.status(504).json({ error: 'upstream_unreachable' });
    return;
  }
  if (!upstream.ok) { res.status(502).json({ error: 'upstream_error', upstream: upstream.status }); return; }
  const text = await upstream.text();
  let manifest;
  try { manifest = JSON.parse(text); } catch (e) { res.status(502).json({ error: 'upstream_malformed' }); return; }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json(manifest);
}
