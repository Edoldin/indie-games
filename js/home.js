/* =====================================================
   HOME PAGE — game picker, create room, join room.
   Depends on: firebase-init.js, utils.js, ui.js,
               auth.js, room.js.

   To add a new game: add one entry to GAME_CONFIGS.
   ===================================================== */

// ── Game registry ─────────────────────────────────────────
// Add a new entry here for each new game.
const GAME_CONFIGS = {
  codenames: {
    slug:        'codenames',
    name:        'Código Secreto',
    icon:        '🕵️',
    description: 'Give one-word clues to lead your team to their secret agents.',
    players:     '4 – 8 players',
    gameUrl:     '/games/codenames/game.html',
    // HTML injected into the game card's settings row (host configures before creating)
    settingsHtml: `
      <label for="cn-lang">Language</label>
      <select id="cn-lang" class="select">
        <option value="en">English</option>
        <option value="es">Español</option>
      </select>
      <label for="cn-timer">Timer</label>
      <select id="cn-timer" class="select">
        <option value="0">Off</option>
        <option value="60">60 s</option>
        <option value="90" selected>90 s</option>
        <option value="120">120 s</option>
      </select>
    `,
    // Reads the settings form and returns a settings object for createRoom()
    collectSettings: () => ({
      language:     document.getElementById('cn-lang')?.value  || 'en',
      timerSeconds: parseInt(document.getElementById('cn-timer')?.value || '90', 10)
    })
  }
  // future games: add here
};

// ── Auth ──────────────────────────────────────────────────
onAuthReady(user => {
  if (user) {
    showPlay(user);
  } else {
    document.getElementById('signin-section').classList.remove('hidden');
    document.getElementById('play-section').classList.add('hidden');
  }
}, false /* don't redirect on home page */);

function showPlay(user) {
  document.getElementById('signin-section').classList.add('hidden');
  const ps = document.getElementById('play-section');
  ps.classList.remove('hidden');
  ps.style.display = 'flex';
  document.getElementById('user-name').textContent = user.displayName || 'Player';
  document.getElementById('user-photo').src        = user.photoURL    || '';
  renderGameCards();
}

document.getElementById('signin-btn').addEventListener('click', async () => {
  document.getElementById('signin-error').textContent = '';
  try { await signIn(); }
  catch (e) { document.getElementById('signin-error').textContent = e.message; }
});

document.getElementById('signout-btn').addEventListener('click', () => signOutUser());

// ── Game card rendering ───────────────────────────────────
function renderGameCards() {
  const grid = document.getElementById('games-grid');
  grid.innerHTML = Object.values(GAME_CONFIGS).map(g => `
    <div class="game-card">
      <div class="game-icon">${g.icon}</div>
      <div class="game-info">
        <div class="game-name">${esc(g.name)}</div>
        <div class="game-desc">${esc(g.description)}</div>
        <div class="game-meta">${esc(g.players)}</div>
        <div class="game-settings">${g.settingsHtml || ''}</div>
      </div>
      <div class="game-card-actions">
        <button class="btn btn-primary btn-sm" data-create="${g.slug}">Create</button>
      </div>
    </div>
  `).join('');

  // Bind create buttons
  grid.querySelectorAll('[data-create]').forEach(btn => {
    btn.addEventListener('click', () => handleCreate(btn.dataset.create));
  });
}

async function handleCreate(slug) {
  const cfg = GAME_CONFIGS[slug];
  if (!cfg) return;
  showLoading('Creating room…');
  try {
    const settings = cfg.collectSettings();
    await createRoom(slug, settings, cfg.gameUrl);
    // createRoom() navigates away on success
  } catch (e) {
    hideLoading();
    showToast(e.message, 'error');
  }
}

// ── Join room ─────────────────────────────────────────────
document.getElementById('join-btn').addEventListener('click', handleJoin);
document.getElementById('join-code').addEventListener('keydown', e => {
  if (e.key === 'Enter') handleJoin();
});
document.getElementById('join-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

async function handleJoin() {
  const code  = document.getElementById('join-code').value.trim().toUpperCase();
  const errEl = document.getElementById('join-error');
  errEl.textContent = '';
  if (code.length !== 4) { errEl.textContent = 'Enter a 4-letter code.'; return; }
  showLoading('Joining…');
  try {
    await joinRoom(code); // joinRoom navigates to the correct game page
  } catch (e) {
    hideLoading();
    errEl.textContent = e.message;
  }
}
