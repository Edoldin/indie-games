# Código Secreto — Codenames Web App

## URLs
- **Producción:** (pending — deploy to Netlify)
- **Firebase Console:** (pending)
- **Firebase DB Region:** europe-west1

## Stack
- HTML/CSS/JS (vanilla, no framework)
- Firebase Realtime Database (compat SDK v9.23.0)
- Firebase Authentication — Google OAuth only
- Netlify (auto deploy from main)

---

## File Structure

```
/
├── index.html          # Landing: Google sign-in, create/join room
├── game.html           # Full game: lobby → playing → finished
├── wordlists.js        # 400-word EN list (WORDS_EN) + 400-word ES list (WORDS_ES)
├── rules.md            # Full Codenames rules reference
├── database.rules.json # Firebase Realtime Database security rules
├── netlify.toml        # Netlify headers config
├── .gitignore
├── css/
│   └── style.css       # All styles — mobile-first dark spy theme
└── js/
    ├── firebase-init.js # Firebase init (replace REPLACE_* placeholders)
    ├── utils.js         # generateRoomCode, shuffle, generateKeyCard, pickWords, opposite, copyText
    ├── home.js          # index.html logic: auth state, create room, join room
    └── app.js           # game.html logic: all game state, rendering, Firebase listeners
```

---

## Firebase Setup (required before first run)

1. Create a project at https://console.firebase.google.com/
2. Enable **Realtime Database** — choose `europe-west1` region
3. Enable **Authentication → Google** sign-in provider
4. Add your Netlify domain (and `localhost`) to **Auth → Authorized domains**
5. Copy your project's config object into `js/firebase-init.js` (replace all `REPLACE_*` values)
6. Publish the security rules: copy `database.rules.json` content into the Firebase Console rules editor (or use Firebase CLI)

---

## Firebase Database Schema

```
/rooms/{roomCode}/
  meta/
    status:        "lobby" | "playing" | "finished"
    hostUid:       string
    createdAt:     timestamp
    language:      "en" | "es"
    timerSeconds:  number  (0 = off)
    currentTurn:   "red" | "blue" | null
    startingTeam:  "red" | "blue" | null
    winner:        "red" | "blue" | null
    winReason:     "allFound" | "assassin" | "timer" | null
    timerEndsAt:   timestamp | null

  players/{uid}/
    name:      string
    photoURL:  string
    team:      "red" | "blue" | null
    role:      "spymaster" | "operative"
    online:    boolean
    joinedAt:  timestamp

  board/
    words:    [25 strings]         — word list for this game
    revealed: [25 strings|null]    — null=hidden, "red"|"blue"|"bystander"|"assassin"

  clue/
    word:        string | null
    number:      number | "∞" | null
    guessesLeft: number            — decremented by spymaster after each correct guess
    givenBy:     uid | null
    at:          timestamp

  scores/
    red:  number   — remaining red agents (counts down to 0)
    blue: number   — remaining blue agents

  pendingGuess/                    — written by operative when they tap a card
    idx:        number             — card index (0–24)
    byUid:      uid
    claimedBy:  uid | null         — set atomically by spymaster to prevent double-processing
    at:         timestamp

  clueHistory/{pushKey}/
    word:   string
    number: number | "∞"
    team:   "red" | "blue"
    at:     timestamp

  private/
    keyCard: [25 strings]          — "red"|"blue"|"bystander"|"assassin"
                                   — readable ONLY by players with role=spymaster
```

---

## Security Model

**keyCard is never sent to operative clients.**

Firebase rules restrict `/rooms/{roomCode}/private/keyCard` to players whose role
in that room is `spymaster`. Operatives literally cannot read this path.

**Guess processing flow (spymaster-as-referee):**

1. Operative taps a card → writes `pendingGuess: { idx, byUid, claimedBy: null }`
2. Active team's spymaster client detects the new `pendingGuess` via Firebase listener
3. Spymaster runs a Firebase **transaction** on `pendingGuess/claimedBy` — first one wins
4. Winning spymaster uses their local `keyCard` to resolve the outcome
5. Atomic `db.update()` writes: `board/revealed[idx]`, updated `scores`, `clue`, `meta`, clears `pendingGuess`

This prevents the most common cheat (DevTools + Network tab to read card colors).

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Spymaster-as-referee | No Cloud Functions needed; spymaster is always in game |
| Firebase transaction on `claimedBy` | Prevents two spymasters double-processing the same guess |
| `pendingGuess` cleared atomically in the same `update()` | No intermediate states visible to clients |
| `signInWithRedirect` on mobile, `signInWithPopup` on desktop | Popup blocked by some mobile browsers |
| 16px font on inputs | Prevents iOS Safari auto-zoom on focus |
| `aspect-ratio: 1.1/1` on cards | Consistent card shape across all screen widths |
| `clamp()` for card font-size | Words always fit without overflow on any screen |

---

## Known Limitations / TODO

- No reconnection recovery if spymaster drops mid-guess (operative sees spinner indefinitely — workaround: reload)
- Room auto-expiry not implemented (old rooms stay in DB forever — add Firebase cleanup function or TTL rule)
- Custom word packs not yet supported
- No integrated voice/video chat (use Discord/phone)
- `timerEndsAt` uses client clock (good enough for casual play; can drift ~1s between clients)

---

## Insights from Existing Implementations

Informed by reviewing horsepaste, codenames.game, codenames.plus, and open-source repos:

- **horsepaste** (most popular): sends full keyCard to all clients — cheatable via DevTools. We fixed this.
- **codenames.plus**: no mobile support at all. We are mobile-first.
- **codenames.game**: no onboarding. We include `rules.md` and inline hints.
- Common missing feature: role-locked URLs / spymaster enforcement. We enforce via Firebase rules + transaction.
- Common missing feature: turn timer. We include a configurable one.
