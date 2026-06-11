# CLAUDE.md

This file guides Claude Code (claude.ai/code) when working in this repository.

## What this is

**Global Insight Engine** is a self-evolving FastAPI + vanilla-JS data-analytics web app
(3D news globe, correlation/outlier/decision tools over global development indicators),
deployed as a Docker Space on HuggingFace at `colesr/insight-engine-docker`.

The code lives on **GitHub** (`colesr/insight-engine`, remote `origin`) where two scheduled
GitHub Actions form a cyclical, minimal-supervision dev/test/deploy loop. The HF Space
(remote `hf`) is the **deploy target** — accepted mutations are pushed to it and it rebuilds.

- **Daily** (`.github/workflows/health.yml`, 07:00 UTC): `scripts/collect_metrics.py` boots
  the app, records coverage + latency signals, and commits `evolution/metrics.json`.
- **Nightly** (`.github/workflows/evolve.yml`, 03:00 UTC): `evolution/evolve.py` asks a code
  LLM to rewrite ONE evolvable file as a unified diff. CI runs the frozen suite + frontend
  gate; on pass it commits, pushes to GitHub, **and deploys to the live HF Space**; on fail
  it `git checkout`-reverts.

## Commands

```bash
pip install -r requirements.txt -r requirements-dev.txt
pytest tests/ -q                                  # the fitness gate
node --check static/app_v30.js                    # frontend syntax gate (also v_embed/globe/mapping)
.venv/bin/uvicorn main:app --host 0.0.0.0 --port 7860 --reload   # run locally
python scripts/collect_metrics.py                 # write one metrics.json entry
python evolution/evolve.py                        # propose one mutation (needs HF_TOKEN)
```

## The core invariant

`tests/test_app.py` + `tests/test_frontend.py` are the **frozen fitness definition** and the
user's encoded intent. The loop is only correct because these files (and `.github/`,
`requirements.txt`, `Dockerfile`) can never be modified by the system. Three layers enforce it:

1. `evolve.yml` runs `git diff --quiet -- tests/ .github/ requirements*.txt Dockerfile` and
   reverts + fails if any changed.
2. `evolve.py` rejects any diff whose hunk headers target a frozen path, or whose added lines
   contain forbidden tokens (`import tests`, `pytest.skip`, `sys.exit(0)`, `os.remove`, …),
   *before* applying — and re-checks `git diff --name-only` after applying.
3. `tests/test_app.py` asserts `main.py` never imports from `tests/` and contains no
   fitness-gaming calls.

**To change the system's behavior or goals, edit the tests** — that is the steering
mechanism. Auto-deploy goes straight to live users, so the gate must stay strong; never
weaken a test to make a mutation pass.

Fitness priority order (encoded in tests + `evolution/prompts.md`):
**Reliability > Analysis correctness > Performance > Coverage/features.**

## Evolvable surface

The engine edits ONE file per nightly run, chosen by rotation (weighted toward `main.py`):
`main.py`, `static/app_v30.js`, `static/globe_patch.js`, `static/mapping_canvas.js`,
`static/index.html`. The live frontend load order is
`dataset_embed.js → app_v30.js → init() → globe_patch.js → mapping_canvas.js`.

> ⚠️ `static/app.js` and `static/app_v35.js` are **DEAD** (referenced nowhere) — do not edit
> or resurrect them. The real application is `app_v30.js`.

Coverage floors the engine must never breach (asserted in tests): ≥269 World Bank indicators,
≥12 built-in datasets, exactly 9 WB presets, ≥40 globe countries, ≥10 RSS feeds. Counts may
grow, never shrink.

## Steering the evolution engine

- `evolution/prompts.md` is the goal hierarchy + constraints handed to the mutation LLM. Edit
  it to redirect what mutations optimize for.
- The engine is shown recent `metrics.json` trends and recent `attempts.log` entries so it
  doesn't repeat reverted/rejected/skipped approaches.
- **Kill switch:** create an empty `EVOLUTION_PAUSED` file in the repo root to halt the
  nightly evolution (the daily health run keeps going). Delete it to resume.
- LLM: Hugging Face Inference Providers router (`Qwen/Qwen3-Coder-480B-A35B-Instruct:cheapest`)
  via `HF_TOKEN`, OpenAI-compatible shape — same infra as the sibling WorldDigest system.

## Sibling coupling (World Digest)

This app is bidirectionally coupled to a sibling self-evolving app, **World Digest**
(`colesr/World.alive` on GitHub — a batch RSS digest pipeline), via a **vendored frozen
contract**. The contract lives in `contract/` (`news_exchange.md` spec + `country_aliases.json`),
schema id `world-digest/news-exchange@1` — an *identical copy* is vendored into both repos and
pinned by frozen tests on each side, so it sits outside every evolvable file and no mutation
loop can drift it. Treat `contract/` as a **read-only shared interface**.

- **We consume:** `main.py` `GET /api/news/world-digest` fetches World Digest's published
  `public/digest.json` (env `DIGEST_JSON_URL`, default raw GitHub), cached ~30 min. It is
  **best-effort and never 500s** — a sibling outage degrades to an empty `stale: true` payload.
- **The globe "Digest view":** a self-contained module appended to `static/globe_patch.js`
  adds a "Digest" toggle that overlays the sibling's clustered LLM narrative.
- **They consume us:** World Digest borrows our `/api/news/globe` per-country sentiment over
  HTTP to enrich its digest (we require no change to serve it).
- **Frozen wiring (do not rename/remove):** `tests/test_app.py` (route registered + fallback
  shape) and `tests/test_frontend.py::test_globe_digest_view_wired`.
- **Co-evolution:** `scripts/sibling_dashboard.py` (run in `health.yml`) renders a merged
  health view of both apps; `evolution/prompts.md` carries an integration tier.

**Cardinal invariant:** the coupling is additive and best-effort — this app must fully render
with the sibling offline. A mutation that breaks the bridge will fail the frozen tests and revert.

## Secrets (GitHub repo → Settings → Secrets and variables → Actions)

- `HF_TOKEN` — a HuggingFace token with BOTH "Make calls to Inference Providers" (for the
  mutation LLM) AND "Write access to repos you can contribute to" (so CI can `git push` the
  accepted mutation to the live Space). One fine-grained token can hold both permissions.

## Deploy

The HF Space is a Docker Space built from `Dockerfile` + `requirements.txt` + `main.py`;
pushing `main` triggers a rebuild. CI pushes to it ONLY on the validate-success branch, so the
live app only ever receives test-passing mutations. `requirements-dev.txt` (pytest/httpx) is
CI-only and is never installed into the runtime image.
