'use strict';
(() => {
  const root = document.getElementById('order');
  const id = new URLSearchParams(location.search).get('id') || '';
  const key = store.get('sessionStorage', `am_order_${id}`) || '';

  const badge = (status, label) => `<span class="status-badge status-badge--${escapeHtml(status)}">${escapeHtml(label || String(status).replace(/_/g, ' '))}</span>`;
  const row = (label, value) => `<div class="kv-row"><span class="label">${label}</span><span>${value}</span></div>`;

  function render(o) {
    const codOpen = o.paymentMethod === 'cod' && o.paymentStatus === 'pending';
    const heading = codOpen ? 'Thank you — your order is placed'
      : o.paymentStatus === 'paid' ? 'Thank you — your order is confirmed'
        : o.paymentStatus === 'authorized' ? 'Payment received — confirming'
          : o.paymentStatus === 'pending' ? 'Waiting for payment confirmation' : 'Your order';
    const sub = codOpen ? 'Please keep the exact amount ready — you pay in cash when your order arrives. Keep your order reference to track it.'
      : o.paymentStatus === 'paid' ? 'Your payment was verified. Keep your order reference to track this order.'
        : ['pending', 'authorized'].includes(o.paymentStatus) ? 'We are confirming your payment with Razorpay. This page updates automatically.'
          : 'Keep your order reference to track this order.';
    document.title = `${heading} — Amaanat`;
    root.innerHTML = `
      <header class="page-hero" style="padding-inline:0"><p class="eyebrow">Order ${escapeHtml(o.publicRef)}</p><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(sub)}</p></header>
      <section class="panel" aria-label="Order status">
        ${row('Reference', `<strong>${escapeHtml(o.publicRef)}</strong>`)}
        ${row('Payment', badge(o.paymentStatus, o.paymentStatusLabel))}
        ${row('Order', badge(o.fulfilmentStatus))}
        ${row('Placed', escapeHtml(new Date(o.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })))}
        ${o.customer ? row('Email', escapeHtml(o.customer.email)) : ''}
        ${o.address ? row('Deliver to', escapeHtml([o.customer?.fullName, o.address.line, o.address.apartment, o.address.locality, o.address.city, o.address.state, o.address.pin].filter(Boolean).join(', '))) : ''}
        ${o.tracking ? row('Tracking', `${escapeHtml(o.tracking.courier || '')} ${o.tracking.url ? `<a class="text-link" href="${escapeHtml(o.tracking.url)}" target="_blank" rel="noopener">${escapeHtml(o.tracking.number || 'Track parcel')}</a>` : escapeHtml(o.tracking.number || '')}`) : ''}
      </section>
      <section class="panel" aria-labelledby="items-title">
        <h2 id="items-title">Items</h2>
        ${o.items.map((i) => row(`${escapeHtml(i.name)} × ${i.quantity}`, formatINR(i.lineTotalPaise))).join('')}
        ${row('Subtotal', formatINR(o.subtotalPaise))}
        ${row('Shipping', o.shippingPaise === 0 ? 'Free' : formatINR(o.shippingPaise))}
        ${o.taxPaise ? row('Tax', formatINR(o.taxPaise)) : ''}
        ${row('Total', `<strong>${formatINR(o.totalPaise)}</strong>`)}
      </section>
      <a class="btn btn--ghost" href="/shop">Continue shopping</a>`;
  }

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    root.innerHTML = '<div class="empty-state"><h1 style="font-size:var(--step-3)">Order not found</h1><p>Use order tracking with your reference and email.</p><a class="btn" href="/track">Track an order</a></div>';
    return;
  }

  let tries = 0;
  async function load() {
    try {
      const { order } = await API.get(`/api/orders/${encodeURIComponent(id)}`, key ? { 'X-Order-Key': key } : {});
      render(order);
      if (order.paymentMethod !== 'cod' && (order.paymentStatus === 'pending' || order.paymentStatus === 'authorized') && tries++ < 20) setTimeout(load, 3000);
    } catch (e) {
      root.innerHTML = `<div class="empty-state"><h1 style="font-size:var(--step-3)">Order not available here</h1><p>${escapeHtml(e.status === 404 ? 'This order can only be opened from the browser that placed it, or from your account.' : e.message)}</p><a class="btn" href="/track">Track with reference and email</a></div>`;
    }
  }
  load();
})();
