/* =====================================================
   Shared DOM helpers — available on every page.
   Depends on: nothing (pure DOM).
   ===================================================== */

// Toggle one section visible, hide all others.
// ids: array of element IDs managed as a group.
function showScreen(ids, active) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== active);
  });
}

function showLoading(msg) {
  const el  = document.getElementById('loading-overlay');
  const msg_ = document.getElementById('loading-msg');
  if (el)   el.classList.remove('hidden');
  if (msg_) msg_.textContent = msg || 'Loading…';
}

function hideLoading() {
  const el = document.getElementById('loading-overlay');
  if (el) el.classList.add('hidden');
}

let _toastTimer = null;
function showToast(msg, type) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `app-toast${type === 'error' ? ' error' : ''} show`;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// Escape a string for safe innerHTML injection.
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Returns an HTML string for a player avatar chip.
function playerChip(p, isMe) {
  return `
    <img src="${esc(p.photoURL || '')}" alt=""
      style="width:22px;height:22px;border-radius:50%;object-fit:cover;flex-shrink:0" />
    <span class="chip-name">${esc(p.name || 'Player')}</span>
    ${isMe ? '<span class="chip-you">(you)</span>' : ''}
  `;
}
