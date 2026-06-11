"""
Evolution engine: proposes ONE mutation per run to a single target file.

Mutations are expressed as SEARCH/REPLACE blocks (exact-text edits, Aider-style)
rather than line-numbered unified diffs — code models reliably hallucinate diff
line numbers on a 2k-line file, but a verbatim SEARCH block either matches or it
doesn't. Each block's SEARCH text must be an exact copy of consecutive lines in
the target; the engine replaces the first occurrence. If any block fails to match,
the whole mutation is a clean SKIP (no file change, exit 0) — the nightly run is a
no-op that cycle, not a failure.

Cycle:
  1. Pick ONE target file (rotation, weighted toward main.py).
  2. Ask a code LLM for SEARCH/REPLACE edits to that file only.
  3. Apply them in-process; on success drop evolution/.mutation_applied so CI
     knows to validate + (on pass) deploy. CI decides merge-or-revert.

Hard rules (defense in depth; the CI `git diff` guard is the real wall):
  - Only the single target file is ever written.
  - Never produce forbidden tokens (import tests, pytest.skip, sys.exit(0), ...).
  - Logs every attempt (PROPOSED / SKIPPED / REJECTED) to evolution/attempts.log.

Reuses the working WorldDigest setup: the Hugging Face Inference Providers
OpenAI-compatible router, authed with an `hf_...` HF_TOKEN. (Non-Anthropic by
design — mirrors the sibling system; no Claude SDK is involved here.)
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
METRICS = ROOT / "evolution" / "metrics.json"
ATTEMPTS = ROOT / "evolution" / "attempts.log"
PROMPTS = ROOT / "evolution" / "prompts.md"
MARKER = ROOT / "evolution" / ".mutation_applied"

MAX_TOKENS = 6000  # edits are small; full file is INPUT context only

LLM_ENDPOINT = "https://router.huggingface.co/v1/chat/completions"
LLM_MODEL = "Qwen/Qwen3-Coder-480B-A35B-Instruct:cheapest"

# Files the engine may edit (relative to repo root). main.py is weighted heavily
# because Reliability + Analysis-correctness (priorities 1-2) live there. The dead
# files static/app.js and static/app_v35.js are intentionally absent.
EVOLVABLE = [
    "main.py", "main.py", "main.py",      # ~50% of runs target the backend
    "static/app_v30.js",
    "static/globe_patch.js",
    "static/mapping_canvas.js",
    "static/index.html",
]

FORBIDDEN_TOKENS = ["import tests", "from tests", "pytest.skip", "sys.exit(0)", "os.remove(", "shutil.rmtree"]

EDIT_RE = re.compile(r"<{5,}\s*SEARCH\s*\n(.*?)\n={5,}\s*\n(.*?)\n>{5,}\s*REPLACE", re.DOTALL)


def _git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)


def pick_target() -> str:
    count = _git("rev-list", "--count", "HEAD").stdout.strip()
    idx = (int(count) if count.isdigit() else 0) % len(EVOLVABLE)
    return EVOLVABLE[idx]


def recent_metrics(n=7) -> str:
    if not METRICS.exists():
        return "No metrics yet."
    try:
        history = json.loads(METRICS.read_text() or "[]")
    except json.JSONDecodeError:
        return "No metrics yet."
    return json.dumps(history[-n:], indent=2) if history else "No metrics yet."


def recent_attempts(n=8) -> str:
    if not ATTEMPTS.exists():
        return "No previous attempts."
    lines = ATTEMPTS.read_text().strip().splitlines()
    return "\n".join(lines[-n:]) if lines else "No previous attempts."


def log_attempt(status: str, note: str = ""):
    ATTEMPTS.parent.mkdir(exist_ok=True)
    with ATTEMPTS.open("a") as f:
        f.write(f"{datetime.now(timezone.utc).isoformat()} | {status} | {note}\n")


def propose(target: str) -> str | None:
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("[error] HF_TOKEN not set; cannot evolve.")
        return None

    goals = PROMPTS.read_text() if PROMPTS.exists() else ""
    tree = _git("ls-files", "main.py", "static").stdout.strip()
    target_src = (ROOT / target).read_text()

    prompt = f"""{goals}

REPO FILES (you may ONLY edit the target file below):
{tree}

TARGET FILE THIS RUN: {target}
```
{target_src}
```

RECENT METRICS (last 7 health runs):
{recent_metrics()}

RECENT ATTEMPTS (do NOT repeat reverted/rejected/skipped approaches):
{recent_attempts()}

Propose exactly ONE improvement to `{target}`, consistent with the priority order
and constraints above. Express it as one or more SEARCH/REPLACE edits in EXACTLY
this format (you may output several blocks):

<<<<<<< SEARCH
<verbatim consecutive lines that currently exist in {target}>
=======
<the replacement lines>
>>>>>>> REPLACE

Rules:
- The SEARCH text MUST be copied EXACTLY (whitespace included) from the current
  {target} above, long enough to be unique.
- Edit ONLY {target}. Keep all existing route paths and JSON keys (add, don't
  rename/remove). Output the SEARCH/REPLACE blocks and nothing else.
"""

    resp = requests.post(
        LLM_ENDPOINT,
        headers={"Authorization": f"Bearer {hf_token}"},
        json={
            "model": LLM_MODEL,
            "max_tokens": MAX_TOKENS,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=300,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def parse_edits(text: str):
    return [(m.group(1), m.group(2)) for m in EDIT_RE.finditer(text)]


def main():
    if MARKER.exists():
        MARKER.unlink()

    target = pick_target()
    print(f"[evolve] target this run: {target}")

    try:
        text = propose(target)
    except requests.HTTPError as e:
        log_attempt("SKIPPED", f"{target}: LLM HTTP error {e.response.status_code}")
        print(f"[skip] LLM error: {e}")
        sys.exit(0)
    if not text:
        log_attempt("SKIPPED", f"{target}: no response")
        sys.exit(0)

    edits = parse_edits(text)
    if not edits:
        log_attempt("SKIPPED", f"{target}: no SEARCH/REPLACE blocks in response")
        print("[skip] model returned no usable edit blocks")
        sys.exit(0)

    # Forbidden-token pre-check on replacement text.
    for _, replace in edits:
        for tok in FORBIDDEN_TOKENS:
            if tok in replace:
                log_attempt("REJECTED", f"{target}: forbidden token {tok!r}")
                print(f"[reject] forbidden token {tok!r}")
                sys.exit(0)

    path = ROOT / target
    src = path.read_text()
    new = src
    for search, replace in edits:
        if search not in new:
            log_attempt("SKIPPED", f"{target}: SEARCH block not found (drift)")
            print("[skip] a SEARCH block did not match the current file")
            sys.exit(0)
        new = new.replace(search, replace, 1)

    if new == src:
        log_attempt("SKIPPED", f"{target}: edits were a no-op")
        sys.exit(0)

    path.write_text(new)
    MARKER.write_text(target + "\n")
    log_attempt("PROPOSED", f"{target}: {len(edits)} edit(s) applied; CI will validate")
    print(f"Mutation applied to {target} ({len(edits)} edit(s)). CI will test and merge or revert.")


if __name__ == "__main__":
    main()
