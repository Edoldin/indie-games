/* =====================================================
   CODENAMES — game.js
   Implements the GAME interface consumed by lobby.js.

   Firebase paths owned by this game (under rooms/{code}/):
     board/words       — 25 words for this round
     board/revealed    — 25-element array (null or card type)
     scores/red|blue   — remaining agents per team
     clue/             — active clue: word, number, guessesLeft, givenBy
     clueHistory/      — log of all clues (for history sidebar)
     pendingGuess/     — vote object: { votes:{uid:idx}, confirmations:{uid:true},
                         claimedBy:null, startedAt }
     private/keyCard   — 25-element array (readable by spymasters only)

   Voting flow:
     1. Operatives tap cards to cast/change their vote.
     2. Spymaster clicks "Confirm [CARD]" → immediately resolves top-voted card.
     3. Alternatively, ALL team members confirm → spymaster auto-resolves.
     4. Timer reaches 0: top-voted card resolves (or turn passes if tie/no votes).
   ===================================================== */

(function () {

// ── Module state ─────────────────────────────────────────
let _roomCode, _myUid;
let _myRole      = null;
let _myTeam      = null;
let _keyCard     = null;     // loaded for spymasters and tableside GM
let _isTableside = false;
let _words    = [];
let _revealed = [];
let _scores   = { red: 9, blue: 8 };
let _meta     = {};
let _clue     = {};
let _players       = {};     // full players snapshot (for confirmation checks)
let _myParticipates = false; // spymaster opted in to voting
let _pendingGuess = null;    // { votes:{uid:idx}, confirmations:{uid:true}, claimedBy, startedAt }
let _timerInterval = null;
let _statsWritten  = false;

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
    const list     = Object.values(players);
    const redSpy   = list.filter(p => p.team === 'red'  && p.role === 'spymaster').length;
    const blueSpy  = list.filter(p => p.team === 'blue' && p.role === 'spymaster').length;
    const redCount = list.filter(p => p.team === 'red').length;
    const blueCount= list.filter(p => p.team === 'blue').length;
    const valid    = redSpy >= 1 && blueSpy >= 1 && redCount >= 1 && blueCount >= 1;
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
      'board/words':       words,
      'board/revealed':    Array(25).fill(null),
      'scores':            scores,
      'clue':              { word: null, number: null, guessesLeft: 0, givenBy: null },
      'pendingGuess':      null,
      'clueHistory':       null,
      'private/keyCard':   keyCard,
      'meta/currentTurn':  startTeam,
      'meta/startingTeam': startTeam
    };
  },

  // ── Lifecycle ───────────────────────────────────────────

  init(roomCode, myUid) {
    _roomCode = roomCode;
    _myUid    = myUid;
    const ccBtn = $('copy-code-btn');
    if (ccBtn) ccBtn.addEventListener('click', _shareRoom);
  },

  onStatusChange(status, meta) {
    _meta         = meta;
    _isTableside  = !!(meta.settings?.tableside);
    _pendingGuess = null;
    if (status === 'playing') {
      _subscribeGame();
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
    _players     = players || {};
    _isTableside = !!(meta.settings?.tableside);
    const me = players[_myUid];
    if (me) {
      _myRole         = me.role       || 'operative';
      _myTeam         = me.team       || null;
      _myParticipates = !!me.participates;
    }
    if (_isTableside) { _myRole = 'gm'; _myTeam = null; }
    if (_myRole === 'spymaster' && meta.status === 'playing' && !_keyCard) {
      _loadKeyCard();
    }
  },

  getResetUpdate() {
    _keyCard        = null;
    _words          = [];
    _revealed       = [];
    _pendingGuess   = null;
    _players        = {};
    _myParticipates = false;
    _statsWritten   = false;
    _isTableside    = false;
    return {
      'board':        null,
      'clue':         null,
      'scores':       null,
      'pendingGuess': null,
      'clueHistory':  null,
      'private':      null
    };
  }
};

// ── Game subscriptions ────────────────────────────────────
let _gameSubs = [];

function _subscribeGame() {
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
  _pendingGuess = snap.val();
  if (!_pendingGuess) {
    _renderGrid();
    _renderActions();
    return;
  }

  // Spymaster/GM: check if all team members have confirmed → auto-process
  if (_keyCard && (_isTableside || (_myRole === 'spymaster' && _myTeam === _meta.currentTurn))) {
    const topIdx = _getTopVotedIdx();
    if (topIdx !== null && _allTeamMembersConfirmed()) {
      _processPendingGuess({ ..._pendingGuess, idx: topIdx });
      return;
    }
  }

  _renderGrid();
  _renderActions();
}

