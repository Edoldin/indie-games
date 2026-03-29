# Indie Games — Multi-Game Library

## URLs
- **Producción:** https://dulcet-kangaroo-d57bf5.netlify.app
- **GitHub:** https://github.com/Edoldin/indie-games
- **Firebase Console:** https://console.firebase.google.com — project `indie-games-fdf3b`
- **Firebase DB Region:** europe-west1

## Stack
- HTML/CSS/JS (vanilla, no framework, no build step)
- Firebase Realtime Database (compat SDK v9.23.0)
- Firebase Authentication — Google OAuth only
- Netlify (auto-deploy from `main`)

---

## File Structure

```
/
├── index.html                  # Game picker: sign-in + create/join any game
├── css/
│   └── shared.css              # ALL shared styles (variables, lobby, buttons, forms, toast…)
├── js/
│   ├── firebase-init.js        # Firebase config + init (auth, db globals)
│   ├── utils.js                # Pure helpers: generateRoomCode, shuffle, generateKeyCard,
│   │                           #   pickWords, opposite, copyText, teamLabel
│   ├── ui.js                   # DOM helpers: showScreen, showLoading, hideLoading,
│   │                           #   showToast, esc, playerChip
│   ├── auth.js                 # Google OAuth: onAuthReady, currentUser, signIn, signOutUser
│   ├── room.js                 # Room CRUD: createRoom, joinRoom, ensureInRoom, getRoomCode
│   ├── lobby.js                # Generic lobby: initLobby (call once per game page)
│   └── home.js                 # index.html logic + GAME_CONFIGS registry
├── games/
│   └── codenames/
│       ├── game.html           # Shell: header + #lobby-mount + #game-area + #finished
│       ├── game.js             # Codenames GAME interface implementation
│       ├── style.css           # Codenames-only styles (board, cards, score bar…)
│       └── wordlists.js        # WORDS_EN + WORDS_ES (400 words each)
├── database.rules.json         # Firebase security rules
├── netlify.toml
├── .gitignore
├── CLAUDE.md                   # This file
├── PLAYBOOK.md                 # Repeatable process for adding new games
└── rules.md                    # Codenames game rules reference
```

---

## Shared API Reference

### `js/auth.js`
```js
onAuthReady(cb, redirectIfLoggedOut = true)
// cb(user) called when auth state is resolved.
// Pass false as 2nd arg on index.html (don't redirect logged-out users).

currentUser()           // → Firebase User | null (sync, after onAuthReady)
signIn()                // → Promise — Google popup (desktop) or redirect (mobile)
signOutUser()           // → Promise
```

### `js/room.js`
```js
getRoomCode()           // → string | null — reads ?room= from URL
createRoom(gameType, settings, gameUrl)
// Creates room in Firebase, navigates to gameUrl?room=CODE.
// gameType: string slug e.g. 'codenames'
// settings: { language, timerSeconds, … } — game-specific blob

joinRoom(code)
// Reads meta.game from DB, navigates to /games/{game}/game.html?room=CODE.
// Throws Error if not found or finished.

ensureInRoom(roomCode)
// Adds current user to players list if missing; sets online=true; registers onDisconnect.
```

### `js/lobby.js`
```js
initLobby(roomCode, gameObject)
// Call once from game.js after ensureInRoom().
// Subscribes to meta + players. Routes screens. Calls GAME hooks.
// Renders the lobby HTML (team grid, join buttons, role toggle, settings, start btn).
```

### `js/ui.js`
```js
showScreen(ids, active)   // ids: string[], active: string — hide all, show active
showLoading(msg)
hideLoading()
showToast(msg, type)      // type: 'error' | undefined
esc(str)                  // → HTML-escaped string (use before innerHTML injection)
playerChip(player, isMe)  // → HTML string for an avatar chip
```

### `js/utils.js`
```js
generateRoomCode()         // → 4-char string (unambiguous chars)
shuffle(arr)               // → new shuffled array (pure)
generateKeyCard(startTeam) // → 25-element array: 9 start, 8 other, 7 bystander, 1 assassin
pickWords(wordList)        // → 25 random words from the list
opposite(team)             // 'red' ↔ 'blue'
copyText(text)             // → Promise — clipboard API with fallback
```

---

## GAME Interface Contract

Every `game.js` must assign `window.GAME` **before** calling `onAuthReady`.
`lobby.js` reads `window.GAME` when `initLobby()` is called.

