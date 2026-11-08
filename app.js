/* ═══════════════════════════════════════════════════════════════
   AMAANAT — Frontend Application JS
   Shared by shop, product, cart, checkout, order-tracking pages
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ── Bag SVG Icon (reused across pages) ───────────────────────── */
const BAG_ICON_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>`;

/* ── Currency Formatter ───────────────────────────────────────── */
function formatINR(paise) {
  const rupees = paise / 100;
  return '₹' + rupees.toLocaleString('en-IN');
}

/* ── API Helpers ──────────────────────────────────────────────── */
const API = {
  async get(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw { status: res.status, ...body };
    }
    return res.json();
  },
  async post(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw { status: res.status, ...body };
    }
    return res.json();
  },
};

/* ── Toast Notification System ────────────────────────────────── */
const Toast = {
  _container: null,

  _ensure() {
    if (!this._container) {
      this._container = document.createElement('div');
      this._container.className = 'toast-container';
      document.body.appendChild(this._container);
    }
  },

  show(message, type = 'info', duration = 3500) {
    this._ensure();
    const el = document.createElement('div');
    el.className = `toast${type === 'error' ? ' toast--error' : type === 'success' ? ' toast--success' : ''}`;
    el.textContent = message;
    this._container.appendChild(el);

    requestAnimationFrame(() => {
      el.classList.add('is-visible');
    });

    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 350);
    }, duration);
  },

  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error', 5000); },
  info(msg) { this.show(msg, 'info'); },
};

/* ── Cart Module ──────────────────────────────────────────────── */
const Cart = {
  KEY: 'amaanat_cart',

  _items: null,

  _load() {
    if (this._items !== null) return;
    try {
      this._items = JSON.parse(localStorage.getItem(this.KEY)) || [];
    } catch {
      this._items = [];
    }
  },

  _save() {
    localStorage.setItem(this.KEY, JSON.stringify(this._items));
    this._updateBadges();
    window.dispatchEvent(new CustomEvent('cart-updated'));
  },

  getItems() {
    this._load();
    return [...this._items];
  },

  getCount() {
    this._load();
    return this._items.reduce((sum, i) => sum + i.quantity, 0);
  },

  add(productId, quantity = 1) {
    this._load();
    const existing = this._items.find(i => i.productId === productId);
    if (existing) {
      existing.quantity += quantity;
    } else {
      this._items.push({ productId, quantity });
    }
    this._save();
  },

  remove(productId) {
    this._load();
    this._items = this._items.filter(i => i.productId !== productId);
    this._save();
  },

  updateQuantity(productId, quantity) {
    this._load();
    if (quantity <= 0) {
      this.remove(productId);
      return;
    }
    const item = this._items.find(i => i.productId === productId);
    if (item) {
      item.quantity = quantity;
      this._save();
    }
  },

  clear() {
    this._items = [];
    this._save();
  },

  _updateBadges() {
    const count = this.getCount();
    document.querySelectorAll('.nav-bag-count').forEach(el => {
      el.textContent = count > 0 ? count : '';
      el.setAttribute('data-count', count);
    });
  },

  init() {
    this._load();
    this._updateBadges();
  },
};

/* ── Product Availability Logic ───────────────────────────────── */
function getAvailability(product) {
  if (!product.inventoryConfirmed || product.stockQuantity === null || product.stockQuantity === undefined) {
    return { status: 'unconfirmed', label: 'Stock to be confirmed', canAdd: false };
  }
  if (product.stockQuantity <= 0) {
    return { status: 'out-of-stock', label: 'Out of stock', canAdd: false };
  }
  return { status: 'in-stock', label: 'In stock', canAdd: true };
}

/* ── Product Card Rendering ───────────────────────────────────── */
function renderProductCard(product) {
  const avail = getAvailability(product);
  const imageUrl = product.images && product.images.length > 0
    ? product.images[0]
    : `assets/products/${product.slug}.jpg`;

  const card = document.createElement('article');
  card.className = 'product-card';
  card.dataset.category = product.category || '';

  card.innerHTML = `
    <a href="product.html?slug=${product.slug}" class="product-card-img">
      <img src="${imageUrl}" alt="${product.name}" loading="lazy" />
    </a>
    <div class="product-card-body">
      <h3 class="product-card-name">
        <a href="product.html?slug=${product.slug}">${product.name}</a>
      </h3>
      <p class="product-card-price">${formatINR(product.pricePaise)}</p>
      <p class="product-card-status ${avail.status}">${avail.label}</p>
      <div class="product-card-actions">
        <button class="btn btn-gold" ${!avail.canAdd ? 'disabled' : ''} data-add-to-bag="${product._id || product.id}">Add to Bag</button>
        <a class="btn btn-ghost" href="product.html?slug=${product.slug}">View</a>
      </div>
    </div>
  `;

  const addBtn = card.querySelector('[data-add-to-bag]');
  if (addBtn && avail.canAdd) {
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      Cart.add(product._id || product.id);
      Toast.success(`${product.name} added to bag`);
    });
  }

  return card;
}

/* ── Skeleton Card Rendering ──────────────────────────────────── */
function renderSkeletonCards(container, count = 8) {
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'skeleton-card';
    card.innerHTML = `
      <div class="skeleton-img"></div>
      <div class="skeleton-text"></div>
      <div class="skeleton-text-sm"></div>
    `;
    container.appendChild(card);
  }
}

/* ── Header / Navigation Injection ────────────────────────────── */
function buildSiteHeader(activePage) {
  return `
    <a class="mark" href="/">
      <span class="mark-hi" lang="hi">अमानत</span>
      <span class="mark-en">Amaanat</span>
    </a>
    <nav class="nav" id="nav">
      <a href="/" ${activePage === 'home' ? 'class="is-current"' : ''}>Home</a>
      <a href="/shop.html" ${activePage === 'shop' ? 'class="is-current"' : ''}>Shop</a>
      <a href="/#story">Our Story</a>
      <a href="https://www.instagram.com/amanaat.ind/" target="_blank" rel="noopener" class="nav-ig">Instagram</a>
      <a href="/cart.html" class="nav-bag" ${activePage === 'cart' ? 'style="color:var(--gold-deep)"' : ''}>
        ${BAG_ICON_SVG}
        Bag
        <span class="nav-bag-count" data-count="0"></span>
      </a>
    </nav>
    <div class="header-right">
      <a href="/cart.html" class="header-bag-mobile">
        ${BAG_ICON_SVG}
        <span class="nav-bag-count" data-count="0"></span>
      </a>
      <button class="menu" id="menu" aria-label="Open menu" aria-expanded="false">
        <span></span>
        <span></span>
      </button>
    </div>
  `;
}

function initHeader(activePage) {
  const header = document.getElementById('header');
  if (!header) return;

  header.innerHTML = buildSiteHeader(activePage);

  const menu = document.getElementById('menu');
  const nav = document.getElementById('nav');

  window.addEventListener('scroll', () => {
    header.classList.toggle('is-scrolled', window.scrollY > 12);
  }, { passive: true });

  if (menu && nav) {
    menu.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      menu.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });

    nav.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        nav.classList.remove('is-open');
        menu.setAttribute('aria-expanded', 'false');
      });
    });
  }

  Cart.init();
}

/* ── Footer ───────────────────────────────────────────────────── */
function buildSiteFooter() {
  return `
    <div>
      <p class="mark-hi" lang="hi">अमानत</p>
      <p class="footer-tag">Some things are too precious to lose.</p>
    </div>
    <div class="footer-links">
      <a href="/shop.html">Shop</a>
      <a href="https://www.instagram.com/amanaat.ind/" target="_blank" rel="noopener">Instagram</a>
      <a href="/#story">Our Story</a>
      <a href="/order-tracking.html">Track Order</a>
    </div>
    <p class="footer-small">Amaanat · India · &copy; ${new Date().getFullYear()}</p>
  `;
}

function initFooter() {
  const footer = document.querySelector('.site-footer');
  if (footer && !footer.dataset.init) {
    footer.innerHTML = buildSiteFooter();
    footer.dataset.init = '1';
  }
}

/* ── Products Cache ───────────────────────────────────────────── */
let _productsCache = null;

async function fetchProducts() {
  if (_productsCache) return _productsCache;
  const data = await API.get('/api/products');
  _productsCache = data.products || data;
  return _productsCache;
}

async function fetchProductBySlug(slug) {
  const data = await API.get(`/api/products/${slug}`);
  return data.product || data;
}

/* ── Form Validation ──────────────────────────────────────────── */
const Validate = {
  required(val) {
    return val && val.trim().length > 0;
  },
  email(val) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
  },
  phone(val) {
    return /^[6-9]\d{9}$/.test(val.replace(/[\s\-+91]/g, ''));
  },
  pincode(val) {
    return /^\d{6}$/.test(val);
  },
  clearErrors(form) {
    form.querySelectorAll('.is-error').forEach(el => el.classList.remove('is-error'));
    form.querySelectorAll('.form-error').forEach(el => el.remove());
  },
  showError(input, message) {
    input.classList.add('is-error');
    const err = document.createElement('p');
    err.className = 'form-error';
    err.textContent = message;
    input.parentElement.appendChild(err);
  },
};

/* ── Indian States ────────────────────────────────────────────── */
const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

/* ── DOMContentLoaded Init ────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Only init on pages that use app.js (not index.html which has its own script.js)
  const page = document.body.dataset.page;
  if (page) {
    initHeader(page);
    initFooter();
  } else {
    // For index.html — just init cart badges
    Cart.init();
  }
});
