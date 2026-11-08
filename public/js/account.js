'use strict';
(async () => {
  const root = document.getElementById('account');
  const title = document.getElementById('account-title');
  const sub = document.getElementById('account-sub');
  const next = new URLSearchParams(location.search).get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

  const field = (id, name, label, attrs = '') => `<div class="form-group"><label for="${id}">${label}</label><input id="${id}" name="${name}" ${attrs} /></div>`;

  function renderSignedOut() {
    title.textContent = 'Sign in';
    sub.textContent = 'Save addresses, keep a wishlist and see your orders.';
    root.innerHTML = `
      <div class="account-grid">
        <form class="account-card" id="login-form" novalidate>
          <h2>Sign in</h2>
          ${field('login-email', 'email', 'Email', 'type="email" autocomplete="email" required')}
          ${field('login-password', 'password', 'Password', 'type="password" autocomplete="current-password" required')}
          <button class="btn btn-gold" type="submit">Sign in</button>
        </form>
        <form class="account-card" id="register-form" novalidate>
          <h2>Create an account</h2>
          ${field('reg-name', 'fullName', 'Full name', 'autocomplete="name" maxlength="120"')}
          ${field('reg-email', 'email', 'Email', 'type="email" autocomplete="email" required')}
          ${field('reg-password', 'password', 'Password (8+ characters)', 'type="password" autocomplete="new-password" minlength="8" maxlength="72" required')}
          <button class="btn btn-ghost" type="submit">Create account</button>
        </form>
      </div>`;

    const after = () => { location.href = safeNext || '/account.html'; };
    root.querySelector('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await API.post('/api/auth/login', { email: f.email.value, password: f.password.value });
        after();
      } catch (err) {
        Toast.error(err.message);
      }
    });
    root.querySelector('#register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const r = await API.post('/api/auth/register', { fullName: f.fullName.value, email: f.email.value, password: f.password.value });
        if (r.needsConfirmation) {
          notice(f, r.message, 'info');
        } else {
          after();
        }
      } catch (err) {
        Toast.error(err.message);
      }
    });
  }

  function addressForm(a = {}) {
    return `
      <form class="account-card address-form" data-id="${escapeHtml(a.id || '')}" novalidate>
        <h3>${a.id ? 'Edit address' : 'Add an address'}</h3>
        <div class="form-row">
          <div class="form-group"><label>Label (optional)</label><input name="label" maxlength="40" value="${escapeHtml(a.label || '')}" /></div>
          <div class="form-group"><label>Full name</label><input name="fullName" required maxlength="120" value="${escapeHtml(a.fullName || '')}" /></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Mobile</label><input name="phone" type="tel" required maxlength="16" value="${escapeHtml(a.phone || '')}" /></div>
          <div class="form-group"><label>PIN code</label><input name="pin" inputmode="numeric" maxlength="6" required value="${escapeHtml(a.pin || '')}" /></div>
        </div>
        <div class="form-group"><label>Address</label><input name="line" required maxlength="200" value="${escapeHtml(a.line || '')}" /></div>
        <div class="form-group"><label>Apartment, floor (optional)</label><input name="apartment" maxlength="200" value="${escapeHtml(a.apartment || '')}" /></div>
        <div class="form-row">
          <div class="form-group"><label>Locality</label><input name="locality" required maxlength="120" value="${escapeHtml(a.locality || '')}" /></div>
          <div class="form-group"><label>City</label><input name="city" required maxlength="120" value="${escapeHtml(a.city || '')}" /></div>
        </div>
        <div class="form-group"><label>State</label><select name="state" required data-value="${escapeHtml(a.state || '')}"></select></div>
        <label class="check"><input type="checkbox" name="isDefault" ${a.isDefault ? 'checked' : ''} /> Default address</label>
        <div class="cart-actions"><button class="btn btn-gold" type="submit">Save address</button></div>
      </form>`;
  }

  async function renderSignedIn() {
    const [acct, wish, orders] = await Promise.all([
      API.get('/api/account'),
      API.get('/api/wishlist').catch(() => ({ products: [] })),
      API.get('/api/account/orders').catch(() => ({ orders: [] })),
    ]);
    title.textContent = acct.profile.fullName ? `Hello, ${acct.profile.fullName}` : 'Your account';
    sub.textContent = acct.user.email;
    root.innerHTML = `
      <div class="account-grid">
        <section class="account-card">
          <h2>Orders</h2>
          ${orders.orders.length ? orders.orders.map((o) => `
            <a class="tracking-detail-row order-link" href="/order.html?id=${encodeURIComponent(o.id)}">
              <span>${escapeHtml(o.publicRef)} · ${escapeHtml(new Date(o.createdAt).toLocaleDateString('en-IN'))}</span>
              <span><span class="status-badge status-badge--${escapeHtml(o.paymentStatus)}">${escapeHtml(o.paymentStatusLabel)}</span> ${formatINR(o.totalPaise)}</span>
            </a>`).join('') : '<p class="fine-print">No orders yet.</p>'}
        </section>
        <form class="account-card" id="profile-form" novalidate>
          <h2>Profile</h2>
          <div class="form-group"><label for="p-name">Full name</label><input id="p-name" name="fullName" maxlength="120" value="${escapeHtml(acct.profile.fullName)}" /></div>
          <div class="form-group"><label for="p-phone">Mobile</label><input id="p-phone" name="phone" type="tel" maxlength="16" value="${escapeHtml(acct.profile.phone)}" /></div>
          <div class="cart-actions"><button class="btn btn-gold" type="submit">Save profile</button><button class="btn btn-ghost" type="button" id="logout">Sign out</button></div>
        </form>
      </div>
      <section class="account-section">
        <h2>Saved addresses</h2>
        <div class="account-grid" id="addresses">
          ${acct.addresses.map((a) => `
            <div class="account-card">
              <p><strong>${escapeHtml(a.label || a.fullName)}</strong> ${a.isDefault ? '<span class="status-badge status-badge--paid">Default</span>' : ''}</p>
              <p class="fine-print">${escapeHtml([a.fullName, a.line, a.apartment, a.locality, a.city, a.state, a.pin].filter(Boolean).join(', '))} · ${escapeHtml(a.phone)}</p>
              <div class="cart-actions"><button class="btn btn-ghost" type="button" data-edit="${escapeHtml(a.id)}">Edit</button><button class="cart-item-remove" type="button" data-delete="${escapeHtml(a.id)}">Delete</button></div>
            </div>`).join('')}
          ${acct.addresses.length < 10 ? addressForm() : ''}
        </div>
      </section>
      <section class="account-section">
        <h2>Wishlist</h2>
        <div class="product-grid" id="wishlist"></div>
      </section>`;

    root.querySelectorAll('select[name="state"]').forEach((s) => { fillStates(s); s.value = s.dataset.value; });
    const wl = root.querySelector('#wishlist');
    if (wish.products.length) wish.products.forEach((p) => wl.appendChild(renderProductCard(p)));
    else wl.innerHTML = '<p class="fine-print">Save pieces from their product page.</p>';

    root.querySelector('#profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      Forms.clear(e.target);
      try {
        await API.put('/api/account/profile', Forms.data(e.target));
        Toast.success('Profile saved');
      } catch (err) {
        Forms.errors(e.target, err.body.errors);
        Toast.error(err.message);
      }
    });
    root.querySelector('#logout').addEventListener('click', async () => {
      await API.post('/api/auth/logout').catch(() => {});
      location.href = '/';
    });
    root.addEventListener('submit', async (e) => {
      if (!e.target.classList.contains('address-form')) return;
      e.preventDefault();
      const f = e.target;
      Forms.clear(f);
      const body = { ...Forms.data(f), isDefault: f.isDefault.checked };
      try {
        await (f.dataset.id ? API.put(`/api/account/addresses/${f.dataset.id}`, body) : API.post('/api/account/addresses', body));
        Toast.success('Address saved');
        renderSignedIn();
      } catch (err) {
        Forms.errors(f, err.body.errors);
        Toast.error(err.message);
      }
    });
    root.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-delete]');
      const edit = e.target.closest('[data-edit]');
      if (del && confirm('Delete this address?')) {
        await API.del(`/api/account/addresses/${del.dataset.delete}`).catch((err) => Toast.error(err.message));
        renderSignedIn();
      }
      if (edit) {
        const a = acct.addresses.find((x) => x.id === edit.dataset.edit);
        const card = edit.closest('.account-card');
        card.outerHTML = addressForm(a);
        root.querySelectorAll('select[name="state"]').forEach((s) => { if (!s.options.length) { fillStates(s); s.value = s.dataset.value; } });
      }
    });
  }

  const s = await Session.me();
  if (!s.accountsEnabled) {
    title.textContent = 'Accounts';
    notice(root, 'Customer accounts are not configured on this server yet. You can still check out as a guest.', 'info');
    return;
  }
  if (s.user) renderSignedIn().catch((e) => notice(root, e.message, 'error'));
  else renderSignedOut();
})();