// ── Vote helpers ──────────────────────────────────────────

function _getVoteCounts() {
  const counts = {};
  Object.values(_pendingGuess?.votes || {}).forEach(idx => {
    counts[idx] = (counts[idx] || 0) + 1;
  });
  return counts;
}

// Returns the top-voted card index, or null if no votes or a tie.
function _getTopVotedIdx() {
  const counts  = _getVoteCounts();
  const entries = Object.entries(counts);
  if (!entries.length) return null;
  const maxCount = Math.max(...entries.map(([, c]) => c));
  const tops     = entries.filter(([, c]) => c === maxCount);
  return tops.length === 1 ? parseInt(tops[0][0], 10) : null;
}

// Returns uids of online players on the active team (incl. participating spymasters).
function _getActiveTeamPlayers() {
  return Object.entries(_players)
    .filter(([, p]) => {
      if (p.team !== _meta.currentTurn || p.online === false) return false;
      if (p.role === 'spymaster') return !!p.participates;
      return true;
    })
    .map(([uid]) => uid);
}

// True if every online active-team player has written a confirmation.
function _allTeamMembersConfirmed() {
  if (!_pendingGuess?.confirmations) return false;
  const team = _getActiveTeamPlayers();
  if (!team.length) return false;
  return team.every(uid => _pendingGuess.confirmations[uid]);
}

// ── Key card + guess processing ───────────────────────────

function _loadKeyCard() {
  db.ref(`rooms/${_roomCode}/private/keyCard`).once('value')
    .then(snap => { _keyCard = snap.val(); _renderGrid(); })
    .catch(() => {});
}

function _processPendingGuess(pg) {
  const btn = $('confirm-guess-btn');
  if (btn) btn.disabled = true;
  db.ref(`rooms/${_roomCode}/pendingGuess/claimedBy`).transaction(
    current => (current !== null ? undefined : _myUid),
    (err, committed) => {
      if (btn) btn.disabled = false;
      if (!err && committed) _resolveGuess(pg.idx);
    }
  );
}

