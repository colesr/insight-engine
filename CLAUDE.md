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

## Secrets (GitHub repo → Settings → Secrets and variables → Actions)

- `HF_TOKEN` — a HuggingFace token with BOTH "Make calls to Inference Providers" (for the
  mutation LLM) AND "Write access to repos you can contribute to" (so CI can `git push` the
  accepted mutation to the live Space). One fine-grained token can hold both permissions.

## Deploy

The HF Space is a Docker Space built from `Dockerfile` + `requirements.txt` + `main.py`;
pushing `main` triggers a rebuild. CI pushes to it ONLY on the validate-success branch, so the
live app only ever receives test-passing mutations. `requirements-dev.txt` (pytest/httpx) is
CI-only and is never installed into the runtime image.
