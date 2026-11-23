'use strict';
(function () {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  window.YARD = { csrf };

  // Confirm dialogs on forms with data-confirm.
  document.addEventListener('submit', (e) => {
    const form = e.target;
    const msg = form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  document.addEventListener('click', (e) => {
    // Dismiss flash messages
    const close = e.target.closest('.flash-close');
    if (close) close.parentElement.remove();

    // Mobile nav toggle
    const tog = e.target.closest('[data-toggle]');
    if (tog) document.querySelector(tog.getAttribute('data-toggle'))?.classList.toggle('open');

    // Quick amount buttons on wallet
    const fill = e.target.closest('[data-fill]');
    if (fill) {
      const input = fill.closest('form').querySelector('input[name="amount"]');
      if (input) input.value = Number(fill.getAttribute('data-fill')).toFixed(2);
    }

    // Gallery thumbnails
    const thumb = e.target.closest('.gallery-thumbs button');
    if (thumb) {
      const gallery = thumb.closest('[data-gallery]');
      gallery.querySelector('[data-gallery-main]').src = thumb.getAttribute('data-src');
      gallery.querySelectorAll('.gallery-thumbs button').forEach((b) => b.classList.toggle('active', b === thumb));
    }

    // Close user menu when clicking outside
    document.querySelectorAll('details.usermenu[open]').forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });

  // Favorite buttons without page reload
  document.querySelectorAll('.fav-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { 'x-csrf-token': csrf, accept: 'application/json' },
        });
        if (res.ok) btn.classList.toggle('on', (await res.json()).favorited);
      } catch { /* ignore */ }
    });
  });

  // Image picker on the listing form: each new selection is ADDED to the previous ones
  // (the browser would normally replace them). Selected photos can be removed individually.
  const MAX_IMAGES = 8;
  document.querySelectorAll('input[type="file"][data-preview]').forEach((input) => {
    const box = document.querySelector(input.getAttribute('data-preview'));
    const form = input.closest('form');
    let selected = [];
    const key = (f) => `${f.name}|${f.size}|${f.lastModified}`;

    // Photos already saved on the listing (edit form) that are not ticked for removal.
    const keptExisting = () =>
      form ? form.querySelectorAll('input[name="remove_images"]:not(:checked)').length : 0;

    function sync() {
      const dt = new DataTransfer();
      selected.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      box.querySelectorAll('img').forEach((img) => URL.revokeObjectURL(img.src));
      box.innerHTML = '';
      selected.forEach((f, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'thumb thumb-new';
        const img = document.createElement('img');
        img.alt = f.name;
        img.src = URL.createObjectURL(f);
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'thumb-remove';
        rm.setAttribute('aria-label', `Remove ${f.name}`);
        rm.textContent = '×';
        rm.addEventListener('click', () => { selected.splice(i, 1); sync(); });
        wrap.append(img, rm);
        if (i === 0 && keptExisting() === 0) {
          const tag = document.createElement('span');
          tag.className = 'thumb-cover';
          tag.textContent = 'Cover';
          wrap.appendChild(tag);
        }
        box.appendChild(wrap);
      });
    }

    input.addEventListener('change', () => {
      const room = MAX_IMAGES - keptExisting();
      const known = new Set(selected.map(key));
      const incoming = [...input.files].filter((f) => !known.has(key(f)));
      const merged = selected.concat(incoming);
      if (merged.length > room) alert(`A listing can have at most ${MAX_IMAGES} photos. Only the first ${Math.max(room, 0)} were kept.`);
      selected = merged.slice(0, Math.max(room, 0));
      sync();
    });

    // Re-check the limit when existing photos are ticked/unticked for removal.
    form?.addEventListener('change', (e) => {
      if (e.target.name !== 'remove_images') return;
      const room = MAX_IMAGES - keptExisting();
      if (selected.length > room) selected = selected.slice(0, Math.max(room, 0));
      sync();
    });
  });

  // Unread badge polling
  const badge = document.getElementById('unread-badge');
  if (badge) {
    setInterval(async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/unread', { headers: { accept: 'application/json' } });
        if (!res.ok) return;
        const { unread } = await res.json();
        badge.textContent = unread;
        badge.classList.toggle('hidden', !unread);
      } catch { /* offline */ }
    }, 20000);
  }
})();
