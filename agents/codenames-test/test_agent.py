#!/usr/bin/env python3
"""
Codenames Test Agent
====================
Simulates a full Codenames game by directly writing to Firebase as
anonymous users — no service account or extra credentials required.

Each "player" is a separate anonymous Firebase Auth session with its
own ID token. The agent drives the full game loop and asserts correct
DB state after every action.

Usage:
  pip install -r requirements.txt
  python test_agent.py            # run all test scenarios
  python test_agent.py --verbose  # include DB state diffs in output
  python test_agent.py --keep     # don't delete the test room on finish
"""

import argparse
import random
import string
import time
import sys
import json
from dataclasses import dataclass, field
from typing import Any

import requests

# Fix Windows console encoding for Unicode output
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf-8-sig"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Firebase config (from js/firebase-init.js) ─────────────────
DB_URL  = "https://indie-games-fdf3b-default-rtdb.europe-west1.firebasedatabase.app"
API_KEY = "AIzaSyBWogAby54M1QuZ51X_YUnQ19X49rxJHUo"   # public web API key
AUTH_URL = f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={API_KEY}"

# ── Helpers ─────────────────────────────────────────────────────

VERBOSE = False

def log(msg: str) -> None:
    print(msg)

def vlog(msg: str) -> None:
    if VERBOSE:
        print(f"    {msg}")

def opposite(team: str) -> str:
    return "blue" if team == "red" else "red"

def server_timestamp() -> int:
    """Approximate server timestamp (ms). Firebase will overwrite with real value."""
    return int(time.time() * 1000)

# ── Firebase REST helpers ───────────────────────────────────────

class FirebaseClient:
    """Thin wrapper around the Firebase REST API authenticated as one user."""

    def __init__(self, id_token: str, uid: str):
        self.id_token = id_token
        self.uid = uid

    def _url(self, path: str) -> str:
        clean = path.lstrip("/")
        return f"{DB_URL}/{clean}.json?auth={self.id_token}"

    def get(self, path: str) -> Any:
        r = requests.get(self._url(path), timeout=10)
        r.raise_for_status()
        return r.json()

    def set(self, path: str, value: Any) -> None:
        """PUT — overwrites the node."""
        r = requests.put(self._url(path), json=value, timeout=10)
        r.raise_for_status()

    def patch(self, path: str, updates: dict) -> None:
        """PATCH — multi-path update (shallow merge)."""
        r = requests.patch(self._url(path), json=updates, timeout=10)
        r.raise_for_status()

    def delete(self, path: str) -> None:
        r = requests.delete(self._url(path), timeout=10)
        r.raise_for_status()


def sign_in_anonymous() -> tuple[str, str]:
    """Create a Firebase anonymous user and return (idToken, uid)."""
    r = requests.post(AUTH_URL, json={"returnSecureToken": True}, timeout=10)
    r.raise_for_status()
    data = r.json()
    return data["idToken"], data["localId"]

# ── Game logic (Python port of game.js) ─────────────────────────

# Unambiguous chars (same as js/utils.js generateRoomCode)
ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

def generate_room_code() -> str:
    return "".join(random.choices(ROOM_CHARS, k=4))

def generate_key_card(start_team: str) -> list[str]:
    """
    Port of js/utils.js generateKeyCard.
    Returns 25 card types: 9 start, 8 other, 7 bystander, 1 assassin.
    """
    other = opposite(start_team)
    cards = (
        [start_team] * 9 +
        [other]      * 8 +
        ["bystander"] * 7 +
        ["assassin"]  * 1
    )
    random.shuffle(cards)
    return cards

# Fixed 25-word board for reproducible tests
TEST_WORDS = [
    "APPLE", "BANK", "CRANE", "DESERT", "EAGLE",
    "FISH",  "GLOBE", "HORN", "ICE",   "JEWEL",
    "KNIFE", "LAMP",  "MOON",  "NIGHT", "OAK",
    "PIANO", "QUEEN", "RIVER", "SNAKE", "TREE",
    "UNCLE", "VIOLIN","WHALE", "XRAY",  "ZEBRA",
]

