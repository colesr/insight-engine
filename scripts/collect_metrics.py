"""
Daily health probe. Boots the app in-process, records coverage + latency signals,
appends one entry to evolution/metrics.json (capped at the last 90 runs).

This file is CI-only and is NOT frozen, but nothing in the evolution loop edits it.
Its output is the fitness signal the mutation engine reads each night.
"""

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # so `import main` works when run from scripts/

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

METRICS = ROOT / "evolution" / "metrics.json"
CAP = 90

client = TestClient(main.app)


def _latency_ms(method, path, **kw):
    start = time.perf_counter()
    method(path, **kw)
    return round((time.perf_counter() - start) * 1000, 1)


def collect() -> dict:
    indicators = client.get("/api/worldbank/indicators").json()
    builtin = client.get("/api/datasets/builtin").json()
    sources = client.get("/api/sources/list").json()

    # A representative offline compute, for the latency trend.
    inds = [{"key": f"v{j}", "name": f"V{j}", "category": "Economy"} for j in range(6)]
    recs = [{"country": f"C{i}", **{f"v{j}": float(i * (j + 1)) for j in range(6)}} for i in range(50)]
    up = client.post("/api/dataset/upload", json={"name": "metrics", "indicators": inds, "records": recs})
    ds_id = up.json()["dataset_id"]
    corr_ms = _latency_ms(client.post, "/api/analyze/correlations", json={"dataset_id": ds_id})
    client.delete(f"/api/dataset/{ds_id}")

    globe = main._build_globe_response({})

    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "health_ms": _latency_ms(client.get, "/api/health"),
        "indicator_count": indicators["count"],
        "builtin_dataset_count": builtin["count"],
        "wb_preset_count": sources["total_wb_presets"],
        "globe_country_count": len(globe["countries"]),
        "rss_feed_count": len(main.RSS_FEEDS),
        "correlation_ms_50x6": corr_ms,
    }


def main_():
    entry = collect()
    history = []
    if METRICS.exists():
        try:
            history = json.loads(METRICS.read_text() or "[]")
        except json.JSONDecodeError:
            history = []
    history.append(entry)
    history = history[-CAP:]
    METRICS.write_text(json.dumps(history, indent=2) + "\n")
    print(json.dumps(entry, indent=2))


if __name__ == "__main__":
    main_()
