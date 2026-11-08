'use strict';
(async () => {
  const root = document.getElementById('product-detail');
  const slug = new URLSearchParams(location.search).get('slug') || '';
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) {
    root.innerHTML = '<div class="empty-state"><h2>Piece not found</h2><p><a class="btn btn-ghost" href="/shop.html">Back to the shop</a></p></div>';
    return;
  }
  let data;
  try {
    data = await API.get(`/api/products/${encodeURIComponent(slug)}`);
  } catch (e) {
    root.innerHTML = `<div class="empty-state"><h2>${e.status === 404 ? 'Piece not found' : 'Could not load this piece'}</h2><p>${escapeHtml(e.message)}</p><p><a class="btn btn-ghost" href="/shop.html">Back to the shop</a></p></div>`;
    return;
  }
  const p = data.product;
  const a = p.availability;
  document.title = `${p.name} — Amaanat`;
  document.getElementById('crumb-name').textContent = p.name;

  const thumbs = p.images.length > 1
    ? `<div class="thumbs">${p.images.map((src, i) => `<button type="button" class="thumb${i ? '' : ' is-active'}" data-src="${escapeHtml(assetUrl(src))}" aria-label="Image ${i + 1}"><img src="${escapeHtml(assetUrl(src))}" alt="" /></button>`).join('')}</div>`
    : '';
  root.innerHTML = `
    <div class="product-detail-image">
      <img id="main-img" src="${escapeHtml(assetUrl(p.image))}" alt="${escapeHtml(p.alt || p.name)}" />
      ${thumbs}
    </div>
    <div class="product-detail-info">
      <p class="eyebrow">${escapeHtml(p.category)}</p>
      <h1>${escapeHtml(p.name)}</h1>
      <p class="product-detail-price">${formatINR(p.pricePaise)}</p>
      <p class="product-detail-status ${statusClass(a.code)}">${escapeHtml(a.label)}</p>
      <p class="product-detail-desc">${escapeHtml(p.description)}</p>
      <div class="quantity-selector" ${a.canBuy ? '' : 'hidden'}>
        <button class="qty-btn" type="button" data-step="-1" aria-label="Decrease quantity">−</button>
        <span class="qty-value" id="qty" aria-live="polite">1</span>
        <button class="qty-btn" type="button" data-step="1" aria-label="Increase quantity">+</button>
      </div>
      <div class="product-detail-actions">
        <button class="btn btn-gold" id="add" type="button" ${a.canBuy ? '' : 'disabled'}>${a.canBuy ? 'Add to bag' : escapeHtml(a.label)}</button>
        <button class="btn btn-ghost" id="wish" type="button">Save to wishlist</button>
      </div>
      ${a.code === 'unconfirmed' ? '<p class="fine-print">This piece is not available to order yet. Stock is still being confirmed.</p>' : ''}
    </div>`;

  let qty = 1;
  const qtyEl = document.getElementById('qty');
  const max = Math.max(1, a.maxQuantity || 1);
  root.querySelectorAll('.qty-btn').forEach((b) => b.addEventListener('click', () => {
    qty = Math.min(max, Math.max(1, qty + Number(b.dataset.step)));
    qtyEl.textContent = String(qty);
  }));
  const addBtn = document.getElementById('add');
  if (a.canBuy) addBtn.addEventListener('click', () => addToBag(p, qty, addBtn));

  root.querySelectorAll('.thumb').forEach((b) => b.addEventListener('click', () => {
    document.getElementById('main-img').src = b.dataset.src;
    root.querySelectorAll('.thumb').forEach((x) => x.classList.toggle('is-active', x === b));
  }));

  const wish = document.getElementById('wish');
  const session = await Session.me();
  if (!session.accountsEnabled) {
    wish.hidden = true;
  } else if (!session.user) {
    wish.addEventListener('click', () => { location.href = `/account.html?next=${encodeURIComponent(location.pathname + location.search)}`; });
  } else {
    let saved = false;
    try {
      saved = (await API.get('/api/wishlist')).products.some((x) => x.id === p.id);
    } catch { /* ignore */ }
    const paint = () => { wish.textContent = saved ? 'Saved ♥' : 'Save to wishlist'; wish.setAttribute('aria-pressed', String(saved)); };
    paint();
    wish.addEventListener('click', async () => {
      wish.disabled = true;
      try {
        const url = `/api/wishlist/${encodeURIComponent(p.id)}`;
        await (saved ? API.del(url) : API.put(url));
        saved = !saved;
        paint();
      } catch (e) {
        Toast.error(e.message);
      } finally {
        wish.disabled = false;
      }
    });
  }

  if (data.related.length) {
    const sec = document.getElementById('related-section');
    const grid = document.getElementById('related-grid');
    data.related.forEach((r) => grid.appendChild(renderProductCard(r)));
    sec.hidden = false;
  }
})();
