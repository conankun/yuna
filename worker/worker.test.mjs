import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from './worker.mjs';
globalThis.crypto ??= webcrypto;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function fixture() {
  const entries = new Map();
  const writes = [];
  const env = {
    ALLOWED_ORIGINS: 'https://example.test', TURNSTILE_HOSTNAMES: 'example.test',
    TURNSTILE_SECRET_KEY: 'test-secret', RETENTION_END: '2099-01-01T00:00:00Z', CONSENT_VERSION: 'test-v1',
    WAITLIST: { async get(key) { return entries.get(key); }, async put(key, value, options) { entries.set(key, value); writes.push({ key, value, options }); } },
  };
  globalThis.fetch = async () => Response.json({ success: true, hostname: 'example.test', action: 'subscribe' });
  return { env, writes };
}
function request(body = { email: ' Test@Example.com ', consent: true, turnstileToken: 'valid' }, extra = {}) {
  return new Request('https://api.example.test/subscribe', { method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra });
}
test('stores normalized email once under hashed key with configured retention and consent', async () => {
  const { env, writes } = fixture();
  const result = await worker.fetch(request(), env);
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { ok: true });
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), 'https://example.test');
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.match(writes[0].key, /^email:[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(writes[0].value).email, 'test@example.com');
  assert.equal(JSON.parse(writes[0].value).consentVersion, 'test-v1');
  assert.equal(writes[0].options.expiration, Date.parse(env.RETENTION_END) / 1000);
  const duplicate = await worker.fetch(request(), env);
  assert.deepEqual(await duplicate.json(), { ok: true }); assert.equal(writes.length, 1);
});
test('preflight permits only POST + content-type on configured origin', async () => {
  const { env } = fixture();
  const req = method => request(undefined, { method: 'OPTIONS', body: undefined, headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal((await worker.fetch(req('POST'), env)).status, 204);
  assert.equal((await worker.fetch(req('DELETE'), env)).status, 403);
  const denied = await worker.fetch(request(undefined, { headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' } }), env);
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
});
test('invalid email, consent, token, malformed and oversized body do not call verification or KV', async () => {
  const { env, writes } = fixture(); let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('unexpected'); };
  for (const patch of [{ email: 'bad' }, { email: '.x@example.com' }, { consent: false }, { consent: 'true' }, { turnstileToken: '' }, { turnstileToken: 'x'.repeat(2049) }]) {
    assert.equal((await worker.fetch(request({ email: 'x@example.com', consent: true, turnstileToken: 'x', ...patch }), env)).status, 400);
  }
  for (const body of ['{', JSON.stringify({ x: 'a'.repeat(4097) }), 'null']) assert.equal((await worker.fetch(request(undefined, { body }), env)).status, 400);
  assert.equal(calls, 0); assert.equal(writes.length, 0);
});
test('missing required settings, expired retention and missing KV fail closed', async () => {
  const { env } = fixture();
  for (const key of ['WAITLIST', 'ALLOWED_ORIGINS', 'TURNSTILE_HOSTNAMES', 'TURNSTILE_SECRET_KEY', 'CONSENT_VERSION', 'RETENTION_END']) {
    assert.equal((await worker.fetch(request(), { ...env, [key]: undefined })).status, 503);
  }
  assert.equal((await worker.fetch(request(), { ...env, RETENTION_END: '2000-01-01' })).status, 503);
});
test('replay/invalid token and wrong action/hostname never store', async () => {
  const { env, writes } = fixture();
  for (const result of [{ success: false, 'error-codes': ['timeout-or-duplicate'] }, { success: true, hostname: 'evil.test', action: 'subscribe' }, { success: true, hostname: 'example.test', action: 'other' }]) {
    globalThis.fetch = async () => Response.json(result);
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 400); assert.equal((await response.json()).error, 'verification_failed');
  }
  assert.equal(writes.length, 0);
});
test('Cloudflare-flagged testing-key response verifies without action/hostname (local dev only)', async () => {
  const { env, writes } = fixture();
  globalThis.fetch = async () => Response.json({ success: true, metadata: { result_with_testing_key: true } });
  const result = await worker.fetch(request({ email: 'dev@example.com', consent: true, turnstileToken: 'tk' }), env);
  assert.equal(result.status, 200); assert.equal(writes.length, 1);
});

test('verification network/server/JSON and storage failures do not return success', async () => {
  const { env, writes } = fixture();
  for (const mock of [async () => { throw new Error('network'); }, async () => new Response('', { status: 500 }), async () => new Response('invalid')]) {
    globalThis.fetch = mock; assert.equal((await worker.fetch(request(), env)).status, 503);
  }
  assert.equal(writes.length, 0);
  globalThis.fetch = async () => Response.json({ success: true, hostname: 'example.test', action: 'subscribe' });
  env.WAITLIST.put = async () => { throw new Error('storage failed'); };
  assert.equal((await worker.fetch(request(), env)).status, 503);
});
