'use strict';
(async () => {
  const root = document.getElementById('account');
  const title = document.getElementById('account-title');
  const sub = document.getElementById('account-sub');
  const next = new URLSearchParams(location.search).get('next');
  const safeNext = next && /^\/(?!\/)[\w\-/]*$/.test(next) ? next : null;
  let uid = 0;
  let acct = null;

  const field = (name, label, value = '', attrs = '') => {
    const id = `f-${name}-${++uid}`;
    return `<div class="form-group"><label for="${id}">${label}</label><input id="${id}" name="${name}" value="${escapeHtml(value)}" ${attrs}></div>`;
  };

  async function submitting(form, fn) {
    const btn = form.querySelector('[type="submit"]');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Please wait…';
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const pwField = (name, label, autocomplete, extra = '') => {
    const id = `f-${name}-${++uid}`;
    return `<div class="form-group"><label for="${id}">${label}</label><div class="pw-wrap"><input id="${id}" name="${name}" type="password" autocomplete="${autocomplete}" required maxlength="72" ${extra}>
      <button type="button" class="pw-toggle" aria-controls="${id}" aria-pressed="false">Show</button></div></div>`;
  };
  function bindToggles(scope) {
    scope.querySelectorAll('.pw-toggle').forEach((btn) => btn.addEventListener('click', () => {
      const input = document.getElementById(btn.getAttribute('aria-controls'));
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
    }));
  }
  // Shows one message under each invalid field; returns true when the form is valid.
  function validate(form, rules) {
    form.querySelectorAll('.field-error').forEach((el) => el.remove());
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    let first = null;
    for (const [name, check] of rules) {
      const input = form.elements[name];
      const msg = check(input.value);
      if (!msg) continue;
      input.setAttribute('aria-invalid', 'true');
      const p = document.createElement('p');
      p.className = 'field-error';
      p.id = `${input.id}-err`;
      p.textContent = msg;
      input.setAttribute('aria-describedby', p.id);
      (input.closest('.pw-wrap') || input).after(p);
      first ||= input;
    }
    first?.focus();
    return !first;
  }
  const emailRule = (v) => (!v.trim() ? 'Enter your email address.' : EMAIL_RE.test(v.trim()) ? '' : 'Enter a valid email address, like name@example.com.');

  function renderSignedOut() {
    title.textContent = 'Sign in';
    sub.textContent = 'Save addresses, keep a wishlist and see your orders.';
    root.innerHTML = `
      <div class="account-grid auth-grid">
        <form class="panel" id="login-form" novalidate>
          <p class="eyebrow">Welcome back</p>
          <h2>Sign in</h2>
          ${field('email', 'Email', '', 'type="email" autocomplete="email" required maxlength="254"')}
          ${pwField('password', 'Password', 'current-password')}
          <p style="margin:-.5rem 0 1rem;text-align:right"><a class="text-link" href="/forgot-password">Forgot password?</a></p>
          <p class="form-error" data-msg role="alert"></p>
          <button class="btn btn--block" type="submit">Sign in</button>
        </form>
        <form class="panel" id="register-form" novalidate>
          <p class="eyebrow">New to Amaanat</p>
          <h2>Create an account</h2>
          ${field('fullName', 'Full name', '', 'autocomplete="name" maxlength="120"')}
          ${field('email', 'Email', '', 'type="email" autocomplete="email" required maxlength="254"')}
          ${pwField('password', 'Password', 'new-password', 'minlength="8"')}
          <p class="fine-print" style="margin:-.6rem 0 1rem">8 to 72 characters. A short phrase is easy to remember and hard to guess.</p>
          ${pwField('confirm', 'Confirm password', 'new-password', 'minlength="8"')}
          <p class="form-error" data-msg role="alert"></p>
          <div data-ok></div>
          <button class="btn btn--ghost btn--block" type="submit">Create account</button>
          <p class="fine-print">Checking out as a guest is always possible.</p>
        </form>
      </div>`;
    bindToggles(root);
    const after = () => { location.href = safeNext || '/account'; };
    root.querySelector('#login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      f.querySelector('[data-msg]').textContent = '';
      if (!validate(f, [['email', emailRule], ['password', (v) => (v ? '' : 'Enter your password.')]])) return;
      submitting(f, () => API.post('/api/auth/login', { email: f.email.value.trim(), password: f.password.value }).then(() => {
        f.querySelector('[type="submit"]').textContent = 'Signed in ✓';
        after();
      })).catch((err) => { f.querySelector('[data-msg]').textContent = err.message; });
    });
    root.querySelector('#register-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      f.querySelector('[data-msg]').textContent = '';
      const ok = validate(f, [
        ['fullName', (v) => (v.trim() && v.trim().length < 2 ? 'Enter your full name, or leave it empty.' : '')],
        ['email', emailRule],
        ['password', (v) => (v.length < 8 ? 'Use at least 8 characters.' : v.length > 72 ? 'Use 72 characters or fewer.' : '')],
        ['confirm', (v) => (v !== f.password.value ? 'The passwords do not match.' : '')],
      ]);
      if (!ok) return;
      submitting(f, async () => {
        const r = await API.post('/api/auth/register', { fullName: f.fullName.value.trim(), email: f.email.value.trim(), password: f.password.value });
        if (r.needsConfirmation) {
          f.reset();
          notice(f.querySelector('[data-ok]'), r.message, 'ok');
        } else after();
      }).catch((err) => { f.querySelector('[data-msg]').textContent = err.message; });
    });
  }

  function addressForm(a = {}) {
    return `
      <form class="panel address-form" data-id="${escapeHtml(a.id || '')}" novalidate>
        <h3>${a.id ? 'Edit address' : 'Add an address'}</h3>
        <div class="form-row">${field('label', 'Label (optional)', a.label || '', 'maxlength="40"')}${field('fullName', 'Full name', a.fullName || '', 'required maxlength="120" autocomplete="name"')}</div>
        <div class="form-row">${field('phone', 'Mobile', a.phone || '', 'type="tel" required maxlength="16" autocomplete="tel-national"')}${field('pin', 'PIN code', a.pin || '', 'inputmode="numeric" maxlength="6" required autocomplete="postal-code"')}</div>
        ${field('line', 'Address', a.line || '', 'required maxlength="200" autocomplete="address-line1"')}
        ${field('apartment', 'Apartment, floor (optional)', a.apartment || '', 'maxlength="200" autocomplete="address-line2"')}
        <div class="form-row">${field('locality', 'Locality', a.locality || '', 'required maxlength="120"')}${field('city', 'City', a.city || '', 'required maxlength="120" autocomplete="address-level2"')}</div>
        <div class="form-group"><label for="st-${++uid}">State</label><select id="st-${uid}" name="state" required data-value="${escapeHtml(a.state || '')}"></select></div>
        <label class="check"><input type="checkbox" name="isDefault" ${a.isDefault ? 'checked' : ''}> Default address</label>
        <div style="margin-top:1rem;display:flex;gap:.75rem;flex-wrap:wrap"><button class="btn" type="submit">Save address</button>${a.id ? '<button class="btn btn--ghost" type="button" data-cancel>Cancel</button>' : ''}</div>
      </form>`;
  }

  function initStates() {
    root.querySelectorAll('select[name="state"]').forEach((s) => { if (!s.options.length) { fillStates(s); s.value = s.dataset.value; } });
  }

  async function renderSignedIn() {
    const [a, wish, orders] = await Promise.all([
      API.get('/api/account'),
      API.get('/api/wishlist').catch(() => ({ products: [] })),
      API.get('/api/account/orders').catch(() => ({ orders: [] })),
    ]);
    acct = a;
    title.textContent = acct.profile.fullName ? `Hello, ${acct.profile.fullName}` : 'Your account';
    sub.textContent = acct.user.email;
    root.innerHTML = `
      <div class="account-grid">
        <section class="panel" aria-labelledby="orders-title">
          <h2 id="orders-title">Orders</h2>
          ${orders.orders.length ? orders.orders.map((o) => `
            <a class="kv-row order-link" href="/order?id=${encodeURIComponent(o.id)}">
              <span>${escapeHtml(o.publicRef)} · ${escapeHtml(new Date(o.createdAt).toLocaleDateString('en-IN'))}</span>
              <span><span class="status-badge status-badge--${escapeHtml(o.paymentStatus)}">${escapeHtml(o.paymentStatusLabel)}</span> ${formatINR(o.totalPaise)}</span>
            </a>`).join('') : '<p class="fine-print">No orders yet.</p>'}
        </section>
        <form class="panel" id="profile-form" novalidate>
          <h2>Profile</h2>
          ${field('fullName', 'Full name', acct.profile.fullName, 'maxlength="120" autocomplete="name"')}
          ${field('phone', 'Mobile', acct.profile.phone, 'type="tel" maxlength="16" autocomplete="tel-national"')}
          <div style="display:flex;gap:.75rem;flex-wrap:wrap"><button class="btn" type="submit">Save profile</button><button class="btn btn--ghost" type="button" id="logout">Sign out</button></div>
        </form>
      </div>
      <section class="account-section" aria-labelledby="addr-title">
        <h2 id="addr-title" style="font-size:var(--step-2)">Saved addresses</h2>
        <div class="account-grid">
          ${acct.addresses.map((x) => `
            <div class="panel">
              <p><strong>${escapeHtml(x.label || x.fullName)}</strong> ${x.isDefault ? '<span class="status-badge status-badge--paid">Default</span>' : ''}</p>
              <p class="fine-print">${escapeHtml([x.fullName, x.line, x.apartment, x.locality, x.city, x.state, x.pin].filter(Boolean).join(', '))} · ${escapeHtml(x.phone)}</p>
              <div style="display:flex;gap:1rem;align-items:center;margin-top:1rem"><button class="btn btn--ghost btn--small" type="button" data-edit="${escapeHtml(x.id)}">Edit</button><button class="remove-link" type="button" data-delete="${escapeHtml(x.id)}">Delete</button></div>
            </div>`).join('')}
          ${acct.addresses.length < 10 ? addressForm() : ''}
        </div>
      </section>
      <section class="account-section" aria-labelledby="wish-title">
        <div class="section-head" style="margin-bottom:1.5rem"><h2 id="wish-title" style="font-size:var(--step-2)">Wishlist</h2><a class="link-arrow" href="/wishlist">Open wishlist</a></div>
        <div class="product-grid" id="wishlist-grid"></div>
      </section>`;
    initStates();
    const wl = root.querySelector('#wishlist-grid');
    if (wish.products.length) wish.products.slice(0, 4).forEach((p) => wl.appendChild(renderProductCard(p)));
    else wl.innerHTML = '<p class="fine-print">Save pieces from their product page.</p>';
  }

  // Delegated listeners, attached once.
  root.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id === 'profile-form') {
      e.preventDefault();
      Forms.clear(f);
      try {
        await submitting(f, () => API.put('/api/account/profile', Forms.data(f)));
        Toast.success('Profile saved');
      } catch (err) {
        Forms.errors(f, err.body.errors);
        Toast.error(err.message);
      }
    } else if (f.classList.contains('address-form')) {
      e.preventDefault();
      Forms.clear(f);
      const body = { ...Forms.data(f), isDefault: f.isDefault.checked };
      try {
        await submitting(f, () => (f.dataset.id ? API.put(`/api/account/addresses/${f.dataset.id}`, body) : API.post('/api/account/addresses', body)));
        Toast.success('Address saved');
        renderSignedIn();
      } catch (err) {
        Forms.errors(f, err.body.errors);
        Toast.error(err.message);
      }
    }
  });
  root.addEventListener('click', async (e) => {
    if (e.target.id === 'logout') {
      await API.post('/api/auth/logout').catch(() => {});
      location.href = '/';
      return;
    }
    const del = e.target.closest('[data-delete]');
    if (del && confirm('Delete this address?')) {
      await API.del(`/api/account/addresses/${del.dataset.delete}`).catch((err) => Toast.error(err.message));
      renderSignedIn();
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const a = acct.addresses.find((x) => x.id === edit.dataset.edit);
      edit.closest('.panel').outerHTML = addressForm(a);
      initStates();
    }
    if (e.target.closest('[data-cancel]')) renderSignedIn();
  });

  const s = await Session.me();
  if (!s.accountsEnabled) {
    title.textContent = 'Accounts';
    notice(root, 'Customer accounts are not available yet. You can still check out as a guest.');
    return;
  }
  if (s.user) renderSignedIn().catch((e) => notice(root, e.message, 'error'));
  else renderSignedOut();
})();
