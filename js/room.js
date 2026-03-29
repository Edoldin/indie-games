/* =====================================================
   Room CRUD and presence helpers — shared by all games.
   Depends on: firebase-init.js, utils.js, auth.js.
   ===================================================== */

// Reads ?room= from the current URL.
function getRoomCode() {
  return new URLSearchParams(location.search).get('room');
}

// Creates a new room for the given game type and navigates to the game page.
// gameType: string slug, e.g. 'codenames'
// settings: game-specific settings object (stored under meta.settings)
// gameUrl:  path to the game page, e.g. '/games/codenames/game.html'
async function createRoom(gameType, settings, gameUrl) {
  const user = currentUser();
  let code, attempts = 0;
  do {
    code = generateRoomCode();
    const snap = await db.ref(`rooms/${code}/meta`).once('value');
    if (!snap.exists()) break;
  } while (++attempts < 10);

  await db.ref(`rooms/${code}`).set({
    meta: {
      game:        gameType,
      status:      'lobby',
      hostUid:     user.uid,
      createdAt:   firebase.database.ServerValue.TIMESTAMP,
      settings:    settings || {},
      winner:      null,
      winReason:   null,
      currentTurn: null,
      timerEndsAt: null
    },
    players: {
      [user.uid]: _makePlayer(user)
    }
  });

  window.location.href = `${gameUrl}?room=${code}`;
}

// Joins an existing room by code. Reads meta.game to find the game page and navigates there.
// Returns the meta snapshot value on success; throws on not-found or finished.
async function joinRoom(code) {
  const snap = await db.ref(`rooms/${code}/meta`).once('value');
  if (!snap.exists())                   throw new Error('Room not found.');
  if (snap.val().status === 'finished') throw new Error('That game has already ended.');

  const user  = currentUser();
  const pSnap = await db.ref(`rooms/${code}/players/${user.uid}`).once('value');
  if (!pSnap.exists()) {
    await db.ref(`rooms/${code}/players/${user.uid}`).set(_makePlayer(user));
  } else {
    await db.ref(`rooms/${code}/players/${user.uid}/online`).set(true);
  }

  const gameType = snap.val().game;
  window.location.href = `/games/${gameType}/game.html?room=${code}`;
}

// Ensures the signed-in user exists in the room's players list.
// Called once at the top of every game page before subscribing.
async function ensureInRoom(roomCode) {
  const user  = currentUser();
  if (!user) return;
  const snap  = await db.ref(`rooms/${roomCode}/players/${user.uid}`).once('value');
  if (!snap.exists()) {
    await db.ref(`rooms/${roomCode}/players/${user.uid}`).set(_makePlayer(user));
  } else {
    await db.ref(`rooms/${roomCode}/players/${user.uid}/online`).set(true);
  }
  db.ref(`rooms/${roomCode}/players/${user.uid}/online`).onDisconnect().set(false);
}

function _makePlayer(user) {
  return {
    name:     getDisplayName(user),
    photoURL: user.photoURL || '',
    team:     null,
    role:     'operative',
    online:   true,
    joinedAt: firebase.database.ServerValue.TIMESTAMP
  };
}
