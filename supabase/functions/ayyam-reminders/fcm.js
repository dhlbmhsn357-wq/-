// FCM HTTP v1 sender. No ambient I/O — fetch/now/service-account are injected, so it unit-tests with
// mocks (tests/unit/fcm.test.mjs) and runs unchanged under Deno (edge function) and Node (WebCrypto).
// The service-account private key is a BACKEND secret supplied by the caller; it is never in the repo/APK.

const enc = (s) => new TextEncoder().encode(s);
function b64url(input) {
  const bytes = typeof input === 'string' ? enc(input) : new Uint8Array(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// Sign a Google OAuth2 JWT and exchange it for an access token (scope: firebase.messaging).
export async function getAccessToken(sa, { fetchImpl = fetch, now = Date.now } = {}) {
  if (!sa || !sa.client_email || !sa.private_key) throw Object.assign(new Error('bad service account'), { statusCode: 500 });
  const iat = Math.floor(now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc(signingInput));
  const jwt = signingInput + '.' + b64url(sig);
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw Object.assign(new Error('oauth failed'), { statusCode: res.status || 500 });
  return body.access_token;
}

// FCM v1 message: notification + data.url for the tap deep-link, collapse/tag to avoid duplicates.
export function buildFcmMessage(item) {
  return {
    message: {
      token: item.token,
      notification: { title: item.title, body: item.body },
      data: { url: 'ayyam://today', tag: item.tag || 'ayyam' },
      android: { collapse_key: item.tag || 'ayyam', notification: { tag: item.tag || 'ayyam', click_action: 'ayyam://today' } },
    },
  };
}

// Send one FCM delivery. Resolves on 2xx; throws an error carrying statusCode so classifyError maps it
// (404 UNREGISTERED / 403 sender-mismatch → gone → disable token; 400 → terminal; 429/5xx → retry).
export async function fcmSend(item, { accessToken, projectId, fetchImpl = fetch }) {
  const res = await fetchImpl('https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildFcmMessage(item)),
  });
  if (res.ok) return;
  throw Object.assign(new Error('fcm send failed'), { statusCode: res.status });
}
