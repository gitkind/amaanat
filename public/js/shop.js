'use strict';
/* The shop filters are a normal GET form (works without JS). This just applies
   sort / in-stock changes immediately. */
(() => {
  const form = document.getElementById('shop-filters');
  if (!form) return;
  form.querySelectorAll('select, input[type="checkbox"]').forEach((el) => el.addEventListener('change', () => form.requestSubmit()));
  form.addEventListener('submit', () => {
    // Keep URLs tidy: drop empty / default values.
    if (!form.q.value.trim()) form.q.disabled = true;
    if (form.sort.value === 'featured') form.sort.disabled = true;
  });
})();
