'use strict';
(() => {
  const root = document.getElementById('cart');
  const ISSUE = {
    unconfirmed: 'Stock to be confirmed — remove it to continue.',
    variant_required: 'Choose an option on the product page — remove it to continue.',
    out: 'Sold out — remove it to continue.',
    inactive: 'No longer available — remove it to continue.',
    insufficient_stock: 'Fewer pieces left than in your bag — lower the quantity.',
  };

  function render(cart) {
    if (!cart.items.length) {
      root.innerHTML = '<div class="empty-state"><h2>Your bag is empty</h2><p>Pieces you add will wait here.</p><a class="btn" href="/shop">Browse the collection</a></div>';
      return;
    }
    const q = cart.quote || { ok: false };
    root.innerHTML = `
      <div class="cart-layout">
        <section aria-label="Pieces in your bag">${cart.items.map((i) => `
          <div class="cart-item" data-id="${escapeHtml(i.product.id)}" data-variant="${escapeHtml(i.variant ? i.variant.id : '')}">
            <a class="cart-item-img" href="${productUrl(i.product.slug)}"><img src="${escapeHtml(assetUrl(i.product.image))}" alt="${escapeHtml(i.product.alt || i.product.name)}" width="96" height="120"></a>
            <div>
              <h3><a href="${productUrl(i.product.slug)}" style="text-decoration:none">${escapeHtml(i.product.name)}</a></h3>
              <p class="cart-item-meta">${i.variant ? `${escapeHtml(i.variant.name)} · ` : ''}${formatINR(i.unitPricePaise)} each</p>
              ${i.issue ? `<p class="form-error" role="alert">${escapeHtml(ISSUE[i.issue] || i.issue)}</p>` : ''}
              <div class="cart-item-actions">
                <div class="qty" role="group" aria-label="Quantity of ${escapeHtml(i.product.name)}">
                  <button type="button" data-step="-1" aria-label="Decrease quantity">−</button>
                  <output aria-live="polite">${i.quantity}</output>
                  <button type="button" data-step="1" aria-label="Increase quantity" ${i.quantity >= (i.maxQuantity || 0) ? 'disabled' : ''}>+</button>
                </div>
                <button class="remove-link" type="button" data-remove>Remove</button>
              </div>
            </div>
            <p class="cart-item-total">${formatINR(i.lineTotalPaise)}</p>
          </div>`).join('')}
        </section>
        <aside class="summary" aria-labelledby="bag-summary-title">
          <h2 id="bag-summary-title">Summary</h2>
          <div class="summary-row"><span>Subtotal</span><span>${formatINR(cart.subtotalPaise)}</span></div>
          ${q.ok ? `
            <div class="summary-row"><span>Shipping</span><span>${q.shippingPaise === 0 ? 'Free' : formatINR(q.shippingPaise)}</span></div>
            ${q.taxPaise ? `<div class="summary-row"><span>Tax</span><span>${formatINR(q.taxPaise)}</span></div>` : ''}
            <div class="summary-row summary-row--total"><span>Total</span><span>${formatINR(q.totalPaise)}</span></div>
            <a class="btn" href="/checkout">Checkout</a>`
          : `<p class="notice" style="margin-top:1rem">${escapeHtml(q.message || 'Checkout is not available yet.')}</p>
            <a class="btn" aria-disabled="true" tabindex="-1">Checkout</a>`}
          <a class="btn btn--ghost" href="/shop">Keep browsing</a>
        </aside>
      </div>`;
  }

  root.addEventListener('click', async (e) => {
    const row = e.target.closest('.cart-item');
    if (!row) return;
    const id = row.dataset.id;
    const variantId = row.dataset.variant || null;
    const item = Cart.state.items.find((i) => i.product.id === id && (i.variant ? i.variant.id : null) === variantId);
    const remove = e.target.closest('[data-remove]');
    const step = e.target.closest('[data-step]');
    if (!remove && !step) return;
    row.style.opacity = '.5';
    try {
      if (remove) render(await Cart.remove(id, variantId));
      else if (item) render(await Cart.set(id, Math.max(0, item.quantity + Number(step.dataset.step)), variantId));
    } catch (err) {
      row.style.opacity = '';
      Toast.error(err.message);
    }
  });

  Cart.load().then(render);
})();