function _resolveGuess(idx) {
  const cardType = _keyCard[idx];
  const turn     = _meta.currentTurn;
  const opp      = opposite(turn);
  const updates  = {};

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

  const votes   = _pendingGuess?.votes || {};
  const counts  = _getVoteCounts();
  const topIdx  = _getTopVotedIdx();
  const myVote  = (votes[_myUid] !== undefined) ? votes[_myUid] : null;

  // Collect which cards have a participating spymaster's vote
  const spyVotedCards = new Set();
  Object.entries(_players).forEach(([uid, p]) => {
    if (p.role === 'spymaster' && p.participates && votes[uid] !== undefined) {
      spyVotedCards.add(votes[uid]);
    }
  });

  grid.innerHTML = '';
  _words.forEach((word, i) => {
    const div = document.createElement('div');
    div.className   = 'card';
    div.textContent = word;

    const rev = Array.isArray(_revealed) ? _revealed[i] : (_revealed && _revealed[i]);

    if (rev) {
      div.classList.add(`revealed-${rev}`);
    } else {
      if ((_myRole === 'spymaster' || _isTableside) && _keyCard?.[i]) {
        div.classList.add(`key-${_keyCard[i]}`);
      }
      if (_canGuess()) {
        div.classList.add('clickable');
        div.addEventListener('click', () => _handleCardClick(i));
      }
      if (myVote === i) div.classList.add('my-vote');
      if (topIdx === i) div.classList.add('top-voted');
      if (counts[i] > 0) {
        const badge = document.createElement('span');
        badge.className = spyVotedCards.has(i) ? 'vote-badge spy-vote-badge' : 'vote-badge';
        badge.textContent = counts[i];
        div.appendChild(badge);
      }
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
    const isSpy = (_isTableside) || (turn === _myTeam && _myRole === 'spymaster');
    el.innerHTML = `<span style="color:var(--text-muted);font-size:13px">${
      isSpy ? 'Give a clue to your team\u2026' : 'Waiting for spymaster\u2026'
    }</span>`;
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
  const hasClue    = !!_clue?.word && (_clue.guessesLeft || 0) > 0;
  const topIdx     = _getTopVotedIdx();
  const voteCount  = Object.keys(_pendingGuess?.votes || {}).length;

  const endBtn      = $('end-turn-btn');
  const clueForm    = $('clue-form');
  const hint        = $('action-hint');
  const confirmBtn  = $('confirm-guess-btn');
  const pendingEl   = $('pending-indicator');
  const participBtn = $('toggle-participate-btn');
  const bar         = $('turn-bar');

  if (bar) {
    bar.className   = `turn-bar turn-${turn || 'none'}`;
    bar.textContent = turn
      ? `${turn === 'red' ? '🔴 RED' : '🔵 BLUE'}'S TURN`
      : 'Waiting\u2026';
  }

  if (!endBtn || !clueForm || !hint) return;

  // Reset
  endBtn.classList.add('hidden');
  clueForm.classList.add('hidden');
  confirmBtn?.classList.add('hidden');
  pendingEl?.classList.add('hidden');
  participBtn?.classList.add('hidden');
  hint.textContent = '';

  const isMyTurn    = _isTableside || (turn === _myTeam && _myTeam !== null);
  const isMyTurnSpy = isMyTurn && (_myRole === 'spymaster' || _isTableside);

  // ── Participate toggle (spymaster only, visible during guess phase) ──
  if (_myRole === 'spymaster' && hasClue && isMyTurn && participBtn) {
    participBtn.textContent = _myParticipates ? '👁 Leave voting' : '🗳 Join voting';
    participBtn.classList.remove('hidden');
  }

  // ── Clue phase ──
  if (!hasClue) {
    participBtn?.classList.add('hidden'); // hide toggle when no active clue
    if (isMyTurnSpy) {
      clueForm.classList.remove('hidden');
      hint.textContent = `Give a one-word clue for the ${turn?.toUpperCase() || ''} team.`;
    } else if (isMyTurn) {
      hint.textContent = 'Waiting for your spymaster\u2019s clue\u2026';
    } else {
      hint.textContent = 'Opponent\u2019s turn.';
    }
    return;
  }

  // ── Guess phase — not my team ──
  if (!isMyTurn) {
    hint.textContent = voteCount > 0
      ? `Opponents are voting (${voteCount} vote${voteCount !== 1 ? 's' : ''}\u2026)`
      : 'Opponent\u2019s turn \u2014 stay expressionless!';
    return;
  }

  // ── Guess phase — my team ──
  if (voteCount === 0) {
    hint.textContent = _isTableside
      ? `Tap a card to select the guess for ${turn?.toUpperCase()} team.`
      : 'Tap a card to cast your vote.';
    endBtn.classList.remove('hidden');
    return;
  }

  // Votes exist
  if (topIdx !== null) {
    const topWord      = esc(_words[topIdx]);
    const confirmCount = Object.keys(_pendingGuess?.confirmations || {}).length;
    const teamSize     = _getActiveTeamPlayers().length;
    const myConfirmed  = !!_pendingGuess?.confirmations?.[_myUid];

    if (confirmBtn) {
      if (isMyTurnSpy) {
        confirmBtn.textContent = `Confirm "${topWord}"`;
        confirmBtn.disabled    = false;
      } else {
        confirmBtn.textContent = myConfirmed ? 'Confirmed \u2713' : `Confirm "${topWord}"`;
        confirmBtn.disabled    = myConfirmed;
      }
      confirmBtn.classList.remove('hidden');
    }

    hint.textContent = isMyTurnSpy
      ? `${voteCount} vote${voteCount !== 1 ? 's' : ''} \u2014 you can confirm or let the team decide.`
      : `Top vote: \u201c${topWord}\u201d \u2014 ${confirmCount}/${teamSize} confirmed`;
  } else {
    // Tie
    hint.textContent = 'Tie vote! Players must agree on a card. Timer expiry will pass the turn.';
  }

  endBtn.classList.remove('hidden');
}

function _writeStats(meta) {
  if (_statsWritten) return;
  if (_isTableside)  return;
  if (!meta.winner || !_myTeam) return;
  _statsWritten = true;
  const won = _myTeam === meta.winner;
  db.ref(`userStats/${_myUid}/codenames`).transaction(current => {
    const s = current || { gamesPlayed: 0, wins: 0 };
    return { gamesPlayed: s.gamesPlayed + 1, wins: s.wins + (won ? 1 : 0) };
  });
}

function _renderFinished() {
  const winner = _meta.winner;
  const banner = $('winner-banner');
  if (banner) {
    banner.className = `winner-banner ${winner || ''}`;
    const name = $('winner-name');
    if (name) { name.className = `team-name ${winner||''}`; name.textContent = winner ? `${winner.toUpperCase()} TEAM` : '—'; }
    const reasons = { assassin: 'Found the assassin!', allFound: 'All agents found!', timer: 'Time ran out!' };
    const r = $('winner-reason');
    if (r) r.textContent = reasons[_meta.winReason] || '';
  }

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

// Can this player cast/change a vote?
function _canGuess() {
  if (_isTableside) {
    return !!_clue?.word && (_clue.guessesLeft || 0) > 0 && _meta.status === 'playing';
  }
  const canVote = _myRole === 'operative' || (_myRole === 'spymaster' && _myParticipates);
  return canVote
    && _meta.currentTurn === _myTeam
    && _myTeam !== null
    && !!_clue?.word
    && (_clue.guessesLeft || 0) > 0
    && _meta.status === 'playing';
}

function _handleCardClick(idx) {
  if (!_canGuess()) return;
  if (!_pendingGuess) {
    // First vote — create the pending guess object
    db.ref(`rooms/${_roomCode}/pendingGuess`).set({
      votes:         { [_myUid]: idx },
      confirmations: {},
      claimedBy:     null,
      startedAt:     firebase.database.ServerValue.TIMESTAMP
    }).catch(e => showToast(e.message, 'error'));
  } else {
    // Change vote
    db.ref(`rooms/${_roomCode}/pendingGuess/votes/${_myUid}`).set(idx)
      .catch(e => showToast(e.message, 'error'));
  }
}

async function _confirmGuess() {
  const topIdx = _getTopVotedIdx();
  if (topIdx === null) {
    // Tie or no votes: pass the turn
    _doEndTurn();
    return;
  }
  // Write confirmation so others can see consensus
  await db.ref(`rooms/${_roomCode}/pendingGuess/confirmations/${_myUid}`).set(true).catch(() => {});
  // Spymaster/GM immediately resolves
  if (_keyCard && (_isTableside || (_myRole === 'spymaster' && _myTeam === _meta.currentTurn))) {
    _processPendingGuess({ ..._pendingGuess, idx: topIdx });
  }
}

document.addEventListener('click', e => {
  if (e.target.id === 'end-turn-btn')          _doEndTurn();
  if (e.target.id === 'submit-clue-btn')        _submitClue();
  if (e.target.id === 'confirm-guess-btn')      _confirmGuess();
  if (e.target.id === 'toggle-participate-btn') _toggleParticipation();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement?.id === 'clue-word') _submitClue();
});

async function _toggleParticipation() {
  const newVal = !_myParticipates;
  await db.ref(`rooms/${_roomCode}/players/${_myUid}/participates`).set(newVal);
  // Remove vote when opting out
  if (!newVal && _pendingGuess?.votes?.[_myUid] !== undefined) {
    await db.ref(`rooms/${_roomCode}/pendingGuess/votes/${_myUid}`).remove().catch(() => {});
  }
}

async function _doEndTurn() {
  if (!_isTableside && (!_myTeam || _meta.currentTurn !== _myTeam)) return;
  $('end-turn-btn')?.classList.add('hidden');
  const updates = {};
  _applyEndTurn(updates, _isTableside ? _meta.currentTurn : _myTeam);
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
  updates[`clueHistory/${histKey}`] = {
    word, number,
    team: _isTableside ? _meta.currentTurn : _myTeam,
    at:   Date.now()
  };

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
    const rem = endsAt - Date.now();
    if (rem <= 0) {
      el.textContent = '0s'; el.className = 'timer-display urgent';
      _stopTimer();
      const isActive = _isTableside || _meta.currentTurn === _myTeam;
      if (!isActive) return;
      // Top-voted (no tie) → resolve; tie or no votes → pass turn
      const topIdx = _getTopVotedIdx();
      if (topIdx !== null && _keyCard) {
        _processPendingGuess({ ..._pendingGuess, idx: topIdx });
      } else if (topIdx !== null) {
        // Operative confirms; spymaster will process via _onPendingGuess
        db.ref(`rooms/${_roomCode}/pendingGuess/confirmations/${_myUid}`).set(true).catch(() => {});
      } else {
        // Tie or no votes — pass the turn
        _doEndTurn();
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
  if (!user) return;
  const roomCode = getRoomCode();
  if (!roomCode) { window.location.href = '/index.html'; return; }
  $('header-avatar').src            = user.photoURL || '';
  $('header-room-code').textContent = roomCode;
  await ensureInRoom(roomCode);
  initLobby(roomCode, window.GAME);
});

})(); // end IIFE
