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

  // Image previews on the listing form
  document.querySelectorAll('input[type="file"][data-preview]').forEach((input) => {
    input.addEventListener('change', () => {
      const box = document.querySelector(input.getAttribute('data-preview'));
      box.innerHTML = '';
      [...input.files].slice(0, 8).forEach((f) => {
        const img = document.createElement('img');
        img.alt = f.name;
        img.src = URL.createObjectURL(f);
        const wrap = document.createElement('div');
        wrap.className = 'thumb';
        wrap.appendChild(img);
        box.appendChild(wrap);
      });
      if (input.files.length > 8) alert('Only the first 8 images will be uploaded.');
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
