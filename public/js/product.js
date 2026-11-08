'use strict';
/* Enhances the server-rendered product page: gallery, options, quantity, add to bag, wishlist. */
(() => {
  const dataEl = document.getElementById('product-data');
  if (!dataEl) return;
  const p = JSON.parse(dataEl.textContent);
  const form = document.getElementById('buy-form');
  const addBtn = document.getElementById('add');
  const qtyOut = document.getElementById('qty');
  const priceEl = document.getElementById('pdp-price');
  const statusEl = document.getElementById('pdp-status');
  const qtyWrap = form.querySelector('.qty');
  let qty = 1;
  let variant = null;

  // Gallery
  const main = document.querySelector('#gallery-main img');
  document.querySelectorAll('.gallery-thumb').forEach((btn) => btn.addEventListener('click', () => {
    const i = Number(btn.dataset.index);
    const thumbImg = btn.querySelector('img');
    main.removeAttribute('srcset');
    main.src = thumbImg.currentSrc || thumbImg.src || p.images[i];
    if (thumbImg.srcset) { main.srcset = thumbImg.srcset; main.sizes = '(max-width: 860px) 100vw, 56vw'; }
    document.querySelectorAll('.gallery-thumb').forEach((b) => b.removeAttribute('aria-current'));
    btn.setAttribute('aria-current', 'true');
  }));

  const unit = () => (variant ? variant.availability : p.availability);
  const maxQty = () => Math.max(1, unit().maxQuantity || 1);
  function paintQty() {
    qtyOut.textContent = String(qty);
    const [dec, inc] = qtyWrap.querySelectorAll('button');
    dec.disabled = qty <= 1;
    inc.disabled = qty >= maxQty();
  }

  qtyWrap.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    qty = Math.min(maxQty(), Math.max(1, qty + Number(b.dataset.step)));
    paintQty();
  }));

  form.querySelectorAll('input[name="variant"]').forEach((r) => r.addEventListener('change', () => {
    variant = p.variants.find((v) => v.id === r.value);
    priceEl.textContent = formatINR(variant.pricePaise);
    statusEl.textContent = variant.availability.label;
    statusEl.classList.toggle('pdp-status--in', variant.availability.canBuy);
    qty = 1;
    qtyWrap.hidden = !variant.availability.canBuy;
    addBtn.disabled = !variant.availability.canBuy;
    addBtn.textContent = variant.availability.canBuy ? 'Add to bag' : variant.availability.label;
    paintQty();
  }));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (p.variants.length && !variant) { Toast.info('Choose an option first.'); return; }
    if (!unit().canBuy) return;
    addToBag(p, qty, addBtn, variant);
  });
  paintQty();

  // Wishlist (accounts only)
  const wish = document.getElementById('wish');
  Session.me().then(async (session) => {
    if (!session.accountsEnabled) return;
    wish.hidden = false;
    if (!session.user) {
      wish.addEventListener('click', () => { location.href = `/account?next=${encodeURIComponent(location.pathname)}`; });
      return;
    }
    let saved = false;
    try { saved = (await API.get('/api/wishlist')).products.some((x) => x.id === p.id); } catch { /* ignore */ }
    const paint = () => { wish.textContent = saved ? 'Saved to wishlist ♥' : 'Save to wishlist'; wish.setAttribute('aria-pressed', String(saved)); };
    paint();
    wish.addEventListener('click', async () => {
      wish.disabled = true;
      try {
        const url = `/api/wishlist/${encodeURIComponent(p.id)}`;
        await (saved ? API.del(url) : API.put(url));
        saved = !saved;
        paint();
      } catch (err) {
        Toast.error(err.message);
      } finally {
        wish.disabled = false;
      }
    });
  });
})();
