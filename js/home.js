/* =====================================================
   HOME PAGE — game library, sign-in, stats, create/join.
   Depends on: firebase-init.js, utils.js, ui.js,
               auth.js, room.js.

   To add a new game: add one entry to GAME_CONFIGS.
   ===================================================== */

// ── Game registry ─────────────────────────────────────────
// status: 'live' | 'coming-soon'
const GAME_CONFIGS = {
  codenames: {
    slug:        'codenames',
    status:      'live',
    name:        'Código Secreto',
    icon:        '🕵️',
    description: 'Give one-word clues to lead your team to their secret agents.',
    players:     '2 – 8 players',
    gameUrl:     '/games/codenames/game.html',
    settingsHtml: `
      <label for="cn-lang" class="home-select-label">Language</label>
      <select id="cn-lang" class="form-select form-select-sm home-select">
        <option value="en">English</option>
        <option value="es">Español</option>
      </select>
      <label for="cn-timer" class="home-select-label">Timer</label>
      <select id="cn-timer" class="form-select form-select-sm home-select">
        <option value="0">Off</option>
        <option value="60">60 s</option>
        <option value="90" selected>90 s</option>
        <option value="120">120 s</option>
      </select>
    `,
    collectSettings: () => ({
      language:     document.getElementById('cn-lang')?.value  || 'en',
      timerSeconds: parseInt(document.getElementById('cn-timer')?.value || '90', 10)
    })
  },

  werewolves: {
    slug:        'werewolves',
    status:      'live',
    name:        'Werewolves',
    icon:        '🐺',
    description: 'Hidden roles, night kills, and village votes. Can the villagers root out the werewolves?',
    players:     '4 – 12 players',
    gameUrl:     '/games/werewolves/game.html',
    settingsHtml: '',
    collectSettings: () => ({})
  },

  wavelength: {
    slug:        'wavelength',
    status:      'coming-soon',
    name:        'Wavelength',
    icon:        '🌊',
    description: 'Guess where a concept lands on a hidden spectrum. One player knows the target, the rest must tune in.',
    players:     '2 – 12 players',
  },

  dixit: {
    slug:        'dixit',
    status:      'coming-soon',
    name:        'Dixit',
    icon:        '🃏',
    description: 'Tell a story about a card so some — but not all — players can guess which one it is.',
    players:     '3 – 6 players',
  },

  taboo: {
    slug:        'taboo',
    status:      'coming-soon',
    name:        'Taboo',
    icon:        '🚫',
    description: 'Describe words to your team without saying the obvious clues. Speed counts.',
    players:     '4 – 10 players',
  }
};

// ── Auth ──────────────────────────────────────────────────
onAuthReady(async user => {
  let stats = {};
  if (user) {
    try {
      const snap = await db.ref(`userStats/${user.uid}`).once('value');
      stats = snap.val() || {};
    } catch (_) { /* stats unavailable, show zeros */ }
    _showSignedIn(user, stats);
  } else {
    _showSignedOut();
  }
  _renderGameCards(user, stats);
}, false /* don't redirect on home page */);

// ── Auth state renderers ──────────────────────────────────

function _showSignedIn(user, stats) {
  const name = getDisplayName(user);

  // Navbar
  if (user.isAnonymous) {
    document.getElementById('nav-auth').innerHTML = `
      <span class="small fw-semibold">${esc(name)}</span>
      <button class="btn btn-outline-secondary btn-sm" id="signout-btn">Change name</button>
    `;
  } else {
    document.getElementById('nav-auth').innerHTML = `
      <img src="${esc(user.photoURL || '')}" alt="avatar"
        style="width:32px;height:32px;border-radius:50%;border:2px solid var(--border);object-fit:cover" />
      <span class="d-none d-sm-inline small fw-semibold">${esc(name)}</span>
      <button class="btn btn-outline-secondary btn-sm" id="signout-btn">Sign out</button>
    `;
  }
  document.getElementById('signout-btn').addEventListener('click', () => signOutUser());

  // Stats section (shown for all users — anonymous stats persist per browser)
  document.getElementById('user-photo').src = user.photoURL || '';
  document.getElementById('user-name-display').textContent = name;
  _renderStatsOverview(stats);
  document.getElementById('stats-section').classList.remove('hidden');
  document.getElementById('signin-prompt').classList.add('hidden');
}

function _showSignedOut() {
  // Navbar
  document.getElementById('nav-auth').innerHTML = `
    <button class="btn btn-primary btn-sm" id="signin-btn-nav">Sign in</button>
  `;
  document.getElementById('signin-btn-nav').addEventListener('click', () => {
    document.getElementById('signin-prompt')?.scrollIntoView({ behavior: 'smooth' });
    document.getElementById('player-name-input')?.focus();
  });

  // Show sign-in prompt
  document.getElementById('stats-section').classList.add('hidden');
  document.getElementById('signin-prompt').classList.remove('hidden');

  // Name-only sign-in
  const nameInput = document.getElementById('player-name-input');
  const playBtn   = document.getElementById('play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', _handlePlayAsName);
    nameInput?.addEventListener('keydown', e => { if (e.key === 'Enter') _handlePlayAsName(); });
  }

  // Google sign-in
  document.getElementById('signin-btn-main')?.addEventListener('click', _handleSignIn);
}

async function _handlePlayAsName() {
  const nameInput = document.getElementById('player-name-input');
  const errEl     = document.getElementById('signin-error');
  if (errEl) errEl.textContent = '';
  const name = nameInput?.value || '';
  try {
    showLoading('Joining…');
    await signInWithName(name);
    // onAuthStateChanged will fire and re-render via onAuthReady
  } catch (e) {
    hideLoading();
    if (errEl) errEl.textContent = e.message;
  }
}

