// Production signup configuration. Public values only; the Turnstile secret
// lives in the Worker, never here.
window.YUNA_WAITLIST = Object.freeze({
  endpoint: 'https://yuna-waitlist.conankun.workers.dev/subscribe',
  turnstileSiteKey: '0x4AAAAAAFR90vFNDHLB3wmw',
});
