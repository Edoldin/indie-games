/* =====================================================
   Google OAuth helpers — shared by all pages.
   Depends on: firebase-init.js (auth global).
   ===================================================== */

// Call once on any page.
// cb(user) is called when auth state is known.
// redirectIfLoggedOut: pass true on game pages so unauthenticated
// visitors are sent back to the home page automatically.
function onAuthReady(cb, redirectIfLoggedOut = true) {
  auth.getRedirectResult().catch(() => {}); // consume pending mobile redirect
  auth.onAuthStateChanged(user => {
    if (!user && redirectIfLoggedOut) {
      window.location.href = '/index.html';
      return;
    }
    cb(user);
  });
}

// Returns the currently signed-in user or null (sync, after onAuthReady).
function currentUser() {
  return auth.currentUser;
}

// Triggers Google sign-in. Uses redirect on mobile (popup is blocked there).
function signIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  const mobile   = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  return mobile
    ? auth.signInWithRedirect(provider)
    : auth.signInWithPopup(provider);
}

// Signs in anonymously and stores the chosen display name.
// localStorage is the reliable source of truth for name because updateProfile
// does not always re-trigger onAuthStateChanged.
async function signInWithName(name) {
  const trimmed = (name || '').trim().slice(0, 30);
  if (!trimmed) throw new Error('Please enter your name.');
  localStorage.setItem('playerName', trimmed);
  const cred = await auth.signInAnonymously();
  await cred.user.updateProfile({ displayName: trimmed }).catch(() => {});
  return auth.currentUser;
}

// Returns the best available display name for a user.
function getDisplayName(user) {
  if (!user) return '';
  return user.displayName
    || (user.isAnonymous ? localStorage.getItem('playerName') : null)
    || 'Player';
}

function signOutUser() {
  return auth.signOut();
}