async function _handleSignIn() {
  const errEl = document.getElementById('signin-error');
  if (errEl) errEl.textContent = '';
  try { await signIn(); }
  catch (e) {
    if (errEl) errEl.textContent = e.message;
  }
}

// ── Stats section ─────────────────────────────────────────

function _renderStatsOverview(stats) {
  let totalPlayed = 0, totalWins = 0;
  Object.values(GAME_CONFIGS)
    .filter(g => g.status === 'live')
    .forEach(g => {
      const s = stats[g.slug] || {};
      totalPlayed += s.gamesPlayed || 0;
      totalWins   += s.wins       || 0;
    });
  const winRate = totalPlayed > 0 ? Math.round(totalWins / totalPlayed * 100) : 0;

  document.getElementById('stats-overview').innerHTML = `
    <div class="col-4">
      <div class="card home-card text-center">
        <div class="card-body py-3 px-2">
          <div class="stat-number">${totalPlayed}</div>
          <div class="stat-label">Games</div>
        </div>
      </div>
    </div>
    <div class="col-4">
      <div class="card home-card text-center">
        <div class="card-body py-3 px-2">
          <div class="stat-number">${totalWins}</div>
          <div class="stat-label">Wins</div>
        </div>
      </div>
    </div>
    <div class="col-4">
      <div class="card home-card text-center">
        <div class="card-body py-3 px-2">
          <div class="stat-number">${winRate}%</div>
          <div class="stat-label">Win Rate</div>
        </div>
      </div>
    </div>
  `;
}

// ── Game card rendering ───────────────────────────────────

function _renderGameCards(user, stats) {
  const grid = document.getElementById('games-grid');
  grid.innerHTML = Object.values(GAME_CONFIGS)
    .map(g => _gameCardHtml(g, user, stats))
    .join('');

  grid.querySelectorAll('[data-create]').forEach(btn => {
    btn.addEventListener('click', () => _handleCreate(btn.dataset.create));
  });
  grid.querySelectorAll('[data-signin]').forEach(btn => {
    btn.addEventListener('click', _handleSignIn);
  });
}

function _gameCardHtml(g, user, stats) {
  const isLive = g.status === 'live';

  const statusBadge = isLive
    ? '<span class="badge bg-success ms-2 game-status-badge">Live</span>'
    : '<span class="badge bg-warning text-dark ms-2 game-status-badge">Coming Soon</span>';

  // Per-game stats (only for live games when signed in)
  const gs = stats?.[g.slug] || {};
  const played  = gs.gamesPlayed || 0;
  const wins    = gs.wins || 0;
  const winPct  = played > 0 ? Math.round(wins / played * 100) : 0;
  const statsRow = (user && isLive && played > 0)
    ? `<p class="game-card-stats">${played} played &middot; ${wins} won &middot; ${winPct}% win rate</p>`
    : '';

  // Footer actions
  let footer = '';
  if (!isLive) {
    footer = '';
  } else if (user) {
    footer = `
      <div class="game-card-footer mt-auto pt-3">
        ${g.settingsHtml ? `<div class="d-flex flex-wrap align-items-center gap-2 mb-3">${g.settingsHtml}</div>` : ''}
        <button class="btn btn-primary btn-sm w-100" data-create="${g.slug}">Create Room</button>
      </div>
    `;
  } else {
    footer = `
      <div class="game-card-footer mt-auto pt-3">
        <button class="btn btn-outline-secondary btn-sm w-100" data-signin="1">Sign in to play</button>
      </div>
    `;
  }

  return `
    <div class="col-12 col-md-6 col-xl-4">
      <div class="card home-card h-100 game-card-home${isLive ? '' : ' game-card-dimmed'}">
        <div class="card-body d-flex flex-column">
          <div class="d-flex gap-3 mb-2">
            <div class="game-icon-home">${g.icon}</div>
            <div class="flex-fill">
              <div class="d-flex align-items-baseline flex-wrap gap-1">
                <span class="game-name-home">${esc(g.name)}</span>
                ${statusBadge}
              </div>
              <p class="text-muted small mb-1 mt-1">${esc(g.description)}</p>
              <small class="text-muted" style="font-size:11px">${esc(g.players)}</small>
            </div>
          </div>
          ${statsRow}
          ${footer}
        </div>
      </div>
    </div>
  `;
}

// ── Create room ───────────────────────────────────────────

async function _handleCreate(slug) {
  const cfg = GAME_CONFIGS[slug];
  if (!cfg) return;
  showLoading('Creating room…');
  try {
    const settings = cfg.collectSettings();
    await createRoom(slug, settings, cfg.gameUrl);
  } catch (e) {
    hideLoading();
    showToast(e.message, 'error');
  }
}

// ── Join room ─────────────────────────────────────────────

document.getElementById('join-btn').addEventListener('click', _handleJoin);
document.getElementById('join-code').addEventListener('keydown', e => {
  if (e.key === 'Enter') _handleJoin();
});
document.getElementById('join-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

async function _handleJoin() {
  const code  = document.getElementById('join-code').value.trim().toUpperCase();
  const errEl = document.getElementById('join-error');
  errEl.textContent = '';
  if (code.length !== 4) { errEl.textContent = 'Enter a 4-letter code.'; return; }
  showLoading('Joining…');
  try {
    await joinRoom(code);
  } catch (e) {
    hideLoading();
    errEl.textContent = e.message;
  }
}
