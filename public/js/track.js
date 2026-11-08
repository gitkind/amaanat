'use strict';
(() => {
  const form = document.getElementById('track-form');
  const out = document.getElementById('track-result');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    Forms.clear(form);
    const ref = form.ref.value.trim().toUpperCase();
    const email = form.email.value.trim();
    const errors = {};
    if (!/^AM-[A-F0-9]{8}$/.test(ref)) errors.ref = 'Use the reference from your confirmation, like AM-1A2B3C4D.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter the email used at checkout.';
    if (Object.keys(errors).length) return Forms.errors(form, errors);
    out.innerHTML = '';
    try {
      // POST keeps the email out of URLs and server logs.
      const { order: o } = await API.post('/api/orders/lookup', { ref, email });
      out.innerHTML = `
        <div class="tracking-result">
          <h2>${escapeHtml(o.publicRef)}</h2>
          <div class="tracking-detail-row"><span class="label">Payment</span><span class="status-badge status-badge--${escapeHtml(o.paymentStatus)}">${escapeHtml(o.paymentStatusLabel)}</span></div>
          <div class="tracking-detail-row"><span class="label">Order</span><span class="status-badge status-badge--${escapeHtml(o.fulfilmentStatus)}">${escapeHtml(o.fulfilmentStatus.replace('_', ' '))}</span></div>
          <div class="tracking-detail-row"><span class="label">Placed</span><span>${escapeHtml(new Date(o.createdAt).toLocaleDateString('en-IN'))}</span></div>
          ${o.tracking ? `<div class="tracking-detail-row"><span class="label">Courier</span><span>${escapeHtml(o.tracking.courier || '')} ${escapeHtml(o.tracking.number || '')}</span></div>` : ''}
          <div class="tracking-items"><h3>Items</h3>
            ${o.items.map((i) => `<div class="tracking-item-row"><span>${escapeHtml(i.name)} × ${i.quantity}</span><span>${formatINR(i.lineTotalPaise)}</span></div>`).join('')}
            <div class="tracking-item-row total"><span>Total</span><span>${formatINR(o.totalPaise)}</span></div>
          </div>
        </div>`;
    } catch (err) {
      notice(out, err.message, 'error');
    }
  });
})();
