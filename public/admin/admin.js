'use strict';
/* AMAANAT admin dashboard. The server enforces every permission; this UI only
   mirrors them. All values rendered from the API are escaped. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (p) => (Number.isFinite(p) ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(p / 100) : '—');
  const date = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const toRupees = (p) => (Number.isInteger(p) ? (p / 100).toFixed(2).replace(/\.00$/, '') : '');
  function toPaise(value, { allowEmpty = false } = {}) {
    const s = String(value ?? '').trim();
    if (!s && allowEmpty) return null;
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) throw new Error('Enter an amount in rupees, e.g. 499 or 499.50');
    return Math.round(Number(s) * 100);
  }
  const imgSrc = (p) => (!p ? '' : /^https?:\/\//.test(p) || p.startsWith('/') ? p : `/${p}`);

  let me = null;
  const isOwner = () => me?.role === 'owner';

  /* ── API ── */
  class ApiError extends Error {
    constructor(status, body) { super(body?.message || `Request failed (${status})`); this.status = status; this.body = body || {}; }
  }
  async function api(method, url, body, { raw, type } = {}) {
    const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (raw) { init.body = raw; init.headers['Content-Type'] = type; } else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch(url, init); } catch { throw new ApiError(0, { message: 'Network error — check your connection.' }); }
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) { showLogin(); throw new ApiError(401, json); }
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  }

  /* ── UI helpers ── */
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
  }
  const loading = () => { view.innerHTML = '<div class="state"><div class="spinner"></div>Loading…</div>'; };
  function failed(err, retry) {
    view.innerHTML = `<div class="state"><p class="error">${esc(err.message)}</p><button class="btn" type="button" id="retry">Try again</button></div>`;
    $('#retry').addEventListener('click', retry);
  }
  const empty = (msg) => `<div class="state">${esc(msg)}</div>`;
  const badge = (status) => {
    const cls = { paid: 'ok', delivered: 'ok', shipped: 'ok', confirmed: 'ok', processed: 'ok', pending: 'warn', authorized: 'warn', processing: 'warn', partially_refunded: 'warn', creating: 'warn', on_hold: 'bad', failed: 'bad', cancelled: 'bad', expired: 'bad', refunded: 'bad' }[status] || '';
    return `<span class="badge ${cls}">${esc(String(status).replace(/_/g, ' '))}</span>`;
  };
  async function withButton(btn, fn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Working…';
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
  }
  function formErrors(form, err) {
    form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
    const f = err.body?.field && form.elements[err.body.field];
    if (f) { f.classList.add('invalid'); f.focus(); }
    toast(err.message, 'bad');
  }
  const ownerNote = () => (isOwner() ? '' : '<p class="banner">Only the store owner can change these. You can view them.</p>');

  /* ── Session ── */
  function showLogin() {
    me = null;
    $('#shell').hidden = true;
    $('#login').hidden = false;
    $('#l-email').focus();
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#login-error').textContent = '';
    try {
      const r = await withButton(f.querySelector('button'), () => fetch('/api/admin/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: f.email.value, password: f.password.value }),
      }).then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) })));
      if (!r.ok) { $('#login-error').textContent = r.body.message || 'Sign-in failed.'; return; }
      f.password.value = '';
      await start();
    } catch {
      $('#login-error').textContent = 'Network error.';
    }
  });
  $('#logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    showLogin();
  });
  $('#menu').addEventListener('click', () => {
    const open = $('#side').classList.toggle('open');
    $('#menu').setAttribute('aria-expanded', String(open));
  });

  async function start() {
    try {
      me = (await api('GET', '/api/admin/me')).admin;
    } catch (err) {
      if (err.status === 403) { $('#login-error').textContent = err.message; showLogin(); }
      return;
    }
    $('#login').hidden = true;
    $('#shell').hidden = false;
    $('#who').textContent = `${me.email} · ${me.role}`;
    document.querySelectorAll('[data-owner]').forEach((el) => { el.hidden = !isOwner(); });
    route();
  }

  /* ── Router ── */
  const routes = [
    [/^#\/overview$/, overview, 'Overview'],
    [/^#\/orders$/, orders, 'Orders'],
    [/^#\/orders\/([0-9a-f-]{36})$/, orderDetail, 'Order'],
    [/^#\/products$/, products, 'Products'],
    [/^#\/products\/new$/, () => productEdit(null), 'New product'],
    [/^#\/products\/([A-Za-z0-9_-]+)$/, productEdit, 'Product'],
    [/^#\/inventory$/, inventory, 'Inventory'],
    [/^#\/customers$/, customers, 'Customers'],
    [/^#\/settings$/, settings, 'Settings'],
    [/^#\/pages$/, pages, 'Pages'],
    [/^#\/audit$/, audit, 'Audit log'],
  ];
  function route() {
    if (!me) return;
    const hash = location.hash || '#/overview';
    const match = routes.find(([re]) => re.test(hash.split('?')[0]));
    if (!match) { location.hash = '#/overview'; return; }
    const [re, fn, title] = match;
    const section = hash.split('/')[1]?.split('?')[0];
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
    $('#top-title').textContent = title;
    document.title = `${title} — Amaanat admin`;
    $('#side').classList.remove('open');
    const args = re.exec(hash.split('?')[0]).slice(1);
    loading();
    Promise.resolve(fn(...args)).catch((err) => { if (err.status !== 401) failed(err, route); });
    view.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', route);
  const query = () => new URLSearchParams((location.hash.split('?')[1]) || '');

  /* ── Overview ── */
  async function overview() {
    const o = await api('GET', '/api/admin/overview');
    const setup = [];
    if (!o.setup.payments && !o.setup.codEnabled) setup.push('No payment method is on — turn on Cash on Delivery in Settings (or add Razorpay keys) before customers can order.');
    if (!o.setup.shippingConfirmed) setup.push('Shipping charge is not confirmed — checkout stays closed. Set it in Settings.');
    if (o.products.stockUnconfirmed) setup.push(`${o.products.stockUnconfirmed} active product(s) have unconfirmed stock and can't be bought. Count them in Inventory.`);
    if (!o.setup.storage) setup.push('Image storage is not configured — uploads are disabled.');
    view.innerHTML = `
      <div class="head"><h1>Overview</h1></div>
      ${setup.length ? `<div class="banner"><b>Before customers can buy:</b><ul>${setup.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
      ${o.orders.needsReview ? `<div class="banner bad">${o.orders.needsReview} order(s) need review. <a href="#/orders?review=1">Open them</a></div>` : ''}
      <div class="grid kpis">
        <div class="kpi"><b>${inr(o.revenue.netPaise)}</b><span>Net paid revenue (verified payments − refunds)</span></div>
        <div class="kpi"><b>${o.orders.paid}</b><span>Paid orders</span></div>
        <div class="kpi"><b>${o.orders.toFulfil}</b><span>To fulfil</span></div>
        <div class="kpi"><b>${o.orders.awaitingPayment}</b><span>Awaiting online payment</span></div>
        <div class="kpi"><b>${o.orders.codToCollect}</b><span>Cash on delivery to collect</span></div>
        <div class="kpi"><b>${o.orders.total}</b><span>All orders</span></div>
        <div class="kpi"><b>${o.products.active}</b><span>Active products (${o.products.archived} archived)</span></div>
      </div>
      <div class="grid two" style="margin-top:1.25rem">
        <section class="card"><h2>Recent orders</h2>
          ${o.recentOrders.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Order</th><th>Customer</th><th>Payment</th><th class="num">Total</th></tr></thead><tbody>
            ${o.recentOrders.map((r) => `<tr class="clickable" data-href="#/orders/${esc(r.id)}"><td data-label="Order"><a href="#/orders/${esc(r.id)}">${esc(r.publicRef)}</a><br><small>${date(r.createdAt)}</small></td><td data-label="Customer">${esc(r.customer)}</td><td data-label="Payment">${badge(r.paymentStatus)}</td><td class="num" data-label="Total">${inr(r.totalPaise)}</td></tr>`).join('')}
          </tbody></table></div>` : empty('No orders yet.')}
        </section>
        <section class="card"><h2>Low stock</h2>
          ${o.lowStockThreshold === null ? '<p class="hint">Set a low-stock threshold in Settings to see alerts.</p>'
            : o.lowStock.length ? `<ul>${o.lowStock.map((u) => `<li>${esc(u.name)} — <b>${u.stock}</b> left</li>`).join('')}</ul><a class="btn small" href="#/inventory">Open inventory</a>`
            : `<p class="hint">Nothing at or below ${o.lowStockThreshold} pieces.</p>`}
        </section>
      </div>`;
    view.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.tagName !== 'A') location.hash = tr.dataset.href; }));
  }

  /* ── Orders ── */
  async function orders() {
    const q = query();
    const limit = 25;
    const offset = Number(q.get('offset') || 0);
    const r = await api('GET', `/api/admin/orders?${q.toString()}&limit=${limit}`);
    const opt = (vals, cur) => vals.map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v ? v.replace(/_/g, ' ') : 'Any'}</option>`).join('');
    view.innerHTML = `
      <div class="head"><h1>Orders</h1><span class="hint">${r.total} found</span></div>
      <form class="card row" id="filters" role="search">
        <div class="field"><label for="f-q">Search</label><input id="f-q" name="q" value="${esc(q.get('q') || '')}" placeholder="Reference, name, email or phone" /></div>
        <div class="field"><label for="f-p">Payment</label><select id="f-p" name="payment">${opt(['', 'pending', 'authorized', 'paid', 'partially_refunded', 'refunded', 'cancelled', 'expired', 'failed'], q.get('payment') || '')}</select></div>
        <div class="field"><label for="f-f">Fulfilment</label><select id="f-f" name="fulfilment">${opt(['', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'on_hold', 'cancelled', 'refunded'], q.get('fulfilment') || '')}</select></div>
        <div class="field"><label for="f-m">Method</label><select id="f-m" name="method">${['', 'cod', 'razorpay'].map((v) => `<option value="${v}" ${v === (q.get('method') || '') ? 'selected' : ''}>${v === 'cod' ? 'Cash on delivery' : v === 'razorpay' ? 'Online (Razorpay)' : 'Any'}</option>`).join('')}</select></div>
        <label class="check"><input type="checkbox" name="review" value="1" ${q.get('review') === '1' ? 'checked' : ''}/> Needs review</label>
        <button class="btn primary" type="submit">Filter</button>
      </form>
      ${r.orders.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Payment</th><th>Fulfilment</th><th class="num">Total</th></tr></thead><tbody>
        ${r.orders.map((o) => `<tr class="clickable" data-href="#/orders/${esc(o.id)}">
          <td data-label="Order"><a href="#/orders/${esc(o.id)}">${esc(o.publicRef)}</a> ${o.needsReview ? '<span class="badge bad">review</span>' : ''}<br><small>${date(o.createdAt)}</small></td>
          <td data-label="Customer">${esc(o.customer)}<br><small>${esc(o.email)}</small></td>
          <td data-label="Items">${o.itemCount}</td><td data-label="Payment">${o.paymentMethod === 'cod' ? '<span class="badge">COD</span> ' : ''}${badge(o.paymentStatus)}</td>
          <td data-label="Fulfilment">${badge(o.fulfilmentStatus)}</td><td class="num" data-label="Total">${inr(o.totalPaise)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="pager">${offset > 0 ? '<button class="btn small" id="prev" type="button">← Newer</button>' : ''}${offset + limit < r.total ? '<button class="btn small" id="next" type="button">Older →</button>' : ''}</div>`
      : empty('No orders match these filters.')}`;
    const go = (o) => { const p = new URLSearchParams(new FormData($('#filters'))); if (o) p.set('offset', o); location.hash = `#/orders?${p}`; };
    $('#filters').addEventListener('submit', (e) => { e.preventDefault(); go(0); });
    $('#prev')?.addEventListener('click', () => go(Math.max(0, offset - limit)));
    $('#next')?.addEventListener('click', () => go(offset + limit));
    view.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.tagName !== 'A') location.hash = tr.dataset.href; }));
  }

  const NEXT_FULFILMENT = { pending: ['confirmed'], confirmed: ['processing', 'shipped', 'on_hold'], processing: ['shipped', 'on_hold', 'confirmed'], on_hold: ['confirmed', 'processing'], shipped: ['delivered'] };

  async function orderDetail(id) {
    const { order: o } = await api('GET', `/api/admin/orders/${id}`);
    const paid = ['paid', 'partially_refunded'].includes(o.paymentStatus);
    const cod = o.paymentMethod === 'cod';
    const codOpen = cod && o.paymentStatus === 'pending';
    const shippedOut = ['shipped', 'delivered'].includes(o.fulfilmentStatus);
    const next = paid || codOpen ? NEXT_FULFILMENT[o.fulfilmentStatus] || [] : [];
    const refundable = o.totalPaise - o.refunds.filter((r) => ['pending', 'processed', 'creating'].includes(r.status)).reduce((s, r) => s + r.amountPaise, 0);
    const a = o.address || {};
    view.innerHTML = `
      <div class="head"><h1>Order ${esc(o.publicRef)}</h1><a class="btn" href="#/orders">← All orders</a></div>
      ${o.needsReview ? `<div class="banner bad"><b>Needs review:</b> ${esc(o.reviewReason || '')}
        <form class="row" id="resolve" style="margin-top:.5rem"><div class="field"><label for="r-note">Resolution note</label><input id="r-note" name="note" required minlength="3" maxlength="300" /></div><button class="btn" type="submit">Mark resolved</button></form></div>` : ''}
      <div class="grid two">
        <section class="card"><h2>Status</h2>
          <dl class="kv"><dt>Method</dt><dd>${cod ? 'Cash on delivery' : 'Online (Razorpay)'}</dd><dt>Payment</dt><dd>${badge(o.paymentStatus)}</dd><dt>Fulfilment</dt><dd>${badge(o.fulfilmentStatus)}</dd>
          <dt>Placed</dt><dd>${date(o.createdAt)}</dd><dt>Paid</dt><dd>${date(o.paidAt)}</dd>
          <dt>Total</dt><dd>${inr(o.totalPaise)}</dd><dt>Refunded</dt><dd>${inr(o.refundedPaise)}</dd>
          ${cod ? '' : `<dt>Razorpay order</dt><dd>${esc(o.razorpayOrderId || '—')}</dd><dt>Razorpay payment</dt><dd>${esc(o.razorpayPaymentId || '—')}</dd>`}</dl>
          <div class="actions" style="margin-top:1rem">
            ${!cod && ['pending', 'authorized'].includes(o.paymentStatus) ? '<button class="btn" id="reconcile" type="button">Check payment with Razorpay</button>' : ''}
            ${o.paymentStatus === 'pending' && !(cod && shippedOut) ? `<button class="btn danger" id="cancel" type="button">${cod ? 'Cancel order' : 'Cancel unpaid order'}</button>` : ''}
          </div>
          ${codOpen && o.fulfilmentStatus === 'delivered' && isOwner() ? `<form class="row" id="codpaid" style="margin-top:1rem">
            <div class="field"><label for="cod-note">Cash received — note (e.g. courier remittance ref)</label><input id="cod-note" name="note" required minlength="3" maxlength="300" /></div>
            <button class="btn primary" type="submit">Record ${inr(o.totalPaise)} received</button></form>` : ''}
          <p class="hint">${cod ? 'Cash on delivery: confirm, pack and ship the order, then record the cash once it is collected. Orders can be cancelled (stock returned) only before shipping.'
            : 'Payment status only changes from verified Razorpay evidence (checkout signature, webhook or this check).'}</p>
        </section>
        <section class="card"><h2>Customer &amp; delivery</h2>
          <dl class="kv"><dt>Name</dt><dd>${esc(o.customer?.fullName)}</dd><dt>Email</dt><dd>${esc(o.customer?.email)}</dd><dt>Phone</dt><dd>${esc(o.customer?.phone)}</dd>
          <dt>Address</dt><dd>${esc([a.line, a.apartment, a.locality, a.city, a.state, a.pin].filter(Boolean).join(', '))}</dd>
          ${o.notes ? `<dt>Note</dt><dd>${esc(o.notes)}</dd>` : ''}</dl>
        </section>
      </div>
      <section class="card"><h2>Items</h2><div class="table-wrap"><table class="stack"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead><tbody>
        ${o.items.map((i) => `<tr><td data-label="Item">${esc(i.name)}</td><td class="num" data-label="Qty">${i.quantity}</td><td class="num" data-label="Price">${inr(i.unitPricePaise)}</td><td class="num" data-label="Total">${inr(i.lineTotalPaise)}</td></tr>`).join('')}
        <tr><td data-label="">Subtotal / shipping / tax</td><td></td><td></td><td class="num" data-label="">${inr(o.subtotalPaise)} / ${inr(o.shippingPaise)} / ${inr(o.taxPaise)}</td></tr>
      </tbody></table></div></section>
      <div class="grid two">
        <section class="card"><h2>Fulfilment</h2>
          ${next.length || o.fulfilmentStatus === 'shipped' ? `<form id="fulfil">
            <div class="field"><label for="fs">Status</label><select id="fs" name="status">${[o.fulfilmentStatus, ...next].map((s) => `<option value="${s}">${s.replace(/_/g, ' ')}${s === o.fulfilmentStatus ? ' (current)' : ''}</option>`).join('')}</select></div>
            <div class="row"><div class="field"><label for="tc">Courier</label><input id="tc" name="courier" maxlength="80" value="${esc(o.tracking?.courier || '')}" /></div>
            <div class="field"><label for="tn">Tracking number</label><input id="tn" name="trackingNumber" maxlength="80" value="${esc(o.tracking?.number || '')}" /></div></div>
            <div class="field"><label for="tu">Tracking link (https)</label><input id="tu" name="trackingUrl" type="url" maxlength="500" value="${esc(o.tracking?.url || '')}" /></div>
            <div class="field"><label for="tnote">Internal note (optional)</label><input id="tnote" name="note" maxlength="300" /></div>
            <button class="btn primary" type="submit">Save fulfilment</button></form>`
            : `<p class="hint">${paid || codOpen ? 'No further fulfilment steps.' : 'Fulfilment opens once the payment is verified.'}</p>`}
        </section>
        <section class="card"><h2>Refunds</h2>
          ${o.refunds.length ? `<ul>${o.refunds.map((r) => `<li>${inr(r.amountPaise)} ${badge(r.status)} — ${esc(r.reason || '')} <small>${esc(r.by || 'Razorpay')} · ${date(r.createdAt)}${r.error ? ` · ${esc(r.error)}` : ''}</small></li>`).join('')}</ul>` : '<p class="hint">No refunds.</p>'}
          ${paid && isOwner() ? `<form id="refund">
            <div class="row"><div class="field"><label for="ra">Amount (₹)</label><input id="ra" name="amount" inputmode="decimal" value="${toRupees(refundable)}" required /></div>
            <div class="field"><label for="rr">Reason</label><input id="rr" name="reason" required minlength="3" maxlength="300" /></div></div>
            ${!['shipped', 'delivered'].includes(o.fulfilmentStatus) && o.refundedPaise === 0 ? '<label class="check"><input type="checkbox" name="restock" checked /> Full refund: cancel the order and return items to stock</label>' : ''}
            <button class="btn danger" type="submit">Refund via Razorpay</button>
            <p class="hint">Up to ${inr(refundable)} can be refunded. The money goes back through Razorpay; the order updates when Razorpay confirms.</p></form>`
            : paid ? '<p class="hint">Only the owner can issue refunds.</p>' : ''}
        </section>
      </div>
      <div class="grid two">
        <section class="card"><h2>Payment events</h2>${o.payments.length ? `<ul>${o.payments.map((p) => `<li>${badge(p.status)} ${inr(p.amountPaise)} <small>${esc(p.source || '')} · ${esc(p.paymentId || '')} · ${date(p.createdAt)}</small></li>`).join('')}</ul>` : '<p class="hint">None yet.</p>'}</section>
        <section class="card"><h2>History</h2>${o.history.length ? `<ul>${o.history.map((h) => `<li>${esc(h.action)} <small>${esc(h.by || '')} · ${date(h.at)}</small></li>`).join('')}</ul>` : '<p class="hint">No admin actions yet.</p>'}</section>
      </div>`;

    const reload = () => orderDetail(id);
    $('#reconcile')?.addEventListener('click', (e) => withButton(e.target, async () => {
      try { const r = await api('POST', `/api/admin/orders/${id}/reconcile`, {}); toast(`Razorpay says: ${r.result}`, r.result === 'paid' ? 'ok' : ''); reload(); } catch (err) { toast(err.message, 'bad'); }
    }));
    $('#cancel')?.addEventListener('click', (e) => {
      if (!confirm(cod ? 'Cancel this Cash on Delivery order and return its items to stock?' : 'Cancel this unpaid order and return its items to stock? Razorpay is checked first.')) return;
      withButton(e.target, async () => { try { await api('POST', `/api/admin/orders/${id}/cancel`, {}); toast('Order cancelled', 'ok'); reload(); } catch (err) { toast(err.message, 'bad'); } });
    });
    $('#codpaid')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!confirm(`Record ${inr(o.totalPaise)} as received in cash for ${o.publicRef}? This marks the order paid.`)) return;
      try { await api('POST', `/api/admin/orders/${id}/cod-collected`, { note: e.target.note.value }); toast('Cash recorded', 'ok'); reload(); } catch (err) { formErrors(e.target, err); }
    });
    $('#resolve')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('POST', `/api/admin/orders/${id}/resolve`, { note: e.target.note.value }); toast('Marked resolved', 'ok'); reload(); } catch (err) { formErrors(e.target, err); }
    });
    $('#fulfil')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await withButton(f.querySelector('button'), () => api('POST', `/api/admin/orders/${id}/fulfilment`, { status: f.status.value, courier: f.courier.value, trackingNumber: f.trackingNumber.value, trackingUrl: f.trackingUrl.value, note: f.note.value }));
        toast('Fulfilment saved', 'ok'); reload();
      } catch (err) { formErrors(f, err); }
    });
    $('#refund')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      let amountPaise;
      try { amountPaise = toPaise(f.amount.value); } catch (err) { toast(err.message, 'bad'); return; }
      if (!confirm(`Refund ${inr(amountPaise)} to the customer through Razorpay? This cannot be undone.`)) return;
      try {
        const r = await withButton(f.querySelector('button'), () => api('POST', `/api/admin/orders/${id}/refund`, { amountPaise, reason: f.reason.value, restock: f.restock?.checked === true }));
        toast(r.status === 'processed' ? 'Refund processed' : r.message || `Refund ${r.status}`, 'ok'); reload();
      } catch (err) { formErrors(f, err); }
    });
  }

  /* ── Products ── */
  async function products() {
    const { products: list } = await api('GET', '/api/admin/products');
    const q = (query().get('q') || '').toLowerCase();
    const shown = list.filter((p) => !q || `${p.name} ${p.category} ${p.slug}`.toLowerCase().includes(q));
    const stock = (p) => {
      const vs = p.variants.filter((v) => v.active);
      if (vs.length) return `${vs.length} option(s)`;
      return p.inventoryConfirmed ? `${p.stockQuantity} in stock` : '<span class="badge warn">unconfirmed</span>';
    };
    view.innerHTML = `
      <div class="head"><h1>Products</h1><a class="btn primary" href="#/products/new">New product</a></div>
      <form class="card row" id="psearch" role="search"><div class="field"><label for="pq">Search</label><input id="pq" name="q" value="${esc(q)}" /></div><button class="btn" type="submit">Search</button></form>
      ${shown.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th></th><th>Product</th><th>Category</th><th class="num">Price</th><th>Stock</th><th>Status</th></tr></thead><tbody>
        ${shown.map((p) => `<tr class="clickable" data-href="#/products/${esc(p.id)}">
          <td data-label="">${p.image ? `<img class="thumb" src="${esc(imgSrc(p.image))}" alt="" loading="lazy" />` : ''}</td>
          <td data-label="Product"><a href="#/products/${esc(p.id)}">${esc(p.name)}</a> ${p.featured ? '<span class="badge ok">featured</span>' : ''}<br><small>/${esc(p.slug)}</small></td>
          <td data-label="Category">${esc(p.category)}</td><td class="num" data-label="Price">${inr(p.pricePaise)}</td>
          <td data-label="Stock">${stock(p)}</td><td data-label="Status">${p.active ? '<span class="badge ok">active</span>' : '<span class="badge">archived</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : empty(q ? 'No products match.' : 'No products yet.')}`;
    $('#psearch').addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/products?q=${encodeURIComponent(e.target.q.value)}`; });
    view.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.tagName !== 'A') location.hash = tr.dataset.href; }));
  }

  const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);

  async function productEdit(id) {
    const [{ products: all }] = await Promise.all([api('GET', '/api/admin/products')]);
    const p = id ? all.find((x) => x.id === id) : null;
    if (id && !p) throw new Error('Product not found.');
    const categories = [...new Set(all.map((x) => x.category))].sort();
    view.innerHTML = `
      <div class="head"><h1>${p ? esc(p.name) : 'New product'}</h1><a class="btn" href="#/products">← All products</a></div>
      ${p && !p.active ? '<div class="banner">This product is archived and hidden from the store.</div>' : ''}
      <form class="card" id="pform" novalidate>
        <div class="row"><div class="field"><label for="pn">Name</label><input id="pn" name="name" required maxlength="120" value="${esc(p?.name)}" /></div>
        <div class="field"><label for="ps">URL slug</label><input id="ps" name="slug" required maxlength="120" value="${esc(p?.slug)}" pattern="[a-z0-9]+(-[a-z0-9]+)*" /></div></div>
        <div class="field"><label for="pd">Description</label><textarea id="pd" name="description" required maxlength="2000">${esc(p?.description)}</textarea></div>
        <div class="row"><div class="field"><label for="pc">Category</label><input id="pc" name="category" required maxlength="60" list="cats" value="${esc(p?.category)}" /><datalist id="cats">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
        <div class="field"><label for="pp">Price (₹)</label><input id="pp" name="price" inputmode="decimal" required value="${toRupees(p?.pricePaise)}" /></div></div>
        <div class="field"><label for="pa">Image description (alt text)</label><input id="pa" name="alt" maxlength="300" value="${esc(p?.alt)}" /><p class="hint">Describe the photo for people using screen readers.</p></div>
        <label class="check"><input type="checkbox" name="featured" ${p?.featured ? 'checked' : ''} /> Featured on the homepage</label>
        <div class="actions"><button class="btn primary" type="submit">${p ? 'Save changes' : 'Create product'}</button>
          ${p ? (p.active ? '<button class="btn" type="button" id="archive">Archive</button>' : '<button class="btn" type="button" id="restore">Restore</button>') : ''}
          ${p && isOwner() && !p.hasOrders ? '<button class="btn danger" type="button" id="delete">Delete permanently</button>' : ''}</div>
        ${p ? '<p class="hint">New products start with unconfirmed stock. Count stock in Inventory before they can be bought.</p>' : ''}
      </form>
      ${p ? `
      <section class="card"><h2>Images</h2>
        ${p.images.length ? `<div class="images">${p.images.map((src, i) => `<figure class="image ${i === 0 ? 'primary-img' : ''}"><img src="${esc(imgSrc(src))}" alt="Image ${i + 1}" />
          <div class="actions">${i ? `<button class="btn small" type="button" data-move="${i}" data-dir="-1" aria-label="Move earlier">←</button><button class="btn small" type="button" data-primary="${i}">Main</button>` : '<span class="badge ok">main</span>'}
          ${i < p.images.length - 1 ? `<button class="btn small" type="button" data-move="${i}" data-dir="1" aria-label="Move later">→</button>` : ''}
          <button class="btn small danger" type="button" data-remove="${i}">Remove</button></div></figure>`).join('')}</div>` : empty('No images yet.')}
        <div class="field" style="margin-top:1rem"><label for="upload">Add images (JPEG, PNG or WebP, up to 4 MB each, max 10)</label>
          <input id="upload" type="file" accept="image/jpeg,image/png,image/webp" multiple ${p.images.length >= 10 ? 'disabled' : ''} /></div>
        <p class="hint">To replace an image, add the new one, make it main if needed, then remove the old one.</p>
      </section>
      <section class="card"><h2>Options (variants)</h2>
        <p class="hint">Use options for sizes or finishes. When a product has active options, each option has its own stock (set in Inventory) and customers must choose one. Leave price empty to use the product price.</p>
        ${p.variants.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Name</th><th>SKU</th><th>Price (₹)</th><th>Order</th><th>Active</th><th></th></tr></thead><tbody>
          ${p.variants.map((v) => `<tr data-variant="${esc(v.id)}"><td data-label="Name"><input name="name" value="${esc(v.name)}" maxlength="80" aria-label="Option name" /></td>
            <td data-label="SKU"><input name="sku" value="${esc(v.sku || '')}" maxlength="60" aria-label="SKU" /></td>
            <td data-label="Price"><input name="price" value="${toRupees(v.pricePaise)}" inputmode="decimal" placeholder="${toRupees(p.pricePaise)}" aria-label="Option price" /></td>
            <td data-label="Order"><input name="position" type="number" min="0" max="999" value="${v.position}" aria-label="Display order" style="width:5rem" /></td>
            <td data-label="Active"><input type="checkbox" name="active" ${v.active ? 'checked' : ''} aria-label="Active" /></td>
            <td data-label=""><div class="actions"><button class="btn small" type="button" data-vsave>Save</button><button class="btn small danger" type="button" data-vdel>Remove</button></div></td></tr>`).join('')}
        </tbody></table></div>` : ''}
        <form class="row" id="vform" style="margin-top:1rem"><div class="field"><label for="vn">New option name</label><input id="vn" name="name" required maxlength="80" placeholder="e.g. 18 inch" /></div>
          <div class="field"><label for="vp">Price (₹, optional)</label><input id="vp" name="price" inputmode="decimal" /></div><button class="btn" type="submit">Add option</button></form>
      </section>` : ''}`;

    const form = $('#pform');
    if (!p) form.name.addEventListener('input', () => { if (!form.slug.dataset.touched) form.slug.value = slugify(form.name.value); });
    form.slug.addEventListener('input', () => { form.slug.dataset.touched = '1'; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let pricePaise;
      try { pricePaise = toPaise(form.price.value); } catch (err) { form.price.classList.add('invalid'); toast(err.message, 'bad'); return; }
      const body = { name: form.name.value, slug: form.slug.value, description: form.description.value, category: form.category.value, pricePaise, alt: form.alt.value, featured: form.featured.checked };
      try {
        const r = await withButton(form.querySelector('[type=submit]'), () => (p ? api('PUT', `/api/admin/products/${p.id}`, body) : api('POST', '/api/admin/products', body)));
        toast(p ? 'Saved' : 'Product created', 'ok');
        if (p) productEdit(p.id); else location.hash = `#/products/${r.product.id}`;
      } catch (err) { formErrors(form, err); }
    });
    if (!p) return;
    const reload = () => productEdit(p.id);
    $('#archive')?.addEventListener('click', async () => { if (confirm('Archive this product? It will be hidden from the store; orders are kept.')) { try { await api('POST', `/api/admin/products/${p.id}/archive`, {}); toast('Archived', 'ok'); reload(); } catch (err) { toast(err.message, 'bad'); } } });
    $('#restore')?.addEventListener('click', async () => { try { await api('POST', `/api/admin/products/${p.id}/restore`, {}); toast('Restored', 'ok'); reload(); } catch (err) { toast(err.message, 'bad'); } });
    $('#delete')?.addEventListener('click', async () => { if (confirm('Permanently delete this product and its uploaded images? This cannot be undone.')) { try { await api('DELETE', `/api/admin/products/${p.id}`); toast('Deleted', 'ok'); location.hash = '#/products'; } catch (err) { toast(err.message, 'bad'); } } });

    view.querySelectorAll('[data-move],[data-primary]').forEach((b) => b.addEventListener('click', async () => {
      const imgs = [...p.images];
      const i = Number(b.dataset.move ?? b.dataset.primary);
      const j = b.dataset.primary !== undefined ? 0 : i + Number(b.dataset.dir);
      const [it] = imgs.splice(i, 1); imgs.splice(j, 0, it);
      try { await api('PUT', `/api/admin/products/${p.id}/images`, { images: imgs }); reload(); } catch (err) { toast(err.message, 'bad'); }
    }));
    view.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remove this image?')) return;
      try { await api('DELETE', `/api/admin/products/${p.id}/images?url=${encodeURIComponent(p.images[Number(b.dataset.remove)])}`); toast('Image removed', 'ok'); reload(); } catch (err) { toast(err.message, 'bad'); }
    }));
    $('#upload')?.addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.disabled = true;
      let done = 0;
      for (const file of files) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { toast(`${file.name}: use JPEG, PNG or WebP`, 'bad'); continue; }
        if (file.size > 4 * 1024 * 1024) { toast(`${file.name}: larger than 4 MB`, 'bad'); continue; }
        try { await api('POST', `/api/admin/products/${p.id}/images`, undefined, { raw: file, type: file.type }); done++; } catch (err) { toast(`${file.name}: ${err.message}`, 'bad'); }
      }
      if (done) toast(`${done} image(s) uploaded`, 'ok');
      reload();
    });
    view.querySelectorAll('tr[data-variant]').forEach((tr) => {
      const vid = tr.dataset.variant;
      tr.querySelector('[data-vsave]').addEventListener('click', async (e) => {
        let pricePaise;
        try { pricePaise = toPaise(tr.querySelector('[name=price]').value, { allowEmpty: true }); } catch (err) { toast(err.message, 'bad'); return; }
        try {
          await withButton(e.target, () => api('PUT', `/api/admin/products/${p.id}/variants/${vid}`, { name: tr.querySelector('[name=name]').value, sku: tr.querySelector('[name=sku]').value, pricePaise, position: Number(tr.querySelector('[name=position]').value || 0), active: tr.querySelector('[name=active]').checked }));
          toast('Option saved', 'ok');
        } catch (err) { toast(err.message, 'bad'); }
      });
      tr.querySelector('[data-vdel]').addEventListener('click', async () => {
        if (!confirm('Remove this option? Options with orders are archived instead.')) return;
        try { const r = await api('DELETE', `/api/admin/products/${p.id}/variants/${vid}`); toast(r.archived ? 'Option archived (it has orders)' : 'Option removed', 'ok'); reload(); } catch (err) { toast(err.message, 'bad'); }
      });
    });
    $('#vform').addEventListener('submit', async (e) => {
      e.preventDefault();
      let pricePaise;
      try { pricePaise = toPaise(e.target.price.value, { allowEmpty: true }); } catch (err) { toast(err.message, 'bad'); return; }
      try { await api('POST', `/api/admin/products/${p.id}/variants`, { name: e.target.name.value, pricePaise, position: p.variants.length }); toast('Option added — set its stock in Inventory', 'ok'); reload(); } catch (err) { formErrors(e.target, err); }
    });
  }

  /* ── Inventory ── */
  async function inventory() {
    const pid = query().get('product') || '';
    const [inv, mv] = await Promise.all([api('GET', '/api/admin/inventory'), api('GET', `/api/admin/inventory/movements${pid ? `?productId=${encodeURIComponent(pid)}` : ''}`)]);
    view.innerHTML = `
      <div class="head"><h1>Inventory</h1><span class="hint">${inv.lowStockThreshold === null ? 'No low-stock threshold set' : `Low stock: ≤ ${inv.lowStockThreshold}`}</span></div>
      <p class="hint">“Set count” records what you physically counted and confirms the stock. “Adjust” adds or removes pieces. Every change needs a reason and is logged. Reserved = held by checkouts awaiting payment.</p>
      ${inv.units.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Reserved</th><th>Status</th><th>Change stock</th></tr></thead><tbody>
        ${inv.units.map((u, i) => `<tr><td data-label="Item"><a href="#/products/${esc(u.productId)}">${esc(u.productName)}</a>${u.variantName ? ` — ${esc(u.variantName)}` : ''}${u.active ? '' : ' <span class="badge">archived</span>'}</td>
          <td class="num" data-label="On hand">${u.stock ?? '—'}</td><td class="num" data-label="Reserved">${u.reserved}</td>
          <td data-label="Status">${u.confirmed ? (u.low ? '<span class="badge bad">low</span>' : u.stock === 0 ? '<span class="badge bad">sold out</span>' : '<span class="badge ok">confirmed</span>') : '<span class="badge warn">unconfirmed</span>'}</td>
          <td data-label="Change"><form class="row" data-adjust="${i}" style="flex-wrap:nowrap;gap:.35rem">
            <select name="mode" aria-label="Mode"><option value="set">Set count</option>${u.confirmed ? '<option value="delta">Adjust ±</option>' : ''}</select>
            <input name="quantity" type="number" step="1" required aria-label="Quantity" style="width:5.5rem" />
            <input name="reason" required minlength="3" maxlength="200" placeholder="Reason" aria-label="Reason" style="min-width:8rem" />
            <button class="btn small primary" type="submit">Save</button></form></td></tr>`).join('')}
      </tbody></table></div>` : empty('No products.')}
      <section class="card" style="margin-top:1.25rem"><div class="head"><h2>Movement history</h2>
        <select id="mvp" aria-label="Filter by product"><option value="">All products</option>${[...new Map(inv.units.map((u) => [u.productId, u.productName])).entries()].map(([id, n]) => `<option value="${esc(id)}" ${id === pid ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
        ${mv.movements.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>When</th><th>Item</th><th class="num">Change</th><th class="num">Now</th><th>Reason</th><th>By</th></tr></thead><tbody>
          ${mv.movements.map((m) => `<tr><td data-label="When">${date(m.created_at)}</td><td data-label="Item">${esc(m.product_name)}${m.variant_name ? ` — ${esc(m.variant_name)}` : ''}</td>
            <td class="num" data-label="Change">${m.delta > 0 ? '+' : ''}${m.delta}</td><td class="num" data-label="Now">${m.new_quantity}</td>
            <td data-label="Reason">${esc(m.reason)}${m.order_ref ? ` <a href="#/orders?q=${esc(m.order_ref)}">${esc(m.order_ref)}</a>` : ''}</td><td data-label="By">${esc(m.actor_email || (m.order_id ? 'checkout' : ''))}</td></tr>`).join('')}
        </tbody></table></div>` : empty('No stock movements yet.')}
      </section>`;
    view.querySelectorAll('[data-adjust]').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = inv.units[Number(f.dataset.adjust)];
      try {
        const r = await withButton(f.querySelector('button'), () => api('POST', '/api/admin/inventory/adjust', { productId: u.productId, variantId: u.variantId, mode: f.mode.value, quantity: Number(f.quantity.value), reason: f.reason.value }));
        toast(`Stock now ${r.result.stock_quantity}`, 'ok'); inventory();
      } catch (err) { formErrors(f, err); }
    }));
    $('#mvp').addEventListener('change', (e) => { location.hash = `#/inventory${e.target.value ? `?product=${encodeURIComponent(e.target.value)}` : ''}`; });
  }

  /* ── Customers ── */
  async function customers() {
    const q = query();
    const r = await api('GET', `/api/admin/customers?${q.toString()}`);
    view.innerHTML = `
      <div class="head"><h1>Customers</h1><span class="hint">${r.total} with orders</span></div>
      ${r.masked ? '<p class="banner">Contact details are masked for managers. Full details are on each order you fulfil.</p>' : ''}
      <form class="card row" id="csearch" role="search"><div class="field"><label for="cq">Search name or email</label><input id="cq" name="q" value="${esc(q.get('q') || '')}" /></div><button class="btn" type="submit">Search</button></form>
      ${r.customers.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Customer</th><th>Phone</th><th class="num">Orders</th><th class="num">Paid</th><th>Last order</th><th>Account</th></tr></thead><tbody>
        ${r.customers.map((c, i) => `<tr ${c.key ? `class="clickable" data-i="${i}"` : ''}><td data-label="Customer">${esc(c.fullName)}<br><small>${esc(c.email)}</small></td><td data-label="Phone">${esc(c.phone || '—')}</td>
          <td class="num" data-label="Orders">${c.orders}</td><td class="num" data-label="Paid">${inr(c.paidPaise)}</td><td data-label="Last order">${date(c.lastOrderAt)}</td><td data-label="Account">${c.hasAccount ? 'Yes' : 'Guest'}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No customers yet. Customers appear after their first order.')}
      <div id="cdetail"></div>
      ${isOwner() ? '<section class="card" id="nl" style="margin-top:1.25rem"><h2>Newsletter sign-ups</h2><div class="state"><div class="spinner"></div></div></section>' : ''}`;
    if (isOwner()) {
      api('GET', '/api/admin/newsletter').then((n) => {
        const box = $('#nl');
        if (!box) return;
        box.innerHTML = `<div class="head"><h2>Newsletter sign-ups (${n.total})</h2>${n.total ? '<button class="btn small" type="button" id="nlcsv">Download CSV</button>' : ''}</div>
          ${n.subscribers.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Email</th><th>Signed up</th><th>Where</th></tr></thead><tbody>
            ${n.subscribers.map((x) => `<tr><td data-label="Email">${esc(x.email)}</td><td data-label="Signed up">${date(x.consentAt)}</td><td data-label="Where">${esc(x.source || '')}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="hint">No sign-ups yet.</p>'}
          <p class="hint">The site does not send emails itself. Export the list to your email tool, and honour unsubscribe requests.</p>`;
        $('#nlcsv')?.addEventListener('click', () => {
          const csv = ['email,signed_up,source', ...n.subscribers.map((x) => [x.email, x.consentAt, x.source || ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join(String.fromCharCode(10));
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
          a.download = 'amaanat-newsletter.csv';
          a.click();
          URL.revokeObjectURL(a.href);
        });
      }).catch((err) => { const box = $('#nl'); if (box) box.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
    }
    $('#csearch').addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/customers?q=${encodeURIComponent(e.target.q.value)}`; });
    view.querySelectorAll('tr[data-i]').forEach((tr) => tr.addEventListener('click', async () => {
      const c = r.customers[Number(tr.dataset.i)];
      const box = $('#cdetail');
      box.innerHTML = '<div class="state"><div class="spinner"></div></div>';
      try {
        const d = await api('GET', `/api/admin/customer?email=${encodeURIComponent(c.key)}`);
        box.innerHTML = `<section class="card" style="margin-top:1.25rem"><h2>${esc(c.fullName)} · ${esc(d.email)}</h2>
          ${d.account ? `<p>Account: ${esc(d.account.fullName || '')} ${esc(d.account.phone || '')} · ${d.account.savedAddresses} saved address(es)</p>` : '<p class="hint">Guest checkout (no account).</p>'}
          <ul>${d.orders.map((o) => `<li><a href="#/orders/${esc(o.id)}">${esc(o.publicRef)}</a> · ${date(o.createdAt)} · ${inr(o.totalPaise)} ${badge(o.paymentStatus)} ${badge(o.fulfilmentStatus)} · ${esc(o.city || '')}</li>`).join('')}</ul></section>`;
        box.scrollIntoView({ behavior: 'smooth' });
      } catch (err) { box.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
    }));
  }

  /* ── Settings ── */
  async function settings() {
    const { settings: s } = await api('GET', '/api/admin/settings');
    const h = s.homepage || {};
    const dis = isOwner() ? '' : 'disabled';
    const input = (name, label, value, attrs = '') => `<div class="field"><label for="s-${name}">${label}</label><input id="s-${name}" name="${name}" value="${esc(value ?? '')}" ${attrs} ${dis} /></div>`;
    const area = (name, label, value) => `<div class="field"><label for="s-${name}">${label}</label><textarea id="s-${name}" name="${name}" maxlength="1000" ${dis}>${esc(value ?? '')}</textarea></div>`;
    view.innerHTML = `
      <div class="head"><h1>Settings</h1></div>${ownerNote()}
      <form id="sform" novalidate>
        <section class="card"><h2>Checkout</h2>
          <p class="hint">Checkout stays closed until shipping is confirmed. Enter 0 for free shipping. Only enable tax if it applies to your business.</p>
          <div class="row">${input('shipping', 'Shipping charge per order (₹)', toRupees(s.shippingPaise), 'inputmode="decimal"')}
            <label class="check"><input type="checkbox" name="shippingConfirmed" ${s.shippingConfirmed ? 'checked' : ''} ${dis}/> Shipping confirmed</label></div>
          <label class="check"><input type="checkbox" name="codEnabled" ${s.codEnabled ? 'checked' : ''} ${dis}/> Offer Cash on Delivery at checkout</label>
          <div class="row">${input('taxPercent', 'Tax rate (%)', s.taxRateBps == null ? '' : s.taxRateBps / 100, 'inputmode="decimal"')}
            <label class="check"><input type="checkbox" name="taxConfirmed" ${s.taxConfirmed ? 'checked' : ''} ${dis}/> Charge tax</label></div>
          ${input('lowStockThreshold', 'Low-stock alert at or below (pieces, blank = off)', s.lowStockThreshold, 'type="number" min="0" max="1000"')}
        </section>
        <section class="card"><h2>Contact</h2>
          <div class="row">${input('storeName', 'Store name', s.storeName, 'maxlength="80"')}${input('contactEmail', 'Contact email', s.contactEmail, 'type="email"')}</div>
          <div class="row">${input('contactPhone', 'Phone', s.contactPhone)}${input('whatsappE164', 'WhatsApp (international, e.g. +919876543210)', s.whatsappE164)}</div>
          ${input('businessAddress', 'Business address (shown on Contact page)', s.businessAddress, 'maxlength="300"')}
        </section>
        <section class="card"><h2>Social links</h2>
          <div class="row">${input('instagramUrl', 'Instagram', s.instagramUrl, 'type="url"')}${input('facebookUrl', 'Facebook', s.facebookUrl, 'type="url"')}</div>
          <div class="row">${input('youtubeUrl', 'YouTube', s.youtubeUrl, 'type="url"')}${input('pinterestUrl', 'Pinterest', s.pinterestUrl, 'type="url"')}</div>
        </section>
        <section class="card"><h2>Announcement bar</h2>
          <div class="row">${input('announcementText', 'Text', s.announcementText, 'maxlength="160"')}${input('announcementLink', 'Link (/page or https://)', s.announcementLink)}</div>
          <label class="check"><input type="checkbox" name="announcementEnabled" ${s.announcementEnabled ? 'checked' : ''} ${dis}/> Show the announcement bar</label>
        </section>
        <section class="card"><h2>Homepage</h2><p class="hint">Leave blank to use the current brand copy.</p>
          <div class="row">${input('heroEyebrow', 'Hero small heading', h.heroEyebrow)}${input('heroTitle', 'Hero title', h.heroTitle)}</div>
          ${input('heroSubtitle', 'Hero tagline', h.heroSubtitle)}${area('heroText', 'Hero text', h.heroText)}
          ${input('heroImage', 'Hero image (path like /assets/post.jpg or https:// link)', h.heroImage)}
          ${input('storyTitle', 'Story heading', h.storyTitle)}${area('storyText', 'Story text', h.storyText)}
        </section>
        ${isOwner() ? '<div class="actions"><button class="btn primary" type="submit">Save settings</button></div>' : ''}
      </form>
      <section class="card" style="margin-top:1.25rem"><h2>Logo</h2>
        ${s.logoUrl ? `<img src="${esc(imgSrc(s.logoUrl))}" alt="Current logo" style="max-height:80px;margin-bottom:1rem" />` : '<p class="hint">No logo uploaded — the text wordmark is used.</p>'}
        ${isOwner() ? '<div class="field"><label for="logo">Upload logo (PNG, JPEG or WebP, max 4 MB)</label><input id="logo" type="file" accept="image/png,image/jpeg,image/webp" /></div>' : ''}
      </section>`;
    if (!isOwner()) return;
    $('#sform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      let shippingPaise, taxRateBps;
      try {
        shippingPaise = toPaise(f.shipping.value, { allowEmpty: true });
        const tp = String(f.taxPercent.value).trim();
        if (tp && !/^\d{1,3}(\.\d{1,2})?$/.test(tp)) throw new Error('Tax rate must be a percentage like 3 or 18');
        taxRateBps = tp ? Math.round(Number(tp) * 100) : null;
      } catch (err) { toast(err.message, 'bad'); return; }
      const body = {
        shippingPaise, shippingConfirmed: f.shippingConfirmed.checked, codEnabled: f.codEnabled.checked, taxRateBps, taxConfirmed: f.taxConfirmed.checked,
        lowStockThreshold: f.lowStockThreshold.value === '' ? null : Number(f.lowStockThreshold.value),
        storeName: f.storeName.value, contactEmail: f.contactEmail.value, contactPhone: f.contactPhone.value, whatsappE164: f.whatsappE164.value,
        businessAddress: f.businessAddress.value, instagramUrl: f.instagramUrl.value, facebookUrl: f.facebookUrl.value, youtubeUrl: f.youtubeUrl.value,
        pinterestUrl: f.pinterestUrl.value, announcementText: f.announcementText.value, announcementLink: f.announcementLink.value,
        announcementEnabled: f.announcementEnabled.checked,
        homepage: { heroEyebrow: f.heroEyebrow.value, heroTitle: f.heroTitle.value, heroSubtitle: f.heroSubtitle.value, heroText: f.heroText.value, heroImage: f.heroImage.value, storyTitle: f.storyTitle.value, storyText: f.storyText.value },
      };
      try { await withButton(f.querySelector('[type=submit]'), () => api('PUT', '/api/admin/settings', body)); toast('Settings saved', 'ok'); settings(); } catch (err) { formErrors(f, err); }
    });
    $('#logo')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) { toast('Logo must be 4 MB or smaller', 'bad'); return; }
      try { await api('POST', '/api/admin/settings/logo', undefined, { raw: file, type: file.type }); toast('Logo uploaded', 'ok'); settings(); } catch (err) { toast(err.message, 'bad'); }
    });
  }

  /* ── Pages ── */
  const PAGE_NAMES = { about: 'About (extra text)', faq: 'FAQ', privacy: 'Privacy policy', terms: 'Terms', shipping: 'Shipping policy', returns: 'Returns & refunds' };
  async function pages() {
    const { pages: list } = await api('GET', '/api/admin/pages');
    const slug = query().get('edit');
    const cur = list.find((p) => p.slug === slug);
    view.innerHTML = `
      <div class="head"><h1>Pages</h1></div>${ownerNote()}
      <p class="hint">Write only confirmed business policies. Unpublished pages show customers a “being prepared” message.</p>
      <div class="table-wrap"><table class="stack"><thead><tr><th>Page</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>
        ${list.map((p) => `<tr><td data-label="Page">${esc(PAGE_NAMES[p.slug])}</td><td data-label="Status">${p.published ? '<span class="badge ok">published</span>' : p.body ? '<span class="badge warn">draft</span>' : '<span class="badge">empty</span>'}</td>
          <td data-label="Updated">${date(p.updatedAt)} ${p.updatedBy ? `<small>${esc(p.updatedBy)}</small>` : ''}</td><td data-label=""><a class="btn small" href="#/pages?edit=${p.slug}">${isOwner() ? 'Edit' : 'View'}</a> ${p.published ? `<a class="btn small" href="/${p.slug}" target="_blank" rel="noopener">Open ↗</a>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      ${cur ? `<form class="card" id="pgform" style="margin-top:1.25rem"><h2>${esc(PAGE_NAMES[cur.slug])}</h2>
        <div class="field"><label for="pt">Title</label><input id="pt" name="title" required maxlength="120" value="${esc(cur.title || PAGE_NAMES[cur.slug])}" ${isOwner() ? '' : 'disabled'} /></div>
        <div class="field"><label for="pb">Text</label><textarea id="pb" name="body" maxlength="50000" style="min-height:18rem" ${isOwner() ? '' : 'disabled'}>${esc(cur.body)}</textarea>
          <p class="hint">Formatting: blank line = new paragraph · “## ” starts a heading · “- ” starts a bullet.</p></div>
        <label class="check"><input type="checkbox" name="published" ${cur.published ? 'checked' : ''} ${isOwner() ? '' : 'disabled'}/> Published</label>
        ${isOwner() ? '<button class="btn primary" type="submit">Save page</button>' : ''}</form>` : ''}`;
    $('#pgform')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try { await withButton(f.querySelector('button'), () => api('PUT', `/api/admin/pages/${cur.slug}`, { title: f.title.value, body: f.body.value, published: f.published.checked })); toast('Page saved', 'ok'); pages(); } catch (err) { formErrors(f, err); }
    });
  }

  /* ── Audit ── */
  async function audit() {
    if (!isOwner()) { view.innerHTML = empty('Only the owner can view the audit log.'); return; }
    const q = query();
    const offset = Number(q.get('offset') || 0);
    const r = await api('GET', `/api/admin/audit?${q.toString()}`);
    const ent = q.get('entity') || '';
    view.innerHTML = `
      <div class="head"><h1>Audit log</h1>
        <select id="aent" aria-label="Filter">${['', 'order', 'product', 'settings', 'page', 'customer', 'admin'].map((v) => `<option value="${v}" ${v === ent ? 'selected' : ''}>${v || 'Everything'}</option>`).join('')}</select></div>
      <p class="hint">Append-only record of sensitive admin actions.</p>
      ${r.entries.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>On</th><th>Details</th></tr></thead><tbody>
        ${r.entries.map((a) => `<tr><td data-label="When">${date(a.at)}</td><td data-label="Who">${esc(a.actor || '—')}<br><small>${esc(a.role || '')} ${esc(a.ip || '')}</small></td>
          <td data-label="Action">${esc(a.action)}</td><td data-label="On">${esc(a.entityType || '')} ${esc(a.entityId || '')}</td>
          <td data-label="Details"><details><summary>View</summary><pre class="json">${esc(JSON.stringify(a.details, null, 1))}</pre></details></td></tr>`).join('')}
      </tbody></table></div>
      <div class="pager">${offset ? '<button class="btn small" id="aprev" type="button">← Newer</button>' : ''}${r.entries.length === 100 ? '<button class="btn small" id="anext" type="button">Older →</button>' : ''}</div>` : empty('No entries.')}`;
    const go = (o) => { const p = new URLSearchParams(); if ($('#aent').value) p.set('entity', $('#aent').value); if (o) p.set('offset', o); location.hash = `#/audit?${p}`; };
    $('#aent').addEventListener('change', () => go(0));
    $('#aprev')?.addEventListener('click', () => go(Math.max(0, offset - 100)));
    $('#anext')?.addEventListener('click', () => go(offset + 100));
  }

  start();
})();
