"""
FROZEN FITNESS DEFINITION (frontend).

Backend pytest cannot catch a white-screened UI, and mutations auto-deploy to the
LIVE public Space. This gate is the safety net:

  1. Every live JS file must pass `node --check` (a syntax error would blank the app).
  2. index.html must keep its structural anchors — required <script> includes, the
     element IDs the app mounts into, all 8 tabs, and the init() bootstrap.

The live frontend load order (index.html) is dataset_embed.js -> app_v30.js ->
inline init() -> globe_patch.js -> mapping_canvas.js. NOTE: static/app.js and
static/app_v35.js are dead (referenced nowhere) and are intentionally NOT gated here.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
INDEX = STATIC / "index.html"

LIVE_JS = ["dataset_embed.js", "app_v30.js", "globe_patch.js", "mapping_canvas.js"]

REQUIRED_SCRIPT_SRCS = [
    "/static/dataset_embed.js",
    "/static/app_v30.js",
    "/static/globe_patch.js",
    "/static/mapping_canvas.js",
    "cdn.tailwindcss.com",
    "chart.js",
    "three.min.js",
]

REQUIRED_IDS = [
    "categoryGrid", "variableList", "datasetTbody", "globeContainer",
    "correlationBars", "scatterChart", "distributionChart", "emptyState", "resultsArea",
]

REQUIRED_TABS = [
    "explorer", "simulator", "discover", "compare",
    "decisions", "benchmark", "outliers", "mapping",
]

_NODE = shutil.which("node")


@pytest.mark.skipif(_NODE is None, reason="node not installed (CI installs it via setup-node)")
@pytest.mark.parametrize("js_file", LIVE_JS)
def test_live_js_passes_node_check(js_file):
    path = STATIC / js_file
    assert path.exists(), f"{js_file} missing"
    result = subprocess.run(
        [_NODE, "--check", str(path)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, f"{js_file} failed node --check:\n{result.stderr}"


def test_index_has_required_script_includes():
    html = INDEX.read_text()
    for src in REQUIRED_SCRIPT_SRCS:
        assert src in html, f"index.html missing required script reference: {src}"


def test_index_has_required_element_ids():
    html = INDEX.read_text()
    for el_id in REQUIRED_IDS:
        assert f'id="{el_id}"' in html, f"index.html missing element id: {el_id}"


def test_index_has_all_tabs():
    html = INDEX.read_text()
    for tab in REQUIRED_TABS:
        assert f'data-tab="{tab}"' in html, f"index.html missing tab: {tab}"


def test_index_bootstraps_init():
    html = INDEX.read_text()
    assert "init()" in html


def test_globe_digest_view_wired():
    """The globe's 'Digest view' must keep calling the sibling bridge endpoint
    (contract/news_exchange.md). A mutation may restyle it but not unwire it."""
    src = (STATIC / "globe_patch.js").read_text()
    assert "/api/news/world-digest" in src
