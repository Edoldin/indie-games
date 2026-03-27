/* =====================================================
   CÓDIGO SECRETO — Game page logic
   Security model: keyCard is stored under /private/keyCard
   and is only readable by players with role=spymaster
   (enforced via Firebase rules). Operatives write a
   pendingGuess; the active-team spymaster processes it
   atomically, preventing double-processing via transaction.
   ===================================================== */

// ── State ────────────────────────────────────────────────
let roomCode   = null;
let myUid      = null;
let myRole     = null;   // 'spymaster' | 'operative'
let myTeam     = null;   // 'red' | 'blue' | null
let isHost     = false;
let keyCard    = null;   // only loaded for spymasters
let words      = [];     // 25 words for this game
let revealed   = [];     // 25-element array: null or card type string
let scores     = { red: 9, blue: 8 };
let meta       = {};
let clue       = {};
let players    = {};
let timerInterval = null;
let hasGuessedThisTurn = false;
let pendingIdx = null;   // index currently being processed

// DOM refs
const $ = id => document.getElementById(id);

// ── Bootstrap ────────────────────────────────────────────
auth.onAuthStateChanged(user => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  myUid = user.uid;
  $('header-avatar').src = user.photoURL || '';

  roomCode = new URLSearchParams(location.search).get('room');
  if (!roomCode) { window.location.href = 'index.html'; return; }

  $('header-room-code').textContent = roomCode;
  ensureInRoom(user).then(subscribeAll);
});

async function ensureInRoom(user) {
  const snap = await db.ref(`rooms/${roomCode}/players/${myUid}`).once('value');
  if (!snap.exists()) {
    // Player arrived via direct link — add them with no team
    await db.ref(`rooms/${roomCode}/players/${myUid}`).set({
      name:     user.displayName || 'Player',
      photoURL: user.photoURL   || '',
      team:     null,
      role:     'operative',
      online:   true,
      joinedAt: firebase.database.ServerValue.TIMESTAMP
    });
  } else {
    await db.ref(`rooms/${roomCode}/players/${myUid}/online`).set(true);
  }
  // Mark offline on disconnect
  db.ref(`rooms/${roomCode}/players/${myUid}/online`).onDisconnect().set(false);
}

// ── Firebase subscriptions ───────────────────────────────
function subscribeAll() {
  const ref = db.ref(`rooms/${roomCode}`);

  ref.child('meta').on('value',    onMeta);
  ref.child('players').on('value', onPlayers);
  ref.child('board').on('value',   onBoard);
  ref.child('clue').on('value',    onClue);
  ref.child('scores').on('value',  onScores);
  ref.child('pendingGuess').on('value', onPendingGuess);
  ref.child('clueHistory').on('value',  onClueHistory);
}

// ── Handlers ─────────────────────────────────────────────
function onMeta(snap) {
  meta = snap.val() || {};
  isHost = meta.hostUid === myUid;

  hideLoading();

  if (meta.status === 'lobby')    { showScreen('lobby');    renderLobby(); }
  if (meta.status === 'playing')  { showScreen('board');    renderBoard(); }
  if (meta.status === 'finished') { showScreen('finished'); renderFinished(); }
}

function onPlayers(snap) {
  players = snap.val() || {};

  // Update local role/team from DB (source of truth)
  const me = players[myUid];
  if (me) {
    myRole = me.role || 'operative';
    myTeam = me.team || null;
  }

  if (meta.status === 'lobby')   renderLobby();
  if (meta.status === 'playing') renderActions();

  // Load keyCard once we know we're a spymaster and game is playing
  if (myRole === 'spymaster' && meta.status === 'playing' && !keyCard) {
    loadKeyCard();
  }
}

function onBoard(snap) {
  const board = snap.val() || {};
  words    = board.words    || [];
  revealed = board.revealed || Array(25).fill(null);
  if (meta.status === 'playing')  renderGrid();
  if (meta.status === 'finished') renderMiniBoard();
}

function onClue(snap) {
  clue = snap.val() || {};
  if (meta.status === 'playing') {
    renderClueDisplay();
    renderActions();
    if (clue.word) hasGuessedThisTurn = false;
  }
}

function onScores(snap) {
  scores = snap.val() || { red: 9, blue: 8 };
  if (meta.status === 'playing') renderScores();
}

