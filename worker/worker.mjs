const MAX_BODY_BYTES = 4096;
const json = (status, body, origin) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
  },
});

function config(env) {
  const origins = (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  const hostnames = (env.TURNSTILE_HOSTNAMES || '').split(',').map(x => x.trim()).filter(Boolean);
  const expiry = Math.floor(Date.parse(env.RETENTION_END || '') / 1000);
  if (!env.WAITLIST?.get || !env.WAITLIST?.put || !env.TURNSTILE_SECRET_KEY || !origins.length || !hostnames.length ||
      !env.CONSENT_VERSION || !Number.isFinite(expiry) || expiry <= Date.now() / 1000 + 60 ||
      origins.some(origin => { try { return new URL(origin).origin !== origin; } catch { return true; } })) return null;
  return { origins, hostnames, expiry };
}

async function readBoundedJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new Error('invalid');
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) throw new Error('invalid');
  if (!request.body) throw new Error('invalid');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('invalid'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

const CONFIRM_FROM = '유나 <no-reply@yuna.com>';
const CONFIRM_SUBJECT = '유나 방송 시작 알림 신청 완료!';
const confirmText = email => `유나 방송 시작 알림 신청이 완료됐어!
방송 켜지면 ${email} 로 알려줄게.
2027년에 보자~

— 유나 (yuna.com)`;

// Best-effort confirmation mail. Missing key or send failure never fails the
// signup itself. Sent only for first-time registrations (see caller).
async function sendConfirmation(env, email) {
  if (!env.RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: CONFIRM_FROM, to: [email], subject: CONFIRM_SUBJECT, text: confirmText(email) }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* signup already succeeded */ }
}

export default {
  async fetch(request, env) {
    const cfg = config(env);
    const origin = request.headers.get('Origin');
    const allowedOrigin = cfg?.origins.includes(origin) ? origin : null;
    if (!cfg) return json(503, { ok: false, error: 'unavailable' });
    if (!allowedOrigin) return json(403, { ok: false, error: 'forbidden' });
    if (new URL(request.url).pathname !== '/subscribe') return json(404, { ok: false, error: 'not_found' }, allowedOrigin);
    if (request.method === 'OPTIONS') {
      const method = request.headers.get('Access-Control-Request-Method');
      const headers = (request.headers.get('Access-Control-Request-Headers') || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      if (method !== 'POST' || headers.some(x => x !== 'content-type')) return json(403, { ok: false, error: 'forbidden' }, allowedOrigin);
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      } });
    }
    if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, allowedOrigin);
    let data;
    try { data = await readBoundedJson(request); }
    catch { return json(400, { ok: false, error: 'invalid_request' }, allowedOrigin); }
    const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
    const token = data?.turnstileToken;
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) ||
        email.split('@')[0].length > 64 || email.startsWith('.') || email.split('@')[0].endsWith('.') || email.includes('..') ||
        data?.consent !== true || typeof token !== 'string' || !token.trim() || token.length > 2048) {
      return json(400, { ok: false, error: 'invalid_request' }, allowedOrigin);
    }
    try {
      const verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
        signal: AbortSignal.timeout(8000),
      });
      if (!verification.ok) return json(503, { ok: false, error: 'unavailable' }, allowedOrigin);
      const result = await verification.json();
      const testingKey = result.metadata?.result_with_testing_key === true;
      if (result.success !== true || (!testingKey && (result.action !== 'subscribe' || !cfg.hostnames.includes(result.hostname)))) {
        return json(400, { ok: false, error: 'verification_failed' }, allowedOrigin);
      }
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
      const key = 'email:' + Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
      if (!(await env.WAITLIST.get(key))) {
        await env.WAITLIST.put(key, JSON.stringify({ email, createdAt: new Date().toISOString(), consentVersion: env.CONSENT_VERSION }), { expiration: cfg.expiry });
        await sendConfirmation(env, email);
      }
      return json(200, { ok: true }, allowedOrigin);
    } catch {
      return json(503, { ok: false, error: 'unavailable' }, allowedOrigin);
    }
  },
};