def resolve_guess(idx: int, key_card: list, meta: dict, scores: dict, clue: dict) -> dict:
    """
    Port of game.js _resolveGuess.
    Returns a dict of multi-path updates to apply to rooms/{code}/.
    """
    card_type = key_card[idx]
    turn = meta["currentTurn"]
    opp  = opposite(turn)
    updates: dict = {}

    updates[f"board/revealed/{idx}"] = card_type

    if card_type == "assassin":
        updates["meta/winner"]    = opp
        updates["meta/status"]    = "finished"
        updates["meta/winReason"] = "assassin"

    elif card_type == turn:
        new_score = scores[turn] - 1
        updates[f"scores/{turn}"] = new_score
        if new_score == 0:
            updates["meta/winner"]    = turn
            updates["meta/status"]    = "finished"
            updates["meta/winReason"] = "allFound"
        else:
            left = clue.get("guessesLeft", 1) - 1
            updates["clue/guessesLeft"] = left
            if left == 0:
                _add_end_turn(updates, turn)
    else:
        if card_type == opp:
            ns = scores[opp] - 1
            updates[f"scores/{opp}"] = ns
            if ns == 0:
                updates["meta/winner"]    = opp
                updates["meta/status"]    = "finished"
                updates["meta/winReason"] = "allFound"
        if "meta/status" not in updates:
            _add_end_turn(updates, turn)

    updates["pendingGuess"] = None
    return updates

def _add_end_turn(updates: dict, turn: str) -> None:
    updates["clue/word"]        = None
    updates["clue/number"]      = None
    updates["clue/guessesLeft"] = 0
    updates["clue/givenBy"]     = None
    updates["meta/currentTurn"] = opposite(turn)
    updates["meta/timerEndsAt"] = None

# ── Player personas ─────────────────────────────────────────────

@dataclass
class Player:
    name: str
    team: str
    role: str   # 'spymaster' | 'operative'
    client: FirebaseClient = field(repr=False)

    @property
    def uid(self) -> str:
        return self.client.uid

# ── Test game orchestrator ──────────────────────────────────────

