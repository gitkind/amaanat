'use strict';
(async () => {
  const form = document.getElementById('checkout-form');
  const payBtn = document.getElementById('pay-btn');
  const noticeEl = document.getElementById('checkout-notice');
  const summary = document.getElementById('summary');
  const KEY = 'am_checkout_key';
  fillStates(form.state);

  // One key per checkout attempt: repeated submits reuse it, so the server returns
  // the same reserved order instead of creating a second one.
  function checkoutKey() {
    let k = store.get('sessionStorage', KEY);
    if (!k || !/^[A-Za-z0-9_-]{32,128}$/.test(k)) {
      k = randomKey();
      store.set('sessionStorage', KEY, k);
    }
    return k;
  }
  const resetKey = () => store.remove('sessionStorage', KEY);

  function renderSummary(cart) {
    const q = cart.quote;
    summary.innerHTML = `
      <div class="summary-items">${cart.items.map((i) => `
        <div class="summary-item">
          <img src="${escapeHtml(assetUrl(i.product.image))}" alt="" width="56" height="70">
          <div>${escapeHtml(i.product.name)}${i.variant ? ` — ${escapeHtml(i.variant.name)}` : ''}<small>Qty ${i.quantity}</small></div>
          <div>${formatINR(i.lineTotalPaise)}</div>
        </div>`).join('')}</div>
      <div class="summary-row"><span>Subtotal</span><span>${formatINR(cart.subtotalPaise)}</span></div>
      ${q.ok ? `
        <div class="summary-row"><span>Shipping</span><span>${q.shippingPaise === 0 ? 'Free' : formatINR(q.shippingPaise)}</span></div>
        ${q.taxPaise ? `<div class="summary-row"><span>Tax</span><span>${formatINR(q.taxPaise)}</span></div>` : ''}
        <div class="summary-row summary-row--total"><span>Total</span><span>${formatINR(q.totalPaise)}</span></div>` : ''}
      <p class="fine-print">Prices, stock and totals are checked again on our server when you pay.</p>`;
  }

  const [settings, cart, session] = await Promise.all([
    API.get('/api/settings').catch(() => null),
    Cart.load(),
    Session.me(),
  ]);

  if (!cart.items.length) {
    summary.innerHTML = '<p>No pieces yet.</p>';
    form.hidden = true;
    noticeEl.innerHTML = '<div class="empty-state"><h2>Your bag is empty</h2><p>Add a piece to check out.</p><a class="btn" href="/shop">Browse the collection</a></div>';
    return;
  }
  renderSummary(cart);

  const blockers = settings?.checkout?.blockers || [];
  if (blockers.length || !cart.quote.ok) {
    const msgs = blockers.map((b) => b.message);
    if (!cart.quote.ok) msgs.unshift(cart.quote.message);
    noticeEl.innerHTML = `<div class="notice" role="status"><strong>Payment can't open yet.</strong><ul>${[...new Set(msgs)].map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul></div>`;
  } else {
    payBtn.disabled = false;
  }
  if (settings?.checkout?.razorpayMode === 'test') {
    document.getElementById('pay-mode').textContent = 'Razorpay TEST mode: no real money moves. Use Razorpay test cards or test UPI.';
  }

  // Prefill from the account.
  if (session.user) {
    document.getElementById('save-wrap').hidden = false;
    form.email.value = session.user.email;
    try {
      const acct = await API.get('/api/account');
      if (acct.profile.fullName) form.fullName.value = acct.profile.fullName;
      if (acct.profile.phone) form.phone.value = acct.profile.phone;
      if (acct.addresses.length) {
        const wrap = document.getElementById('saved-wrap');
        const sel = document.getElementById('saved-address');
        sel.innerHTML = '<option value="">Enter a new address</option>' + acct.addresses.map((a, i) => `<option value="${i}">${escapeHtml(a.label || a.line)}, ${escapeHtml(a.city)} ${escapeHtml(a.pin)}</option>`).join('');
        const apply = (a) => {
          if (!a) return;
          form.fullName.value = a.fullName; form.phone.value = a.phone; form.address.value = a.line;
          form.apartment.value = a.apartment || ''; form.locality.value = a.locality; form.city.value = a.city;
          form.state.value = a.state; form.pin.value = a.pin;
        };
        sel.addEventListener('change', () => apply(acct.addresses[Number(sel.value)]));
        const def = acct.addresses.findIndex((a) => a.isDefault);
        if (def >= 0) { sel.value = String(def); apply(acct.addresses[def]); }
        wrap.hidden = false;
      }
    } catch { /* prefill is optional */ }
  }

  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Razorpay Checkout could not load. Check your connection and try again.'));
      document.head.appendChild(s);
    });
  }

  function goToOrder(order, key) {
    store.set('sessionStorage', `am_order_${order.id}`, key);
    resetKey();
    location.href = `/order?id=${encodeURIComponent(order.id)}`;
  }

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    Forms.clear(form);
    busy = true;
    payBtn.disabled = true;
    payBtn.textContent = 'Reserving your pieces…';
    const key = checkoutKey();
    const customer = Forms.data(form);
    try {
      const res = await API.post('/api/checkout', {
        checkoutKey: key,
        customer,
        saveAddress: document.getElementById('saveAddress').checked,
      });
      if (res.status === 'paid') return goToOrder(res.order, key);
      await loadRazorpay();
      const r = res.razorpay;
      const rzp = new window.Razorpay({
        key: r.keyId,
        order_id: r.orderId,
        amount: r.amount,
        currency: r.currency,
        name: r.name,
        description: r.description,
        prefill: r.prefill,
        theme: { color: '#252525' },
        handler: async (resp) => {
          payBtn.textContent = 'Confirming payment…';
          try {
            await API.post('/api/payments/verify', {
              orderId: res.order.id,
              checkoutKey: key,
              razorpay_order_id: resp.razorpay_order_id,
              razorpay_payment_id: resp.razorpay_payment_id,
              razorpay_signature: resp.razorpay_signature,
            });
          } catch (err) {
            // Payment may still be confirmed by the webhook; the order page shows the truth.
            Toast.error(err.message);
          }
          goToOrder(res.order, key);
        },
        modal: {
          ondismiss: async () => {
            try {
              const c = await API.post('/api/checkout/cancel', { orderId: res.order.id, checkoutKey: key });
              if (c.status === 'paid') return goToOrder(c.order, key);
              resetKey();
              Toast.info('Payment closed. Your pieces were released back to the shop.');
            } catch (err) {
              Toast.error(err.message);
            }
            busy = false;
            payBtn.disabled = false;
            payBtn.textContent = 'Pay securely';
          },
        },
      });
      rzp.on('payment.failed', (resp) => {
        Toast.error(resp?.error?.description || 'The payment failed. You can try again in the Razorpay window.');
      });
      payBtn.textContent = 'Complete payment in the Razorpay window';
      rzp.open();
    } catch (err) {
      busy = false;
      payBtn.disabled = false;
      payBtn.textContent = 'Pay securely';
      if (err.body?.errors) Forms.errors(form, err.body.errors);
      if (err.code === 'order_not_payable') resetKey();
      notice(noticeEl, err.message, 'error');
      if (['insufficient_stock', 'inventory_unconfirmed', 'inactive_product'].includes(err.code)) {
        resetKey();
        renderSummary(await Cart.load());
      }
    }
  });
})();
