/* ═══════════════════════════════════════════════════════════════
   AMAANAT — shared storefront module
   Pages are rendered on the server. This file adds behaviour:
   menu, bag count, quick add, newsletter, gentle reveal effects,
   plus helpers used by the page scripts. All prices, stock and
   totals come from the server; the bag lives server-side.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

document.documentElement.classList.add('js');

// Password-reset links that land anywhere but /reset-password are forwarded there (token kept intact).
(() => {
  const h = location.hash;
  const q = new URLSearchParams(location.search);
  const recovery = /(^|[#&])type=recovery(&|$)/.test(h) || /(^|[#&])error_code=/.test(h) || (q.get('type') === 'recovery' && q.get('token_hash'));
  if (recovery && location.pathname !== '/reset-password') location.replace(`/reset-password${location.search}${h}`);
})();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatINR(paise) {
  if (!Number.isInteger(paise)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: paise % 100 === 0 ? 0 : 2 }).format(paise / 100);
}

function assetUrl(path) {
  if (!path) return '/assets/post.jpg';
  return /^https?:\/\//.test(path) || path.startsWith('/') ? path : `/${path}`;
}

const productUrl = (slug) => `/products/${encodeURIComponent(slug)}`;

function randomKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const store = {
  get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
  set(area, key, value) { try { window[area].setItem(key, value); } catch { /* storage unavailable */ } },
  remove(area, key) { try { window[area].removeItem(key); } catch { /* storage unavailable */ } },
};

/* ── API ── */
class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error;
    this.body = body || {};
  }
}

const API = {
  async request(method, url, data, headers = {}) {
    const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...headers } };
    if (data !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(data);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch {
      throw new ApiError(0, { error: 'network', message: 'Could not reach the store. Check your connection.' });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body);
    return Object.assign(body, { _status: res.status });
  },
  get: (url, headers) => API.request('GET', url, undefined, headers),
  post: (url, data) => API.request('POST', url, data ?? {}),
  put: (url, data) => API.request('PUT', url, data ?? {}),
  del: (url) => API.request('DELETE', url),
};

/* ── Toasts ── */
const Toast = {
  _el: null,
  show(message, type = 'info', duration = 3500) {
    if (!this._el) {
      this._el = document.createElement('div');
      this._el.className = 'toast-container';
      this._el.setAttribute('role', 'status');
      this._el.setAttribute('aria-live', 'polite');
      document.body.appendChild(this._el);
    }
    const el = document.createElement('div');
    el.className = `toast${type === 'error' ? ' toast--error' : type === 'success' ? ' toast--success' : ''}`;
    el.textContent = message;
    this._el.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => { el.classList.remove('is-visible'); setTimeout(() => el.remove(), 350); }, duration);
  },
  success(m) { this.show(m, 'success'); },
  error(m) { this.show(m, 'error', 5500); },
  info(m) { this.show(m); },
};

/* ── Bag (server-side) ── */
const Cart = {
  state: null,
  _loading: null,
  load() {
    this._loading ||= API.get('/api/cart')
      .catch(() => ({ items: [], count: 0, subtotalPaise: 0, quote: { ok: false } }))
      .then((s) => { this.state = s; this._badges(); this._loading = null; return s; });
    return this._loading;
  },
  async add(productId, quantity = 1, variantId = null) {
    this.state = await API.post('/api/cart/items', { productId, quantity, variantId });
    this._changed();
    return this.state;
  },
  async set(productId, quantity, variantId = null) {
    this.state = await API.put(`/api/cart/items/${encodeURIComponent(productId)}`, { quantity, variantId });
    this._changed();
    return this.state;
  },
  async remove(productId, variantId = null) {
    this.state = await API.del(`/api/cart/items/${encodeURIComponent(productId)}${variantId ? `?variant=${encodeURIComponent(variantId)}` : ''}`);
    this._changed();
    return this.state;
  },
  _changed() {
    this._badges();
    window.dispatchEvent(new CustomEvent('cart-updated', { detail: this.state }));
  },
  _badges() {
    const count = this.state?.count || 0;
    document.querySelectorAll('.bag-count').forEach((el) => {
      el.textContent = count > 0 ? String(count) : '';
      el.setAttribute('data-count', String(count));
      el.setAttribute('aria-label', `${count} ${count === 1 ? 'item' : 'items'} in bag`);
    });
  },
};

const Session = {
  _p: null,
  me() {
    this._p ||= API.get('/api/auth/me').catch(() => ({ user: null, accountsEnabled: false }));
    return this._p;
  },
};

/* ── Helpers used by page scripts ── */
function statusClass(code) {
  return code === 'in' ? 'card-status--in' : '';
}