```js
window.GAME = {

  name: 'Your Game Name',        // shown in header (optional)

  // ── Lobby ──────────────────────────────────────────────

  // Returns HTML string for host-only settings row.
  // Read current values from meta.settings. Return '' for no settings.
  renderSettings(meta) {},

  // Called when any control inside #game-settings-slot changes.
  // Write updated value to Firebase: db.ref(`rooms/${roomCode}/meta/settings/KEY`).set(val)
  onSettingChange(event, roomCode) {},

  // Returns { valid: boolean, hint: string }.
  // hint is shown below the Start button.
  lobbyValid(players, meta) {},

  // Returns a Firebase multi-path update object.
  // Keys are paths relative to rooms/{roomCode}/. DO NOT include meta/status.
  // lobby.js adds meta/status='playing', meta/winner=null, meta/winReason=null.
  generateState(players, meta) {},

  // ── Lifecycle ───────────────────────────────────────────

  // Called once by lobby.js after auth + ensureInRoom.
  // Set up game state, attach header button listeners.
  // DO NOT subscribe to meta or players here — lobby.js owns those.
  init(roomCode, myUid) {},

  // Called when meta.status changes to 'playing' or 'finished'.
  // lobby.js has already switched the visible screen.
  // You are responsible for rendering game-area and finished screens.
  onStatusChange(status, meta) {},

  // Called on every players snapshot (all statuses).
  // Update local myRole / myTeam from the source of truth.
  onPlayersUpdate(players, meta) {},

  // Returns Firebase multi-path update to reset game state for Play Again.
  // lobby.js adds meta/status='lobby', meta/winner=null, currentTurn=null, player roles reset.
  // Return null to manage the finished screen entirely yourself.
  getResetUpdate(players, meta) {},
};
```

---

## Firebase Database Schema

```
/rooms/{roomCode}/
  meta/
    game:        string          — game type slug ('codenames', …)
    status:      "lobby" | "playing" | "finished"
    hostUid:     string
    createdAt:   timestamp
    settings:    object          — game-specific settings blob
    winner:      string | null
    winReason:   string | null
    currentTurn: string | null   — game-specific (team name, player uid, etc.)
    timerEndsAt: timestamp | null

  players/{uid}/
    name, photoURL, team, role, online, joinedAt

  [game-specific paths — each game owns these]:
    board/...
    scores/...
    clue/...
    pendingGuess/...
    clueHistory/...
    private/...    ← restricted by Firebase rules
```

---

## Adding a New Game (Step-by-Step)

1. **Create the folder:** `games/{slug}/`

2. **Write `game.html`** — copy `games/codenames/game.html`, change:
   - `<title>` and `.logo` text
   - CSS `<link>` to your game's stylesheet
   - The `#game-area` section (game-specific board HTML)
   - Keep everything else identical

3. **Write `style.css`** — only game-specific styles. Import from `css/shared.css` (loaded via HTML).

4. **Write `game.js`** — implement `window.GAME` interface (8 methods).
   The boot block at the bottom is always the same 5 lines:
   ```js
   onAuthReady(async user => {
     if (!user) return;
     const roomCode = getRoomCode();
     if (!roomCode) { window.location.href = '/index.html'; return; }
     $('header-avatar').src = user.photoURL || '';
     $('header-room-code').textContent = roomCode;
     await ensureInRoom(roomCode);
     initLobby(roomCode, window.GAME);
   });
   ```

5. **Register in `js/home.js`** — add one entry to `GAME_CONFIGS`:
   ```js
   yourslug: {
     slug:            'yourslug',
     name:            'Game Name',
     icon:            '🎲',
     description:     'One sentence description.',
     players:         '2 – 6 players',
     gameUrl:         '/games/yourslug/game.html',
     settingsHtml:    `...`,           // HTML for create-room settings on index.html
     collectSettings: () => ({ ... }) // reads the settingsHtml form values
   }
   ```

6. **Firebase rules** — if your game stores secret data under `private/`, add a read rule:
   ```json
   "private": {
     "yourSecret": {
       ".read": "root.child('rooms').child($roomCode).child('players').child(auth.uid).child('role').val() === 'your-privileged-role'"
     }
   }
   ```

That's all. `lobby.js`, `auth.js`, `room.js`, and `ui.js` need zero changes.

---

## Prompt Template for Claude (Add New Game)

```
I want to add [GAME NAME] to the Indie Games library.

Read CLAUDE.md for the full shared API. The files you need to write:
  games/{slug}/game.html  — copy codenames shell, adapt #game-area
  games/{slug}/game.js    — implement window.GAME interface (CLAUDE.md has the contract)
  games/{slug}/style.css  — game-specific styles only

Also add one entry to GAME_CONFIGS in js/home.js.

Game rules: [paste rules or link]

Secret data (if any): [e.g. "player hands must be hidden"]
Special mechanics: [e.g. "real-time bidding", "hidden roles", etc.]
```

---

## Codenames — Security Notes

- `private/keyCard` is only readable by players with `role=spymaster` (Firebase rules).
- Guess resolution: operative writes `pendingGuess`; spymaster claims it via a Firebase
  **transaction** on `claimedBy` (prevents double-processing); resolves outcome atomically.
- Operatives never receive keyCard data — their client simply cannot read that path.
