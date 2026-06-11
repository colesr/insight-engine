"""
Co-evolution dashboard. Renders a merged GitHub Step Summary showing the health of
BOTH self-evolving siblings — this InsightsEngine and World Digest — so the two
organisms can be watched in one place.

CI-only and NOT frozen; nothing in the evolution loop edits it. Best-effort: a
failed sibling fetch degrades to a notice and never fails the job. Writes markdown
to $GITHUB_STEP_SUMMARY when set (GitHub Actions), otherwise to stdout.
"""

import json
import os
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
LOCAL_METRICS = ROOT / "evolution" / "metrics.json"

SIBLING_METRICS_URL = os.environ.get(
    "SIBLING_METRICS_URL",
    "https://raw.githubusercontent.com/colesr/World.alive/main/evolution/metrics.json",
)
SIBLING_DIGEST_URL = os.environ.get(
    "DIGEST_JSON_URL",
    "https://raw.githubusercontent.com/colesr/World.alive/main/public/digest.json",
)


def out(line: str = "") -> None:
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if target:
        with open(target, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    else:
        print(line)


def _load_local() -> list:
    try:
        return json.loads(LOCAL_METRICS.read_text() or "[]")
    except Exception:
        return []


def _fetch_json(url: str):
    try:
        resp = requests.get(url, timeout=10)
        if resp.ok:
            return resp.json()
    except Exception as exc:  # noqa: BLE001 - dashboard must never fail the job
        print(f"[warn] fetch failed {url}: {exc}")
    return None


def main() -> None:
    out("## 🌐 Co-evolution dashboard\n")

    local = _load_local()
    out("### InsightsEngine (this repo)\n")
    if local:
        m = local[-1]
        out(
            f"- {m.get('indicator_count', '—')} indicators · {m.get('builtin_dataset_count', '—')} datasets · "
            f"{m.get('globe_country_count', '—')} globe countries · {m.get('rss_feed_count', '—')} feeds"
        )
        out(
            f"- health {m.get('health_ms', '—')}ms · correlation {m.get('correlation_ms_50x6', '—')}ms · "
            f"{len(local)} runs logged"
        )
    else:
        out("_No metrics logged yet._")

    out("\n### World Digest (sibling)\n")
    sib = _fetch_json(SIBLING_METRICS_URL)
    if isinstance(sib, list) and sib:
        m = sib[-1]
        out(
            f"- {m.get('items_fetched', '—')} items · {m.get('clusters', '—')} clusters · "
            f"{len(m.get('regions_covered', []))} regions · digest {m.get('digest_words', '—')} words"
        )
        out(
            f"- does World Digest see *us*? reachable={m.get('sibling_reachable', '—')}, "
            f"enriched={m.get('sentiment_enriched', '—')}"
        )
    else:
        out("_Sibling metrics unreachable — World Digest may not have run yet._")

    out("\n### Exchange (`world-digest/news-exchange@1`)\n")
    digest = _fetch_json(SIBLING_DIGEST_URL)
    if isinstance(digest, dict):
        n = len(digest.get("clusters", []))
        out(
            f"- World Digest is publishing: {n} clusters, {digest.get('digest_words', '—')} words, "
            f"generated {digest.get('generated_at', '—')}"
        )
        out("- InsightsEngine surfaces this via `/api/news/world-digest` + the globe Digest view.")
    else:
        out("- World Digest's `public/digest.json` not reachable yet — the globe Digest view shows its quiet fallback.")


if __name__ == "__main__":
    main()
