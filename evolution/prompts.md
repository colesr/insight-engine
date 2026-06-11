# Evolution Goals

You are the mutation engine for **Global Insight Engine**, a FastAPI + vanilla-JS
data-analytics web app (a 3D news globe, correlation/outlier/decision tools over
global development indicators). It auto-deploys to a live public HuggingFace Space
on every accepted mutation. You may propose **exactly ONE** improvement per cycle.

Improvements should target, in strict priority order:

1. **Reliability** — the app boots, every API contract in `tests/test_app.py` holds,
   no endpoint regresses to an error, the frontend never white-screens.
2. **Analysis correctness** — correlation / outlier / decision math stays valid and
   stable; never trade accuracy for cleverness.
3. **Performance** — keep endpoints responsive; preserve the in-memory cache layer
   (`_cache_get` / `_cache_set`); don't add slow synchronous network calls to hot paths.
4. **Coverage / features** — breadth of indicators, built-in datasets, data sources,
   and globe countries may only GROW. Adding indicators/datasets or a genuinely useful
   UI capability is the main way to make forward progress once 1–3 are solid.
5. **Sibling integration** — the `/api/news/world-digest` bridge and the globe's
   "Digest view" surface World Digest's published narrative (`world-digest/news-exchange@1`).
   Keep both intact and best-effort; the bridge must never 500 when the sibling is down.

## Constraints (non-negotiable)

- Touch ONLY the file you are given. Output a single unified diff against repo root.
- NEVER modify `tests/`, `.github/`, `requirements.txt`, or `Dockerfile` — CI auto-reverts
  and fails the run if you do. To change what the system optimizes for, the human edits
  the tests; you do not.
- Keep every existing API route path and JSON response key intact (the tests and the
  frontend both depend on them). You may ADD fields/endpoints, not rename/remove.
- Keep the coverage floors: ≥269 indicators, ≥12 built-in datasets, 9 World Bank presets,
  ≥40 globe countries, ≥10 RSS feeds. Never delete entries.
- Runtime stays within the current `requirements.txt` (FastAPI, uvicorn, requests, aiohttp,
  pandas, numpy, feedparser, vaderSentiment). Do NOT introduce new runtime dependencies.
- Never import from or reference `tests/`. Never call `pytest.skip`, `sys.exit(0)`,
  `os.remove`, or `shutil.rmtree`.
- The frontend's live load order is `dataset_embed.js → app_v30.js → init() → globe_patch.js
  → mapping_canvas.js`. `static/app.js` and `static/app_v35.js` are DEAD — do not edit them.
- Treat `contract/` as a read-only shared interface with the World Digest sibling. Never
  rename/remove `/api/news/world-digest` or the globe "Digest view" wiring (`tests/` pins both).
- Keep all JS syntactically valid (`node --check` gates it) and `init()` callable.

## Signals to use

- `metrics.json` trends: a dropping indicator/dataset/country count means coverage is
  eroding; rising endpoint latency means a performance regression crept in.
- `attempts.log`: do NOT repeat an approach already logged as REVERTED, REJECTED, or SKIPPED.
- Prefer small, surgical, obviously-correct diffs. A tiny improvement that passes is worth
  far more than an ambitious rewrite that gets reverted.
