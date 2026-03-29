/* =====================================================
   Generic lobby — works for any game.
   Injects lobby HTML into #lobby-mount and handles:
     • team join / leave
     • spymaster role toggle
     • host settings (delegated to GAME.renderSettings)
     • start button (calls GAME.generateState → writes to Firebase)
     • play again / go home on the finished screen

   Depends on: firebase-init.js, auth.js, ui.js, utils.js.
   The GAME interface contract is documented in CLAUDE.md.
   ===================================================== */

let _roomCode, _game, _myUid, _isHost;
let _meta = {}, _players = {};

// ── Public API ────────────────────────────────────────────

// Call once from game.js after ensureInRoom().
// Subscribes to meta + players; routes screens; delegates to GAME hooks.
function initLobby(roomCode, game) {
  _roomCode = roomCode;
  _game     = game;
  _myUid    = currentUser().uid;

  _game.init(roomCode, _myUid);

  const ref = db.ref(`rooms/${roomCode}`);

  ref.child('meta').on('value', snap => {
    _meta    = snap.val() || {};
    _isHost  = _meta.hostUid === _myUid;

    hideLoading();

    if (_meta.status === 'lobby') {
      showScreen(['lobby-mount', 'game-area', 'finished'], 'lobby-mount');
      _renderLobby();
    } else if (_meta.status === 'playing') {
      showScreen(['lobby-mount', 'game-area', 'finished'], 'game-area');
      _game.onStatusChange('playing', _meta);
    } else if (_meta.status === 'finished') {
      showScreen(['lobby-mount', 'game-area', 'finished'], 'finished');
      _renderFinished();
      _game.onStatusChange('finished', _meta);
    }
  });

  ref.child('players').on('value', snap => {
    _players = snap.val() || {};
    if (_meta.status === 'lobby') _renderLobby();
    _game.onPlayersUpdate(_players, _meta);
  });
}

// ── Lobby rendering ───────────────────────────────────────

function _renderLobby() {
  const mount = document.getElementById('lobby-mount');
  if (!mount) return;
  mount.innerHTML = _buildLobbyHTML();
  _bindLobbyEvents();
}

function _buildLobbyHTML() {
  const me      = _players[_myUid] || {};
  const entries = Object.entries(_players);

  const redSpy  = entries.find(([,p]) => p.team === 'red'  && p.role === 'spymaster');
  const blueSpy = entries.find(([,p]) => p.team === 'blue' && p.role === 'spymaster');
  const redOps  = entries.filter(([,p]) => p.team === 'red'  && p.role !== 'spymaster');
  const blueOps = entries.filter(([,p]) => p.team === 'blue' && p.role !== 'spymaster');
  const unassigned = entries.filter(([,p]) => !p.team);

  const { valid, hint } = _game.lobbyValid(_players, _meta);
  const settingsHtml    = _isHost ? (_game.renderSettings(_meta) || '') : '';
  const hasSettings     = settingsHtml.trim() !== '';

  const chipFor = ([uid, p]) => `<div class="player-chip">${playerChip(p, uid === _myUid)}</div>`;

  return `
  <div class="lobby-body">
    <div class="share-row">
      <p>Share the room code with your friends.</p>
      <button id="share-btn" class="btn btn-ghost btn-sm">Share 🔗</button>
    </div>

    <div class="teams-grid">
      <div class="team-col team-red">
        <h4>🔴 Red Team</h4>
        <div class="spymaster-slot" id="red-spy-slot">
          ${redSpy
            ? `<div class="player-chip">${playerChip(redSpy[1], redSpy[0] === _myUid)}</div>
               <span class="spy-label">Spymaster</span>`
            : '<span style="opacity:.5;font-size:11px">Spymaster — empty</span>'}
        </div>
        <div class="operatives-list">
          ${redOps.map(chipFor).join('') || ''}
        </div>
      </div>

      <div class="team-col team-blue">
        <h4>🔵 Blue Team</h4>
        <div class="spymaster-slot" id="blue-spy-slot">
          ${blueSpy
            ? `<div class="player-chip">${playerChip(blueSpy[1], blueSpy[0] === _myUid)}</div>
               <span class="spy-label">Spymaster</span>`
            : '<span style="opacity:.5;font-size:11px">Spymaster — empty</span>'}
        </div>
        <div class="operatives-list">
          ${blueOps.map(chipFor).join('') || ''}
        </div>
      </div>
    </div>

    ${unassigned.length ? `
    <div style="margin-top:4px">
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Not on a team yet</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${unassigned.map(([uid, p]) =>
          `<div class="player-chip">${playerChip(p, uid === _myUid)}</div>`
        ).join('')}
      </div>
    </div>` : ''}

    <div class="lobby-actions">
      <div class="join-row">
        <button id="join-red-btn"  class="btn btn-red">${me.team === 'red'  ? '✓ Red' : 'Join Red'}</button>
        <button id="join-blue-btn" class="btn btn-blue">${me.team === 'blue' ? '✓ Blue' : 'Join Blue'}</button>
      </div>

      <div class="role-row">
        <div>
          <div style="font-weight:600">🕵️ Be Spymaster</div>
          <div class="role-hint">One per team. Gives clues, sees the key.</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="spy-toggle"
            ${me.role === 'spymaster' ? 'checked' : ''}
            ${!me.team ? 'disabled' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>

      ${hasSettings ? `
      <div id="game-settings-slot" class="settings-row">
        <span>⚙️</span>${settingsHtml}
      </div>` : ''}

      ${_isHost ? `
      <div class="start-area">
        <button id="start-btn" class="btn btn-primary btn-full" ${valid ? '' : 'disabled'}>
          Start Game
        </button>
        <p class="start-hint">${esc(hint)}</p>
      </div>` : `
      <p class="start-hint">Waiting for the host to start…</p>`}
    </div>
  </div>`;
}

