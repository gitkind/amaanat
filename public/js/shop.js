'use strict';
(() => {
  const grid = document.getElementById('product-grid');
  const tabs = document.getElementById('filter-tabs');
  const form = document.getElementById('shop-controls');
  const count = document.getElementById('results-count');
  const params = new URLSearchParams(location.search);
  const state = {
    category: params.get('category') || '',
    q: params.get('q') || '',
    sort: params.get('sort') || 'featured',
    inStock: params.get('inStock') === '1',
  };
  form.q.value = state.q;
  form.sort.value = state.sort;
  form.inStock.checked = state.inStock;

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.category) p.set('category', state.category);
    if (state.q) p.set('q', state.q);
    if (state.sort !== 'featured') p.set('sort', state.sort);
    if (state.inStock) p.set('inStock', '1');
    history.replaceState(null, '', `${location.pathname}${p.toString() ? `?${p}` : ''}`);
    return p;
  }

  function renderTabs(collections) {
    const all = [{ slug: '', name: 'All' }, ...collections];
    tabs.innerHTML = '';
    for (const c of all) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `filter-tab${state.category === c.slug ? ' is-active' : ''}`;
      b.textContent = c.count ? `${c.name} (${c.count})` : c.name;
      b.setAttribute('aria-pressed', String(state.category === c.slug));
      b.addEventListener('click', () => { state.category = c.slug; load(); });
      tabs.appendChild(b);
    }
  }

  let seq = 0;
  async function load() {
    const p = syncUrl();
    const mine = ++seq;
    renderSkeletonCards(grid, 4);
    try {
      const data = await API.get(`/api/products?${p}`);
      if (mine !== seq) return;
      renderTabs(data.collections);
      const active = data.collections.find((c) => c.slug === state.category);
      document.getElementById('shop-title').textContent = active ? active.name : 'The collection';
      grid.innerHTML = '';
      if (!data.products.length) {
        grid.innerHTML = '<div class="empty-state"><h2>Nothing matched</h2><p>Try a different search or collection.</p></div>';
      } else {
        data.products.forEach((product) => grid.appendChild(renderProductCard(product)));
      }
      count.textContent = `${data.total} piece${data.total === 1 ? '' : 's'}`;
    } catch (e) {
      if (mine === seq) notice(grid, e.message, 'error');
    }
  }

  let t;
  form.q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.q = form.q.value.trim(); load(); }, 250); });
  form.sort.addEventListener('change', () => { state.sort = form.sort.value; load(); });
  form.inStock.addEventListener('change', () => { state.inStock = form.inStock.checked; load(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); state.q = form.q.value.trim(); load(); });
  load();
})();
