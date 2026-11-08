'use strict';
(async () => {
  const root = document.getElementById('wishlist');
  const s = await Session.me();
  if (!s.accountsEnabled) {
    notice(root, 'Wishlists need an account, and accounts are not available yet.');
    return;
  }
  if (!s.user) {
    root.innerHTML = '<div class="empty-state"><h2>Sign in to see your wishlist</h2><p>Save pieces you love and find them here on any device.</p><a class="btn" href="/account?next=/wishlist">Sign in</a></div>';
    return;
  }

  async function render() {
    const { products } = await API.get('/api/wishlist');
    if (!products.length) {
      root.innerHTML = '<div class="empty-state"><h2>Nothing saved yet</h2><p>Tap “Save to wishlist” on any piece.</p><a class="btn" href="/shop">Browse the collection</a></div>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'product-grid';
    products.forEach((p) => {
      const card = renderProductCard(p);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-link card-quick';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${p.name} from wishlist`);
      remove.addEventListener('click', async () => {
        try {
          await API.del(`/api/wishlist/${encodeURIComponent(p.id)}`);
          render();
        } catch (err) {
          Toast.error(err.message);
        }
      });
      card.querySelector('.card-body').appendChild(remove);
      grid.appendChild(card);
    });
    root.replaceChildren(grid);
  }
  render().catch((e) => notice(root, e.message, 'error'));
})();
