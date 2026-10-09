# Yuna email collection API

This worker only collects email addresses; it does not send notifications. The frontend must use Turnstile with action `subscribe`, collect explicit consent, and POST `{email, consent: true, turnstileToken}` to `/subscribe`. Repeated submissions receive the same success response. Reset Turnstile after each attempt: tokens are single use.

## Deployment configuration (not deployed)

1. Use the authorized Cloudflare account and create a Workers KV namespace; bind it as `WAITLIST` in `wrangler.jsonc` using its actual namespace ID. No account or namespace is preselected.
2. Set `ALLOWED_ORIGINS` to a comma-separated list of exact, verified public site origins (scheme + host, no trailing slash). Set `TURNSTILE_HOSTNAMES` to the allowed site hostnames. CORS is explicit; it is not an authentication mechanism.
3. Create a Turnstile widget for those hostnames. Set its public site key in the frontend, and store its private key using `wrangler secret put TURNSTILE_SECRET_KEY`.
4. Set `CONSENT_VERSION` to the published consent policy revision. Align the page notice with `RETENTION_END`. The template end-of-2027 retention deadline is a **candidate**, not an approved policy. The API fails closed when configuration is absent or the deadline has passed. Records expire automatically; changing the variable does not alter old records' expiry.
5. Deploy with the existing authenticated Cloudflare mechanism and set the frontend's API URL to the actual returned endpoint. Keep the site on GitHub Pages.
6. Verify live preflight, approved-origin signup with a real Turnstile token, KV storage/expiry, duplicate submission, and rejection of invalid tokens. Mock tests alone do not establish live acceptance.

Run local targeted tests: `node --test worker.test.mjs`.

KV keys are SHA-256 hashes of normalized emails; KV values contain the emails for future notification delivery. Hashing keys does not anonymize this data. No email/body logging is implemented, and Workers observability is disabled in the template. KV provides eventual consistency; simultaneous duplicates can overwrite the same key (never create separate entries). This flow does not prove mailbox ownership. No confirmation email or send system is implemented.
