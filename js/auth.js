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

function signOutUser() {
  return auth.signOut();
}
