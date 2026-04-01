#!/usr/bin/env python3
"""
Game Rules Agent — browser-use + NVIDIA NIM
An autonomous browser agent that searches the web, follows links, reads
rules pages, and writes a structured rules.md — no fixed URLs needed.

Setup:
  pip install -r requirements.txt
  playwright install chromium
  # Set NVIDIA_NIM_API_KEY in agent.env

Usage:
  python agent.py --game "Masquerade"
  python agent.py --game "Wavelength" --slug wavelength
  python agent.py --all
"""

import argparse
import asyncio
import re
import sys
from pathlib import Path

from dotenv import dotenv_values

# Fix Windows console encoding for emoji output
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf-8-sig"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Paths & config ─────────────────────────────────────────
AGENT_DIR    = Path(__file__).parent
PROJECT_ROOT = AGENT_DIR.parent.parent
OUTPUT_DIR   = PROJECT_ROOT / "games"

env_config = {}
for f in [AGENT_DIR / "agent.env", AGENT_DIR / ".env"]:
    if f.exists():
        env_config.update(dotenv_values(f))

API_KEY = env_config.get("NVIDIA_NIM_API_KEY", "")
# Strip LiteLLM "nvidia_nim/" prefix — native NIM API does not use it
MODEL = env_config.get("MODEL", "meta/llama-3.1-70b-instruct").removeprefix("nvidia_nim/")

if not API_KEY:
    print("ERROR: NVIDIA_NIM_API_KEY not set in agent.env")
    sys.exit(1)

# ── Task template ──────────────────────────────────────────
# The agent's full task description. Be explicit about the expected output
# format so the LLM knows what to produce as its final answer.

TASK_TEMPLATE = """\
You are a board game rules researcher. Find and document the COMPLETE rules for the board game "{game_name}".

STEPS:
1. Search Google (or Bing) for: "{game_name} board game rules how to play"
2. From the results, open the most reliable source — prefer in this order:
   - ultraboardgames.com
   - boardgamegeek.com (wiki or forum thread with rules)
   - wikihow.com
   - Official publisher website
3. Read the FULL rules page carefully. Scroll down if needed.
4. If the page is missing sections (e.g. no setup or no winning conditions), go back and try another result.
5. Once you have a complete picture of the rules, write the final document.

FINAL OUTPUT — write a complete markdown rules document with ALL of these sections:

# {game_name} — Rules

## Overview
(2–3 sentences about the game and its theme)

## Objective
(What players are trying to achieve to win)

## Components
(Full list of game components)

## Setup
(Step-by-step instructions for setting up the game)

## How to Play
### Turn Structure
(What happens on a player's turn, step by step)
(Add more subsections as needed for this game's specific mechanics)

## Winning and Losing
(End-game trigger and how the winner is determined)

## Special Rules & Edge Cases
(Important exceptions, clarifications, and edge cases)

## Quick Reference
(One-paragraph or bullet-list summary of the most important rules)

IMPORTANT:
- Include ALL rules — do not summarise or skip sections
- Only include rules you actually read on the page (do not invent rules)
- The FINAL ANSWER must be the complete markdown document above, nothing else
"""

# ── Browser agent ──────────────────────────────────────────

async def fetch_rules_with_browser(game_name: str) -> str | None:
    try:
        from browser_use import Agent, Browser, BrowserProfile
        from langchain_openai import ChatOpenAI
    except ImportError:
        print("ERROR: Required packages missing.")
        print("Run: pip install browser-use langchain-openai && playwright install chromium")
        return None

    llm = ChatOpenAI(
        model=MODEL,
        base_url="https://integrate.api.nvidia.com/v1",
        api_key=API_KEY,
        temperature=0.1,
    )
    # browser-use 0.12+ checks llm.provider; ChatOpenAI doesn't expose it —
    # patch it so the check doesn't raise AttributeError.
    if not hasattr(llm, "provider"):
        object.__setattr__(llm, "provider", "openai")

    # Run headless so no browser window pops up
    browser = Browser(browser_profile=BrowserProfile(headless=True))

    print(f"  🌐 Browser agent starting for '{game_name}'…")
    agent = Agent(
        task=TASK_TEMPLATE.format(game_name=game_name),
        llm=llm,
        browser=browser,
    )

    try:
        result = await agent.run(max_steps=25)
        content = result.final_result()
        if content and len(content) > 400:
            return content
        print("  ⚠️  Agent returned too little content.")
        return None
    except Exception as e:
        print(f"  ✗ Browser agent error: {e}")
        return None
    finally:
        await browser.close()

# ── Output ─────────────────────────────────────────────────

def save_rules(slug: str, content: str) -> None:
    out_dir = OUTPUT_DIR / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "rules.md").write_text(content, encoding="utf-8")
    print(f"  ✅ Saved → games/{slug}/rules.md")

# ── Orchestration ──────────────────────────────────────────

async def process_game(name: str, slug: str) -> bool:
    print(f"\n🎮 {name}  (slug: {slug})")
    rules = await fetch_rules_with_browser(name)
    if not rules:
        print("  ✗ Could not retrieve rules. Try again or check the model logs.")
        return False
    save_rules(slug, rules)
    return True

KNOWN_GAMES = [
    ("Codenames",  "codenames"),
    ("Werewolves", "werewolves"),
    ("Wavelength", "wavelength"),
    ("Dixit",      "dixit"),
    ("Taboo",      "taboo"),
]

# ── Entry point ────────────────────────────────────────────

async def main_async(args: argparse.Namespace) -> None:
    print("=" * 60)
    print(f"  Game Rules Agent (browser-use)  |  Model: {MODEL}")
    print("=" * 60)

    if args.all:
        ok = 0
        for name, slug in KNOWN_GAMES:
            if await process_game(name, slug):
                ok += 1
            await asyncio.sleep(3)
        print(f"\n{'='*60}")
        print(f"  Done — {ok}/{len(KNOWN_GAMES)} games processed")
    else:
        slug = args.slug or re.sub(r"\s+", "", args.game.lower())
        await process_game(args.game, slug)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Game Rules Agent — autonomous browser + NVIDIA NIM"
    )
    grp = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--game", metavar="NAME", help='Game name, e.g. "Masquerade"')
    grp.add_argument("--all",  action="store_true", help="Process all known games")
    parser.add_argument(
        "--slug", metavar="SLUG",
        help="Output folder name (default: lowercase game name, spaces removed)",
    )
    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
