'use strict';
(() => {
  const root = document.getElementById('cart');
  const ISSUE = {
    unconfirmed: 'Stock to be confirmed — remove to continue',
    variant_required: 'Choose an option on the product page — remove to continue',
    out: 'Sold out — remove to continue',
    inactive: 'No longer available — remove to continue',
    insufficient_stock: 'Fewer pieces left than in your bag — lower the quantity',
  };

  function render(cart) {
    if (!cart.items.length) {
      root.innerHTML = '<div class="empty-state"><h2>Your bag is empty</h2><p>Pieces you add will wait here.</p><p><a class="btn btn-gold" href="/shop.html">Browse the collection</a></p></div>';
      return;
    }
    const q = cart.quote;
    root.innerHTML = `
      <div class="cart-items">${cart.items.map((i) => `
        <div class="cart-item" data-id="${escapeHtml(i.product.id)}" data-variant="${escapeHtml(i.variant ? i.variant.id : '')}">
          <a class="cart-item-img" href="/product.html?slug=${encodeURIComponent(i.product.slug)}"><img src="${escapeHtml(assetUrl(i.product.image))}" alt="${escapeHtml(i.product.alt || i.product.name)}" /></a>
          <div class="cart-item-info">
            <h3>${escapeHtml(i.product.name)}</h3>
            ${i.variant ? `<p class="cart-item-variant">${escapeHtml(i.variant.name)}</p>` : ''}
            <p class="cart-item-unit-price">${formatINR(i.unitPricePaise)} each</p>
            ${i.issue ? `<p class="form-error">${escapeHtml(ISSUE[i.issue] || i.issue)}</p>` : ''}
            <button class="cart-item-remove" type="button" data-remove>Remove</button>
          </div>
          <div class="cart-item-qty quantity-selector">
            <button class="qty-btn" type="button" data-step="-1" aria-label="Decrease ${escapeHtml(i.product.name)}">−</button>
            <span class="qty-value">${i.quantity}</span>
            <button class="qty-btn" type="button" data-step="1" aria-label="Increase ${escapeHtml(i.product.name)}" ${i.quantity >= (i.maxQuantity || 0) ? 'disabled' : ''}>+</button>
          </div>
          <p class="cart-item-total">${formatINR(i.lineTotalPaise)}</p>
        </div>`).join('')}
      </div>
      <div class="cart-summary">
        <div class="cart-summary-row"><span>Subtotal</span><span>${formatINR(cart.subtotalPaise)}</span></div>
        ${q.ok ? `
          <div class="cart-summary-row"><span>Shipping</span><span>${q.shippingPaise === 0 ? 'Free' : formatINR(q.shippingPaise)}</span></div>
          ${q.taxPaise ? `<div class="cart-summary-row"><span>Tax</span><span>${formatINR(q.taxPaise)}</span></div>` : ''}
          <div class="cart-summary-row total"><span>Total</span><span>${formatINR(q.totalPaise)}</span></div>`
        : `<p class="notice notice--info">${escapeHtml(q.message)}</p>`}
      </div>
      <div class="cart-actions">
        <a class="btn btn-ghost" href="/shop.html">Keep browsing</a>
        <a class="btn btn-gold${q.ok ? '' : ' is-disabled'}" href="/checkout.html" ${q.ok ? '' : 'aria-disabled="true" tabindex="-1"'}>Checkout</a>
      </div>`;
  }

  root.addEventListener('click', async (e) => {
    const row = e.target.closest('.cart-item');
    if (!row) return;
    const id = row.dataset.id;
    const variantId = row.dataset.variant || null;
    const item = Cart.state.items.find((i) => i.product.id === id && (i.variant ? i.variant.id : null) === variantId);
    try {
      if (e.target.closest('[data-remove]')) render(await Cart.remove(id, variantId));
      const step = e.target.closest('[data-step]');
      if (step && item) render(await Cart.set(id, Math.max(0, item.quantity + Number(step.dataset.step)), variantId));
    } catch (err) {
      Toast.error(err.message);
    }
  });

  Cart.load().then(render);
})();
