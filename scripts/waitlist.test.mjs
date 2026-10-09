import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function setup({configured = true, success = true} = {}) {
  const events = {}, status = { dataset: {}, focus() {} }, fields = { hidden: false }, button = {};
  const form = { querySelector: () => button, addEventListener: (name, fn) => { events[name] = fn; }, reportValidity: () => true, elements: { email: { value: 'test@example.com' }, consent: { checked: true } }, reset() {}, requestSubmit() { return events.submit({ preventDefault() {} }); } };
  let options, requests = 0, resets = 0, removed = 0;
  const context = {
    document: { querySelector: key => ({ '#signup': form, '#signup-fields': fields, '#signup-status': status })[key], createElement: () => ({ remove() {} }), head: { append(script) { queueMicrotask(() => script.onload()); } } },
    window: { YUNA_WAITLIST: configured ? { endpoint: 'https://api.test/subscribe', turnstileSiteKey: 'key' } : {}, turnstile: { render(target, args) { options = args; return 'widget'; }, reset() { resets++; options.callback('fresh'); }, remove() { removed++; } } },
    setTimeout, clearTimeout, AbortSignal, queueMicrotask,
    fetch: async () => { requests++; return { ok: success, json: async () => ({ ok: success, error: 'unavailable' }) }; },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../waitlist.js', import.meta.url), 'utf8'), context);
  return { status, fields, button, events, get options() { return options; }, get requests() { return requests; }, get resets() { return resets; }, get removed() { return removed; }, submit: () => events.submit({ preventDefault() {} }), async init() { events.focusin(); await new Promise(resolve => queueMicrotask(resolve)); } };
}
test('missing deployment configuration never pretends to collect an email', async () => {
  const ui = setup({configured:false}); await ui.submit(); assert.equal(ui.requests,0); assert.equal(ui.fields.hidden,false); assert.match(ui.status.textContent,/준비 중/);
});
test('success removes challenge and remains successful after stale challenge callbacks', async () => {
  const ui = setup(); await ui.init(); ui.options.callback('token'); await ui.submit();
  assert.equal(ui.fields.hidden,true); assert.equal(ui.removed,1); assert.equal(ui.status.dataset.state,'success');
  ui.options['expired-callback'](); ui.options['error-callback'](); ui.options.callback('late');
  assert.equal(ui.status.textContent,'저장 완료! 2027년에 보자~'); await ui.submit(); assert.equal(ui.requests,1);
});
test('storage failure keeps fields and error visible, resets one-use token and enables retry', async () => {
  const ui = setup({success:false}); await ui.init(); ui.options.callback('token'); await ui.submit();
  assert.equal(ui.fields.hidden,false); assert.equal(ui.button.disabled,false); assert.equal(ui.resets,1); assert.match(ui.status.textContent,/저장이 안 됐어/);
  await ui.submit(); assert.equal(ui.requests,2);
});
test('failed challenge can be reset even when it has no token', async () => {
  const ui = setup(); await ui.init(); ui.options['error-callback'](); await ui.submit(); assert.equal(ui.resets,1); assert.equal(ui.requests,1);
});

test('pending challenge submits automatically once verification finishes', async () => {
  const ui = setup(); await ui.init(); await ui.submit(); assert.equal(ui.requests,0);
  ui.options.callback('ready');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.requests,1); assert.equal(ui.fields.hidden,true);
});
