# Game Implementation Playbook

A repeatable process for building multiplayer board/card games as web apps.
Stack: Vanilla HTML/CSS/JS + Firebase Realtime Database + Google OAuth + Netlify.

---

## Phase 1 — Research (before writing any code)

### 1.1 Get the rules
- Search for the official rules PDF (publisher's site) and 2–3 secondary sources
- Summarize into a `rules.md` file in the repo — this becomes the single source of truth
- Note: objective, setup, turn structure, win/lose conditions, edge cases

### 1.2 Review existing web implementations
Search for "[game name] play online" and "[game name] github". Look for:
- What features are praised?
- What are the most common complaints? (mobile support, cheating, UX friction)
- What open-source repos exist and what stack do they use?
- What is the #1 unfixed bug across all implementations?

Document findings. These become your competitive advantages.

### 1.3 Gather assets
- Word lists, card decks, tile sets, etc. — find permissively licensed sources
- Store as plain JS arrays or JSON files in the repo (no external runtime dependency)

---

## Phase 2 — Plan (update CLAUDE.md before coding)

### 2.1 Core decisions to make
| Question | Default answer |
|---|---|
| How many players? | 2–8, browser-based, no accounts except Google |
| Realtime sync needed? | Yes → Firebase Realtime Database |
| Server-side logic needed? | Avoid Cloud Functions — use client-side logic with Firebase rules |
| Auth | Google OAuth only (Firebase Auth) |
| Deployment | Netlify (auto-deploy from main branch) |
| Mobile? | Mobile-first always |

### 2.2 Security model
The most important design decision for multiplayer games:

**Which data must be hidden from which players?**

- Identify "secret" data (e.g. card identities, other player's hand, role assignments)
- Store secret data under `/rooms/{roomCode}/private/` in Firebase
- Write Firebase rules that restrict reads to the correct role
- Design a "referee" pattern: the player who CAN see the data processes actions on behalf of others
  - They subscribe to a `pendingAction` node
  - They use a Firebase **transaction** to claim it atomically (prevents double-processing)
  - They write the outcome and clear `pendingAction` in one `update()` call

### 2.3 Database schema template
```
/rooms/{roomCode}/
  meta/         — game state machine (status, currentTurn, winner, hostUid, settings)
  players/{uid}/ — name, photoURL, team, role, online, joinedAt
  board/        — public game state (revealed cards, positions, etc.)
  clue/         — current active action (clue, move, bid, etc.)
  scores/       — per-team or per-player scores
  pendingAction/ — operative/player writes here; referee processes it
  history/      — log of all actions (for display and replay)
  private/      — secret data (key card, hands, hidden roles)
    secret: []  — readable only by the correct role (enforced via Firebase rules)
```

### 2.4 Page structure
Two HTML pages is usually the right split:
- `index.html` — sign in + create/join room (stateless, no Firebase listeners)
- `game.html?room=CODE` — full game (lobby → playing → finished, managed via JS)

Single-page game with JS-managed screens avoids full page reloads during gameplay.

### 2.5 File structure
```
/
├── index.html
├── game.html
├── [assets].js          — word lists, card data, etc.
├── CLAUDE.md            — project context (stack, schema, decisions)
├── PLAYBOOK.md          — this file
├── rules.md             — game rules reference
├── database.rules.json  — Firebase security rules
├── netlify.toml         — headers config
├── .gitignore
├── css/
│   └── style.css        — all styles, mobile-first
└── js/
    ├── firebase-init.js — config (replace REPLACE_* before running)
    ├── utils.js         — pure helpers (shuffle, roomCode, etc.)
    ├── home.js          — index.html logic
    └── app.js           — game.html logic (state, listeners, rendering, actions)
```

---

## Phase 3 — Implement (in this order)

### Step 1: Infrastructure (no dependencies between these — write in parallel)
- `js/firebase-init.js` — config placeholder with `REPLACE_*` values
- `js/utils.js` — pure functions: shuffle, generateRoomCode, opposite(), copyText(), etc.
- `database.rules.json` — Firebase security rules
- `.gitignore` — exclude `.firebase/`, `.env`, `node_modules/`
- `netlify.toml` — security headers

### Step 2: CSS
Write ALL styles before HTML. Mobile-first using CSS custom properties.
```css
:root {
  /* Define every color, radius, transition as a variable */
  /* Never hardcode values in component styles */
}
/* Order: reset → variables → base → layout → components → states → animations → desktop */
```
Key mobile rules:
- `font-size: 16px` on all `<input>` elements (prevents iOS zoom)
- `aspect-ratio` on cards (consistent shape across screen widths)
- `clamp(min, preferred, max)` for font sizes in grids
- `-webkit-tap-highlight-color: transparent` on clickable elements
- `min-height: 44px` on tap targets

### Step 3: HTML
Write both HTML files. Use IDs consistently — these are the contract between HTML and JS.
- All screens present in DOM, toggled via `.hidden` class
- No inline styles (except one-off layout values)
- Script tags at bottom of `<body>`, in load order:
  1. Firebase SDK (CDN)
  2. `firebase-init.js`
  3. `utils.js`
  4. asset files (wordlists, card data, etc.)
  5. `home.js` or `app.js`

### Step 4: JS — home.js
Handles: auth state, create room, join room.
Key points:
- `auth.onAuthStateChanged` is the entry point — show/hide UI based on user
- Use `signInWithRedirect` on mobile, `signInWithPopup` on desktop (popup blocked on some mobile browsers)
- `auth.getRedirectResult()` handles the return from mobile redirect
- Room creation: generate code, check uniqueness in DB, write full initial state, redirect to game page
- Room joining: validate code exists and status !== 'finished', write player to DB, redirect

### Step 5: JS — app.js
The largest file. Organize into clear sections:
```javascript
// ── State ─────────────── (local variables, never mutated directly except by handlers)
// ── Bootstrap ─────────── (auth.onAuthStateChanged → ensureInRoom → subscribeAll)
// ── Subscriptions ──────── (one .on('value') per Firebase node)
// ── Handlers ──────────── (onMeta, onPlayers, onBoard, onClue, etc.)
// ── Referee logic ─────── (processPendingAction — only runs for the right role)
// ── Lobby actions ──────── (joinTeam, toggleRole, updateSettings, startGame)
// ── Game actions ──────── (clickCard, endTurn, submitClue/move/bid)
// ── UI rendering ──────── (renderLobby, renderBoard, renderFinished, renderGrid, etc.)
// ── Helpers ───────────── (showScreen, showToast, showLoading, hideLoading, esc())
```

**Always escape player-provided strings before injecting into innerHTML:**
```javascript
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

**Always use Firebase transactions for actions that must not be processed twice:**
```javascript
db.ref(`rooms/${roomCode}/pendingAction/claimedBy`).transaction(current => {
  if (current !== null) return; // already claimed — abort
  return myUid;
}, (error, committed) => {
  if (committed) resolveAction();
});
```

---

## Phase 4 — Firebase Setup (one-time per project)

1. **Create project** — console.firebase.google.com → Add project → disable Analytics
2. **Realtime Database** — Build → Realtime Database → Create database → choose region → start in test mode
3. **Authentication** — Build → Authentication → Get started → Sign-in method → Google → Enable → add support email → Save
4. **Get config** — Project settings (gear icon) → Your apps → Web → Register app → copy `firebaseConfig`
5. **Paste config** into `js/firebase-init.js` — replace ALL `REPLACE_*` values including `databaseURL`
6. **databaseURL format:**
   - `europe-west1`: `https://PROJECT_ID-default-rtdb.europe-west1.firebasedatabase.app`
   - `us-central1`:  `https://PROJECT_ID-default-rtdb.firebaseio.com`
   - Always verify against the URL shown in Firebase Console → Realtime Database
7. **Publish security rules** — Realtime Database → Rules tab → paste `database.rules.json` content → Publish
8. **Authorized domains** — Authentication → Settings → Authorized domains → add Netlify URL + `localhost`

### Common Firebase gotchas
| Gotcha | Fix |
|---|---|
| `databaseURL` missing from config | Add it manually — Firebase Console shows the exact URL |
| Wrong region in `databaseURL` | Check actual URL in Firebase Console → Realtime Database |
| PERMISSION_DENIED on all operations | Rules not published yet — paste and publish `database.rules.json` |
| Google sign-in fails with `auth/operation-not-allowed` | Enable Google provider in Authentication → Sign-in method |
| Sign-in fails on Netlify domain | Add Netlify URL to Authentication → Settings → Authorized domains |
| `.on('value')` never fires | Check browser console — likely a silent permission error (add error callback to diagnose) |

---

## Phase 5 — Deploy

1. Push repo to GitHub
2. Netlify → Add new site → Import from Git → select repo
3. Build command: *(empty)*  — Publish directory: `.`
4. Deploy
5. Add Netlify URL to Firebase Authorized domains

---

## Phase 6 — Test checklist

- [ ] Sign in with Google works
- [ ] Create room → lands on lobby
- [ ] Second player can join via link
- [ ] Team/role assignment works in real time
- [ ] Host can start game
- [ ] Cards render correctly (spymaster sees colors, operative sees plain)
- [ ] Operative guess → spymaster processes → card reveals for everyone
- [ ] Wrong guess ends turn
- [ ] Assassin ends game immediately
- [ ] Win condition triggers winner screen
- [ ] Play Again resets to lobby
- [ ] Works on mobile (iOS Safari + Android Chrome)

---

## Prompt template for implementing a new game

When starting a new game, give Claude this prompt:

```
I want to build [GAME NAME] as a multiplayer web app.

Stack: vanilla HTML/CSS/JS + Firebase Realtime Database + Google OAuth + Netlify.
Follow the PLAYBOOK.md structure from the Código Secreto project.

Please:
1. Search the internet for the official rules and summarize into rules.md
2. Search for existing web implementations and their reviews — note what to improve
3. Gather any required assets (word lists, card data, etc.)
4. Update CLAUDE.md with the architecture plan (do NOT implement yet)

Key constraints:
- Mobile-first
- No frameworks, no build step
- [Any game-specific secret data, e.g. "player hands must be hidden from others"]
- [Any game-specific mechanics, e.g. "real-time bidding", "hidden roles", etc.]

Once I approve the plan, implement the full game.
```

---

## Notes from Código Secreto

Lessons learned building this specific game:

- **Spymaster-as-referee** works well for games where one player has privileged info
- **Firebase transactions** on a `claimedBy` field elegantly solve the double-processing problem
- The biggest improvement over existing Codenames apps: keyCard restricted by Firebase rules (not just JS)
- `wordlists.js` with 400 EN + 400 ES words covers most player bases
- Clue history log (sidebar showing all clues given) is a small addition that players love
- Timer with urgency animation at ≤10s keeps games moving without being annoying
