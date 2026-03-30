#!/usr/bin/env python3
"""
Game Rules Agent — NVIDIA NIM + Web Search
Searches the web for board game rules and synthesizes them into rules.md.

Setup:
  pip install -r requirements.txt
  # Set NVIDIA_NIM_API_KEY in agent.env

Usage:
  python agent.py --game "Wavelength"
  python agent.py --game "Taboo" --slug taboo
  python agent.py --all
"""

import argparse
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from dotenv import dotenv_values

# ── Paths ──────────────────────────────────────────────────
AGENT_DIR    = Path(__file__).parent
PROJECT_ROOT = AGENT_DIR.parent.parent
OUTPUT_DIR   = PROJECT_ROOT / "games"

# ── Config ─────────────────────────────────────────────────
env_config = {}
for f in [AGENT_DIR / "agent.env", AGENT_DIR / ".env"]:
    if f.exists():
        env_config.update(dotenv_values(f))

API_KEY = env_config.get("NVIDIA_NIM_API_KEY", "")
# Strip LiteLLM/LangChain "nvidia_nim/" prefix — NIM API does not use it
_raw_model = env_config.get("MODEL", "meta/llama-3.1-70b-instruct")
MODEL = _raw_model.removeprefix("nvidia_nim/")

if not API_KEY:
    print("ERROR: NVIDIA_NIM_API_KEY not set in agent.env")
    sys.exit(1)

NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
WEB_UA  = "Mozilla/5.0 (compatible; GameRulesBot/1.0; +https://github.com)"

# ── NVIDIA NIM ─────────────────────────────────────────────

def nim_query(prompt: str, system: str | None = None, max_tokens: int = 3000) -> str | None:
    """Send a single prompt to NVIDIA NIM and return the text response."""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    try:
        resp = requests.post(NIM_URL, headers=HEADERS, json={
            "model":       MODEL,
            "messages":    messages,
            "temperature": 0.2,
            "max_tokens":  max_tokens,
        }, timeout=120)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
    except requests.HTTPError as e:
        print(f"  ✗ NIM API error {e.response.status_code}: {e.response.text[:200]}")
        return None
    except Exception as e:
        print(f"  ✗ NIM request failed: {e}")
        return None

# ── Web search ─────────────────────────────────────────────

def search_duckduckgo(query: str, max_results: int = 5) -> list[dict]:
    """Search DuckDuckGo HTML and return a list of {title, url} dicts."""
    try:
        resp = requests.post(
            "https://html.duckduckgo.com/html/",
            data={"q": query},
            headers={"User-Agent": WEB_UA},
            timeout=15,
        )
        soup = BeautifulSoup(resp.text, "html.parser")
        results = []
        for a in soup.select(".result__a")[:max_results]:
            href = a.get("href", "")
            # DuckDuckGo wraps URLs in redirects — extract the real URL
            if "uddg=" in href:
                from urllib.parse import unquote, urlparse, parse_qs
                qs = parse_qs(urlparse(href).query)
                href = unquote(qs.get("uddg", [href])[0])
            if href.startswith("http"):
                results.append({"title": a.get_text(strip=True), "url": href})
        return results
    except Exception as e:
        print(f"  ✗ Search failed: {e}")
        return []

def fetch_text(url: str, max_chars: int = 8000) -> str:
    """Fetch a URL and return its cleaned plain text."""
    try:
        resp = requests.get(url, headers={"User-Agent": WEB_UA}, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "nav", "header", "footer", "aside"]):
            tag.decompose()
        text = soup.get_text(separator="\n", strip=True)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text[:max_chars]
    except Exception as e:
        return f"[could not fetch: {e}]"

def gather_web_content(game_name: str) -> str | None:
    """Search for game rules online and return concatenated page content."""
    query   = f"{game_name} board game rules how to play complete"
    print(f"  🌐 Searching: {query}")
    results = search_duckduckgo(query)

    if not results:
        print("  ✗ No search results found.")
        return None

    # Prefer rules/wiki/BGG pages over generic results
    priority = ["boardgamegeek", "wikihow", "ultraboardgames", "fandom", "rules"]
    results.sort(key=lambda r: any(p in r["url"] for p in priority), reverse=True)

    chunks = []
    for r in results[:3]:
        print(f"     ↳ {r['url'][:70]}")
        text = fetch_text(r["url"])
        if len(text) > 300:
            chunks.append(f"=== Source: {r['url']} ===\n{text}")
        time.sleep(0.5)  # be polite

    return "\n\n".join(chunks) if chunks else None

# ── Rules generation ───────────────────────────────────────

SYSTEM_PROMPT = (
    "You are an expert board game rules writer. "
    "You write clear, accurate, well-structured markdown documentation from source material. "
    "Never invent rules that aren't supported by the sources."
)

def generate_rules(game_name: str, web_content: str) -> str | None:
    """Use NIM to synthesize web content into a clean rules.md."""
    print(f"  🤖 Synthesising with {MODEL}…")

    prompt = f"""Based on the following web content about the board game "{game_name}", write a comprehensive rules.md file.

WEB CONTENT (use this as your primary source):
{web_content[:7000]}

Output a complete markdown document with these sections:
# {game_name} — Rules

## Overview
## Objective
## Components
## Setup
## How to Play
### Turn Structure
(expand as needed for this game's mechanics)
## Winning and Losing
## Special Rules & Edge Cases
## Quick Reference

Use bullet lists, numbered steps, and tables where appropriate. Be specific and accurate.
Only include information supported by the sources above.
"""
    return nim_query(prompt, system=SYSTEM_PROMPT)

# ── File output ────────────────────────────────────────────

def save_rules(slug: str, content: str) -> None:
    out_dir = OUTPUT_DIR / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "rules.md").write_text(content, encoding="utf-8")
    print(f"  ✅ Saved → games/{slug}/rules.md")

# ── Orchestration ──────────────────────────────────────────

def process_game(name: str, slug: str) -> bool:
    print(f"\n🎮 {name}  (slug: {slug})")

    web_content = gather_web_content(name)
    if not web_content:
        print(f"  ✗ Skipping — no web content found.")
        return False

    rules = generate_rules(name, web_content)
    if not rules:
        print(f"  ✗ Skipping — NIM did not return rules.")
        return False

    save_rules(slug, rules)
    return True

# Games known to the Indie Games library
KNOWN_GAMES = [
    ("Codenames",  "codenames"),
    ("Werewolves", "werewolves"),
    ("Wavelength", "wavelength"),
    ("Dixit",      "dixit"),
    ("Taboo",      "taboo"),
]

# ── Entry point ────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Game Rules Agent (NVIDIA NIM + Web Search)")
    grp = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--game", metavar="NAME", help='Game name, e.g. "Wavelength"')
    grp.add_argument("--all",  action="store_true", help="Process all known games")
    parser.add_argument("--slug", metavar="SLUG",
                        help="Output folder slug (default: lowercased game name, spaces removed)")
    args = parser.parse_args()

    print("=" * 58)
    print(f"  Game Rules Agent  |  Model: {MODEL}")
    print("=" * 58)

    if args.all:
        ok = 0
        for name, slug in KNOWN_GAMES:
            if process_game(name, slug):
                ok += 1
            time.sleep(2)
        print(f"\n{'='*58}")
        print(f"  Done — {ok}/{len(KNOWN_GAMES)} games processed")
    else:
        slug = args.slug or re.sub(r"\s+", "", args.game.lower())
        process_game(args.game, slug)

if __name__ == "__main__":
    main()