class CodenamesTestGame:
    """
    Drives a complete scripted Codenames game via Firebase REST API.
    All four players are separate anonymous auth sessions.
    """

    def __init__(self, keep_room: bool = False):
        self.keep_room  = keep_room
        self.room_code  = generate_room_code()
        self.players: list[Player] = []
        self.key_card: list[str]   = []
        self.words: list[str]      = TEST_WORDS[:]
        self.scores: dict          = {}
        self.meta: dict            = {}
        self.clue: dict            = {}
        self.revealed: list        = [None] * 25
        self.start_team: str       = ""
        self._assertions: list[tuple[bool, str]] = []

    # ── Setup ────────────────────────────────────────────────

    def setup(self) -> None:
        log(f"\n{'='*55}")
        log(f"  Setting up room  {self.room_code}")
        log(f"{'='*55}")

        # Create 4 anonymous players
        personas = [
            ("Red Spy",  "red",  "spymaster"),
            ("Red Op",   "red",  "operative"),
            ("Blue Spy", "blue", "spymaster"),
            ("Blue Op",  "blue", "operative"),
        ]
        for name, team, role in personas:
            token, uid = sign_in_anonymous()
            client = FirebaseClient(token, uid)
            self.players.append(Player(name, team, role, client))
            vlog(f"Created player {name} ({uid[:8]}…)")
        time.sleep(0.3)

        host = self.players[0]

        # Deterministic board: red starts
        self.start_team = "red"
        self.key_card   = generate_key_card(self.start_team)
        self.scores     = {"red": 9, "blue": 8}

        # ── Step 1: Host creates room with only their own player slot ──────
        # (mirrors room.js createRoom — hostUid must exist before we can write
        #  other players' slots, because players/$uid.write checks hostUid)
        meta = {
            "game":        "codenames",
            "status":      "lobby",
            "hostUid":     host.uid,
            "createdAt":   server_timestamp(),
            "settings":    {"language": "en", "timerSeconds": 0, "tableside": False},
            "winner":      None,
            "winReason":   None,
            "currentTurn": None,
            "startTeam":   None,
            "timerEndsAt": None,
        }
        # Write meta first (sets hostUid in DB)
        host.client.set(f"rooms/{self.room_code}/meta", meta)
        # Then write host's own player slot (auth.uid === $uid satisfies the rule)
        host.client.set(f"rooms/{self.room_code}/players/{host.uid}", {
            "name":     host.name,
            "photoURL": "",
            "team":     host.team,
            "role":     host.role,
            "online":   True,
            "joinedAt": server_timestamp(),
        })
        vlog("Room shell created (host only)")

        # ── Step 2: Each other player writes their own slot ────────────────
        # (mirrors joinRoom — players write their own uid, so auth.uid === $uid)
        for p in self.players[1:]:
            p.client.set(f"rooms/{self.room_code}/players/{p.uid}", {
                "name":     p.name,
                "photoURL": "",
                "team":     p.team,
                "role":     p.role,
                "online":   True,
                "joinedAt": server_timestamp(),
            })
            vlog(f"  {p.name} joined")
        time.sleep(0.2)

        # ── Step 3: Host starts game — writes board, scores, clue, status ──
        host.client.patch(f"rooms/{self.room_code}", {
            "board/words":        self.words,
            "board/revealed":     [None] * 25,
            "scores":             self.scores,
            "clue":               {"word": None, "number": None, "guessesLeft": 0, "givenBy": None},
            "pendingGuess":       None,
            "clueHistory":        None,
            "meta/status":        "playing",
            "meta/currentTurn":   self.start_team,
            "meta/startTeam":     self.start_team,
            "meta/winner":        None,
            "meta/winReason":     None,
        })
        vlog("Game started — board written")

        # ── Step 4: Host writes keyCard (hostUid now in DB → write allowed) ─
        host.client.set(f"rooms/{self.room_code}/private/keyCard", self.key_card)
        vlog("KeyCard written")

        self.meta = {**meta, "status": "playing", "currentTurn": self.start_team}
        log(f"  Room created. Start team: {self.start_team.upper()}")
        log(f"  Board: {len([c for c in self.key_card if c == 'red'])} red  "
            f"{len([c for c in self.key_card if c == 'blue'])} blue  "
            f"{len([c for c in self.key_card if c == 'bystander'])} bystander  "
            f"{len([c for c in self.key_card if c == 'assassin'])} assassin")

    def _find_cards(self, card_type: str, exclude: set[int] | None = None) -> list[int]:
        """Return indices of unrevealed cards of a given type."""
        return [
            i for i, t in enumerate(self.key_card)
            if t == card_type and self.revealed[i] is None
            and (exclude is None or i not in exclude)
        ]

    def _get_player(self, team: str, role: str) -> Player:
        return next(p for p in self.players if p.team == team and p.role == role)

    def _refresh_state(self) -> None:
        """Pull current meta, scores, clue, revealed from DB."""
        host = self.players[0]
        room = host.client.get(f"rooms/{self.room_code}")
        self.meta   = room.get("meta", {})
        self.scores = room.get("scores", {})
        self.clue   = room.get("clue", {})

        raw = room.get("board", {}).get("revealed", [])
        if isinstance(raw, dict):
            # Firebase may return a sparse object {0: val, 5: val, ...}
            d = {int(k): v for k, v in raw.items()}
            self.revealed = [d.get(i) for i in range(25)]
        elif isinstance(raw, list):
            # Firebase trims trailing nulls — pad back to 25
            self.revealed = list(raw) + [None] * (25 - len(raw))
        else:
            self.revealed = [None] * 25

    # ── Game actions ─────────────────────────────────────────

    def give_clue(self, team: str, word: str, number: int) -> None:
        spy    = self._get_player(team, "spymaster")
        guesses_left = number + 1   # operatives get number+1 guesses
        clue_data = {
            "word":        word,
            "number":      number,
            "guessesLeft": guesses_left,
            "givenBy":     spy.uid,
            "at":          server_timestamp(),
        }
        spy.client.set(f"rooms/{self.room_code}/clue", clue_data)
        self.clue = clue_data
        log(f"  [{team.upper()} SPY] Clue: {word} {number} (up to {guesses_left} guesses)")

    def vote_and_confirm(self, team: str, card_idx: int) -> str:
        """
        Operative votes for card_idx, spymaster confirms.
        Returns the card type that was revealed.
        Mirrors the voting mechanic in game.js.
        """
        op  = self._get_player(team, "operative")
        spy = self._get_player(team, "spymaster")

        word = self.words[card_idx]
        card_type = self.key_card[card_idx]
        vlog(f"Voting for card {card_idx} ({word!r}) — actual type: {card_type}")

        # 1. Operative casts vote
        op.client.set(
            f"rooms/{self.room_code}/pendingGuess",
            {
                "votes":         {op.uid: card_idx},
                "confirmations": {},
                "claimedBy":     None,
                "startedAt":     server_timestamp(),
            },
        )

        # 2. Spymaster writes confirmation + claims + resolves
        spy.client.patch(
            f"rooms/{self.room_code}/pendingGuess",
            {"confirmations": {spy.uid: True}},
        )

        # Claim (simulate transaction — in test we're the only writer)
        spy.client.set(
            f"rooms/{self.room_code}/pendingGuess/claimedBy",
            spy.uid,
        )

        # 3. Resolve
        self._refresh_state()
        updates = resolve_guess(card_idx, self.key_card, self.meta, self.scores, self.clue)
        spy.client.patch(f"rooms/{self.room_code}", updates)

        # Update local state
        self.revealed[card_idx] = card_type
        if f"scores/{team}" in updates:
            self.scores[team] = updates[f"scores/{team}"]
        opp = opposite(team)
        if f"scores/{opp}" in updates:
            self.scores[opp] = updates[f"scores/{opp}"]

        result_label = {
            team:        f"✓ correct ({card_type})",
            opp:         f"✗ wrong team ({card_type}) → turn passes",
            "bystander": f"○ bystander → turn passes",
            "assassin":  f"☠ assassin → {opp} wins",
        }.get(card_type, card_type)

        log(f"  [{team.upper()} OP ] Guessed {word!r} → {result_label}")
        return card_type

    def _is_finished(self) -> bool:
        self._refresh_state()
        return self.meta.get("status") == "finished"

    # ── Assertions ───────────────────────────────────────────

    def assert_state(self, description: str, **expected) -> None:
        self._refresh_state()
        ok = True
        for key, expected_val in expected.items():
            actual_val = self.meta.get(key, self.scores.get(key, "NOT_FOUND"))
            if key.startswith("scores."):
                team = key.split(".")[1]
                actual_val = self.scores.get(team, "NOT_FOUND")
            if actual_val != expected_val:
                log(f"  ✗ FAIL [{description}] {key}: expected {expected_val!r}, got {actual_val!r}")
                ok = False
        if ok:
            log(f"  ✓ PASS [{description}]")
        self._assertions.append((ok, description))

    # ── Cleanup ──────────────────────────────────────────────

    def teardown(self) -> None:
        if self.keep_room:
            log(f"\n  Room {self.room_code} kept for inspection.")
            log(f"  URL: {DB_URL}/rooms/{self.room_code}.json")
            return
        # No .write rule at room root — delete each permitted sub-path.
        host = self.players[0]
        for sub in ["meta", "players", "board", "scores", "clue",
                    "pendingGuess", "clueHistory"]:
            try:
                host.client.delete(f"rooms/{self.room_code}/{sub}")
            except Exception:
                pass
        try:
            host.client.delete(f"rooms/{self.room_code}/private/keyCard")
        except Exception:
            pass
        log(f"\n  Room {self.room_code} deleted.")

    # ── Summary ──────────────────────────────────────────────

    def print_summary(self) -> bool:
        passed = sum(1 for ok, _ in self._assertions if ok)
        total  = len(self._assertions)
        log(f"\n{'='*55}")
        log(f"  Results: {passed}/{total} assertions passed")
        if passed < total:
            for ok, desc in self._assertions:
                if not ok:
                    log(f"  ✗ {desc}")
        log(f"{'='*55}")
        return passed == total


