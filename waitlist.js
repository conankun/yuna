(() => {
  const form = document.querySelector('#signup');
  const fields = document.querySelector('#signup-fields');
  const status = document.querySelector('#signup-status');
  const button = form.querySelector('button');
  const config = window.YUNA_WAITLIST || {};
  button.disabled = false;
  let busy = false;
  let widget;
  let ready;
  let token = '';
  let completed = false;
  let needsReset = false;
  let submitWhenVerified = false;
  const message = (text, state = 'error') => {
    status.textContent = text;
    status.dataset.state = state;
  };
  function verification() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => fail(), 15000);
      function fail() {
        clearTimeout(timeout);
        script.remove();
        ready = null;
        reject(new Error('verification'));
      }
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onerror = fail;
      script.onload = () => {
        clearTimeout(timeout);
        try {
          widget = window.turnstile.render('#signup-verification', {
            sitekey: config.turnstileSiteKey,
            action: 'subscribe', theme: 'light', size: 'flexible',
            callback: value => {
              if (completed) return;
              token = value;
              needsReset = false;
              if (submitWhenVerified) {
                submitWhenVerified = false;
                queueMicrotask(() => form.requestSubmit());
              }
            },
            'expired-callback': () => { if (!completed) { token = ''; submitWhenVerified = false; needsReset = true; message('확인이 만료됐어. 다시 눌러서 확인해 줘.'); } },
            'error-callback': () => { if (!completed) { token = ''; submitWhenVerified = false; needsReset = true; message('확인이 안 됐어. 잠시 후 다시 시도해 줘.'); } },
          });
          resolve();
        } catch { fail(); }
      };
      document.head.append(script);
    });
    return ready;
  }
  // Start verification only when the visitor interacts with the form.
  form.addEventListener('focusin', () => {
    if (config.endpoint && config.turnstileSiteKey) verification().catch(() => {});
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || completed || !form.reportValidity()) return;
    if (!config.endpoint || !config.turnstileSiteKey) {
      message('아직 알림 신청을 준비 중이야. 조금만 기다려 줘!');
      return;
    }
    busy = true;
    button.disabled = true;
    try {
      await verification();
      if (needsReset) { needsReset = false; window.turnstile.reset(widget); }
      if (!token) { submitWhenVerified = true; message('확인이 끝나면 바로 저장할게.', 'pending'); return; }
      button.textContent = '저장 중…';
      message('이메일을 저장하고 있어.', 'pending');
      const response = await fetch(config.endpoint, {
        method: 'POST', credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.elements.email.value.trim(), consent: form.elements.consent.checked, turnstileToken: token }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(result.error || 'unavailable');
      completed = true;
      token = '';
      window.turnstile.remove(widget);
      fields.hidden = true;
      form.reset();
      message('저장 완료! 2027년에 보자~', 'success');
      status.focus({ preventScroll: true });
    } catch (error) {
      message(error.message === 'invalid_request' ? '이메일 주소와 동의를 다시 확인해 줘.' : error.message === 'verification_failed' ? '확인이 만료됐어. 다시 확인하고 눌러줘.' : '저장이 안 됐어. 잠시 후 다시 시도해 줘.');
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = '알려줘!';
      if (token && !fields.hidden) { token = ''; window.turnstile?.reset(widget); }
    }
  });
})();
