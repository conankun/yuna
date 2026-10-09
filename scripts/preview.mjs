// Local-only review server: simulated verification/storage; never sends email.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 8794);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/__preview/subscribe' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413).end(); return; } }
    try {
      const data = JSON.parse(body);
      const ok = data.consent === true && data.turnstileToken === 'local-preview' && data.email !== 'fail@example.com';
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: 'unavailable' }));
    } catch { res.writeHead(400).end(); }
    return;
  }
  if (url.pathname === '/waitlist-config.js' && process.env.PREVIEW_SIMULATED) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end("window.YUNA_WAITLIST={endpoint:'/__preview/subscribe',turnstileSiteKey:'local-preview'};"); return;
  }
  if (url.pathname === '/__preview/turnstile.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end("window.turnstile={render:(el,options)=>{window.previewVerification=options;options.callback('local-preview');return 'preview';},remove:()=>{},reset:()=>window.previewVerification.callback('local-preview')};"); return;
  }
  const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!['index.html', 'waitlist.js', 'waitlist-config.js'].includes(path) && !/^(imgs|fonts)\/[\w.-]+$/.test(path)) { res.writeHead(404).end(); return; }
  try {
    let data = await readFile(resolve(root, path));
    if (path === 'waitlist.js') data = data.toString().replace('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', '/__preview/turnstile.js');
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404).end(); }
}).listen(port, '127.0.0.1', () => console.log(`Local simulated preview: http://127.0.0.1:${port}. No email is stored or sent. Use fail@example.com to test failure.`));
