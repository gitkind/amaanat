'use strict';
(async () => {
  const root = document.getElementById('order');
  const id = new URLSearchParams(location.search).get('id') || '';
  const key = store.get('sessionStorage', `am_order_${id}`) || '';

  function badge(status, label) {
    return `<span class="status-badge status-badge--${escapeHtml(status)}">${escapeHtml(label || status)}</span>`;
  }

  function render(o) {
    const heading = o.paymentStatus === 'paid' ? 'Thank you — your order is confirmed'
      : o.paymentStatus === 'authorized' ? 'Payment received — confirming'
        : o.paymentStatus === 'pending' ? 'Waiting for payment confirmation' : 'Order status';
    root.innerHTML = `
      <h1>${escapeHtml(heading)}</h1>
      <p>Keep your order reference to track this order.</p>
      <div class="tracking-result">
        <h2>${escapeHtml(o.publicRef)}</h2>
        <div class="tracking-detail-row"><span class="label">Payment</span>${badge(o.paymentStatus, o.paymentStatusLabel)}</div>
        <div class="tracking-detail-row"><span class="label">Order</span>${badge(o.fulfilmentStatus, o.fulfilmentStatus.replace('_', ' '))}</div>
        <div class="tracking-detail-row"><span class="label">Placed</span><span>${escapeHtml(new Date(o.createdAt).toLocaleString('en-IN'))}</span></div>
        ${o.customer ? `<div class="tracking-detail-row"><span class="label">Email</span><span>${escapeHtml(o.customer.email)}</span></div>` : ''}
        ${o.address ? `<div class="tracking-detail-row"><span class="label">Deliver to</span><span>${escapeHtml([o.customer?.fullName, o.address.line, o.address.apartment, o.address.locality, o.address.city, o.address.state, o.address.pin].filter(Boolean).join(', '))}</span></div>` : ''}
        ${o.tracking ? `<div class="tracking-detail-row"><span class="label">Tracking</span><span>${escapeHtml(o.tracking.courier || '')} ${o.tracking.url ? `<a href="${escapeHtml(o.tracking.url)}" target="_blank" rel="noopener">${escapeHtml(o.tracking.number || 'Track')}</a>` : escapeHtml(o.tracking.number || '')}</span></div>` : ''}
        <div class="tracking-items">
          <h3>Items</h3>
          ${o.items.map((i) => `<div class="tracking-item-row"><span>${escapeHtml(i.name)} × ${i.quantity}</span><span>${formatINR(i.lineTotalPaise)}</span></div>`).join('')}
          <div class="tracking-item-row"><span>Subtotal</span><span>${formatINR(o.subtotalPaise)}</span></div>
          <div class="tracking-item-row"><span>Shipping</span><span>${o.shippingPaise === 0 ? 'Free' : formatINR(o.shippingPaise)}</span></div>
          ${o.taxPaise ? `<div class="tracking-item-row"><span>Tax</span><span>${formatINR(o.taxPaise)}</span></div>` : ''}
          <div class="tracking-item-row total"><span>Total</span><span>${formatINR(o.totalPaise)}</span></div>
        </div>
      </div>
      <p class="hero-actions"><a class="btn btn-ghost" href="/shop.html">Continue shopping</a></p>`;
  }

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    root.innerHTML = '<h1>Order not found</h1><p>Use <a href="/order-tracking.html">order tracking</a> with your reference and email.</p>';
    return;
  }

  let tries = 0;
  async function load() {
    try {
      const { order } = await API.get(`/api/orders/${encodeURIComponent(id)}`, key ? { 'X-Order-Key': key } : {});
      render(order);
      // Webhook / reconciliation may still be confirming the payment.
      if ((order.paymentStatus === 'pending' || order.paymentStatus === 'authorized') && tries++ < 20) setTimeout(load, 3000);
    } catch (e) {
      root.innerHTML = `<h1>Order not available here</h1><p>${escapeHtml(e.status === 404 ? 'This order can only be opened from the browser that placed it, or from your account.' : e.message)}</p><p><a class="btn btn-gold" href="/order-tracking.html">Track with reference and email</a></p>`;
    }
  }
  load();
})();
