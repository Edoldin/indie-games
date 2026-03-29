/* =====================================================
   CODENAMES — game.js
   Implements the GAME interface consumed by lobby.js.

   Firebase paths owned by this game (under rooms/{code}/):
     board/words       — 25 words for this round
     board/revealed    — 25-element array (null or card type)
     scores/red|blue   — remaining agents per team
     clue/             — active clue: word, number, guessesLeft, givenBy
     clueHistory/      — log of all clues (for history sidebar)
     pendingGuess/     — operative writes; spymaster processes atomically
     private/keyCard   — 25-element array (readable by spymasters only)

   Security: keyCard is never sent to operative clients.
   Guess resolution uses a Firebase transaction on pendingGuess/claimedBy
   so only one spymaster processes each guess.
   ===================================================== */

// Wrapped in an IIFE so private variables don't clash with lobby.js globals.
(function () {

// ── Module state (reset in init) ─────────────────────────
let _roomCode, _myUid, _isHost;
let _myRole      = null;
let _myTeam      = null;
let _keyCard     = null;   // loaded for spymasters and tableside GM
let _isTableside = false;  // GM mode: 1 phone, host acts as neutral key-card holder
let _words    = [];
let _revealed = [];
let _scores   = { red: 9, blue: 8 };
let _meta     = {};
let _clue     = {};
let _pendingIdx      = null;
let _guessedThisTurn = false;
let _timerInterval   = null;
let _statsWritten    = false;

const $ = id => document.getElementById(id);

// ── GAME interface ────────────────────────────────────────
window.GAME = {

  name: 'Codenames',

  // ── Lobby hooks ────────────────────────────────────────

  renderSettings(meta) {
    const s  = meta.settings || {};
    const ts = !!s.tableside;
    return `
      <label for="cn-mode">Mode</label>
      <select id="cn-mode" class="select">
        <option value="0" ${!ts?'selected':''}>Online (teams with spymasters)</option>
        <option value="1" ${ts?'selected':''}>Tableside (1 phone, GM with key card)</option>
      </select>
      <label for="lang-sel">Language</label>
      <select id="lang-sel" class="select">
        <option value="en" ${(s.language||'en')==='en'?'selected':''}>English</option>
        <option value="es" ${s.language==='es'?'selected':''}>Español</option>
      </select>
      <label for="timer-sel">Timer</label>
      <select id="timer-sel" class="select">
        <option value="0"   ${(s.timerSeconds||90)===0  ?'selected':''}>Off</option>
        <option value="60"  ${s.timerSeconds===60 ?'selected':''}>60 s</option>
        <option value="90"  ${(s.timerSeconds===90||s.timerSeconds==null)?'selected':''}>90 s</option>
        <option value="120" ${s.timerSeconds===120?'selected':''}>120 s</option>
      </select>`;
  },

  onSettingChange(event, roomCode) {
    const id  = event.target.id;
    const val = event.target.value;
    if (id === 'cn-mode')   db.ref(`rooms/${roomCode}/meta/settings/tableside`).set(val === '1');
    if (id === 'lang-sel')  db.ref(`rooms/${roomCode}/meta/settings/language`).set(val);
    if (id === 'timer-sel') db.ref(`rooms/${roomCode}/meta/settings/timerSeconds`).set(parseInt(val, 10));
  },

  lobbyValid(players, meta) {
    const s = meta.settings || {};
    if (s.tableside) {
      const list = Object.values(players);
      return {
        valid: list.length >= 1,
        hint: list.length >= 1
          ? 'Game master ready — you hold the key card for both teams.'
          : 'Waiting for the game master to join.'
      };
    }
    const list      = Object.values(players);
    const redSpy    = list.filter(p => p.team === 'red'  && p.role === 'spymaster').length;
    const blueSpy   = list.filter(p => p.team === 'blue' && p.role === 'spymaster').length;
    const redCount  = list.filter(p => p.team === 'red').length;
    const blueCount = list.filter(p => p.team === 'blue').length;
    const valid     = redSpy >= 1 && blueSpy >= 1 && redCount >= 1 && blueCount >= 1;
    return {
      valid,
      hint: valid
        ? 'Both teams have a spymaster — ready to go!'
        : 'Need at least 1 player + 1 spymaster per team.'
    };
  },

  generateState(players, meta) {
    const settings  = meta.settings || {};
    const lang      = settings.language || 'en';
    const wordList  = lang === 'es' ? WORDS_ES : WORDS_EN;
    const words     = pickWords(wordList);
    const startTeam = Math.random() < 0.5 ? 'red' : 'blue';
    const keyCard   = generateKeyCard(startTeam);
    const scores    = { red: 8, blue: 8 };
    scores[startTeam] = 9;

    return {
      'board/words':      words,
      'board/revealed':   Array(25).fill(null),
      'scores':           scores,
      'clue':             { word: null, number: null, guessesLeft: 0, givenBy: null },
      'pendingGuess':     null,
      'clueHistory':      null,
      'private/keyCard':  keyCard,
      'meta/currentTurn': startTeam,
      'meta/startingTeam': startTeam
    };
  },

  // ── Lifecycle ───────────────────────────────────────────

  init(roomCode, myUid) {
    _roomCode = roomCode;
    _myUid    = myUid;

    // Copy-code button
    const ccBtn = $('copy-code-btn');
    if (ccBtn) ccBtn.addEventListener('click', _shareRoom);
  },

  onStatusChange(status, meta) {
    _meta        = meta;
    _isTableside = !!(meta.settings?.tableside);
    if (status === 'playing') {
      _guessedThisTurn = false;
      _pendingIdx      = null;
      _subscribeGame();
      // GM always loads the key card; spymasters load theirs
      if (_myRole === 'spymaster' || _isTableside) { if (!_keyCard) _loadKeyCard(); }
      _startTimer();
    }
    if (status === 'finished') {
      _stopTimer();
      _renderFinished();
      _writeStats(meta);
    }
  },

  onPlayersUpdate(players, meta) {
    _isTableside = !!(meta.settings?.tableside);
    const me = players[_myUid];
    if (me) {
      _myRole = me.role || 'operative';
      _myTeam = me.team || null;
    }
    // In tableside mode the host acts as GM regardless of lobby role assignment
    if (_isTableside) { _myRole = 'gm'; _myTeam = null; }
    if (_myRole === 'spymaster' && meta.status === 'playing' && !_keyCard) {
      _loadKeyCard();
    }
  },

  getResetUpdate(players) {
    const update = {
      'board':        null,
      'clue':         null,
      'scores':       null,
      'pendingGuess': null,
      'clueHistory':  null,
      'private':      null
    };
    _keyCard         = null;
    _words           = [];
    _revealed        = [];
    _guessedThisTurn = false;
    _pendingIdx      = null;
    _statsWritten    = false;
    _isTableside     = false;
    return update;
  }
};

// ── Game subscriptions ────────────────────────────────────
let _gameSubs = [];

function _subscribeGame() {
  // Clean up any previous subs
  _gameSubs.forEach(off => off());
  _gameSubs = [];

  const ref = db.ref(`rooms/${_roomCode}`);
  const sub = (path, handler) => {
    ref.child(path).on('value', handler);
    _gameSubs.push(() => ref.child(path).off('value', handler));
  };

  sub('board',        _onBoard);
  sub('clue',         _onClue);
  sub('scores',       _onScores);
  sub('pendingGuess', _onPendingGuess);
  sub('clueHistory',  _onClueHistory);
  sub('meta',         snap => { _meta = snap.val() || _meta; _renderActions(); _startTimer(); });
}

// ── Firebase handlers ─────────────────────────────────────

function _onBoard(snap) {
  const board = snap.val() || {};
  _words    = board.words    || [];
  _revealed = board.revealed || Array(25).fill(null);
  _renderGrid();
}

function _onClue(snap) {
  _clue = snap.val() || {};
  if (_clue.word) _guessedThisTurn = false;
  _renderClueDisplay();
  _renderActions();
}

function _onScores(snap) {
  _scores = snap.val() || { red: 9, blue: 8 };
  _renderScores();
}

function _onClueHistory(snap) {
  const history = snap.val();
  const wrap    = $('clue-history-wrap');
  const list    = $('clue-history-list');
  if (!history || !wrap || !list) return;
  const entries = Object.values(history).sort((a, b) => a.at - b.at);
  if (!entries.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  list.innerHTML = entries.map(e =>
    `<span class="clue-history-item ${e.team}">${esc(e.word)} <strong>${e.number}</strong></span>`
  ).join('');
}

function _onPendingGuess(snap) {
  const pg = snap.val();
  if (!pg) {
    // Guess resolved — clear local pending state
    _pendingIdx = null;
    $('pending-indicator')?.classList.add('hidden');
    _renderGrid();
    _renderActions();
    return;
  }
  // Show spinner for all operatives
  if (_myRole === 'operative') {
    _pendingIdx = pg.idx;
    $('pending-indicator')?.classList.remove('hidden');
    $('end-turn-btn')?.classList.add('hidden');
    _renderGrid();
  }
  // Active team's spymaster (or GM) processes the guess
  if ((_isTableside || (_myRole === 'spymaster' && _myTeam === _meta.currentTurn)) && _keyCard) {
    _processPendingGuess(pg);
  }
}

// ── Spymaster: key card + guess processing ────────────────

function _loadKeyCard() {
  db.ref(`rooms/${_roomCode}/private/keyCard`).once('value')
    .then(snap => {
      _keyCard = snap.val();
      _renderGrid(); // re-render with color overlays
    })
    .catch(() => {}); // permission denied for operatives — expected
}

function _processPendingGuess(pg) {
  // Claim atomically — only one spymaster wins
  db.ref(`rooms/${_roomCode}/pendingGuess/claimedBy`).transaction(
    current => (current !== null ? undefined : _myUid),
    (err, committed) => { if (!err && committed) _resolveGuess(pg.idx); }
  );
}

function _resolveGuess(idx) {
  const cardType   = _keyCard[idx];
  const turn       = _meta.currentTurn;
  const opp        = opposite(turn);
  const updates    = {};

  updates[`board/revealed/${idx}`] = cardType;

  if (cardType === 'assassin') {
    updates['meta/winner']    = opp;
    updates['meta/status']    = 'finished';
    updates['meta/winReason'] = 'assassin';
    _stopTimer();

  } else if (cardType === turn) {
    const newScore = (_scores[turn] || 1) - 1;
    updates[`scores/${turn}`] = newScore;
    if (newScore === 0) {
      updates['meta/winner']    = turn;
      updates['meta/status']    = 'finished';
      updates['meta/winReason'] = 'allFound';
      _stopTimer();
    } else {
      const left = (_clue.guessesLeft || 1) - 1;
      updates['clue/guessesLeft'] = left;
      if (left === 0) _applyEndTurn(updates, turn);
    }
  } else {
    if (cardType === opp) {
      const ns = (_scores[opp] || 1) - 1;
      updates[`scores/${opp}`] = ns;
      if (ns === 0) {
        updates['meta/winner']    = opp;
        updates['meta/status']    = 'finished';
        updates['meta/winReason'] = 'allFound';
        _stopTimer();
      }
    }
    if (!updates['meta/status']) _applyEndTurn(updates, turn);
  }

  updates['pendingGuess'] = null;
  db.ref(`rooms/${_roomCode}`).update(updates)
    .catch(e => showToast(e.message, 'error'));
}

function _applyEndTurn(updates, turn) {
  updates['clue/word']        = null;
  updates['clue/number']      = null;
  updates['clue/guessesLeft'] = 0;
  updates['clue/givenBy']     = null;
  updates['meta/currentTurn'] = opposite(turn);
  updates['meta/timerEndsAt'] = null;
}

// ── UI rendering ──────────────────────────────────────────

function _renderGrid() {
  const grid = $('card-grid');
  if (!grid || !_words.length) return;

  grid.innerHTML = '';
  _words.forEach((word, i) => {
    const div = document.createElement('div');
    div.className   = 'card';
    div.textContent = word;

    const rev = Array.isArray(_revealed) ? _revealed[i] : (_revealed && _revealed[i]);

    if (rev) {
      div.classList.add(`revealed-${rev}`);
    } else {
      if (_myRole === 'spymaster' && _keyCard?.[i]) {
        div.classList.add(`key-${_keyCard[i]}`);
      }
      if (_canGuess()) {
        div.classList.add('clickable');
        div.addEventListener('click', () => _handleCardClick(i));
      }
      if (_pendingIdx === i) div.classList.add('pending');
    }
    grid.appendChild(div);
  });
}

function _renderScores() {
  const r = $('score-red');
  const b = $('score-blue');
  if (r) r.textContent = _scores.red  ?? '?';
  if (b) b.textContent = _scores.blue ?? '?';
}

function _renderClueDisplay() {
  const el   = $('clue-display');
  const turn = _meta.currentTurn;
  if (!el) return;

  if (!_clue?.word) {
    const waiting = (turn === _myTeam && _myRole === 'spymaster')
      ? 'Give a clue to your team…'
      : 'Waiting for spymaster…';
    el.innerHTML = `<span style="color:var(--text-muted);font-size:13px">${waiting}</span>`;
    return;
  }
  el.innerHTML = `
    <span class="clue-word">${esc(_clue.word)}</span>
    <span class="clue-num">— ${_clue.number ?? '?'}</span>
    ${(_clue.guessesLeft > 0)
      ? `<span class="clue-left">${_clue.guessesLeft} guess${_clue.guessesLeft === 1 ? '' : 'es'} left</span>`
      : ''}`;
}

function _renderActions() {
  const turn       = _meta.currentTurn;
  const hasClue    = !!_clue?.word;
  const hasPending = _pendingIdx !== null;

  const endBtn   = $('end-turn-btn');
  const clueForm = $('clue-form');
  const hint     = $('action-hint');
  const bar      = $('turn-bar');

  if (bar) {
    bar.className   = `turn-bar turn-${turn || 'none'}`;
    bar.textContent = turn
      ? `${turn === 'red' ? '🔴 RED' : '🔵 BLUE'}'S TURN`
      : 'Waiting…';
  }

  if (!endBtn || !clueForm || !hint) return;
  endBtn.classList.add('hidden');
  clueForm.classList.add('hidden');
  hint.textContent = '';

  if (_isTableside) {
    // GM sees everything; clue form shows when no clue is active; guess controls always visible
    if (!hasClue) {
      clueForm.classList.remove('hidden');
      hint.textContent = `Give a clue for the ${turn?.toUpperCase() || ''} team.`;
    } else if (!hasPending && _canGuess()) {
      hint.textContent = `Tap a card to guess for ${turn?.toUpperCase() || 'the'} team.`;
      if (_guessedThisTurn) endBtn.classList.remove('hidden');
    } else if (hasPending) {
      hint.textContent = 'Processing guess…';
    }
  } else {
    const isMyTurn = turn === _myTeam && _myTeam !== null;
    if (_myRole === 'spymaster') {
      if (isMyTurn && !hasClue)  { clueForm.classList.remove('hidden'); hint.textContent = 'Give a one-word clue and a number.'; }
      else if (isMyTurn)          { hint.textContent = 'Your team is guessing…'; }
      else                        { hint.textContent = "Opponent's turn — stay expressionless!"; }
    } else {
      if (!isMyTurn)              { hint.textContent = "Opponent's turn."; }
      else if (!hasClue)          { hint.textContent = "Waiting for your spymaster\u2019s clue\u2026"; }
      else if (!hasPending && _canGuess()) {
        hint.textContent = 'Tap a card to guess.';
        if (_guessedThisTurn) endBtn.classList.remove('hidden');
      }
    }
  }
}

function _writeStats(meta) {
  if (_statsWritten) return;
  if (_isTableside) return; // no per-user stats for tableside GM games
  if (!meta.winner || !_myTeam) return;
  _statsWritten = true;
  const won = _myTeam === meta.winner;
  db.ref(`userStats/${_myUid}/codenames`).transaction(current => {
    const s = current || { gamesPlayed: 0, wins: 0 };
    return { gamesPlayed: s.gamesPlayed + 1, wins: s.wins + (won ? 1 : 0) };
  });
}

function _renderFinished() {
  const winner  = _meta.winner;
  const banner  = $('winner-banner');
  if (banner) {
    banner.className = `winner-banner ${winner || ''}`;
    const name = $('winner-name');
    if (name) { name.className = `team-name ${winner||''}`; name.textContent = winner ? `${winner.toUpperCase()} TEAM` : '—'; }
    const reasons = { assassin: 'Found the assassin!', allFound: 'All agents found!', timer: 'Time ran out!' };
    const r = $('winner-reason');
    if (r) r.textContent = reasons[_meta.winReason] || '';
  }

  // Mini board in #finished-extra
  const extra = $('finished-extra');
  if (extra && _words.length && _keyCard) {
    extra.innerHTML = `
      <div class="mini-board">
        <h4>Final board</h4>
        <div class="mini-card-grid">
          ${_words.map((w, i) => {
            const rev = Array.isArray(_revealed) ? _revealed[i] : (_revealed?.[i]);
            const cls = rev || _keyCard[i] || 'unrevealed';
            return `<div class="mini-card ${cls}">${esc(w)}</div>`;
          }).join('')}
        </div>
      </div>`;
  }
}

// ── Game actions ──────────────────────────────────────────

function _canGuess() {
  if (_isTableside) {
    // GM can guess on behalf of the active team whenever there's an active clue
    return !!_clue?.word && (_clue.guessesLeft || 0) > 0
      && _pendingIdx === null && _meta.status === 'playing';
  }
  return _myRole === 'operative'
    && _meta.currentTurn === _myTeam
    && _myTeam !== null
    && !!_clue?.word
    && (_clue.guessesLeft || 0) > 0
    && _pendingIdx === null
    && _meta.status === 'playing';
}

function _handleCardClick(idx) {
  if (!_canGuess()) return;
  _pendingIdx = idx;
  $('pending-indicator')?.classList.remove('hidden');
  $('end-turn-btn')?.classList.add('hidden');
  db.ref(`rooms/${_roomCode}/pendingGuess`).set({
    idx,
    byUid:     _myUid,
    claimedBy: null,
    at:        firebase.database.ServerValue.TIMESTAMP
  }).catch(e => {
    _pendingIdx = null;
    $('pending-indicator')?.classList.add('hidden');
    showToast(e.message, 'error');
  });
}

// End-turn button
document.addEventListener('click', e => {
  if (e.target.id === 'end-turn-btn') _doEndTurn();
  if (e.target.id === 'submit-clue-btn') _submitClue();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement?.id === 'clue-word') _submitClue();
});

async function _doEndTurn() {
  if (!_isTableside && (!_myTeam || _meta.currentTurn !== _myTeam)) return;
  $('end-turn-btn')?.classList.add('hidden');
  _guessedThisTurn = false;
  const updates = {};
  _applyEndTurn(updates, _myTeam);
  updates['pendingGuess'] = null;
  await db.ref(`rooms/${_roomCode}`).update(updates);
}

async function _submitClue() {
  const wordEl = $('clue-word');
  const numEl  = $('clue-num');
  const word   = wordEl?.value.trim().toUpperCase();
  const numRaw = numEl?.value;
  const number = numRaw === '∞' ? '∞' : parseInt(numRaw, 10);

  if (!word) { showToast('Enter a clue word.', 'error'); return; }
  if (_words.map(w => w.toUpperCase()).includes(word)) {
    showToast('Clue cannot be a word on the board!', 'error');
    return;
  }

  const guessesLeft = number === '∞' ? 999 : number + 1;
  const timerSecs   = _meta.settings?.timerSeconds || 0;
  const updates     = {
    clue: { word, number, guessesLeft, givenBy: _myUid, at: firebase.database.ServerValue.TIMESTAMP }
  };
  if (timerSecs > 0) updates['meta/timerEndsAt'] = Date.now() + timerSecs * 1000;

  const histKey = db.ref(`rooms/${_roomCode}/clueHistory`).push().key;
  updates[`clueHistory/${histKey}`] = { word, number, team: _isTableside ? _meta.currentTurn : _myTeam, at: Date.now() };

  await db.ref(`rooms/${_roomCode}`).update(updates);
  if (wordEl) wordEl.value = '';
}

// ── Timer ─────────────────────────────────────────────────

function _startTimer() {
  _stopTimer();
  const el = $('timer-display');
  if (!el) return;
  const timerSecs = _meta.settings?.timerSeconds || 0;
  if (!timerSecs) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');

  _timerInterval = setInterval(() => {
    const endsAt = _meta.timerEndsAt;
    if (!endsAt) { el.textContent = ''; el.className = 'timer-display ok'; return; }
    const rem  = endsAt - Date.now();
    if (rem <= 0) {
      el.textContent = '0s'; el.className = 'timer-display urgent';
      if (_myRole === 'operative' && _meta.currentTurn === _myTeam) {
        _stopTimer(); _doEndTurn();
      }
      return;
    }
    const s = Math.ceil(rem / 1000);
    el.textContent = `⏱ ${s}s`;
    el.className   = s <= 10 ? 'timer-display urgent' : s <= 20 ? 'timer-display warn' : 'timer-display ok';
  }, 500);
}

function _stopTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}

async function _shareRoom() {
  const url = `${location.origin}/games/codenames/game.html?room=${_roomCode}`;
  if (navigator.share) { await navigator.share({ title: 'Código Secreto', url }).catch(() => {}); }
  else { await copyText(url); showToast(`Link copied! Code: ${_roomCode}`); }
}

// ── Boot ──────────────────────────────────────────────────
onAuthReady(async user => {
  if (!user) return; // auth.js redirects to /index.html

  const roomCode = getRoomCode();
  if (!roomCode) { window.location.href = '/index.html'; return; }

  $('header-avatar').src                = user.photoURL || '';
  $('header-room-code').textContent     = roomCode;

  await ensureInRoom(roomCode);
  initLobby(roomCode, window.GAME);
});

})(); // end IIFE