function onClueHistory(snap) {
  const history = snap.val();
  if (!history || meta.status !== 'playing') return;
  const list = $('clue-history-list');
  const wrap = $('clue-history-wrap');
  const entries = Object.values(history).sort((a, b) => a.at - b.at);
  if (!entries.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  list.innerHTML = entries.map(e =>
    `<span class="clue-history-item ${e.team}">${e.word} <strong>${e.number}</strong></span>`
  ).join('');
}

function onPendingGuess(snap) {
  const pg = snap.val();
  if (!pg) {
    // Guess was processed — clear pending state
    pendingIdx = null;
    $('pending-indicator').classList.add('hidden');
    renderGrid();
    renderActions();
    return;
  }

  // Show waiting spinner for operatives
  if (myRole === 'operative') {
    pendingIdx = pg.idx;
    $('pending-indicator').classList.remove('hidden');
    $('end-turn-btn').classList.add('hidden');
    renderGrid(); // re-render to show pending state on clicked card
  }

  // Spymasters: try to claim and process the guess
  if (myRole === 'spymaster' && myTeam === meta.currentTurn && keyCard) {
    processPendingGuess(pg);
  }
}

// ── Spymaster: load key card ─────────────────────────────
function loadKeyCard() {
  db.ref(`rooms/${roomCode}/private/keyCard`).once('value')
    .then(snap => {
      keyCard = snap.val();
      renderGrid(); // re-render with color overlays
    })
    .catch(() => {}); // non-spymasters will get permission denied — that's expected
}

// ── Spymaster: process pending guess (atomic via transaction) ──
function processPendingGuess(pg) {
  // Use a transaction on pendingGuess/claimedBy to prevent double-processing
  const claimRef = db.ref(`rooms/${roomCode}/pendingGuess/claimedBy`);

  claimRef.transaction(current => {
    if (current !== null) return; // already claimed — abort
    return myUid;
  }, (error, committed) => {
    if (!committed || error) return;
    // We have exclusive ownership — resolve the guess
    resolveGuess(pg.idx);
  });
}

function resolveGuess(idx) {
  const cardType    = keyCard[idx];
  const myOpp       = opposite(myTeam);
  const currentTurn = meta.currentTurn;
  const updates     = {};

  // Reveal the card
  updates[`board/revealed/${idx}`] = cardType;

  if (cardType === 'assassin') {
    // Immediate loss for the guessing team
    updates['meta/winner']  = myOpp;
    updates['meta/status']  = 'finished';
    updates['meta/winReason'] = 'assassin';
    stopTimer();

  } else if (cardType === currentTurn) {
    // Correct guess — own team's agent
    const newScore = (scores[currentTurn] || 1) - 1;
    updates[`scores/${currentTurn}`] = newScore;
    hasGuessedThisTurn = true;

    if (newScore === 0) {
      updates['meta/winner']    = currentTurn;
      updates['meta/status']    = 'finished';
      updates['meta/winReason'] = 'allFound';
      stopTimer();
    } else {
      const newLeft = (clue.guessesLeft || 1) - 1;
      updates['clue/guessesLeft'] = newLeft;
      if (newLeft === 0) {
        endTurnUpdates(updates, currentTurn);
      }
    }

  } else {
    // Wrong guess — opponent agent or bystander
    if (cardType === myOpp) {
      const newOppScore = (scores[myOpp] || 1) - 1;
      updates[`scores/${myOpp}`] = newOppScore;
      if (newOppScore === 0) {
        updates['meta/winner']    = myOpp;
        updates['meta/status']    = 'finished';
        updates['meta/winReason'] = 'allFound';
        stopTimer();
      }
    }
    if (!updates['meta/status']) {
      endTurnUpdates(updates, currentTurn);
    }
  }

  updates['pendingGuess'] = null;

  db.ref(`rooms/${roomCode}`).update(updates).catch(err => showToast(err.message, 'error'));
}

function endTurnUpdates(updates, currentTurn) {
  updates['clue/word']       = null;
  updates['clue/number']     = null;
  updates['clue/guessesLeft'] = 0;
  updates['clue/givenBy']    = null;
  updates['meta/currentTurn'] = opposite(currentTurn);
  updates['meta/timerEndsAt'] = null;
}

// ── Lobby rendering ───────────────────────────────────────
function renderLobby() {
  const redSpySlot  = $('red-spy-slot');
  const blueSpySlot = $('blue-spy-slot');
  const redOps      = $('red-ops-list');
  const blueOps     = $('blue-ops-list');
  const unRow       = $('unassigned-row');
  const unList      = $('unassigned-list');

  redSpySlot.innerHTML  = '<span style="opacity:0.5;font-size:11px">Spymaster — empty</span>';
  blueSpySlot.innerHTML = '<span style="opacity:0.5;font-size:11px">Spymaster — empty</span>';
  redOps.innerHTML  = '';
  blueOps.innerHTML = '';
  unList.innerHTML  = '';

  let hasUnassigned = false;

  Object.entries(players).forEach(([uid, p]) => {
    const isMe   = uid === myUid;
    const chip   = playerChip(p, isMe);

    if (!p.team) {
      unList.innerHTML += chip;
      hasUnassigned = true;
      return;
    }

    if (p.role === 'spymaster') {
      const slot = p.team === 'red' ? redSpySlot : blueSpySlot;
      slot.innerHTML = `<div class="player-chip">${chip}</div>`;
    } else {
      const list = p.team === 'red' ? redOps : blueOps;
      list.innerHTML += `<div class="player-chip">${chip}</div>`;
    }
  });

  unRow.style.display = hasUnassigned ? '' : 'none';

  // My controls
  const me = players[myUid] || {};
  $('spy-toggle').checked  = me.role === 'spymaster';
  $('spy-toggle').disabled = !myTeam; // can't be spy without a team

  // Settings: host only
  const settingsRow = $('settings-row');
  if (isHost) {
    settingsRow.classList.remove('hidden');
    $('lang-select').value  = meta.language     || 'en';
    $('timer-select').value = String(meta.timerSeconds || 0);
  } else {
    settingsRow.classList.add('hidden');
  }

  // Start button: host only
  const startArea   = $('start-area');
  const waitingHint = $('waiting-hint');
  if (isHost) {
    startArea.classList.remove('hidden');
    waitingHint.classList.add('hidden');
    const canStart = lobbyValid();
    $('start-btn').disabled = !canStart;
    $('start-hint').textContent = canStart
      ? 'Both teams have a spymaster — ready to go!'
      : 'Need at least 1 player per team with a spymaster each.';
  } else {
    startArea.classList.add('hidden');
    waitingHint.classList.remove('hidden');
  }
}

function playerChip(p, isMe) {
  return `
    <img src="${p.photoURL || ''}" alt="" style="width:22px;height:22px;border-radius:50%;object-fit:cover;flex-shrink:0" />
    <span class="chip-name">${esc(p.name)}</span>
    ${isMe ? '<span class="chip-you">(you)</span>' : ''}
  `;
}

function lobbyValid() {
  const redSpyCount  = Object.values(players).filter(p => p.team === 'red'  && p.role === 'spymaster').length;
  const blueSpyCount = Object.values(players).filter(p => p.team === 'blue' && p.role === 'spymaster').length;
  const redCount     = Object.values(players).filter(p => p.team === 'red').length;
  const blueCount    = Object.values(players).filter(p => p.team === 'blue').length;
  return redSpyCount >= 1 && blueSpyCount >= 1 && redCount >= 1 && blueCount >= 1;
}

// ── Board rendering ───────────────────────────────────────
function renderBoard() {
  renderGrid();
  renderScores();
  renderClueDisplay();
  renderTurnBar();
  renderActions();
  startTimer();
}

function renderGrid() {
  const grid = $('card-grid');
  if (!words.length) return;

  grid.innerHTML = '';
  words.forEach((word, i) => {
    const div = document.createElement('div');
    div.className = 'card';
    div.dataset.index = i;
    div.textContent = word;

    const rev = Array.isArray(revealed) ? revealed[i] : (revealed && revealed[i]);

    if (rev) {
      div.classList.add(`revealed-${rev}`);
    } else {
      // Spymaster key card overlay
      if (myRole === 'spymaster' && keyCard && keyCard[i]) {
        div.classList.add(`key-${keyCard[i]}`);
      }
      // Clickable if operative, my turn, active clue, guesses left, no pending
      if (canGuess()) {
        div.classList.add('clickable');
        div.addEventListener('click', () => handleCardClick(i));
      }
      // Pending state
      if (pendingIdx === i) {
        div.classList.add('pending');
      }
    }

    grid.appendChild(div);
  });
}

function renderScores() {
  $('score-red').textContent  = scores.red  ?? '?';
  $('score-blue').textContent = scores.blue ?? '?';
}

function renderTurnBar() {
  const bar = $('turn-bar');
  const turn = meta.currentTurn;
  bar.className = `turn-bar turn-${turn || 'none'}`;
  if (!turn) { bar.textContent = 'Waiting…'; return; }
  const isMy = turn === myTeam;
  const label = turn === 'red' ? '🔴 RED' : '🔵 BLUE';
  bar.textContent = `${label}${isMy ? ' — YOUR TURN' : "'S TURN"}`;
}

function renderClueDisplay() {
  const el   = $('clue-display');
  const turn = meta.currentTurn;

  if (!clue || !clue.word) {
    const isMy = turn === myTeam;
    if (isMy && myRole === 'spymaster') {
      el.innerHTML = '<span style="color:var(--text-muted);font-size:13px">Give a clue to your team…</span>';
    } else {
      el.innerHTML = '<span style="color:var(--text-muted);font-size:13px">Waiting for spymaster…</span>';
    }
    return;
  }

  el.innerHTML = `
    <span class="clue-word">${esc(clue.word)}</span>
    <span class="clue-num">— ${clue.number ?? '?'}</span>
    ${clue.guessesLeft > 0
      ? `<span class="clue-left">${clue.guessesLeft} guess${clue.guessesLeft === 1 ? '' : 'es'} left</span>`
      : ''}
  `;
}

function renderActions() {
  const isMyTurn       = meta.currentTurn === myTeam && myTeam !== null;
  const hasActiveClue  = !!(clue && clue.word);
  const guessesLeft    = clue ? (clue.guessesLeft || 0) : 0;
  const hasPending     = pendingIdx !== null;

  const endBtn    = $('end-turn-btn');
  const clueForm  = $('clue-form');
  const hintEl    = $('action-hint');

  endBtn.classList.add('hidden');
  clueForm.classList.add('hidden');
  hintEl.textContent = '';

  if (meta.status !== 'playing') return;

  if (myRole === 'spymaster') {
    if (isMyTurn && !hasActiveClue) {
      clueForm.classList.remove('hidden');
      hintEl.textContent = 'Give a one-word clue and a number.';
    } else if (isMyTurn && hasActiveClue) {
      hintEl.textContent = 'Your team is guessing…';
    } else {
      hintEl.textContent = "Opponent's turn — stay expressionless!";
    }
  } else {
    // Operative
    if (!isMyTurn) {
      hintEl.textContent = "Opponent's turn.";
    } else if (!hasActiveClue) {
      hintEl.textContent = 'Waiting for your spymaster's clue…';
    } else if (hasPending) {
      // pending-indicator handles this
    } else if (canGuess()) {
      hintEl.textContent = 'Tap a card to guess.';
      if (hasGuessedThisTurn) {
        endBtn.classList.remove('hidden');
      }
    } else if (guessesLeft === 0 && hasActiveClue) {
      hintEl.textContent = 'No more guesses — waiting for spymaster to end turn.';
    }
  }

  renderTurnBar();
}

function canGuess() {
  return myRole === 'operative'
    && meta.currentTurn === myTeam
    && myTeam !== null
    && !!(clue && clue.word)
    && (clue.guessesLeft || 0) > 0
    && pendingIdx === null
    && meta.status === 'playing';
}

// ── Finished rendering ────────────────────────────────────
function renderFinished() {
  stopTimer();

  const winner = meta.winner;
  const banner = $('winner-banner');
  banner.className = `winner-banner ${winner || ''}`;

  $('winner-name').className   = `team-name ${winner || ''}`;
  $('winner-name').textContent = winner ? `${winner.toUpperCase()} TEAM` : '—';

  const reasons = {
    assassin: 'Found the assassin!',
    allFound:  'All agents found!',
    timer:     'Time ran out!'
  };
  $('winner-reason').textContent = reasons[meta.winReason] || '';

  // Show play again only for host
  $('play-again-btn').classList.toggle('hidden', !isHost);

  renderMiniBoard();
}

function renderMiniBoard() {
  const grid = $('mini-card-grid');
  if (!words.length || !keyCard) return;
  grid.innerHTML = words.map((word, i) => {
    const rev = Array.isArray(revealed) ? revealed[i] : (revealed && revealed[i]);
    const cls = rev || keyCard[i] || 'unrevealed';
    return `<div class="mini-card ${cls}">${esc(word)}</div>`;
  }).join('');
}

// ── Timer ─────────────────────────────────────────────────
function startTimer() {
  stopTimer();
  const display = $('timer-display');
  if (!meta.timerSeconds || meta.timerSeconds === 0) {
    display.classList.add('hidden');
    return;
  }
  display.classList.remove('hidden');

  timerInterval = setInterval(() => {
    const endsAt = meta.timerEndsAt;
    if (!endsAt) { display.textContent = ''; display.className = 'timer-display ok'; return; }

    const remaining = endsAt - Date.now();
    if (remaining <= 0) {
      display.textContent = '0s';
      display.className = 'timer-display urgent';
      // Auto end turn when timer expires (only operative's perspective)
      if (myRole === 'operative' && meta.currentTurn === myTeam) {
        stopTimer();
        doEndTurn();
      }
      return;
    }
    const secs = Math.ceil(remaining / 1000);
    display.textContent = `⏱ ${secs}s`;
    display.className = secs <= 10 ? 'timer-display urgent'
                      : secs <= 20 ? 'timer-display warn'
                      : 'timer-display ok';
  }, 500);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Lobby actions ─────────────────────────────────────────
$('join-red-btn').addEventListener('click', () => joinTeam('red'));
$('join-blue-btn').addEventListener('click', () => joinTeam('blue'));

async function joinTeam(team) {
  await db.ref(`rooms/${roomCode}/players/${myUid}`).update({ team, role: 'operative' });
}

$('spy-toggle').addEventListener('change', async e => {
  const newRole = e.target.checked ? 'spymaster' : 'operative';

  // Check if another spymaster already exists on this team
  if (newRole === 'spymaster') {
    const existing = Object.entries(players).find(
      ([uid, p]) => uid !== myUid && p.team === myTeam && p.role === 'spymaster'
    );
    if (existing) {
      e.target.checked = false;
      showToast('Each team can only have one spymaster.', 'error');
      return;
    }
  }
  await db.ref(`rooms/${roomCode}/players/${myUid}/role`).set(newRole);
});

// Settings (host only)
$('lang-select').addEventListener('change',  e => db.ref(`rooms/${roomCode}/meta/language`).set(e.target.value));
$('timer-select').addEventListener('change', e => db.ref(`rooms/${roomCode}/meta/timerSeconds`).set(parseInt(e.target.value)));

$('start-btn').addEventListener('click', startGame);

async function startGame() {
  if (!lobbyValid()) return;
  showLoading('Starting game…');

  const lang   = meta.language     || 'en';
  const wordList = lang === 'es' ? WORDS_ES : WORDS_EN;
  const gameWords = pickWords(wordList);

  // Coin-flip for starting team
  const startTeam = Math.random() < 0.5 ? 'red' : 'blue';
  const kc        = generateKeyCard(startTeam);

  const startScores = { red: 8, blue: 8 };
  startScores[startTeam] = 9;

  const updates = {
    'meta/status':       'playing',
    'meta/currentTurn':  startTeam,
    'meta/startingTeam': startTeam,
    'meta/winner':       null,
    'meta/winReason':    null,
    'meta/timerEndsAt':  null,
    'board/words':       gameWords,
    'board/revealed':    Array(25).fill(null),
    'scores':            startScores,
    'clue':              { word: null, number: null, guessesLeft: 0, givenBy: null },
    'pendingGuess':      null,
    'clueHistory':       null,
    'private/keyCard':   kc
  };

  await db.ref(`rooms/${roomCode}`).update(updates);
}

// ── Game actions ──────────────────────────────────────────
$('share-btn').addEventListener('click', shareRoom);
$('copy-code-btn').addEventListener('click', shareRoom);

async function shareRoom() {
  const url = `${location.origin}${location.pathname}?room=${roomCode}`;
  if (navigator.share) {
    await navigator.share({ title: 'Código Secreto', text: `Join room ${roomCode}`, url });
  } else {
    await copyText(url);
    showToast(`Link copied! Room: ${roomCode}`);
  }
}

$('end-turn-btn').addEventListener('click', doEndTurn);

async function doEndTurn() {
  if (!myTeam || meta.currentTurn !== myTeam) return;
  $('end-turn-btn').classList.add('hidden');
  hasGuessedThisTurn = false;

  const updates = {
    'clue/word':        null,
    'clue/number':      null,
    'clue/guessesLeft': 0,
    'clue/givenBy':     null,
    'meta/currentTurn': opposite(myTeam),
    'meta/timerEndsAt': null,
    'pendingGuess':     null
  };
  await db.ref(`rooms/${roomCode}`).update(updates);
}

$('submit-clue-btn').addEventListener('click', submitClue);
$('clue-word').addEventListener('keydown', e => { if (e.key === 'Enter') submitClue(); });

async function submitClue() {
  const wordInput = $('clue-word');
  const numSelect = $('clue-num');
  const word      = wordInput.value.trim().toUpperCase();
  const numRaw    = numSelect.value;
  const number    = numRaw === '∞' ? '∞' : parseInt(numRaw, 10);

  if (!word) { showToast('Enter a clue word.', 'error'); return; }

  // Basic validation: clue word must not be on the board
  if (words.map(w => w.toUpperCase()).includes(word)) {
    showToast('Clue cannot be a word on the board!', 'error');
    return;
  }

  const guessesLeft = number === '∞' ? 999 : number + 1;
  const timerEndsAt = (meta.timerSeconds > 0)
    ? firebase.database.ServerValue.TIMESTAMP  // will add offset server-side
    : null;

  // Write clue and set timer
  const clueData = {
    word, number, guessesLeft, givenBy: myUid, at: firebase.database.ServerValue.TIMESTAMP
  };

  const updates = {
    clue: clueData
  };

  if (meta.timerSeconds > 0) {
    // timerEndsAt = now + timerSeconds * 1000 — use client time (good enough)
    updates['meta/timerEndsAt'] = Date.now() + (meta.timerSeconds * 1000);
  }

  // Append to clue history
  const histKey = db.ref(`rooms/${roomCode}/clueHistory`).push().key;
  updates[`clueHistory/${histKey}`] = { word, number, team: myTeam, at: Date.now() };

  await db.ref(`rooms/${roomCode}`).update(updates);
  wordInput.value = '';
}

function handleCardClick(idx) {
  if (!canGuess()) return;
  if (pendingIdx !== null) return;

  pendingIdx = idx;
  $('pending-indicator').classList.remove('hidden');
  $('end-turn-btn').classList.add('hidden');

  db.ref(`rooms/${roomCode}/pendingGuess`).set({
    idx,
    byUid: myUid,
    claimedBy: null,
    at: firebase.database.ServerValue.TIMESTAMP
  }).catch(err => {
    pendingIdx = null;
    $('pending-indicator').classList.add('hidden');
    showToast(err.message, 'error');
  });
}

// ── Finished actions ──────────────────────────────────────
$('play-again-btn').addEventListener('click', async () => {
  // Reset to lobby, keeping same players
  const updates = {
    'meta/status':       'lobby',
    'meta/winner':       null,
    'meta/winReason':    null,
    'meta/currentTurn':  null,
    'meta/startingTeam': null,
    'meta/timerEndsAt':  null,
    'board':             null,
    'clue':              null,
    'scores':            null,
    'pendingGuess':      null,
    'clueHistory':       null,
    'private':           null
  };
  // Reset player roles to operative (keep teams)
  Object.keys(players).forEach(uid => {
    updates[`players/${uid}/role`] = 'operative';
  });
  keyCard   = null;
  words     = [];
  revealed  = [];
  await db.ref(`rooms/${roomCode}`).update(updates);
});

$('go-home-btn').addEventListener('click', () => { window.location.href = 'index.html'; });

// ── UI helpers ────────────────────────────────────────────
function showScreen(name) {
  ['lobby', 'board', 'finished'].forEach(s => {
    $(s).classList.toggle('hidden', s !== name);
  });
}

function showLoading(msg) {
  $('loading-msg').textContent = msg || 'Loading…';
  $('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  $('loading-overlay').classList.add('hidden');
}

let toastTimer = null;
function showToast(msg, type) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast${type === 'error' ? ' error' : ''} show`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 2800);
}

// Escape HTML to prevent XSS from player-provided names
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