# ── Test scenarios ──────────────────────────────────────────────

def run_scenario_happy_path(keep: bool) -> bool:
    """
    Red team finds all 9 of their cards without mistakes.
    Verifies: correct card → score decreases, guesses_left decreases,
              last card → game status = 'finished', winner = 'red'.
    """
    log("\n\n📋 SCENARIO 1: Happy path — red team finds all cards")
    game = CodenamesTestGame(keep_room=keep)
    game.setup()

    red_cards = game._find_cards("red")
    assert len(red_cards) == 9, f"Expected 9 red cards, got {len(red_cards)}"

    # Give one clue per round (clue covers all remaining red cards)
    round_sizes = [3, 3, 3]   # 3 + 3 + 3 = 9 cards
    card_iter   = iter(red_cards)

    for round_num, size in enumerate(round_sizes, 1):
        game.give_clue("red", f"ROUND{round_num}", size)
        for _ in range(size):
            card_idx = next(card_iter)
            game.vote_and_confirm("red", card_idx)
            if game._is_finished():
                break
        if game._is_finished():
            break

    game.assert_state("red wins after finding all cards",
                      status="finished", winner="red", winReason="allFound")
    game.assert_state("red score is 0", **{"scores.red": 0})

    ok = game.print_summary()
    game.teardown()
    return ok


