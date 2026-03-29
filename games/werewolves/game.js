/* =====================================================
   WEREWOLVES OF MILLERS HOLLOW — game.js
   Implements the GAME interface consumed by lobby.js.

   Firebase paths owned by this game (under rooms/{code}/):
     private/roles       — { uid: role }  (host+wolves can read)
     game/alive          — { uid: true }
     game/eliminated     — { uid: { at, by } }
     game/nightVotes     — { voterUid: targetUid }
     game/nightVictim    — uid | null
     game/seerAction     — { by, at }
     game/witchAction    — { byUid, healed, kill, at }
     game/witchPotions   — { witchUid: { heal, kill } }
     game/dayVotes       — { voterUid: targetUid }
     game/lastVictims    — uid[]

   Tableside (pass-and-play) mode:
     - Host creates game with player names in settings.localPlayerNames
     - Fake player uids ts_0…ts_N are created in generateState
     - Host's device acts for all players via cover screen hand-offs
     - All Firebase writes go through the host's authenticated uid

   Night phase order: werewolves → seer → witch → (dawn) → day
   Firebase transactions prevent double-processing.
   ===================================================== */

(function () {

// ── Module state ──────────────────────────────────────────
let _roomCode, _myUid;
let _myRole      = null;   // 'werewolf'|'villager'|'seer'|'witch'|'hunter'|'gm'
let _allRoles    = {};     // full map — wolves + gm (tableside) always have this
let _players     = {};
let _meta        = {};
let _alive       = {};
let _nightVotes  = {};
let _dayVotes    = {};
let _witchPotions= {};
let _witchAction = null;
let _nightVictim = null;
let _lastVictims = null;
let _seerResult  = null;   // { target, isWerewolf } — memory only
let _subs        = [];
let _statsWritten= false;
let _discussTimer= null;

// Tableside (pass-and-play) state
let _isTableside  = false;
let _tsCover      = true;   // true = show cover/selection screen
let _tsActiveUid  = null;   // fake uid of the player currently acting

const $ = id => document.getElementById(id);

const ROLE_ICON = { werewolf:'🐺', villager:'👨‍🌾', seer:'🔮', witch:'🧙', hunter:'🏹' };
const ROLE_NAME = { werewolf:'Werewolf', villager:'Villager', seer:'Seer', witch:'Witch', hunter:'Hunter' };
const ROLE_DESC = {
  werewolf: 'You are a Werewolf. Hunt with your pack at night and stay hidden during the day.',
  villager: 'You are a Villager. Use debate and logic to unmask the werewolves.',
  seer:     "You are the Seer. Each night you may reveal one player's true nature.",
  witch:    'You have one healing potion and one killing potion — each usable once.',
  hunter:   'You are the Hunter. If eliminated, you immediately shoot another player.',
};

// Returns uid of the player currently acting (tableside active player, or self)
function _actingUid() { return _isTableside ? _tsActiveUid : _myUid; }

// ── GAME interface ────────────────────────────────────────

window.GAME = {
  name:      'Werewolves',
  lobbyMode: 'freeform',   // tells lobby.js to use Player / Narrator join buttons

  renderSettings(meta) {
    const s  = meta.settings || {};
    const ds = s.discussSeconds ?? 120;
    const ts = !!s.tableside;
    const names = s.localPlayerNames || '';
    return `
      <label for="ww-mode">Mode</label>
      <select id="ww-mode" class="select">
        <option value="0" ${!ts?'selected':''}>Online (each player uses own phone)</option>
        <option value="1" ${ts?'selected':''}>Tableside (1 phone, pass &amp; play)</option>
      </select>
      <div id="ww-ts-row" style="display:${ts?'contents':'none'}">
        <label for="ww-player-names">Players (comma-separated names)</label>
        <input id="ww-player-names" class="input" type="text" placeholder="Alice, Bob, Carol, Dave, Eve"
          value="${esc(names)}" style="min-width:0;flex:1" />
      </div>
      <label for="ww-discuss">Discussion</label>
      <select id="ww-discuss" class="select">
        <option value="0"   ${ds===0  ?'selected':''}>No timer</option>
        <option value="60"  ${ds===60 ?'selected':''}>1 min</option>
        <option value="120" ${ds===120?'selected':''}>2 min</option>
        <option value="180" ${ds===180?'selected':''}>3 min</option>
      </select>
    `;
  },

  onSettingChange(e, roomCode) {
    if (e.target.id === 'ww-discuss')
      db.ref(`rooms/${roomCode}/meta/settings/discussSeconds`).set(+e.target.value);
    if (e.target.id === 'ww-mode') {
      const ts = e.target.value === '1';
      db.ref(`rooms/${roomCode}/meta/settings/tableside`).set(ts);
      const row = document.getElementById('ww-ts-row');
      if (row) row.style.display = ts ? 'contents' : 'none';
    }
    if (e.target.id === 'ww-player-names')
      db.ref(`rooms/${roomCode}/meta/settings/localPlayerNames`).set(e.target.value);
  },

  lobbyValid(players, meta) {
    const s = meta.settings || {};
    if (s.tableside) {
      const names = _parseNames(s.localPlayerNames || '');
      if (names.length < 4) return { valid: false, hint: `Tableside needs at least 4 player names (${names.length} entered).` };
      if (names.length > 12) return { valid: false, hint: `Max 12 players (${names.length} entered).` };
      return { valid: true, hint: `${names.length} players · tableside mode ready!` };
    }
    const n = Object.values(players).filter(p => p.team === 'player').length;
    if (n < 4) return { valid: false, hint: `Need at least 4 players (${n} joined as player).` };
    return { valid: true, hint: `${n} players — ready!` };
  },

  generateState(players, meta) {
    const settings = meta.settings || {};
    let uids;

    if (settings.tableside) {
      // Create fake player entries for each named local player
      const names = _parseNames(settings.localPlayerNames || '');
      uids = names.map((_, i) => `ts_${i}`);
      // These entries will be written into players/ by the returned update.
      // Firebase rules allow the host to write any player slot in their room.
    } else {
      // Only players who joined as 'player' get roles; narrators are observers
      uids = Object.keys(players).filter(uid => players[uid]?.team === 'player');
    }

    const n        = uids.length;
    const roles    = _buildRoleList(n);
    const shuffled = shuffle(roles);
    const roleMap  = Object.fromEntries(uids.map((uid, i) => [uid, shuffled[i]]));
    const alive    = Object.fromEntries(uids.map(uid => [uid, true]));

    const witchUid = uids.find((uid, i) => shuffled[i] === 'witch');
    const witchPotions = witchUid ? { [witchUid]: { heal: true, kill: true } } : {};

    const update = {
      'private/roles':     roleMap,
      'game/alive':        alive,
      'game/eliminated':   null,
      'game/nightVotes':   null,
      'game/nightVictim':  null,
      'game/seerAction':   null,
      'game/witchAction':  null,
      'game/witchPotions': witchPotions,
      'game/dayVotes':     null,
      'game/lastVictims':  null,
      'meta/phase':        'night',
      'meta/nightPhase':   'werewolves',
      'meta/dayPhase':     null,
      'meta/round':        1,
      'meta/discussEndsAt':null,
    };

    if (settings.tableside) {
      const names = _parseNames(settings.localPlayerNames || '');
      uids.forEach((uid, i) => {
        update[`players/${uid}/name`]      = names[i];
        update[`players/${uid}/photoURL`]  = '';
        update[`players/${uid}/online`]    = true;
        update[`players/${uid}/joinedAt`]  = Date.now();
      });
    }

    return update;
  },

  init(roomCode, myUid) {
    _roomCode = roomCode;
    _myUid    = myUid;
    const ccBtn = $('copy-code-btn');
    if (ccBtn) ccBtn.addEventListener('click', _shareRoom);
  },

  onStatusChange(status, meta) {
    _meta        = meta;
    _isTableside = !!(meta.settings?.tableside);
    if (status === 'playing') {
      _tsCover     = true;
      _tsActiveUid = null;
      _subscribeGame();
      _loadMyRole();
    }
    if (status === 'finished') {
      _stopDiscussTimer();
      _loadAllRoles().then(_renderFinished);
      _writeStats(meta);
    }
  },

  onPlayersUpdate(players, meta) {
    _players = players;
    _meta    = meta;
    _render();
  },

  getResetUpdate() {
    _subs.forEach(off => off()); _subs = [];
    _stopDiscussTimer();
    _myRole = null; _allRoles = {}; _alive = {}; _nightVotes = {};
    _dayVotes = {}; _witchPotions = {}; _witchAction = null;
    _nightVictim = null; _lastVictims = null; _seerResult = null;
    _statsWritten = false; _isTableside = false;
    _tsCover = true; _tsActiveUid = null;
    return { 'private': null, 'game': null };
  }
};

// ── Helpers ───────────────────────────────────────────────

function _parseNames(str) {
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

// ── Role list ─────────────────────────────────────────────

function _buildRoleList(n) {
  if (n < 2) return ['werewolf', 'villager'];
  const wolves = n >= 10 ? 3 : n >= 5 ? 2 : 1;
  const roles  = [...Array(wolves).fill('werewolf'), 'seer'];
  if (n >= 6)  roles.push('witch');
  if (n >= 10) roles.push('hunter');
  while (roles.length < n) roles.push('villager');
  return roles;
}

// ── Subscriptions ─────────────────────────────────────────

function _subscribeGame() {
  _subs.forEach(off => off()); _subs = [];
  const ref = db.ref(`rooms/${_roomCode}`);
  const sub = (path, fn) => {
    ref.child(path).on('value', fn);
    _subs.push(() => ref.child(path).off('value', fn));
  };

  sub('meta', snap => {
    const prev = { nightPhase: _meta.nightPhase, dayPhase: _meta.dayPhase };
    _meta = snap.val() || _meta;
    _render();
    if (_meta.nightPhase !== prev.nightPhase || _meta.dayPhase !== prev.dayPhase) {
      // When a new phase starts in tableside, always return to cover screen
      if (_isTableside) { _tsCover = true; _tsActiveUid = null; }
      _checkAutoAdvance();
    }
    if (_meta.phase === 'day' && _meta.dayPhase === 'discuss' && _meta.discussEndsAt) {
      _startDiscussTimer(_meta.discussEndsAt);
    }
  });

  sub('game/alive',        snap => { _alive = snap.val() || {}; _render(); });
  sub('game/nightVotes',   snap => { _nightVotes = snap.val() || {}; _onNightVotesChange(); _render(); });
  sub('game/nightVictim',  snap => { _nightVictim = snap.val(); _render(); });
  sub('game/witchPotions', snap => { _witchPotions = snap.val() || {}; _render(); });
  sub('game/witchAction',  snap => { _witchAction = snap.val(); _onWitchActionChange(); _render(); });
  sub('game/seerAction',   snap => { _onSeerActionChange(snap.val()); _render(); });
  sub('game/dayVotes',     snap => { _dayVotes = snap.val() || {}; _onDayVotesChange(); _render(); });
  sub('game/lastVictims',  snap => { _lastVictims = snap.val(); _render(); });
}

async function _loadMyRole() {
  if (_isTableside) {
    // GM: load all roles, set special myRole
    await _loadAllRoles();
    _myRole = 'gm';
  } else if (_players[_myUid]?.team === 'narrator') {
    // Narrator: loads all roles to facilitate the game, doesn't receive one
    await _loadAllRoles();
    _myRole = 'narrator';
  } else {
    const snap = await db.ref(`rooms/${_roomCode}/private/roles/${_myUid}`).once('value');
    _myRole = snap.val() || 'villager';
    if (_myRole === 'werewolf') await _loadAllRoles();
  }
  _render();
}

async function _loadAllRoles() {
  const snap = await db.ref(`rooms/${_roomCode}/private/roles`).once('value');
  _allRoles = snap.val() || {};
}

// ── Phase auto-advance ────────────────────────────────────

async function _checkAutoAdvance() {
  const nightPhase = _meta.nightPhase;
  const ref        = db.ref(`rooms/${_roomCode}/private/roles`);

  if (_meta.phase === 'night' && nightPhase === 'seer') {
    const allRoles = (await ref.once('value')).val() || {};
    const aliveSeer = Object.keys(_alive).find(uid => allRoles[uid] === 'seer');
    if (!aliveSeer) await _txNightPhase('seer', 'witch');
  }
  if (_meta.phase === 'night' && nightPhase === 'witch') {
    const allRoles = (await ref.once('value')).val() || {};
    const aliveWitch = Object.keys(_alive).find(uid => allRoles[uid] === 'witch');
    if (!aliveWitch) await _applyDawn();
    else {
      const potions = _witchPotions[aliveWitch] || {};
      if (!potions.heal && !potions.kill) await _applyDawn();
    }
  }
}

// ── Night vote callbacks ──────────────────────────────────

async function _onNightVotesChange() {
  if (_meta.nightPhase !== 'werewolves') return;
  const allRoles    = _allRoles;
  const aliveWolves = Object.keys(_alive).filter(uid => allRoles[uid] === 'werewolf');
  if (!aliveWolves.length) { await _txNightPhase('werewolves', 'seer'); return; }

  const votes = aliveWolves.map(uid => _nightVotes[uid]).filter(Boolean);
  if (votes.length < aliveWolves.length) return;

  const tally = {};
  votes.forEach(v => { tally[v] = (tally[v] || 0) + 1; });
  const [top, cnt] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  if (cnt < Math.ceil(aliveWolves.length / 2)) return;

  let ok = false;
  await db.ref(`rooms/${_roomCode}/meta/nightPhase`).transaction(cur => {
    if (cur === 'werewolves') { ok = true; return 'seer'; }
  });
  if (ok) await db.ref(`rooms/${_roomCode}/game/nightVictim`).set(top);
}

async function _onSeerActionChange(val) {
  if (!val || _meta.nightPhase !== 'seer') return;
  await _txNightPhase('seer', 'witch');
}

async function _onWitchActionChange() {
  if (!_witchAction || _meta.nightPhase !== 'witch') return;
  await _applyDawn();
}

// ── Night phase helpers ───────────────────────────────────

async function _txNightPhase(from, to) {
  await db.ref(`rooms/${_roomCode}/meta/nightPhase`).transaction(cur => {
    if (cur === from) return to;
  });
}

async function _applyDawn() {
  let proceed = false;
  await db.ref(`rooms/${_roomCode}/meta/nightPhase`).transaction(cur => {
    if (cur === 'witch') { proceed = true; return 'dawn'; }
  });
  if (!proceed) return;

  const [vicSnap, waSnap, wpSnap] = await Promise.all([
    db.ref(`rooms/${_roomCode}/game/nightVictim`).once('value'),
    db.ref(`rooms/${_roomCode}/game/witchAction`).once('value'),
    db.ref(`rooms/${_roomCode}/game/witchPotions`).once('value'),
  ]);

  const victim      = vicSnap.val();
  const wa          = waSnap.val() || {};
  const wp          = wpSnap.val() || {};
  const toEliminate = [];

  if (victim && !wa.healed) toEliminate.push(victim);
  if (wa.kill)              toEliminate.push(wa.kill);

  const potionUpdates = {};
  if (wa.byUid) {
    if (wa.healed) potionUpdates[`game/witchPotions/${wa.byUid}/heal`] = false;
    if (wa.kill)   potionUpdates[`game/witchPotions/${wa.byUid}/kill`] = false;
  }

  const aliveSnap = await db.ref(`rooms/${_roomCode}/game/alive`).once('value');
  const newAlive  = { ...(aliveSnap.val() || {}) };
  toEliminate.forEach(uid => delete newAlive[uid]);

  const allRolesSnap = await db.ref(`rooms/${_roomCode}/private/roles`).once('value');
  const allRoles = allRolesSnap.val() || {};
  const winCheck = _checkWin(newAlive, allRoles);

  const discussSeconds = _meta.settings?.discussSeconds ?? 120;

  const updates = {
    'meta/phase':         'day',
    'meta/nightPhase':    null,
    'meta/dayPhase':      'discuss',
    'meta/round':         _meta.round || 1,
    'meta/discussEndsAt': discussSeconds > 0 ? Date.now() + discussSeconds * 1000 : null,
    'game/nightVotes':    null,
    'game/nightVictim':   null,
    'game/seerAction':    null,
    'game/witchAction':   null,
    'game/lastVictims':   toEliminate.length ? toEliminate : null,
    ...potionUpdates,
  };

  toEliminate.forEach(uid => {
    updates[`game/alive/${uid}`]         = null;
    updates[`game/eliminated/${uid}/at`] = firebase.database.ServerValue.TIMESTAMP;
    updates[`game/eliminated/${uid}/by`] = 'night';
  });

  if (winCheck) {
    updates['meta/status']    = 'finished';
    updates['meta/winner']    = winCheck.winner;
    updates['meta/winReason'] = winCheck.reason;
  }

  await db.ref(`rooms/${_roomCode}`).update(updates);
}

// ── Day vote callbacks ────────────────────────────────────

async function _onDayVotesChange() {
  if (_meta.dayPhase !== 'vote') return;
  const aliveUids = Object.keys(_alive);
  const voted     = aliveUids.filter(uid => _dayVotes[uid]);
  if (voted.length < aliveUids.length) return;
  await _applyDayVote();
}

async function _applyDayVote() {
  let proceed = false;
  await db.ref(`rooms/${_roomCode}/meta/dayPhase`).transaction(cur => {
    if (cur === 'vote') { proceed = true; return 'tally'; }
  });
  if (!proceed) return;

  const aliveSnap  = await db.ref(`rooms/${_roomCode}/game/alive`).once('value');
  const dvSnap     = await db.ref(`rooms/${_roomCode}/game/dayVotes`).once('value');
  const currentAlive = aliveSnap.val() || {};
  const dayVotes     = dvSnap.val() || {};

  const tally = {};
  Object.entries(dayVotes).forEach(([voter, target]) => {
    if (currentAlive[voter] && currentAlive[target]) {
      tally[target] = (tally[target] || 0) + 1;
    }
  });

  const sorted   = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const topCount = sorted[0]?.[1] ?? 0;
  const tied     = sorted.filter(([, c]) => c === topCount);
  const eliminated = tied.length === 1 ? [tied[0][0]] : [];

  const newAlive = { ...currentAlive };
  eliminated.forEach(uid => delete newAlive[uid]);

  const allRolesSnap = await db.ref(`rooms/${_roomCode}/private/roles`).once('value');
  const allRoles = allRolesSnap.val() || {};
  const winCheck = _checkWin(newAlive, allRoles);

  const updates = {
    'meta/dayPhase':    null,
    'game/dayVotes':    null,
    'game/lastVictims': eliminated.length ? eliminated : null,
  };

  eliminated.forEach(uid => {
    updates[`game/alive/${uid}`]         = null;
    updates[`game/eliminated/${uid}/at`] = firebase.database.ServerValue.TIMESTAMP;
    updates[`game/eliminated/${uid}/by`] = 'day';
  });

  if (winCheck) {
    updates['meta/status']    = 'finished';
    updates['meta/winner']    = winCheck.winner;
    updates['meta/winReason'] = winCheck.reason;
  } else {
    updates['meta/phase']      = 'night';
    updates['meta/nightPhase'] = 'werewolves';
    updates['meta/round']      = (_meta.round || 1) + 1;
    updates['meta/discussEndsAt'] = null;
  }

  await db.ref(`rooms/${_roomCode}`).update(updates);
}

// ── Win condition ─────────────────────────────────────────

function _checkWin(alive, allRoles) {
  const uids    = Object.keys(alive);
  const wolves  = uids.filter(uid => allRoles[uid] === 'werewolf');
  const village = uids.filter(uid => allRoles[uid] !== 'werewolf');
  if (wolves.length === 0)             return { winner: 'village',    reason: 'allWolvesFound' };
  if (wolves.length >= village.length) return { winner: 'werewolves', reason: 'overrun' };
  return null;
}

// ── Player actions ────────────────────────────────────────

async function _werewolfVote(targetUid) {
  const uid = _actingUid();
  await db.ref(`rooms/${_roomCode}/game/nightVotes/${uid}`).set(targetUid);
  if (_isTableside) { _tsCover = true; _tsActiveUid = null; _render(); }
}

async function _seerPeek(targetUid) {
  const snap = await db.ref(`rooms/${_roomCode}/private/roles/${targetUid}`).once('value');
  _seerResult = { target: targetUid, isWerewolf: snap.val() === 'werewolf' };
  if (!_isTableside) {
    // Non-tableside: immediately signal done so the phase advances
    await db.ref(`rooms/${_roomCode}/game/seerAction`).set({
      by: _myUid, at: firebase.database.ServerValue.TIMESTAMP
    });
  }
  _render();
}

async function _seerDone() {
  // Tableside only: seer has read their result, now signal phase advance
  await db.ref(`rooms/${_roomCode}/game/seerAction`).set({
    by: _tsActiveUid || _myUid, at: firebase.database.ServerValue.TIMESTAMP
  });
  _seerResult  = null;
  _tsCover     = true;
  _tsActiveUid = null;
  _render();
}

async function _witchUseHeal() {
  const uid = _actingUid();
  await db.ref(`rooms/${_roomCode}/game/witchAction`).set({
    byUid: uid, healed: true, kill: null,
    at: firebase.database.ServerValue.TIMESTAMP
  });
  if (_isTableside) { _tsCover = true; _tsActiveUid = null; }
}

async function _witchUseKill(targetUid) {
  const uid = _actingUid();
  await db.ref(`rooms/${_roomCode}/game/witchAction`).set({
    byUid: uid, healed: false, kill: targetUid,
    at: firebase.database.ServerValue.TIMESTAMP
  });
  if (_isTableside) { _tsCover = true; _tsActiveUid = null; }
}

async function _witchPass() {
  const uid = _actingUid();
  await db.ref(`rooms/${_roomCode}/game/witchAction`).set({
    byUid: uid, healed: false, kill: null,
    at: firebase.database.ServerValue.TIMESTAMP
  });
  if (_isTableside) { _tsCover = true; _tsActiveUid = null; }
}

async function _dayVote(targetUid) {
  const uid = _actingUid();
  if (_dayVotes[uid]) return;
  await db.ref(`rooms/${_roomCode}/game/dayVotes/${uid}`).set(targetUid);
  if (_isTableside) { _tsCover = true; _tsActiveUid = null; _render(); }
}

async function _startDayVote() {
  if (_meta.hostUid !== _myUid) return;
  _stopDiscussTimer();
  await db.ref(`rooms/${_roomCode}/meta`).update({ dayPhase: 'vote', discussEndsAt: null });
}

// ── Discuss timer ─────────────────────────────────────────

function _startDiscussTimer(endsAt) {
  _stopDiscussTimer();
  _discussTimer = setInterval(async () => {
    if (Date.now() >= endsAt) {
      _stopDiscussTimer();
      if (_meta.dayPhase === 'discuss' && _meta.hostUid === _myUid) {
        await _startDayVote();
      }
    }
  }, 1000);
}

function _stopDiscussTimer() {
  if (_discussTimer) { clearInterval(_discussTimer); _discussTimer = null; }
}

// ── Render ────────────────────────────────────────────────

function _render() {
  if (!_myRole || !_meta.phase) return;
  _renderPhaseHeader();
  _renderPlayerList();
  _renderActionPanel();
}

function _renderPhaseHeader() {
  const el = $('ww-phase-header');
  if (!el) return;
  const phase = _meta.phase, np = _meta.nightPhase, dp = _meta.dayPhase;
  const round = _meta.round || 1;
  let icon, title, sub;

  if (phase === 'night') {
    icon  = '🌙';
    title = `Night ${round}`;
    sub   = np === 'werewolves' ? 'Werewolves are hunting…'
          : np === 'seer'       ? 'The seer consults the cards…'
          : np === 'witch'      ? 'The witch stirs her cauldron…'
          : 'Night is ending…';
  } else {
    icon  = '☀️';
    title = `Day ${round}`;
    sub   = dp === 'discuss' ? 'The village awakens. Who is the wolf?'
          : dp === 'vote'    ? 'Vote — who do you suspect?'
          : 'Counting votes…';
  }

  el.className = `ww-phase-header ${phase === 'night' ? 'ww-night' : 'ww-day'}`;
  el.innerHTML = `
    <div class="ww-round">Round ${round}</div>
    <div class="ww-phase-title">${icon} ${esc(title)}</div>
    <div class="ww-phase-sub">${esc(sub)}</div>
  `;
}

function _renderPlayerList() {
  const el = $('ww-player-list');
  if (!el) return;
  el.innerHTML = Object.entries(_players).map(([uid, p]) => {
    const isNarrator = p.team === 'narrator';
    const alive  = isNarrator ? true : !!_alive[uid];
    const isMe   = !_isTableside && uid === _myUid;
    const canSeeRoles = _myRole === 'werewolf' || _myRole === 'gm' || _myRole === 'narrator';
    const isWolf = canSeeRoles && !isNarrator && _allRoles[uid] === 'werewolf' && uid !== _myUid;
    return `
      <div class="ww-player${alive ? '' : ' ww-dead'}${isMe ? ' ww-me' : ''}${isWolf ? ' ww-is-wolf' : ''}">
        <img src="${esc(p.photoURL||'')}" alt="" class="ww-avatar" />
        <span class="ww-pname">${esc(p.name||'Player')}</span>
        ${isNarrator ? `<span class="ww-role-badge">📖 Narrator</span>` : ''}
        ${isMe && !isNarrator ? `<span class="ww-role-badge">${ROLE_ICON[_myRole]||''} ${esc(ROLE_NAME[_myRole]||'')}</span>` : ''}
        ${isWolf ? `<span class="ww-role-badge" style="color:var(--red)">🐺 Wolf</span>` : ''}
        ${!alive && !isNarrator ? '<span class="ww-dead-mark">💀</span>' : ''}
        ${isMe ? '<span class="ww-you">(you)</span>' : ''}
      </div>`;
  }).join('');
}

function _renderActionPanel() {
  const el = $('ww-action-panel');
  if (!el) return;
  const phase = _meta.phase, np = _meta.nightPhase, dp = _meta.dayPhase;

  if (_myRole === 'narrator') {
    el.innerHTML = _panelNarrator();
    _bindActions(el);
    return;
  }

  if (_isTableside) {
    if (_tsCover || !_tsActiveUid) {
      el.innerHTML = _panelTablesideCover();
    } else {
      // Show the active player's private panel
      const role = _allRoles[_tsActiveUid];
      if (phase === 'night') {
        if      (np === 'werewolves' && role === 'werewolf') el.innerHTML = _panelWerewolves();
        else if (np === 'seer'       && role === 'seer')     el.innerHTML = _panelSeer();
        else if (np === 'witch'      && role === 'witch')    el.innerHTML = _panelWitch();
        else el.innerHTML = _panelSleep('No action for you this phase. Pass the phone back.');
      } else if (phase === 'day') {
        if (dp === 'vote') el.innerHTML = _panelVote();
        else               el.innerHTML = _panelSleep('Wait for the discussion phase to end.');
      }
    }
  } else {
    if (phase === 'night') {
      if      (np === 'werewolves') el.innerHTML = _panelWerewolves();
      else if (np === 'seer')       el.innerHTML = _panelSeer();
      else if (np === 'witch')      el.innerHTML = _panelWitch();
      else                          el.innerHTML = _panelSleep('Night is ending…');
    } else if (phase === 'day') {
      if      (dp === 'discuss')    el.innerHTML = _panelDiscuss();
      else if (dp === 'vote')       el.innerHTML = _panelVote();
      else                          el.innerHTML = _panelSleep('Tallying votes…');
    }
  }

  _bindActions(el);
}

// ── Tableside cover screen ────────────────────────────────

function _tablesideActorsForPhase() {
  const phase = _meta.phase, np = _meta.nightPhase, dp = _meta.dayPhase;

  if (phase === 'night') {
    if (np === 'werewolves') {
      return Object.keys(_alive)
        .filter(uid => _allRoles[uid] === 'werewolf' && !_nightVotes[uid])
        .map(uid => ({ uid, p: _players[uid] }));
    }
    if (np === 'seer') {
      if (_seerResult) return []; // peeked, waiting for seer-done
      const seerUid = Object.keys(_alive).find(uid => _allRoles[uid] === 'seer');
      return seerUid ? [{ uid: seerUid, p: _players[seerUid] }] : [];
    }
    if (np === 'witch') {
      if (_witchAction) return [];
      const witchUid = Object.keys(_alive).find(uid => _allRoles[uid] === 'witch');
      if (!witchUid) return [];
      const potions = _witchPotions[witchUid] || {};
      if (!potions.heal && !potions.kill) return [];
      return [{ uid: witchUid, p: _players[witchUid] }];
    }
  }
  if (phase === 'day' && dp === 'vote') {
    return Object.keys(_alive)
      .filter(uid => !_dayVotes[uid])
      .map(uid => ({ uid, p: _players[uid] }));
  }
  return [];
}

function _panelTablesideCover() {
  const phase = _meta.phase, np = _meta.nightPhase, dp = _meta.dayPhase;
  const actors = _tablesideActorsForPhase();

  // Special case: seer already peeked, waiting for "Got it" tap
  if (phase === 'night' && np === 'seer' && _seerResult) {
    const seerUid = Object.keys(_alive).find(uid => _allRoles[uid] === 'seer');
    if (seerUid) {
      return `
        <div class="ww-sleep-screen">
          <span class="ww-sleep-icon">🔮</span>
          <p style="font-size:14px;color:var(--text)">The Seer has seen their vision.</p>
          <p>Pass the phone to <strong>${esc(_players[seerUid]?.name||'Seer')}</strong> to dismiss.</p>
        </div>
        <button class="ww-target-btn" data-action="ts-reveal" data-uid="${seerUid}"
          style="max-width:260px;margin:0 auto">
          <img src="${esc(_players[seerUid]?.photoURL||'')}" alt="" class="ww-target-avatar" />
          ${esc(_players[seerUid]?.name||'Seer')} — tap to dismiss
        </button>`;
    }
  }

  let icon, title, hint;
  if (phase === 'night') {
    if      (np === 'werewolves') { icon = '🐺'; title = 'Wolves awaken'; hint = 'Wolves only — tap your name to vote:'; }
    else if (np === 'seer')       { icon = '🔮'; title = 'The Seer awakens'; hint = 'Pass phone to the Seer:'; }
    else if (np === 'witch')      { icon = '🧙'; title = 'The Witch stirs'; hint = 'Pass phone to the Witch:'; }
    else                          { icon = '🌙'; title = 'Night is ending…'; hint = ''; }
  } else if (phase === 'day' && dp === 'discuss') {
    return _panelDiscuss();
  } else if (phase === 'day' && dp === 'vote') {
    icon = '⚖️'; title = 'Village Vote'; hint = 'Tap your name to cast your vote:';
  } else {
    return _panelSleep('Counting…');
  }

  return `
    <div class="ww-sleep-screen" style="padding:24px 20px 12px">
      <span class="ww-sleep-icon">${icon}</span>
      <p style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px">${esc(title)}</p>
      ${hint ? `<p style="font-size:13px">${esc(hint)}</p>` : ''}
    </div>
    ${actors.length
      ? `<div class="ww-targets">
          ${actors.map(({ uid, p }) => `
            <button class="ww-target-btn" data-action="ts-reveal" data-uid="${uid}">
              <img src="${esc(p?.photoURL||'')}" alt="" class="ww-target-avatar" />
              ${esc(p?.name || uid)}
            </button>`).join('')}
         </div>`
      : `<p class="ww-action-hint" style="text-align:center">Waiting for phase to advance…</p>`
    }
  `;
}

// ── Panel builders ────────────────────────────────────────

function _panelNarrator() {
  const phase = _meta.phase, np = _meta.nightPhase, dp = _meta.dayPhase;
  const round = _meta.round || 1;

  // Role summary (shown to narrator at all times)
  const roleSummary = Object.entries(_allRoles).map(([uid, role]) => {
    const p = _players[uid];
    const alive = !!_alive[uid];
    return `<span style="font-size:12px;opacity:${alive?1:0.45}">${ROLE_ICON[role]||'?'} ${esc(p?.name||uid)}${alive?'':'💀'}</span>`;
  }).join('  ');

  if (phase === 'night') {
    const wolfVotes = Object.entries(_nightVotes)
      .map(([uid, tgt]) => `${esc(_players[uid]?.name||uid)} → ${esc(_players[tgt]?.name||'?')}`)
      .join(', ');
    return `
      <p class="ww-action-title">Narrator — Night ${round}</p>
      <p class="ww-action-hint">Phase: <strong>${np || '…'}</strong>${_nightVictim ? ` · Target: <strong style="color:var(--red)">${esc(_players[_nightVictim]?.name||'?')}</strong>` : ''}</p>
      ${wolfVotes ? `<p class="ww-action-hint">Wolf votes: ${wolfVotes}</p>` : ''}
      <div class="ww-pack-status" style="flex-wrap:wrap;gap:8px">${roleSummary}</div>
    `;
  }

  // Day phase: show the dawn announcement then the discuss/vote panels
  if (phase === 'day') {
    const dayPanel = dp === 'vote' ? '' : _panelDiscuss();
    return `
      <p class="ww-action-title">Narrator — Day ${round}</p>
      <div class="ww-pack-status" style="flex-wrap:wrap;gap:8px;margin-bottom:8px">${roleSummary}</div>
      ${dayPanel}
    `;
  }

  return `<p class="ww-action-title">Narrator — Round ${round}</p><div class="ww-pack-status">${roleSummary}</div>`;
}

function _panelSleep(msg) {
  return `<div class="ww-sleep-screen"><span class="ww-sleep-icon">🌙</span><p>${esc(msg)}</p></div>`;
}

function _panelWerewolves() {
  const actingUid = _actingUid();
  const role = _isTableside ? _allRoles[actingUid] : _myRole;
  if (role !== 'werewolf') return _panelSleep('The village sleeps. Keep your eyes closed.');

  const myVote  = _nightVotes[actingUid];
  const targets = Object.entries(_players).filter(([uid]) => _alive[uid] && _allRoles[uid] !== 'werewolf');
  const packLines = Object.entries(_allRoles)
    .filter(([, r]) => r === 'werewolf')
    .map(([uid]) => {
      const p = _players[uid];
      const v = _nightVotes[uid];
      const voted = v ? `→ ${esc(_players[v]?.name || '?')}` : '…';
      return `<span>${esc(p?.name || uid)} ${voted}</span>`;
    }).join(' &nbsp;|&nbsp; ');

  const actorName = _isTableside ? (_players[actingUid]?.name || 'Wolf') : 'you';

  return `
    <p class="ww-action-title">${_isTableside ? esc(actorName) + ' — choose' : 'Choose'} your victim</p>
    <p class="ww-action-hint">${esc(ROLE_DESC.werewolf)}</p>
    <div class="ww-pack-status">🐺 ${packLines}</div>
    <div class="ww-targets">
      ${targets.map(([uid, p]) => {
        const voteCount = Object.values(_nightVotes).filter(v => v === uid).length;
        return `
          <button class="ww-target-btn danger${myVote===uid?' voted':''}" data-action="wolf-vote" data-uid="${uid}">
            <img src="${esc(p.photoURL||'')}" alt="" class="ww-target-avatar" />
            ${esc(p.name||'Player')}
            <span class="ww-vote-count">${voteCount||''}</span>
          </button>`;
      }).join('')}
    </div>
    ${myVote ? `<p class="ww-action-hint" style="color:var(--red)">Voted · ${_isTableside ? 'pass the phone back' : 'waiting for the pack'}…</p>` : ''}
  `;
}

function _panelSeer() {
  const actingUid = _actingUid();
  if (!_isTableside && (_myRole !== 'seer' || !_alive[_myUid])) return _panelSleep('The seer peers into the night…');
  if (_isTableside && (!actingUid || !_alive[actingUid])) return _panelSleep('The seer peers into the night…');

  if (_seerResult) {
    const tgt = _players[_seerResult.target];
    return `
      <p class="ww-action-title">Your vision</p>
      <div class="ww-seer-result ${_seerResult.isWerewolf ? 'wolf' : 'village'}">
        <span class="seer-icon">${_seerResult.isWerewolf ? '🐺' : '👨‍🌾'}</span>
        <strong>${esc(tgt?.name||'?')}</strong> is a
        <strong>${_seerResult.isWerewolf ? 'Werewolf' : 'Villager'}</strong>
      </div>
      <p class="ww-action-hint">Remember this for tomorrow's discussion.</p>
      ${_isTableside ? `<button class="btn btn-primary" data-action="seer-done">Got it — pass the phone back</button>` : ''}
    `;
  }

  const targets = Object.entries(_players).filter(([uid]) => _alive[uid] && uid !== actingUid);
  return `
    <p class="ww-action-title">${_isTableside ? esc(_players[actingUid]?.name||'Seer') + ' — who' : 'Who'} do you wish to see?</p>
    <p class="ww-action-hint">${esc(ROLE_DESC.seer)}</p>
    <div class="ww-targets">
      ${targets.map(([uid, p]) => `
        <button class="ww-target-btn" data-action="seer-peek" data-uid="${uid}">
          <img src="${esc(p.photoURL||'')}" alt="" class="ww-target-avatar" />
          ${esc(p.name||'Player')}
        </button>`).join('')}
    </div>
  `;
}

function _panelWitch() {
  const actingUid = _actingUid();
  if (!_isTableside && (_myRole !== 'witch' || !_alive[_myUid])) return _panelSleep('The witch tends her potions…');
  if (_isTableside && (!actingUid || !_alive[actingUid])) return _panelSleep('The witch tends her potions…');

  if (_witchAction) return `
    <p class="ww-action-title">Done for tonight</p>
    <p class="ww-action-hint">Waiting for dawn…</p>
  `;

  const potions  = _witchPotions[actingUid] || {};
  const victim   = _nightVictim ? _players[_nightVictim] : null;
  const targets  = Object.entries(_players).filter(([uid]) => _alive[uid] && uid !== _nightVictim);
  const actorName = _isTableside ? (_players[actingUid]?.name || 'Witch') : 'your';

  return `
    <p class="ww-action-title">${_isTableside ? esc(actorName) + "'s" : 'Your'} potions</p>
    <p class="ww-action-hint">${esc(ROLE_DESC.witch)}</p>
    <span class="potion-badge ${potions.heal ? 'available' : 'used'}">💊 Heal ${potions.heal ? '(1 left)' : '(used)'}</span>
    <span class="potion-badge ${potions.kill ? 'available' : 'used'}">☠️ Kill ${potions.kill ? '(1 left)' : '(used)'}</span>

    ${victim ? `<p class="ww-action-hint">The wolves targeted <strong class="ww-victim-name">${esc(victim.name||'?')}</strong>.</p>` : ''}

    ${potions.heal && victim ? `
      <div class="ww-witch-option" data-action="witch-heal">
        <h4>💊 Save ${esc(victim.name||'?')}</h4>
        <p>Use your healing potion to protect them tonight.</p>
      </div>` : ''}

    ${potions.kill ? `
      <p class="ww-action-title" style="margin-top:4px">☠️ Kill someone</p>
      <div class="ww-targets">
        ${targets.map(([uid, p]) => `
          <button class="ww-target-btn danger" data-action="witch-kill" data-uid="${uid}">
            <img src="${esc(p.photoURL||'')}" alt="" class="ww-target-avatar" />
            ${esc(p.name||'Player')}
          </button>`).join('')}
      </div>` : ''}

    <button class="btn btn-ghost btn-full" style="margin-top:4px" data-action="witch-pass">Pass (do nothing tonight)</button>
  `;
}

function _panelDiscuss() {
  const victims = Array.isArray(_lastVictims) ? _lastVictims : (_lastVictims ? [_lastVictims] : []);
  const names   = victims.map(uid => _players[uid]?.name || '?').join(' and ');
  const isHost  = _meta.hostUid === _myUid;

  const ds     = _meta.settings?.discussSeconds ?? 0;
  const endsAt = _meta.discussEndsAt;
  const timerHtml = (ds > 0 && endsAt) ? `<p class="ww-action-hint" id="ww-discuss-timer"></p>` : '';

  if (ds > 0 && endsAt) {
    setTimeout(() => {
      const el = $('ww-discuss-timer');
      if (!el) return;
      const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      el.textContent = `Vote starts in ${rem}s`;
    }, 0);
  }

  return `
    <div class="ww-dawn-box">
      <span class="ww-dawn-icon">${victims.length ? '😱' : '😌'}</span>
      <h3>${victims.length ? 'A body was found!' : 'A peaceful night.'}</h3>
      <p class="${victims.length ? 'ww-victim-name' : ''}">${
        victims.length
          ? `${esc(names)} ${victims.length > 1 ? 'were' : 'was'} killed last night.`
          : 'Nobody died last night.'
      }</p>
    </div>
    ${timerHtml}
    <p class="ww-action-hint">Discuss. Find the wolves.</p>
    ${isHost ? `<button class="btn btn-primary" data-action="start-vote">Start Vote</button>` : ''}
  `;
}

function _panelVote() {
  const actingUid = _actingUid();

  if (!_isTableside && !_alive[_myUid]) return `<p class="ww-action-hint">You are dead. Watch the vote unfold.</p>`;
  if (_isTableside && (!actingUid || !_alive[actingUid])) return _panelSleep('...');

  const myVote    = _dayVotes[actingUid];
  const aliveUids = Object.keys(_alive);
  const votedCnt  = aliveUids.filter(uid => _dayVotes[uid]).length;
  const tally     = {};
  Object.entries(_dayVotes).forEach(([v, t]) => {
    if (_alive[v] && _alive[t]) tally[t] = (tally[t] || 0) + 1;
  });

  const actorName = _isTableside ? (_players[actingUid]?.name || '?') : null;

  return `
    <p class="ww-action-title">${actorName ? esc(actorName) + ' — vote' : 'Vote'} to eliminate</p>
    <p class="ww-action-hint">${votedCnt} / ${aliveUids.length} have voted.</p>
    ${myVote ? `<p class="ww-action-hint" style="color:var(--blue)">Voted for ${esc(_players[myVote]?.name||'?')}. ${_isTableside ? 'Pass phone back.' : ''}</p>` : ''}
    <div class="ww-targets">
      ${Object.entries(_players)
          .filter(([uid]) => _alive[uid] && uid !== actingUid)
          .map(([uid, p]) => {
            const cnt = tally[uid] || 0;
            return `
              <button class="ww-target-btn${myVote===uid?' voted':''}"
                data-action="day-vote" data-uid="${uid}"
                ${myVote ? 'disabled' : ''}>
                <img src="${esc(p.photoURL||'')}" alt="" class="ww-target-avatar" />
                ${esc(p.name||'Player')}
                <span class="ww-vote-count">${cnt||''}</span>
              </button>`;
          }).join('')}
    </div>
    ${!myVote ? `<button class="btn btn-ghost" data-action="day-abstain">Abstain</button>` : ''}
  `;
}

// ── Event binding ─────────────────────────────────────────

function _bindActions(panel) {
  panel.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', async e => {
      const btn = e.currentTarget;
      switch (btn.dataset.action) {
        case 'ts-reveal':
          _tsActiveUid = btn.dataset.uid;
          _tsCover     = false;
          _render();
          break;
        case 'seer-done':   await _seerDone();                        break;
        case 'wolf-vote':   await _werewolfVote(btn.dataset.uid);     break;
        case 'seer-peek':   await _seerPeek(btn.dataset.uid);         break;
        case 'witch-heal':  await _witchUseHeal();                    break;
        case 'witch-kill':  await _witchUseKill(btn.dataset.uid);     break;
        case 'witch-pass':  await _witchPass();                       break;
        case 'start-vote':  await _startDayVote();                    break;
        case 'day-vote':    await _dayVote(btn.dataset.uid);          break;
        case 'day-abstain': await _dayVote('_abstain');               break;
      }
    });
  });
}

