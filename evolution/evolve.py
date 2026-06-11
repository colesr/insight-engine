"""
Evolution engine: proposes ONE diff-based mutation per run.

Cycle:
  1. Pick ONE target file (rotation, weighted toward main.py where the top
     priorities live), and gather metrics history + recent attempts + goals.
  2. Ask a code LLM for ONE targeted improvement as a unified diff.
  3. Validate the diff (no frozen paths, no forbidden tokens) and `git apply` it.
  4. CI runs the frozen tests + frontend gate and decides merge-or-revert.

Hard rules (defense in depth; the CI `git diff` guard is the real wall):
  - Never touches tests/, .github/, requirements.txt, Dockerfile.
  - One file, one mutation per run.
  - Logs every attempt (PROPOSED / SKIPPED / REJECTED) to evolution/attempts.log.

This deliberately reuses the working WorldDigest setup: the Hugging Face Inference
Providers OpenAI-compatible router, authed with an `hf_...` HF_TOKEN. (Non-Anthropic
by design — mirrors the sibling system; no Claude SDK is involved here.)
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
METRICS = ROOT / "evolution" / "metrics.json"
ATTEMPTS = ROOT / "evolution" / "attempts.log"
PROMPTS = ROOT / "evolution" / "prompts.md"

MAX_TOKENS = 6000  # a diff is small; full files are only sent as INPUT context

LLM_ENDPOINT = "https://router.huggingface.co/v1/chat/completions"
LLM_MODEL = "Qwen/Qwen3-Coder-480B-A35B-Instruct:cheapest"

# Files the engine may edit (relative to repo root). main.py is weighted heavily
# because Reliability + Analysis-correctness (priorities 1-2) live there. The dead
# files static/app.js and static/app_v35.js are intentionally absent.
EVOLVABLE = [
    "main.py", "main.py", "main.py",      # weight: ~50% of runs target the backend
    "static/app_v30.js",
    "static/globe_patch.js",
    "static/mapping_canvas.js",
    "static/index.html",
]

# Never let a hunk header point at these (also enforced by CI git-diff guard).
FROZEN_PREFIXES = ("tests/", ".github/", "requirements.txt", "Dockerfile", "requirements-dev.txt")
FORBIDDEN_TOKENS = ["import tests", "from tests", "pytest.skip", "sys.exit(0)", "os.remove(", "shutil.rmtree"]


def _git(*args) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)


def pick_target() -> str:
    """Deterministic rotation (no Math.random / Date.now available in CI determinism
    concerns here, but we key off the commit count so successive runs rotate)."""
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


def propose_diff(target: str) -> str | None:
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("[error] HF_TOKEN not set; cannot evolve.")
        return None

    goals = PROMPTS.read_text() if PROMPTS.exists() else ""
    tree = _git("ls-files", "main.py", "static").stdout.strip()
    target_src = (ROOT / target).read_text()

    prompt = f"""{goals}

REPO FILES YOU MAY REFERENCE (you may ONLY edit the target file below):
{tree}

TARGET FILE THIS RUN: {target}
```
{target_src}
```

RECENT METRICS (last 7 health runs):
{recent_metrics()}

RECENT ATTEMPTS (do NOT repeat reverted/rejected/skipped approaches):
{recent_attempts()}

Propose exactly ONE improvement to `{target}`, consistent with the priority order and
constraints above. Output ONLY a single unified diff, git-apply compatible, inside one
```diff fenced block, and nothing else. The diff must:
  - modify ONLY `{target}` (correct `--- a/{target}` / `+++ b/{target}` headers),
  - keep all existing route paths and JSON keys (add, don't rename/remove),
  - never touch tests/, .github/, requirements.txt, or Dockerfile.
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
    text = resp.json()["choices"][0]["message"]["content"]

    match = re.search(r"```(?:diff|patch)?\s*\n(.*?)```", text, re.DOTALL)
    if match:
        return match.group(1).strip() + "\n"
    stripped = text.strip()
    if stripped.startswith(("diff --git", "--- ")):
        return stripped + "\n"
    print(f"[error] no diff block in {len(text)}-char response. Preview:\n{text[:600]}")
    return None


def diff_targets_frozen(diff: str) -> str | None:
    """Return the first frozen path a hunk header points at, else None."""
    for line in diff.splitlines():
        if line.startswith(("+++ ", "--- ", "diff --git")):
            for prefix in FROZEN_PREFIXES:
                # strip a/ b/ and quoting before matching
                norm = line.replace("+++ ", "").replace("--- ", "").replace("diff --git ", "")
                norm = norm.replace("a/", "").replace("b/", "").strip()
                if prefix in norm:
                    return prefix
    return None


def added_lines(diff: str) -> str:
    return "\n".join(l[1:] for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++"))


def apply_diff(diff: str) -> bool:
    """Atomic pre-flight then real apply. Returns True on success."""
    with tempfile.NamedTemporaryFile("w", suffix=".diff", delete=False) as fh:
        fh.write(diff)
        patch_path = fh.name
    for extra in ([], ["--3way"]):
        check = subprocess.run(
            ["git", "-C", str(ROOT), "apply", "--check", *extra, patch_path],
            capture_output=True, text=True,
        )
        if check.returncode == 0:
            real = subprocess.run(
                ["git", "-C", str(ROOT), "apply", *extra, patch_path],
                capture_output=True, text=True,
            )
            os.unlink(patch_path)
            return real.returncode == 0
    print(f"[error] git apply failed: {check.stderr.strip()[:400]}")
    os.unlink(patch_path)
    return False


def main():
    target = pick_target()
    print(f"[evolve] target this run: {target}")

    diff = propose_diff(target)
    if not diff:
        log_attempt("SKIPPED", f"{target}: no usable diff returned")
        sys.exit(1)

    frozen = diff_targets_frozen(diff)
    if frozen:
        log_attempt("REJECTED", f"{target}: diff touches frozen path {frozen}")
        sys.exit(1)

    adds = added_lines(diff)
    for tok in FORBIDDEN_TOKENS:
        if tok in adds:
            log_attempt("REJECTED", f"{target}: forbidden token {tok!r}")
            sys.exit(1)

    if not apply_diff(diff):
        log_attempt("SKIPPED", f"{target}: git apply failed (context drift)")
        sys.exit(1)

    # Belt-and-suspenders: confirm nothing outside the allowed set actually changed.
    changed = [l for l in _git("diff", "--name-only").stdout.splitlines() if l.strip()]
    bad = [c for c in changed if any(p in c for p in FROZEN_PREFIXES)]
    if bad:
        _git("checkout", "--", *bad)
        log_attempt("REJECTED", f"{target}: post-apply touched frozen {bad}")
        sys.exit(1)

    log_attempt("PROPOSED", f"{target}: {len(diff)} char diff applied; CI will validate")
    print(f"Mutation applied to {target}. CI will test and merge or revert.")


if __name__ == "__main__":
    main()