async function addToBag(product, quantity, button, variant = null) {
  const label = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = 'Adding…'; }
  try {
    await Cart.add(product.id, quantity, variant ? variant.id : null);
    Toast.success(`${product.name}${variant ? ` (${variant.name})` : ''} added to your bag`);
  } catch (e) {
    Toast.error(e.message);
  } finally {
    if (button) { button.disabled = false; button.textContent = label; }
  }
}

// Same markup as the server-rendered card (lib/site/pages.js).
function renderProductCard(product) {
  const a = product.availability;
  const href = productUrl(product.slug);
  const price = product.minPricePaise !== undefined && product.minPricePaise !== product.maxPricePaise
    ? `From ${formatINR(product.minPricePaise)}` : formatINR(product.minPricePaise ?? product.pricePaise);
  const quick = a.canBuy && !(product.variants && product.variants.length);
  const card = document.createElement('article');
  card.className = 'card';
  card.innerHTML = `
    <a class="card-media" href="${href}" tabindex="-1" aria-hidden="true"><img src="${escapeHtml(assetUrl(product.image))}" alt="${escapeHtml(product.alt || product.name)}" loading="lazy" decoding="async"></a>
    <div class="card-body">
      <p class="card-cat">${escapeHtml(product.category)}</p>
      <h3 class="card-title"><a href="${href}">${escapeHtml(product.name)}</a></h3>
      <p class="card-price">${price}</p>
      <p class="card-status ${statusClass(a.code)}">${escapeHtml(a.label)}</p>
      ${quick ? `<button class="btn btn--ghost btn--small card-quick" type="button" data-add-to-bag="${escapeHtml(product.id)}" data-name="${escapeHtml(product.name)}">Add to bag</button>` : ''}
    </div>`;
  return card;
}

function notice(container, message, type = 'info') {
  container.innerHTML = `<div class="notice notice--${type}" role="${type === 'error' ? 'alert' : 'status'}">${escapeHtml(message)}</div>`;
}

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

function fillStates(select) {
  select.innerHTML = '<option value="">Choose…</option>' + INDIAN_STATES.map((s) => `<option>${escapeHtml(s)}</option>`).join('');
}

const Forms = {
  clear(form) {
    form.querySelectorAll('.is-error').forEach((el) => { el.classList.remove('is-error'); el.removeAttribute('aria-invalid'); });
    form.querySelectorAll('.form-error').forEach((el) => el.remove());
  },
  errors(form, errors = {}) {
    for (const [name, message] of Object.entries(errors || {})) {
      const input = form.elements[name];
      if (!input || !input.parentElement) continue;
      input.classList.add('is-error');
      input.setAttribute('aria-invalid', 'true');
      const p = document.createElement('p');
      p.className = 'form-error';
      p.id = `${input.id || name}-error`;
      p.textContent = message;
      input.setAttribute('aria-describedby', p.id);
      input.parentElement.appendChild(p);
    }
    form.querySelector('.is-error')?.focus();
  },
  data(form) {
    return Object.fromEntries(new FormData(form).entries());
  },
};

/* ── Page chrome ── */
function initMenu() {
  const header = document.getElementById('header');
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  if (header) {
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
  if (!toggle || !nav) return;
  const close = (focus) => {
    nav.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    if (focus) toggle.focus();
  };
  toggle.addEventListener('click', () => {
    nav.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    nav.querySelector('a')?.focus();
  });
  nav.querySelector('.nav-close')?.addEventListener('click', () => close(true));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('is-open')) close(true); });
  document.addEventListener('click', (e) => {
    if (nav.classList.contains('is-open') && !nav.contains(e.target) && !toggle.contains(e.target)) close(false);
  });
}

function initQuickAdd() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add-to-bag]');
    if (!btn) return;
    e.preventDefault();
    addToBag({ id: btn.dataset.addToBag, name: btn.dataset.name || 'Piece' }, 1, btn);
  });
}

function initNewsletter() {
  document.querySelectorAll('form.newsletter-form').forEach(bindNewsletter);
}

function bindNewsletter(form) {
  const msg = form.querySelector('.newsletter-msg');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'Enter a valid email address.'; form.email.focus(); return; }
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const r = await API.post('/api/newsletter', { email });
      msg.textContent = r.message;
      form.reset();
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

function initReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;
  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
  }), { rootMargin: '0px 0px -8% 0px' });
  els.forEach((el) => io.observe(el));
}

document.addEventListener('DOMContentLoaded', () => {
  initMenu();
  initQuickAdd();
  initNewsletter();
  initReveal();
  Cart.load();
  Session.me().then((s) => {
    document.querySelectorAll('[data-account-link]').forEach((a) => { a.textContent = s.user ? 'Account' : 'Sign in'; });
  });
});
