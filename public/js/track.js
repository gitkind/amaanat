'use strict';
(() => {
  const form = document.getElementById('track-form');
  const out = document.getElementById('track-result');
  const row = (label, value) => `<div class="kv-row"><span class="label">${label}</span><span>${value}</span></div>`;
  const badge = (status, label) => `<span class="status-badge status-badge--${escapeHtml(status)}">${escapeHtml(label || String(status).replace(/_/g, ' '))}</span>`;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    Forms.clear(form);
    const ref = form.ref.value.trim().toUpperCase();
    const email = form.email.value.trim();
    const errors = {};
    if (!/^AM-[A-F0-9]{8}$/.test(ref)) errors.ref = 'Use the reference from your confirmation, like AM-1A2B3C4D.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter the email used at checkout.';
    if (Object.keys(errors).length) return Forms.errors(form, errors);
    const btn = form.querySelector('button');
    btn.disabled = true;
    out.innerHTML = '<div class="spinner" role="status" aria-label="Searching"></div>';
    try {
      // POST keeps the email out of URLs and logs.
      const { order: o } = await API.post('/api/orders/lookup', { ref, email });
      out.innerHTML = `
        <section class="panel" aria-labelledby="track-ref">
          <h2 id="track-ref">${escapeHtml(o.publicRef)}</h2>
          ${row('Payment', badge(o.paymentStatus, o.paymentStatusLabel))}
          ${row('Order', badge(o.fulfilmentStatus))}
          ${row('Placed', escapeHtml(new Date(o.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })))}
          ${o.tracking ? row('Courier', `${escapeHtml(o.tracking.courier || '')} ${o.tracking.url ? `<a class="text-link" href="${escapeHtml(o.tracking.url)}" target="_blank" rel="noopener">${escapeHtml(o.tracking.number || 'Track parcel')}</a>` : escapeHtml(o.tracking.number || '')}`) : ''}
          ${o.items.map((i) => row(`${escapeHtml(i.name)} × ${i.quantity}`, formatINR(i.lineTotalPaise))).join('')}
          ${row('Total', `<strong>${formatINR(o.totalPaise)}</strong>`)}
        </section>`;
      out.querySelector('h2').setAttribute('tabindex', '-1');
      out.querySelector('h2').focus();
    } catch (err) {
      notice(out, err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
})();
