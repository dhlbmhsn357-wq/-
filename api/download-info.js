// Download-page metadata (Vercel Serverless Function). Returns ONLY what the public /download page shows:
// the current versionName and the APK size — fetched server-side (no CORS, no GitHub UI for the user).
// Kept separate from /api/update so the in-app updater endpoint/contract is never touched.
const MANIFEST = 'https://github.com/dhlbmhsn357-wq/-/releases/latest/download/update.json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    const r = await fetch(MANIFEST, { redirect: 'follow', headers: { Accept: 'application/json' } });
    if (!r.ok) { res.status(502).json({ error: 'manifest_unavailable' }); return; }
    const m = JSON.parse(await r.text());
    let size = null;
    try {
      const h = await fetch(m.apkUrl, { method: 'HEAD', redirect: 'follow' });
      const len = h.headers.get('content-length');
      if (len && /^\d+$/.test(len)) size = parseInt(len, 10);
    } catch (e) { /* size is best-effort; the page falls back gracefully */ }
    res.status(200).json({ versionName: m.versionName || '', versionCode: m.versionCode || 0, size });
  } catch (e) {
    res.status(502).json({ error: 'unavailable' });
  }
}
