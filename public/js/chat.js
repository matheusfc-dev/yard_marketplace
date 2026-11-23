'use strict';
(function () {
  const log = document.getElementById('chat-log');
  if (!log) return;
  const convId = log.dataset.conversation;
  const me = Number(log.dataset.me);
  const form = document.getElementById('chat-form');
  let lastId = Number(log.querySelector('.msg:last-child')?.dataset.id || 0);
  let polling = false;

  const fmt = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const scrollDown = () => { log.scrollTop = log.scrollHeight; };

  function render(m) {
    if (log.querySelector(`[data-id="${m.id}"]`)) return;
    const div = document.createElement('div');
    div.className = 'msg ' + (m.is_system ? 'msg-system' : m.sender_id === me ? 'msg-mine' : 'msg-theirs');
    div.dataset.id = m.id;
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = m.body;
    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = fmt(m.created_at);
    div.append(body, time);
    log.appendChild(div);
    lastId = Math.max(lastId, m.id);
  }

  function markSeen(lastReadMine) {
    log.querySelectorAll('.msg-mine').forEach((el) => {
      el.classList.toggle('seen', lastReadMine && Number(el.dataset.id) <= lastReadMine);
    });
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const res = await fetch(`/api/conversations/${convId}/messages?after=${lastId}`, { headers: { accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
        data.messages.forEach(render);
        if (data.messages.length && nearBottom) scrollDown();
        markSeen(data.lastReadMine);
      }
    } catch { /* offline */ }
    polling = false;
  }

  if (form) {
    const ta = form.querySelector('textarea');
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = ta.value.trim();
      if (!body) return;
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': window.YARD.csrf },
          body: JSON.stringify({ body }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not send message');
        ta.value = '';
        ta.style.height = 'auto';
        render(data.message);
        scrollDown();
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
        ta.focus();
      }
    });
  }

  scrollDown();
  poll();
  setInterval(() => { if (!document.hidden) poll(); }, 3000);
})();
