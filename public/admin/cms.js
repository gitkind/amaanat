'use strict';
/* AMAANAT website editor. Forms are generated from the server's schema
   (/api/admin/cms/schema); the server re-validates every save. Content is
   stored in Supabase as a draft, previewed, then published. */
(() => {
  const A = window.AmaanatAdmin;
  if (!A) return;
  const { api, toast, date, imgSrc } = A;

  let schema = null;
  let products = null;
  let collections = null;

  async function loadSchema() {
    schema ||= await api('GET', '/api/admin/cms/schema');
    return schema;
  }
  async function loadPickers() {
    if (!products) {
      const [p, c] = await Promise.all([api('GET', '/api/admin/products'), api('GET', '/api/collections')]);
      products = p.products.filter((x) => x.active !== false);
      collections = c.collections;
    }
  }

  /* tiny DOM builder: h('div', { class: 'x', onclick }, child, …) */
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // only ever used with static markup
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  let uid = 0;
  const nid = (p) => `${p}-${++uid}`;
  const markDirty = () => { A.dirty = true; renderStatus(); };
  const ICONS = {
    hero: '▭', imageText: '◧', featuredProducts: '◫', categories: '▦', promo: '✦', story: '❝', testimonials: '☷', newsletter: '✉', text: '¶', highlights: '✧',
  };

  function confirmBox(message, { ok = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      const dlg = h('dialog', { class: 'dialog' },
        h('p', {}, message),
        h('div', { class: 'actions end' },
          h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); resolve(false); } }, 'Cancel'),
          h('button', { class: `btn ${danger ? 'danger-fill' : 'primary'}`, type: 'button', onclick: () => { dlg.close(); resolve(true); } }, ok)));
      dlg.addEventListener('close', () => { dlg.remove(); resolve(false); });
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  /* ── field widgets ── */
  function fieldWrap(field, control, id) {
    return h('div', { class: 'field' }, h('label', { for: id }, field.label), control, field.hint ? h('p', { class: 'hint' }, field.hint) : null);
  }

  function textInput(field, obj, readOnly) {
    const id = nid('f');
    const attrs = { id, maxlength: field.max || 200, value: obj[field.key] || '', placeholder: field.placeholder || '', disabled: readOnly,
      oninput: (e) => { obj[field.key] = e.target.value; markDirty(); } };
    const el = field.kind === 'textarea' ? h('textarea', { ...attrs, value: null, rows: field.max > 1000 ? 7 : 4 }) : h('input', attrs);
    if (field.kind === 'textarea') el.value = obj[field.key] || '';
    return fieldWrap(field, el, id);
  }

  function imageInput(field, obj, readOnly) {
    obj[field.key] ||= { src: '', alt: '' };
    const val = obj[field.key];
    const box = h('div', { class: 'img-field' });
    const draw = () => {
      box.replaceChildren();
      const fileId = nid('img');
      const file = h('input', { type: 'file', id: fileId, accept: 'image/jpeg,image/png,image/webp', class: 'visually-hidden', disabled: readOnly, onchange: upload });
      box.append(
        h('div', { class: 'img-preview' }, val.src ? h('img', { src: imgSrc(val.src), alt: '' }) : h('span', {}, 'No image')),
        h('div', { class: 'img-side' },
          readOnly ? null : h('div', { class: 'actions' },
            file, h('label', { for: fileId, class: 'btn small' }, val.src ? 'Replace image' : 'Upload image'),
            val.src ? h('button', { type: 'button', class: 'btn small danger', onclick: () => { val.src = ''; markDirty(); draw(); } }, 'Remove') : null),
          h('p', { class: 'hint' }, 'JPEG, PNG or WebP, up to 4 MB. Wide photos (at least 1600px) look best in banners.'),
          (() => { const id = nid('alt'); return h('div', { class: 'field' }, h('label', { for: id }, 'Describe the image (for screen readers and Google)'),
            h('input', { id, maxlength: 200, value: val.alt || '', disabled: readOnly, oninput: (e) => { val.alt = e.target.value; markDirty(); } })); })()));
    };
    async function upload(e) {
      const f = e.target.files[0];
      if (!f) return;
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast('Choose a JPEG, PNG or WebP image', 'bad'); return; }
      if (f.size > 4 * 1024 * 1024) { toast('Images must be 4 MB or smaller', 'bad'); return; }
      box.classList.add('busy');
      try {
        const r = await api('POST', '/api/admin/cms/images', undefined, { raw: f, type: f.type });
        val.src = r.url;
        markDirty();
        toast('Image uploaded', 'ok');
      } catch (err) { toast(err.message, 'bad'); } finally { box.classList.remove('busy'); draw(); }
    }
    draw();
    return h('div', { class: 'field' }, h('span', { class: 'label' }, field.label), box);
  }

  function buttonsInput(field, obj, readOnly) {
    obj[field.key] ||= [];
    const list = obj[field.key];
    const box = h('div', { class: 'stack-sm' });
    const draw = () => {
      box.replaceChildren(...list.map((b, i) => h('div', { class: 'row tight' },
        (() => { const id = nid('bl'); return h('div', { class: 'field' }, h('label', { for: id }, 'Button text'), h('input', { id, value: b.label, maxlength: 40, disabled: readOnly, oninput: (e) => { b.label = e.target.value; markDirty(); } })); })(),
        (() => { const id = nid('bh'); return h('div', { class: 'field' }, h('label', { for: id }, 'Goes to'), linkControl(id, b, 'href', readOnly)); })(),
        readOnly ? null : h('button', { type: 'button', class: 'btn small danger', 'aria-label': 'Remove button', onclick: () => { list.splice(i, 1); markDirty(); draw(); } }, 'Remove'))),
      readOnly || list.length >= field.max ? '' : h('button', { type: 'button', class: 'btn small', onclick: () => { list.push({ label: '', href: '/shop' }); markDirty(); draw(); } }, '+ Add button'));
    };
    draw();
    return h('div', { class: 'field' }, h('span', { class: 'label' }, field.label), box);
  }

  // Link: a list of the site's pages plus "other link".
  function linkControl(id, obj, key, readOnly) {
    const pages = [['/shop', 'Shop all'], ...(collections || []).map((c) => [`/collections/${c.slug}`, `Collection: ${c.name}`]), ['/about', 'Our story'], ['/meet-the-founder', 'Meet the founder'], ['/contact', 'Contact'], ['/track', 'Track order'], ['/shipping', 'Shipping policy'], ['/returns', 'Returns policy'], ['/faq', 'FAQ']];
    const known = pages.some(([v]) => v === obj[key]);
    const custom = h('input', { id: `${id}-c`, placeholder: '/page or https://…', value: known ? '' : obj[key] || '', maxlength: 500, disabled: readOnly, hidden: known && obj[key] ? true : null,
      'aria-label': 'Link address', oninput: (e) => { obj[key] = e.target.value.trim(); markDirty(); } });
    const sel = h('select', { id, disabled: readOnly, onchange: (e) => {
      if (e.target.value === '__other') { custom.hidden = false; custom.focus(); obj[key] = custom.value; } else { custom.hidden = true; obj[key] = e.target.value; }
      markDirty();
    } }, ...pages.map(([v, l]) => h('option', { value: v, selected: v === obj[key] }, l)), h('option', { value: '__other', selected: !known }, 'Other link…'));
    if (!known) custom.hidden = false;
    return h('div', { class: 'link-control' }, sel, custom);
  }

  function selectInput(field, obj, readOnly, onChange) {
    const id = nid('s');
    if (!field.options.some(([v]) => v === obj[field.key])) obj[field.key] = field.options[0][0];
    return fieldWrap(field, h('select', { id, disabled: readOnly, onchange: (e) => { obj[field.key] = e.target.value; markDirty(); onChange?.(); } },
      ...field.options.map(([v, l]) => h('option', { value: v, selected: v === obj[field.key] }, l))), id);
  }

  function toggleInput(field, obj, readOnly) {
    return h('label', { class: 'switch-row' }, h('input', { type: 'checkbox', class: 'switch', checked: obj[field.key] === true, disabled: readOnly,
      onchange: (e) => { obj[field.key] = e.target.checked; markDirty(); } }), h('span', {}, field.label, field.hint ? h('small', { class: 'hint block' }, field.hint) : null));
  }

  function productsInput(field, obj, readOnly) {
    obj[field.key] ||= [];
    const chosen = obj[field.key];
    return h('fieldset', { class: 'field picker' }, h('legend', {}, `${field.label} (up to ${field.max})`),
      h('div', { class: 'picker-grid' }, ...(products || []).map((p) => h('label', { class: 'pick' },
        h('input', { type: 'checkbox', checked: chosen.includes(p.id), disabled: readOnly, onchange: (e) => {
          const i = chosen.indexOf(p.id);
          if (e.target.checked && i < 0) { if (chosen.length >= field.max) { e.target.checked = false; toast(`Choose up to ${field.max}`, 'bad'); return; } chosen.push(p.id); }
          if (!e.target.checked && i >= 0) chosen.splice(i, 1);
          markDirty();
        } }),
        h('img', { src: imgSrc(p.image), alt: '', loading: 'lazy' }), h('span', {}, p.name)))));
  }

  function collectionsInput(field, obj, readOnly) {
    if (field.single) {
      const id = nid('c');
      if (!obj[field.key] && collections?.[0]) obj[field.key] = collections[0].slug;
      return fieldWrap(field, h('select', { id, disabled: readOnly, onchange: (e) => { obj[field.key] = e.target.value; markDirty(); } },
        ...(collections || []).map((c) => h('option', { value: c.slug, selected: c.slug === obj[field.key] }, c.name))), id);
    }
    obj[field.key] ||= [];
    const chosen = obj[field.key];
    return h('fieldset', { class: 'field' }, h('legend', {}, field.label),
      h('div', { class: 'chip-checks' }, ...(collections || []).map((c) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: chosen.includes(c.slug), disabled: readOnly, onchange: (e) => {
        const i = chosen.indexOf(c.slug);
        if (e.target.checked && i < 0) chosen.push(c.slug);
        if (!e.target.checked && i >= 0) chosen.splice(i, 1);
        markDirty();
      } }), c.name))), field.hint ? h('p', { class: 'hint' }, field.hint) : null);
  }

  function itemsInput(field, obj, readOnly) {
    obj[field.key] ||= [];
    const list = obj[field.key];
    const box = h('div', { class: 'items' });
    const draw = () => {
      box.replaceChildren(...list.map((item, i) => h('div', { class: 'item' },
        h('div', { class: 'item-head' }, h('b', {}, `${field.itemLabel || 'Item'} ${i + 1}`),
          readOnly ? null : h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn small icon', disabled: i === 0, 'aria-label': 'Move up', onclick: () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); markDirty(); draw(); } }, '↑'),
            h('button', { type: 'button', class: 'btn small icon', disabled: i === list.length - 1, 'aria-label': 'Move down', onclick: () => { list.splice(i + 1, 0, list.splice(i, 1)[0]); markDirty(); draw(); } }, '↓'),
            h('button', { type: 'button', class: 'btn small danger', onclick: () => { list.splice(i, 1); markDirty(); draw(); } }, 'Remove'))),
        ...fieldsFor(field.fields, item, readOnly))),
      readOnly || list.length >= field.max ? '' : h('button', { type: 'button', class: 'btn small', onclick: () => { list.push({}); markDirty(); draw(); } }, `+ Add ${field.itemLabel || 'item'}`));
    };
    draw();
    return h('fieldset', { class: 'field' }, h('legend', {}, field.label), box);
  }

  function fieldsFor(fields, obj, readOnly, redraw) {
    return fields.map((field) => {
      if (field.showIf && obj[field.showIf[0]] !== field.showIf[1]) return null;
      switch (field.kind) {
        case 'text': case 'textarea': return textInput(field, obj, readOnly);
        case 'image': return imageInput(field, obj, readOnly);
        case 'buttons': return buttonsInput(field, obj, readOnly);
        case 'select': return selectInput(field, obj, readOnly, redraw);
        case 'toggle': return toggleInput(field, obj, readOnly);
        case 'products': return productsInput(field, obj, readOnly);
        case 'collections': return collectionsInput(field, obj, readOnly);
        case 'items': return itemsInput(field, obj, readOnly);
        case 'link': { const id = nid('l'); return fieldWrap(field, linkControl(id, obj, field.key, readOnly), id); }
        default: return null;
      }
    });
  }

  /* ── editor state ── */
  let state = null; // { key, def, data(server view), content }
  let statusEl = null;

  function renderStatus() {
    if (!statusEl || !state) return;
    const d = state.data;
    const changes = A.dirty ? 'Unsaved changes' : d.hasUnpublishedChanges || (d.isDefault && !d.published) ? 'Draft not published yet' : 'Everything is live';
    const cls = A.dirty ? 'warn' : d.hasUnpublishedChanges || (d.isDefault && !d.published) ? 'info' : 'ok';
    statusEl.replaceChildren(h('span', { class: `pill ${cls}` }, changes),
      h('span', { class: 'hint' }, d.published ? `Live version ${d.publishedVersion} · published ${date(d.publishedAt)}${d.publishedBy ? ` by ${d.publishedBy}` : ''}` : 'Not published yet — the website shows the original design.'));
  }

  function sectionSummary(s) {
    return s.title || s.subtitle || s.eyebrow || (s.text || '').slice(0, 60) || (s.items?.length ? `${s.items.length} item(s)` : '');
  }

  function sectionCard(s, i, list, readOnly, redrawList) {
    const t = schema.sectionTypes[s.type];
    const body = h('div', { class: 'sec-body', hidden: !s._open });
    const drawBody = () => {
      body.replaceChildren(
        t.layouts.length > 1 ? h('fieldset', { class: 'field' }, h('legend', {}, 'Layout'),
          h('div', { class: 'layouts' }, ...t.layouts.map(([v, l]) => h('label', { class: `layout-opt${s.layout === v ? ' on' : ''}` },
            h('input', { type: 'radio', name: `lay-${s.id}`, value: v, checked: s.layout === v, disabled: readOnly, onchange: () => { s.layout = v; markDirty(); drawBody(); } }),
            h('span', { class: `lay-thumb lay-${v}`, 'aria-hidden': 'true' }), h('span', {}, l))))) : null,
        ...fieldsFor(t.fields, s, readOnly, drawBody));
    };
    if (s._open) drawBody();
    const card = h('article', { class: `sec${s.enabled === false ? ' off' : ''}`, 'data-index': i },
      h('header', { class: 'sec-head' },
        readOnly ? null : h('span', { class: 'drag', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'),
        h('span', { class: 'sec-icon', 'aria-hidden': 'true' }, ICONS[s.type] || '▢'),
        h('button', { type: 'button', class: 'sec-title', 'aria-expanded': String(Boolean(s._open)), onclick: () => {
          s._open = !s._open; body.hidden = !s._open; if (s._open && !body.childElementCount) drawBody(); card.querySelector('.sec-title').setAttribute('aria-expanded', String(s._open));
        } }, h('b', {}, t.label), h('small', {}, sectionSummary(s) || 'Click to edit')),
        h('div', { class: 'sec-tools' },
          h('label', { class: 'switch-row compact', title: s.enabled === false ? 'Hidden' : 'Visible' },
            h('input', { type: 'checkbox', class: 'switch', checked: s.enabled !== false, disabled: readOnly, 'aria-label': 'Show this section',
              onchange: (e) => { s.enabled = e.target.checked; card.classList.toggle('off', !s.enabled); markDirty(); } }),
            h('span', { class: 'hide-sm' }, 'Show')),
          readOnly ? null : [
            h('button', { type: 'button', class: 'btn small icon', disabled: i === 0, 'aria-label': 'Move up', onclick: () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); markDirty(); redrawList(); } }, '↑'),
            h('button', { type: 'button', class: 'btn small icon', disabled: i === list.length - 1, 'aria-label': 'Move down', onclick: () => { list.splice(i + 1, 0, list.splice(i, 1)[0]); markDirty(); redrawList(); } }, '↓'),
            h('button', { type: 'button', class: 'btn small icon', 'aria-label': 'Duplicate', title: 'Duplicate', onclick: () => {
              const copy = JSON.parse(JSON.stringify(s)); delete copy.id; copy._open = true; list.splice(i + 1, 0, copy); markDirty(); redrawList();
            } }, '⧉'),
            h('button', { type: 'button', class: 'btn small icon danger', 'aria-label': 'Delete section', title: 'Delete', onclick: async () => {
              if (await confirmBox(`Remove the “${t.label}” section? You can undo this by not saving, or by restoring an earlier version.`, { ok: 'Remove', danger: true })) { list.splice(i, 1); markDirty(); redrawList(); }
            } }, '✕')])),
      body);
    if (!readOnly) {
      const handle = card.querySelector('.drag');
      handle.addEventListener('mousedown', () => { card.draggable = true; });
      handle.addEventListener('touchstart', () => { card.draggable = true; }, { passive: true });
      card.addEventListener('dragstart', (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); card.classList.add('dragging'); });
      card.addEventListener('dragend', () => { card.draggable = false; card.classList.remove('dragging'); });
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop'); });
      card.addEventListener('dragleave', () => card.classList.remove('drop'));
      card.addEventListener('drop', (e) => {
        e.preventDefault(); card.classList.remove('drop');
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (Number.isInteger(from) && from !== i) { list.splice(i, 0, list.splice(from, 1)[0]); markDirty(); redrawList(); }
      });
    }
    return card;
  }

  function templatePicker(onPick) {
    const dlg = h('dialog', { class: 'dialog wide' },
      h('div', { class: 'head' }, h('h2', {}, 'Add a section'), h('button', { type: 'button', class: 'btn small', onclick: () => dlg.close() }, 'Close')),
      h('div', { class: 'templates' }, ...Object.entries(schema.sectionTypes).map(([type, t]) => h('button', { type: 'button', class: 'template', onclick: () => { dlg.close(); onPick(type); } },
        h('span', { class: 'template-icon', 'aria-hidden': 'true' }, ICONS[type] || '▢'), h('b', {}, t.label), h('small', {}, t.description)))));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  function cleanForSave(content) {
    return JSON.parse(JSON.stringify(content, (k, v) => (k.startsWith('_') ? undefined : v)));
  }

  async function act(btn, fn, okMsg) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Working…';
    try {
      const data = await fn();
      if (data) { state.data = data; A.dirty = false; }
      if (okMsg) toast(okMsg, 'ok');
      return data;
    } catch (err) { toast(err.message, 'bad'); return null; } finally { btn.disabled = false; btn.textContent = label; renderStatus(); }
  }

  /* ── pages ── */
  async function hub() {
    await loadSchema();
    const keys = Object.keys(schema.docs);
    const states = await Promise.all(keys.map((k) => api('GET', `/api/admin/cms/${k}`).catch((err) => ({ error: err.message }))));
    const err = states.find((s) => s.error);
    A.view.replaceChildren(
      h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Website'), h('p', { class: 'sub' }, 'Edit your homepage, story pages, menu and footer. Changes are saved as a draft, previewed, then published — no developer needed.'))),
      err ? h('div', { class: 'banner bad' }, err.error) : '',
      h('div', { class: 'grid cards3' }, ...keys.map((k, i) => {
        const d = schema.docs[k];
        const s = states[i];
        const pill = s.error ? h('span', { class: 'pill' }, '—') : s.hasUnpublishedChanges ? h('span', { class: 'pill info' }, 'Unpublished changes') : s.published ? h('span', { class: 'pill ok' }, `Live · v${s.publishedVersion}`) : h('span', { class: 'pill' }, 'Original design');
        return h('a', { class: 'tile-card', href: `#/website/${k}` }, h('span', { class: 'tile-kicker' }, d.kind === 'sections' ? 'Page builder' : 'Content'),
          h('h2', {}, d.label), pill, h('p', { class: 'hint' }, s.publishedAt ? `Published ${date(s.publishedAt)}` : 'Not published from the editor yet'), h('span', { class: 'tile-go' }, 'Edit →'));
      }),
      h('a', { class: 'tile-card', href: '#/pages' }, h('span', { class: 'tile-kicker' }, 'Policies'), h('h2', {}, 'Shipping, returns, privacy, terms & FAQ'), h('p', { class: 'hint' }, 'Publish your confirmed policies.'), h('span', { class: 'tile-go' }, 'Edit →')),
      h('a', { class: 'tile-card', href: '#/settings' }, h('span', { class: 'tile-kicker' }, 'Settings'), h('h2', {}, 'Announcement bar, contact & social links'), h('p', { class: 'hint' }, 'Applies immediately when saved.'), h('span', { class: 'tile-go' }, 'Edit →'))));
  }

  async function editor(key) {
    await Promise.all([loadSchema(), loadPickers()]);
    const def = schema.docs[key];
    if (!def) { location.hash = '#/website'; return; }
    const data = await api('GET', `/api/admin/cms/${key}`);
    state = { key, def, data, content: JSON.parse(JSON.stringify(data.content)) };
    A.dirty = false;
    const readOnly = !A.isOwner();
    statusEl = h('div', { class: 'status-line' });

    const btnPreview = h('button', { type: 'button', class: 'btn' }, 'Preview');
    const btnSave = h('button', { type: 'button', class: 'btn' }, 'Save draft');
    const btnPublish = h('button', { type: 'button', class: 'btn gold' }, 'Publish');
    const btnMore = h('details', { class: 'menu-more' }, h('summary', { class: 'btn' }, 'More'),
      h('div', { class: 'menu-pop' },
        h('button', { type: 'button', class: 'link', onclick: () => showHistory() }, 'Version history & restore'),
        h('button', { type: 'button', class: 'link danger-text', onclick: async (e) => {
          e.target.closest('details').open = false;
          if (!(await confirmBox('Throw away all changes that are not published yet?', { ok: 'Discard changes', danger: true }))) return;
          const r = await act(btnSave, () => api('POST', `/api/admin/cms/${key}/discard`, {}), 'Changes discarded');
          if (r) editor(key);
        } }, 'Discard unpublished changes')));

    btnSave.addEventListener('click', () => act(btnSave, () => api('PUT', `/api/admin/cms/${key}`, { content: cleanForSave(state.content) }), 'Draft saved'));
    btnPreview.addEventListener('click', async () => {
      const win = window.open('about:blank', '_blank');
      const r = await act(btnPreview, () => api('PUT', `/api/admin/cms/${key}`, { content: cleanForSave(state.content) }));
      if (r && win) win.location.href = `${def.path}?preview=draft`;
      else if (win) win.close();
    });
    btnPublish.addEventListener('click', async () => {
      if (!(await confirmBox('Publish these changes to the live website now? Customers will see them within about a minute.', { ok: 'Publish' }))) return;
      const r = await act(btnPublish, () => api('POST', `/api/admin/cms/${key}/publish`, { content: cleanForSave(state.content) }), 'Published — your website is updated');
      if (r) { state.content = JSON.parse(JSON.stringify(r.content)); }
    });

    async function showHistory() {
      btnMore.open = false;
      const versions = state.data.versions;
      const dlg = h('dialog', { class: 'dialog wide' },
        h('div', { class: 'head' }, h('h2', {}, 'Version history'), h('button', { type: 'button', class: 'btn small', onclick: () => dlg.close() }, 'Close')),
        versions.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Version'), h('th', {}, 'Published'), h('th', {}, 'By'), h('th', {}, ''))),
          h('tbody', {}, ...versions.map((v) => h('tr', {},
            h('td', {}, `v${v.version}${v.version === state.data.publishedVersion ? ' (live)' : ''}`), h('td', {}, date(v.publishedAt)), h('td', {}, v.publishedBy || '—'),
            h('td', {}, readOnly ? '' : h('button', { type: 'button', class: 'btn small', onclick: async (e) => {
              if (A.dirty && !(await confirmBox('Restoring replaces your unsaved changes. Continue?', { ok: 'Restore', danger: true }))) return;
              const r = await act(e.target, () => api('POST', `/api/admin/cms/${key}/restore`, { version: v.version }), `Version ${v.version} loaded as your draft. Preview it, then Publish to make it live.`);
              if (r) { dlg.close(); editor(key); }
            } }, 'Restore'))))))) : h('p', { class: 'hint' }, 'Nothing has been published from the editor yet.'));
      dlg.addEventListener('close', () => dlg.remove());
      document.body.append(dlg);
      dlg.showModal();
    }

    const main = h('div', { class: 'editor-main' });
    if (def.kind === 'sections') {
      const list = state.content.sections;
      const listEl = h('div', { class: 'sections' });
      const redraw = () => {
        listEl.replaceChildren(...list.map((s, i) => sectionCard(s, i, list, readOnly, redraw)));
        if (!list.length) listEl.append(h('div', { class: 'state' }, 'This page has no sections. Add one below.'));
      };
      redraw();
      main.append(listEl, readOnly ? '' : h('button', { type: 'button', class: 'add-section', onclick: () => {
        if (list.length >= schema.maxSections) { toast(`A page can have up to ${schema.maxSections} sections`, 'bad'); return; }
        templatePicker((type) => {
          list.push({ type, enabled: true, layout: schema.sectionTypes[type].layouts[0][0], _open: true });
          markDirty(); redraw();
          listEl.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      } }, h('span', { 'aria-hidden': 'true' }, '+'), ' Add a section'));
    } else {
      main.append(h('section', { class: 'card form-card' }, ...fieldsFor(def.fields, state.content, readOnly)));
    }

    A.view.replaceChildren(
      h('nav', { class: 'crumbs' }, h('a', { href: '#/website' }, 'Website'), ' / ', def.label),
      h('div', { class: 'editor-bar' },
        h('div', {}, h('h1', {}, def.label), statusEl),
        readOnly ? h('a', { class: 'btn', href: def.path, target: '_blank', rel: 'noopener' }, 'View live ↗') : h('div', { class: 'actions' }, btnPreview, btnSave, btnPublish, btnMore)),
      readOnly ? h('p', { class: 'banner' }, 'Only the store owner can change website content. You can look around.') : '',
      key === 'founder' ? h('p', { class: 'banner info' }, 'Fill in only real details provided by the founder. Until the page is switched on and has a name, customers see “coming soon”.') : '',
      main);
    renderStatus();
  }

  A.addRoute(/^#\/website$/, hub, 'Website');
  A.addRoute(/^#\/website\/(home|about|founder|site)$/, editor, 'Website editor');
})();