def run_scenario_wrong_team_card(keep: bool) -> bool:
    """
    Red operative accidentally guesses a blue card.
    Verifies: blue score decreases, turn switches to blue.
    """
    log("\n\n📋 SCENARIO 2: Wrong card — red guesses a blue card")
    game = CodenamesTestGame(keep_room=keep)
    game.setup()

    blue_cards = game._find_cards("blue")
    accident   = blue_cards[0]   # red team will guess this blue card

    game.give_clue("red", "MISTAKE", 1)
    game.vote_and_confirm("red", accident)

    game.assert_state("turn switched to blue after wrong guess",
                      currentTurn="blue", status="playing")
    game.assert_state("blue score decreased by 1", **{"scores.blue": 7})

    ok = game.print_summary()
    game.teardown()
    return ok


def run_scenario_assassin(keep: bool) -> bool:
    """
    Red operative hits the assassin card.
    Verifies: status = 'finished', winner = 'blue', winReason = 'assassin'.
    """
    log("\n\n📋 SCENARIO 3: Assassin — red team hits the assassin")
    game = CodenamesTestGame(keep_room=keep)
    game.setup()

    [assassin_idx] = game._find_cards("assassin")

    game.give_clue("red", "OOPS", 1)
    game.vote_and_confirm("red", assassin_idx)

    game.assert_state("game ends when assassin hit",
                      status="finished", winner="blue", winReason="assassin")

    ok = game.print_summary()
    game.teardown()
    return ok


def run_scenario_bystander_ends_turn(keep: bool) -> bool:
    """
    Red operative hits a bystander card.
    Verifies: no score change, turn passes to blue.
    """
    log("\n\n📋 SCENARIO 4: Bystander — turn passes, no score change")
    game = CodenamesTestGame(keep_room=keep)
    game.setup()

    bystanders = game._find_cards("bystander")
    bystander_idx = bystanders[0]

    game.give_clue("red", "NEUTRAL", 1)
    game.vote_and_confirm("red", bystander_idx)

    game.assert_state("turn switched to blue",
                      currentTurn="blue", status="playing")
    game.assert_state("red score unchanged", **{"scores.red": 9})
    game.assert_state("blue score unchanged", **{"scores.blue": 8})

    ok = game.print_summary()
    game.teardown()
    return ok


