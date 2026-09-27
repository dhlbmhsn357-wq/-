import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { buildFcmMessage, fcmSend, getAccessToken } from '../../supabase/functions/ayyam-reminders/fcm.js';

// Provide WebCrypto + btoa/atob for the module under Node (Deno has them globally).
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const b64urlDecode = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

test('buildFcmMessage: token + notification + tap deep-link, collapse to avoid dupes', () => {
  const m = buildFcmMessage({ token: 'TKN', title: 'أيام', body: 'ذكّر', tag: 'r-fajr' });
  assert.equal(m.message.token, 'TKN');
  assert.equal(m.message.notification.title, 'أيام');
  assert.equal(m.message.data.url, 'ayyam://today');   // tap opens Today
  assert.equal(m.message.android.collapse_key, 'r-fajr');
});

test('fcmSend: 2xx resolves; error codes surface as statusCode for classifyError', async () => {
  const ok = (status) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) });
  await assert.doesNotReject(fcmSend({ token: 't' }, { accessToken: 'a', projectId: 'p', fetchImpl: ok(200) }));
  for (const [status, expect] of [[404, 404], [400, 400], [429, 429], [503, 503]]) {
    await assert.rejects(
      fcmSend({ token: 't' }, { accessToken: 'a', projectId: 'p', fetchImpl: ok(status) }),
      (e) => e.statusCode === expect, `status ${status} must surface`);
  }
});

test('getAccessToken: signs a valid RS256 JWT and returns the access token', async () => {
  // generate a real RSA key, export as PKCS8 PEM (what a service account provides)
  const kp = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  const pem = '-----BEGIN PRIVATE KEY-----\n' + pkcs8.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
  const sa = { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: pem };

  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, body: opts.body };
    return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.TEST' }) };
  };
  const token = await getAccessToken(sa, { fetchImpl, now: () => 1_800_000_000_000 });
  assert.equal(token, 'ya29.TEST');
  assert.match(captured.url, /oauth2\.googleapis\.com\/token/);
  const jwt = decodeURIComponent(captured.body.split('assertion=')[1]);
  const [h, c] = jwt.split('.');
  assert.equal(b64urlDecode(h).alg, 'RS256');
  const claim = b64urlDecode(c);
  assert.equal(claim.iss, sa.client_email);
  assert.equal(claim.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(claim.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claim.exp - claim.iat, 3600);
});

test('getAccessToken: OAuth failure surfaces statusCode', async () => {
  const sa = { client_email: 'x@y.z', private_key: '-----BEGIN PRIVATE KEY-----\nMII=\n-----END PRIVATE KEY-----' };
  await assert.rejects(getAccessToken(sa, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }));
});
