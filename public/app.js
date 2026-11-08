/* ═══════════════════════════════════════════════════════════════
   AMAANAT — shared storefront module
   All prices, stock and totals come from the server. The browser only
   holds display state; the bag lives server-side (cookie-identified).
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const BAG_ICON_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>';

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

/* ── API ──────────────────────────────────────────────────────── */
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

/* ── Toasts ───────────────────────────────────────────────────── */
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

/* ── Bag (server-side) ────────────────────────────────────────── */
const Cart = {
  state: null,
  async load() {
    try {
      this.state = await API.get('/api/cart');
    } catch {
      this.state = { items: [], count: 0, subtotalPaise: 0 };
    }
    this._badges();
    return this.state;
  },
  async add(productId, quantity = 1) {
    this.state = await API.post('/api/cart/items', { productId, quantity });
    this._changed();
    return this.state;
  },
  async set(productId, quantity) {
    this.state = await API.put(`/api/cart/items/${encodeURIComponent(productId)}`, { quantity });
    this._changed();
    return this.state;
  },
  async remove(productId) {
    this.state = await API.del(`/api/cart/items/${encodeURIComponent(productId)}`);
    this._changed();
    return this.state;
  },
  _changed() {
    this._badges();
    window.dispatchEvent(new CustomEvent('cart-updated', { detail: this.state }));
  },
  _badges() {
    const count = this.state?.count || 0;
    document.querySelectorAll('.nav-bag-count').forEach((el) => {
      el.textContent = count > 0 ? String(count) : '';
      el.setAttribute('data-count', String(count));
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

/* ── Rendering helpers ────────────────────────────────────────── */
function statusClass(code) {
  return { in: 'in-stock', out: 'out-of-stock', unconfirmed: 'unconfirmed', inactive: 'out-of-stock' }[code] || 'unconfirmed';
}

async function addToBag(product, quantity, button) {
  if (button) button.disabled = true;
  try {
    await Cart.add(product.id, quantity);
    Toast.success(`${product.name} added to bag`);
  } catch (e) {
    Toast.error(e.message);
  } finally {
    if (button) button.disabled = !product.availability.canBuy;
  }
}

function renderProductCard(product) {
  const a = product.availability;
  const href = `/product.html?slug=${encodeURIComponent(product.slug)}`;
  const card = document.createElement('article');
  card.className = 'product-card';
  card.innerHTML = `
    <a href="${href}" class="product-card-img">
      <img src="${escapeHtml(assetUrl(product.image))}" alt="${escapeHtml(product.alt || product.name)}" loading="lazy" />
    </a>
    <div class="product-card-body">
      <p class="product-card-category">${escapeHtml(product.category)}</p>
      <h3 class="product-card-name"><a href="${href}">${escapeHtml(product.name)}</a></h3>
      <p class="product-card-price">${formatINR(product.pricePaise)}</p>
      <p class="product-card-status ${statusClass(a.code)}">${escapeHtml(a.label)}</p>
      <div class="product-card-actions">
        <button class="btn btn-gold" type="button" ${a.canBuy ? '' : 'disabled'}>${a.canBuy ? 'Add to bag' : escapeHtml(a.label)}</button>
        <a class="btn btn-ghost" href="${href}">View</a>
      </div>
    </div>`;
  const btn = card.querySelector('button');
  if (a.canBuy) btn.addEventListener('click', () => addToBag(product, 1, btn));
  return card;
}

function renderSkeletonCards(container, count = 8) {
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'skeleton-card';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="skeleton-img"></div><div class="skeleton-text"></div><div class="skeleton-text-sm"></div>';
    container.appendChild(el);
  }
}

function notice(container, message, type = 'info') {
  container.innerHTML = `<div class="notice notice--${type}" role="${type === 'error' ? 'alert' : 'status'}">${escapeHtml(message)}</div>`;
}

/* ── Header / footer ──────────────────────────────────────────── */
function buildSiteHeader(active) {
  const cur = (p) => (active === p ? ' class="is-current" aria-current="page"' : '');
  return `
    <a class="mark" href="/">
      <span class="mark-hi" lang="hi">अमानत</span>
      <span class="mark-en">Amaanat</span>
    </a>
    <nav class="nav" id="nav" aria-label="Main">
      <a href="/shop.html"${cur('shop')}>Shop</a>
      <a href="/order-tracking.html"${cur('track')}>Track order</a>
      <a href="/account.html"${cur('account')} data-account-link>Account</a>
      <a href="/cart.html" class="nav-bag"${cur('cart')}>${BAG_ICON_SVG} Bag <span class="nav-bag-count" data-count="0"></span></a>
    </nav>
    <div class="header-right">
      <a href="/cart.html" class="header-bag-mobile" aria-label="Bag">${BAG_ICON_SVG}<span class="nav-bag-count" data-count="0"></span></a>
      <button class="menu" id="menu" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="nav"><span></span><span></span></button>
    </div>`;
}

function wireMenu(header) {
  const menu = header.querySelector('#menu');
  const nav = header.querySelector('#nav');
  window.addEventListener('scroll', () => header.classList.toggle('is-scrolled', window.scrollY > 12), { passive: true });
  if (!menu || !nav) return;
  menu.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
    nav.classList.remove('is-open');
    menu.setAttribute('aria-expanded', 'false');
  }));
}

function initFooter() {
  const footer = document.querySelector('.site-footer');
  if (!footer || footer.dataset.init) return;
  footer.dataset.init = '1';
  footer.innerHTML = `
    <div>
      <p class="mark-hi" lang="hi">अमानत</p>
      <p class="footer-tag">Some things are too precious to lose.</p>
    </div>
    <div class="footer-links">
      <a href="/shop.html">Shop</a>
      <a href="/order-tracking.html">Track order</a>
      <a href="/account.html">Account</a>
      <a href="https://www.instagram.com/amanaat.ind/" target="_blank" rel="noopener">Instagram</a>
    </div>
    <p class="footer-small">Amaanat · India · &copy; ${new Date().getFullYear()}</p>`;
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
    form.querySelectorAll('.is-error').forEach((el) => el.classList.remove('is-error'));
    form.querySelectorAll('.form-error').forEach((el) => el.remove());
  },
  errors(form, errors = {}) {
    for (const [name, message] of Object.entries(errors)) {
      const input = form.elements[name];
      if (!input) continue;
      input.classList.add('is-error');
      input.setAttribute('aria-invalid', 'true');
      const p = document.createElement('p');
      p.className = 'form-error';
      p.textContent = message;
      input.parentElement.appendChild(p);
    }
    form.querySelector('.is-error')?.focus();
  },
  data(form) {
    return Object.fromEntries(new FormData(form).entries());
  },
};

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  const header = document.getElementById('header');
  if (page && header) {
    header.innerHTML = buildSiteHeader(page);
    wireMenu(header);
    initFooter();
  }
  Cart.load();
  Session.me().then((s) => {
    document.querySelectorAll('[data-account-link]').forEach((a) => { a.textContent = s.user ? 'Account' : 'Sign in'; });
  });
});
