'use strict';
/* Opened from the password-reset email.
   Supports both link styles Supabase can send:
     ?token_hash=…&type=recovery          (recommended email template)
     #access_token=…&type=recovery        (Supabase default template)
     #error=…&error_code=otp_expired      (expired / already-used link)
   The token is removed from the address bar immediately and handed to the server,
   which keeps it in an HttpOnly cookie — page scripts never store it. */
(async () => {
  const form = document.getElementById('reset-form');
  const status = document.getElementById('reset-status');
  const sub = document.getElementById('reset-sub');

  const query = new URLSearchParams(location.search);
  const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
  const tokenHash = query.get('token_hash');
  const accessToken = frag.get('access_token');
  const isRecovery = query.get('type') === 'recovery' || frag.get('type') === 'recovery';
  const linkError = frag.get('error_code') || frag.get('error') || query.get('error_code') || query.get('error');
  history.replaceState(null, '', location.pathname); // drop tokens from the URL and history

  function fail(message) {
    sub.textContent = 'This link can no longer be used.';
    status.innerHTML = `<div class="notice notice--error" role="alert">${escapeHtml(message)}</div>
      <a class="btn btn--block" href="/forgot-password">Request a new link</a>`;
  }

  if (linkError) {
    fail(/expired/i.test(linkError) || /expired/i.test(frag.get('error_description') || '')
      ? 'This reset link has expired or was already used. Request a new one — links are valid for a short time only.'
      : 'This reset link is invalid. Request a new one.');
    return;
  }
  if (!isRecovery || (!tokenHash && !accessToken)) {
    sub.textContent = 'Open the reset link from your email to continue.';
    status.innerHTML = '<p>To choose a new password, use the link in the email we sent you. If you don\'t have one, request a new link.</p><a class="btn btn--block" href="/forgot-password">Request a reset link</a>';
    return;
  }

  try {
    const r = await API.post('/api/auth/recovery', tokenHash ? { tokenHash } : { accessToken });
    sub.textContent = r.email ? `Choose a new password for ${r.email}.` : 'Choose a new password.';
    status.innerHTML = '';
    form.hidden = false;
    form.password.focus();
  } catch (err) {
    fail(err.message || 'This reset link is invalid or has expired.');
    return;
  }

  document.getElementById('rp-show').addEventListener('change', (e) => {
    form.password.type = form.confirm.type = e.target.checked ? 'text' : 'password';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    Forms.clear(form);
    const password = form.password.value;
    const confirm = form.confirm.value;
    const errors = {};
    if (password.length < 8) errors.password = 'Use at least 8 characters.';
    else if (password.length > 72) errors.password = 'Use 72 characters or fewer.';
    else if (!password.trim()) errors.password = "The password can't be only spaces.";
    if (!errors.password && confirm !== password) errors.confirm = "The passwords don't match.";
    if (Object.keys(errors).length) return Forms.errors(form, errors);

    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const r = await API.post('/api/auth/reset', { password, confirm });
      form.hidden = true;
      sub.textContent = 'Password changed.';
      status.innerHTML = `<div class="notice notice--ok" role="status">${escapeHtml(r.message)} Taking you to sign in…</div>
        <a class="btn btn--block" href="${escapeHtml(r.redirect)}">Sign in now</a>`;
      setTimeout(() => { location.href = r.redirect; }, 3000);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Save new password';
      if (err.body?.errors) Forms.errors(form, err.body.errors);
      if (err.code === 'recovery_invalid' || err.code === 'recovery_expired') fail(err.message);
      else if (!err.body?.errors) notice(status, err.message, 'error');
    }
  });
})();
