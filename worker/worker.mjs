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
const CONFIRM_SUBJECT = '유나 데뷔 알림 신청 완료됐어용 🎀';
const confirmText = email => `오빠앙(언니이)~~ 나야, 유나! 🎀
데뷔 알림 신청해줘서 고마워 ㅎㅎ
방송 시작하면 메일로 알려줄게!!!
유나 설레게 해놓고 노쇼 하면 안된다?!! 꼭 놀러와야댕!!!
2027년에 보장❤️
참고로 답장은 못 받는 알림 전용 메일이야 ㅎㅎ

— 유나 (yuna.com)`;

const confirmHtml = email => `<!DOCTYPE html>
<html><body style="margin:0;padding:24px 12px;background:#fbf8f5;font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf8f5;"><tr><td align="center">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#fffdfc;border:3px solid #9e8e97;border-radius:14px;overflow:hidden;">
    <tr><td style="padding:0;"><img src="https://yuna.com/imgs/ribbon-badge.png" width="514" alt="" style="display:block;width:100%;height:auto;"></td></tr>
    <tr><td style="padding:22px 32px 6px;text-align:center;">
      <div style="font-size:12px;letter-spacing:3px;color:#9e8e97;">INVITATION</div>
    </td></tr>
    <tr><td style="padding:6px 34px 10px;color:#8f485e;font-size:19px;line-height:1.8;">
      오빠앙(언니이)~~ 나야, 유나! 🎀<br>
      데뷔 알림 신청해줘서 고마워 ㅎㅎ<br>
      방송 시작하면 메일로 알려줄게!!!<br>
      유나 설레게 해놓고 <strong style="font-size:21px;">노쇼 하면 안된다?!!</strong><br>
      꼭 놀러와야댕!!! 2027년에 보장❤️
      <div style="font-size:13px;color:#9e8e97;padding-top:12px;">참고로 답장은 못 받는 알림 전용 메일이야 ㅎㅎ</div>
    </td></tr>
    <tr><td style="padding:8px 34px 26px;border-top:1px solid #e8dde2;">
      <img src="https://yuna.com/imgs/signature.png" width="150" alt="유나 서명" style="display:block;padding-top:14px;">
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

// Best-effort confirmation mail. Missing key or send failure never fails the
// signup itself. Sent only for first-time registrations (see caller).
async function sendConfirmation(env, email) {
  if (!env.RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: CONFIRM_FROM, to: [email], subject: CONFIRM_SUBJECT, text: confirmText(email), html: confirmHtml(email) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error('resend422', 'to-len:', email.length, 'to-ascii-valid:', /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email), 'to-odd-chars:', JSON.stringify([...email].filter(c => { const n = c.charCodeAt(0); return n > 126 || n < 33; })), 'body:', (await res.text().catch(() => '')).slice(0, 160));
  } catch (error) { console.error('resend-send-error', String(error && error.message || error).slice(0, 120)); }
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
