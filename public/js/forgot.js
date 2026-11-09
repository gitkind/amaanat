'use strict';
(() => {
  const form = document.getElementById('forgot-form');
  const msg = document.getElementById('forgot-msg');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    Forms.clear(form);
    msg.textContent = '';
    const email = form.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Forms.errors(form, { email: 'Enter a valid email address.' });
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const r = await API.post('/api/auth/forgot', { email });
      // Same message whether or not the email has an account.
      form.querySelector('.form-group').hidden = true;
      btn.hidden = true;
      msg.textContent = r.message;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Email me a reset link';
      if (err.body?.errors) Forms.errors(form, err.body.errors);
      msg.textContent = err.status === 429 ? 'Too many requests. Please wait a few minutes and try again.' : err.message;
    }
  });
})();