def run_scenario_full_game(keep: bool) -> bool:
    """
    Both teams take turns. Blue wins by finding all their 8 cards first.
    Exercises the full turn-alternation and scoring logic.
    """
    log("\n\n📋 SCENARIO 5: Full game — blue team wins")
    game = CodenamesTestGame(keep_room=keep)
    game.setup()

    # Red takes one turn (finds 3 correct cards)
    red_cards = game._find_cards("red")
    game.give_clue("red", "START", 3)
    for i in range(3):
        game.vote_and_confirm("red", red_cards[i])

    # End red's turn (next clue word triggers new turn in guessesLeft=0 scenario)
    # Red clue had guessesLeft = 4 (number+1), so 3 guesses leaves 1 left.
    # Simulate one intentional bystander guess to end turn, or just give wrong
    bystanders = game._find_cards("bystander")
    game.vote_and_confirm("red", bystanders[0])  # hits bystander → ends turn

    game.assert_state("turn passed to blue", currentTurn="blue", status="playing")

    # Blue finds all 8 cards
    blue_cards = game._find_cards("blue")
    assert len(blue_cards) == 8

    for i in range(0, 8, 4):
        remaining = blue_cards[i:i+4]
        game.give_clue("blue", f"BLUE{i}", len(remaining))
        for card_idx in remaining:
            game.vote_and_confirm("blue", card_idx)
            if game._is_finished():
                break
        if game._is_finished():
            break

    game.assert_state("blue wins", status="finished", winner="blue", winReason="allFound")
    game.assert_state("blue score is 0", **{"scores.blue": 0})

    ok = game.print_summary()
    game.teardown()
    return ok


# ── Entry point ─────────────────────────────────────────────────

SCENARIOS = [
    ("Happy path — red finds all cards",      run_scenario_happy_path),
    ("Wrong card — turn passes to opponent",   run_scenario_wrong_team_card),
    ("Assassin — opponent wins immediately",   run_scenario_assassin),
    ("Bystander — turn passes, no score loss", run_scenario_bystander_ends_turn),
    ("Full game — blue wins",                  run_scenario_full_game),
]

def main() -> None:
    global VERBOSE

    parser = argparse.ArgumentParser(description="Codenames Test Agent")
    parser.add_argument("--verbose", action="store_true", help="Show DB state details")
    parser.add_argument("--keep",    action="store_true", help="Keep test rooms in DB")
    parser.add_argument("--scenario", type=int, metavar="N",
                        help="Run only scenario N (1-based)")
    args = parser.parse_args()
    VERBOSE = args.verbose

    print("=" * 55)
    print("  Codenames Test Agent")
    print(f"  DB: {DB_URL}")
    print("=" * 55)

    to_run = SCENARIOS
    if args.scenario:
        to_run = [SCENARIOS[args.scenario - 1]]

    results = []
    for label, fn in to_run:
        try:
            ok = fn(keep=args.keep)
        except Exception as e:
            log(f"\n  ✗ SCENARIO CRASHED: {e}")
            if args.verbose:
                import traceback; traceback.print_exc()
            ok = False
        results.append((ok, label))
        time.sleep(1)   # brief pause between scenarios

    print("\n" + "=" * 55)
    print("  FINAL SUMMARY")
    print("=" * 55)
    for ok, label in results:
        icon = "✓" if ok else "✗"
        print(f"  {icon} {label}")
    passed = sum(1 for ok, _ in results if ok)
    print(f"\n  {passed}/{len(results)} scenarios passed")
    print("=" * 55)

    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