function _bindLobbyEvents() {
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };

  on('share-btn',    'click', _shareRoom);
  on('join-red-btn', 'click', () => _joinTeam('red'));
  on('join-blue-btn','click', () => _joinTeam('blue'));

  on('spy-toggle', 'change', async e => {
    const newRole = e.target.checked ? 'spymaster' : 'operative';
    if (newRole === 'spymaster') {
      const me = _players[_myUid] || {};
      const conflict = Object.entries(_players).find(
        ([uid, p]) => uid !== _myUid && p.team === me.team && p.role === 'spymaster'
      );
      if (conflict) {
        e.target.checked = false;
        showToast('Each team can only have one spymaster.', 'error');
        return;
      }
    }
    await db.ref(`rooms/${_roomCode}/players/${_myUid}/role`).set(newRole);
  });

  on('start-btn', 'click', _startGame);

  // Delegate settings changes to the game
  const slot = document.getElementById('game-settings-slot');
  if (slot) {
    slot.addEventListener('change', e => _game.onSettingChange(e, _roomCode));
  }
}

async function _joinTeam(team) {
  await db.ref(`rooms/${_roomCode}/players/${_myUid}`).update({ team, role: 'operative' });
}

async function _startGame() {
  const { valid } = _game.lobbyValid(_players, _meta);
  if (!valid) return;
  showLoading('Starting game…');
  try {
    const updates = _game.generateState(_players, _meta);
    updates['meta/status']    = 'playing';
    updates['meta/winner']    = null;
    updates['meta/winReason'] = null;
    await db.ref(`rooms/${_roomCode}`).update(updates);
  } catch (err) {
    hideLoading();
    showToast(err.message, 'error');
  }
}

async function _shareRoom() {
  const url = `${location.origin}/games/${_meta.game}/game.html?room=${_roomCode}`;
  if (navigator.share) {
    await navigator.share({ title: 'Play with me!', url }).catch(() => {});
  } else {
    await copyText(url);
    showToast(`Link copied! Code: ${_roomCode}`);
  }
}

// ── Finished screen ───────────────────────────────────────

function _renderFinished() {
  const el = document.getElementById('finished-actions');
  if (!el) return;
  el.innerHTML = `
    ${_isHost
      ? `<button class="btn btn-primary" id="play-again-btn">Play Again</button>`
      : ''}
    <button class="btn btn-ghost" id="go-home-btn">← Home</button>
  `;
  const on = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener('click', fn); };
  on('play-again-btn', _playAgain);
  on('go-home-btn', () => { window.location.href = '/index.html'; });
}

async function _playAgain() {
  showLoading('Resetting…');
  const updates = _game.getResetUpdate(_players, _meta) || {};
  updates['meta/status']      = 'lobby';
  updates['meta/winner']      = null;
  updates['meta/winReason']   = null;
  updates['meta/currentTurn'] = null;
  updates['meta/timerEndsAt'] = null;
  // Reset all player roles to operative, keep teams
  Object.keys(_players).forEach(uid => {
    updates[`players/${uid}/role`] = 'operative';
  });
  await db.ref(`rooms/${_roomCode}`).update(updates);
}