// ── Finished ──────────────────────────────────────────────

function _renderFinished() {
  const winner = _meta.winner;
  const banner = $('winner-banner');
  if (banner) {
    banner.className = `winner-banner ${winner||''}`;
    const nameEl = $('winner-name');
    if (nameEl) {
      nameEl.className = `team-name ${winner||''}`;
      nameEl.textContent = winner === 'village' ? 'THE VILLAGE' : winner === 'werewolves' ? 'THE WEREWOLVES' : '—';
    }
    const reasonEl = $('winner-reason');
    if (reasonEl) reasonEl.textContent =
      _meta.winReason === 'allWolvesFound' ? 'All werewolves were found!' :
      _meta.winReason === 'overrun'        ? 'Werewolves took over the village!' : '';
  }

  const extra = $('finished-extra');
  if (extra && Object.keys(_allRoles).length) {
    extra.innerHTML = `
      <h4 style="text-align:center;margin:20px 0 10px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted)">Final Roles</h4>
      <div class="ww-final-roles">
        ${Object.entries(_players).map(([uid, p]) => {
          const role  = _allRoles[uid];
          const alive = !!_alive[uid];
          return `
            <div class="ww-final-card${role==='werewolf'?' is-wolf':''}${!alive?' is-dead':''}">
              <span class="fc-role">${ROLE_ICON[role]||'❓'}</span>
              <span class="fc-name">${esc(p.name||'?')}</span>
              <span class="fc-label">${esc(ROLE_NAME[role]||role||'?')}</span>
            </div>`;
        }).join('')}
      </div>`;
  }
}

// ── Stats ─────────────────────────────────────────────────

function _writeStats(meta) {
  if (_isTableside) return;
  if (_myRole === 'narrator') return;
  if (_statsWritten) return;
  if (!meta.winner || !_myRole) return;
  _statsWritten = true;
  const won = (meta.winner === 'village'    && _myRole !== 'werewolf')
           || (meta.winner === 'werewolves' && _myRole === 'werewolf');
  db.ref(`userStats/${_myUid}/werewolves`).transaction(cur => {
    const s = cur || { gamesPlayed: 0, wins: 0 };
    return { gamesPlayed: s.gamesPlayed + 1, wins: s.wins + (won ? 1 : 0) };
  });
}

// ── Utilities ─────────────────────────────────────────────

async function _shareRoom() {
  const url = `${location.origin}/games/werewolves/game.html?room=${_roomCode}`;
  if (navigator.share) await navigator.share({ title: 'Play Werewolves!', url }).catch(() => {});
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
