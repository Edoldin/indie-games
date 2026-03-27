/* =====================================================
   HOME PAGE — auth, create room, join room
   ===================================================== */

const signinSection = document.getElementById('signin-section');
const playSection   = document.getElementById('play-section');
const homeLoading   = document.getElementById('home-loading');
const homeLoadMsg   = document.getElementById('home-loading-msg');

// ── Auth state ──────────────────────────────────────────
auth.onAuthStateChanged(user => {
  homeLoading.classList.add('hidden');
  if (user) {
    showPlay(user);
  } else {
    showSignIn();
  }
});

function showSignIn() {
  signinSection.classList.remove('hidden');
  playSection.classList.add('hidden');
}

function showPlay(user) {
  signinSection.classList.add('hidden');
  playSection.classList.remove('hidden');
  document.getElementById('user-name').textContent  = user.displayName || 'Player';
  document.getElementById('user-photo').src         = user.photoURL    || '';
}

// ── Sign in ─────────────────────────────────────────────
document.getElementById('signin-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('signin-error');
  errEl.textContent = '';
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    // signInWithRedirect is more reliable on mobile; popup used as fallback
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      await auth.signInWithRedirect(provider);
    } else {
      await auth.signInWithPopup(provider);
    }
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// Handle redirect result on mobile after return from Google
auth.getRedirectResult().catch(err => {
  if (err.code && err.code !== 'auth/no-redirect-result') {
    document.getElementById('signin-error').textContent = err.message;
  }
});

// ── Sign out ─────────────────────────────────────────────
document.getElementById('signout-btn').addEventListener('click', () => auth.signOut());

// ── Create room ──────────────────────────────────────────
document.getElementById('create-btn').addEventListener('click', createRoom);
document.getElementById('join-btn').addEventListener('click', joinRoom);

// Allow Enter key in join input
document.getElementById('join-code').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinRoom();
});

// Auto-uppercase join code
document.getElementById('join-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

async function createRoom() {
  const user = auth.currentUser;
  if (!user) return;

  const errEl = document.getElementById('create-error');
  errEl.textContent = '';
  setLoading('Creating room…');

  try {
    const lang       = document.getElementById('create-lang').value;
    const timerSecs  = parseInt(document.getElementById('create-timer').value, 10);

    // Find a free room code (retry until unique)
    let code;
    let attempts = 0;
    do {
      code = generateRoomCode();
      const snap = await db.ref(`rooms/${code}/meta`).once('value');
      if (!snap.exists()) break;
      attempts++;
    } while (attempts < 10);

    const now = firebase.database.ServerValue.TIMESTAMP;

    await db.ref(`rooms/${code}`).set({
      meta: {
        status:       'lobby',
        hostUid:      user.uid,
        createdAt:    now,
        language:     lang,
        timerSeconds: timerSecs,
        currentTurn:  null,
        startingTeam: null,
        winner:       null
      },
      players: {
        [user.uid]: {
          name:      user.displayName || 'Player',
          photoURL:  user.photoURL   || '',
          team:      null,
          role:      'operative',
          online:    true,
          joinedAt:  now
        }
      }
    });

    window.location.href = `game.html?room=${code}`;
  } catch (err) {
    errEl.textContent = err.message;
    clearLoading();
  }
}

async function joinRoom() {
  const user = auth.currentUser;
  if (!user) return;

  const code   = document.getElementById('join-code').value.trim().toUpperCase();
  const errEl  = document.getElementById('join-error');
  errEl.textContent = '';

  if (code.length !== 4) {
    errEl.textContent = 'Enter a 4-letter room code.';
    return;
  }

  setLoading('Joining room…');

  try {
    const snap = await db.ref(`rooms/${code}/meta`).once('value');
    if (!snap.exists()) {
      errEl.textContent = 'Room not found. Check the code and try again.';
      clearLoading();
      return;
    }
    if (snap.val().status === 'finished') {
      errEl.textContent = 'That game has already ended.';
      clearLoading();
      return;
    }

    // Add self to players (idempotent — overwrite is fine)
    await db.ref(`rooms/${code}/players/${user.uid}`).update({
      name:     user.displayName || 'Player',
      photoURL: user.photoURL   || '',
      online:   true,
      joinedAt: firebase.database.ServerValue.TIMESTAMP
    });

    window.location.href = `game.html?room=${code}`;
  } catch (err) {
    errEl.textContent = err.message;
    clearLoading();
  }
}

// ── Loading helpers ──────────────────────────────────────
function setLoading(msg) {
  homeLoadMsg.textContent = msg;
  homeLoading.classList.remove('hidden');
}

function clearLoading() {
  homeLoading.classList.add('hidden');
}
