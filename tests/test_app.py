"""
FROZEN FITNESS DEFINITION (backend).

The evolution engine must NEVER modify this file or anything under .github/
(enforced by the CI git-diff guard). These tests encode the user's intent: any
mutation of main.py / the frontend must keep them green or it is auto-reverted.

Priority order baked in here mirrors evolution/prompts.md:
    Reliability > Analysis correctness > Performance > Coverage/features.

All tests are offline and deterministic — no live World Bank / RSS calls — so CI
noise can never trigger a spurious revert of a good mutation.
"""

import inspect
import time

import main


# ===========================================================================
# 1. RELIABILITY — the app boots and its core HTTP contracts hold
# ===========================================================================

def test_health_contract(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert isinstance(body["datasets_loaded"], int)
    assert isinstance(body["cache_entries"], int)


def test_spa_shell_served(client):
    r = client.get("/")
    assert r.status_code == 200
    # The single-page shell the frontend mounts into.
    assert 'id="globeContainer"' in r.text
    assert 'id="categoryGrid"' in r.text


def test_indicators_catalog(client):
    r = client.get("/api/worldbank/indicators")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == len(body["indicators"])
    first = body["indicators"][0]
    for key in ("id", "wb_code", "name", "source", "category"):
        assert key in first


def test_sources_list_contract(client):
    r = client.get("/api/sources/list")
    assert r.status_code == 200
    body = r.json()
    assert body["sources"]["builtin_datasets"]
    assert body["sources"]["worldbank_presets"]
    assert body["total_builtin"] >= 1


def test_builtin_list_and_detail(client):
    r = client.get("/api/datasets/builtin")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == len(body["datasets"])
    for ds in body["datasets"]:
        for key in ("id", "name", "record_count", "variable_count"):
            assert key in ds

    detail = client.get("/api/datasets/builtin/happiness_2023")
    assert detail.status_code == 200
    dbody = detail.json()
    assert dbody["record_count"] > 0
    assert isinstance(dbody["data"], list)
    assert "country" in dbody["data"][0] and "happiness_score" in dbody["data"][0]


def test_builtin_unknown_returns_404(client):
    assert client.get("/api/datasets/builtin/does_not_exist").status_code == 404


def test_dataset_crud_roundtrip(client):
    indicators = [{"key": "a", "name": "A", "category": "Economy"}]
    records = [{"country": "X", "a": 1.0}, {"country": "Y", "a": 2.0}]
    up = client.post(
        "/api/dataset/upload",
        json={"name": "crud", "indicators": indicators, "records": records},
    )
    assert up.status_code == 200
    ds_id = up.json()["dataset_id"]
    assert up.json()["record_count"] == 2
    assert up.json()["indicators_count"] == 1

    listed = client.get("/api/dataset/list").json()["datasets"]
    assert any(d["id"] == ds_id for d in listed)

    got = client.get(f"/api/dataset/{ds_id}")
    assert got.status_code == 200 and got.json()["record_count"] == 2

    assert client.get("/api/dataset/nope-nope").status_code == 404

    deleted = client.delete(f"/api/dataset/{ds_id}")
    assert deleted.status_code == 200 and deleted.json()["deleted"] == ds_id
    assert client.get(f"/api/dataset/{ds_id}").status_code == 404


def test_globe_response_builder_shape():
    """Synthesized globe payload (offline path) must keep its full contract."""
    resp = main._build_globe_response({})
    for key in (
        "countries", "total_articles", "avg_sentiment", "most_active",
        "live_count", "total_count", "source", "updated_at",
    ):
        assert key in resp
    assert isinstance(resp["countries"], list)


def test_globe_route_registered(client):
    paths = {getattr(r, "path", None) for r in client.app.routes}
    assert "/api/news/globe" in paths


# ===========================================================================
# 2. ANALYSIS CORRECTNESS — known-answer fixtures
# ===========================================================================

def test_perfect_positive_correlation(uploaded, client):
    inds = [
        {"key": "x", "name": "X", "category": "Economy"},
        {"key": "y", "name": "Y", "category": "Economy"},
    ]
    recs = [{"country": f"C{i}", "x": float(i), "y": float(2 * i)} for i in range(1, 11)]
    ds_id = uploaded(inds, recs, "pos")
    r = client.post("/api/analyze/correlations", json={"dataset_id": ds_id})
    assert r.status_code == 200
    corr = r.json()["correlations"]
    assert corr, "expected at least one correlation"
    top = corr[0]
    assert abs(top["r"] - 1.0) < 0.001
    assert top["n"] == 10


def test_perfect_negative_correlation(uploaded, client):
    inds = [
        {"key": "x", "name": "X", "category": "Economy"},
        {"key": "y", "name": "Y", "category": "Economy"},
    ]
    recs = [{"country": f"C{i}", "x": float(i), "y": float(-i)} for i in range(1, 11)]
    ds_id = uploaded(inds, recs, "neg")
    r = client.post("/api/analyze/correlations", json={"dataset_id": ds_id})
    top = r.json()["correlations"][0]
    assert abs(top["r"] + 1.0) < 0.001
    assert abs(top["abs_r"] - 1.0) < 0.001


def test_correlations_sorted_by_abs_r(uploaded, client):
    inds = [
        {"key": "a", "name": "A", "category": "Economy"},
        {"key": "b", "name": "B", "category": "Economy"},
        {"key": "c", "name": "C", "category": "Economy"},
    ]
    recs = [
        {"country": f"C{i}", "a": float(i), "b": float(2 * i), "c": float((i * 7) % 5)}
        for i in range(1, 13)
    ]
    ds_id = uploaded(inds, recs, "sorted")
    corr = client.post("/api/analyze/correlations", json={"dataset_id": ds_id}).json()["correlations"]
    abs_rs = [c["abs_r"] for c in corr]
    assert abs_rs == sorted(abs_rs, reverse=True)


def test_correlations_bad_dataset_id(client):
    assert client.post("/api/analyze/correlations", json={"dataset_id": "nope"}).status_code == 400


def test_outlier_is_flagged(uploaded, client):
    inds = [{"key": "val", "name": "Value", "category": "Economy"}]
    normal = [10, 10, 11, 9, 10, 12, 10, 9, 11, 10, 10]
    recs = [{"country": f"N{i}", "val": float(v)} for i, v in enumerate(normal)]
    recs.append({"country": "Spikeland", "val": 500.0})
    ds_id = uploaded(inds, recs, "outliers")
    body = client.post("/api/analyze/outliers", json={"dataset_id": ds_id, "threshold": 2.0}).json()
    assert body["total_deviations"] >= 1
    top = body["outliers"][0]
    assert top["country"] == "Spikeland"
    assert top["top_deviation"]["direction"] == "high"
    assert top["top_deviation"]["z_score"] > 2.0


def test_no_false_positive_outliers(uploaded, client):
    inds = [{"key": "val", "name": "Value", "category": "Economy"}]
    recs = [{"country": f"N{i}", "val": v} for i, v in enumerate([10.0, 10.0, 10.1, 9.9, 10.0, 10.0])]
    ds_id = uploaded(inds, recs, "flat")
    body = client.post("/api/analyze/outliers", json={"dataset_id": ds_id, "threshold": 2.0}).json()
    assert body["total_deviations"] == 0
    assert body["country_count"] == 0


# ===========================================================================
# 3. PERFORMANCE — noise-robust (generous ceiling + cache primitive), no tight timing
# ===========================================================================

def test_correlation_latency_ceiling(uploaded, client):
    """Catches only catastrophic algorithmic regressions, not a slow runner."""
    keys = [f"v{j}" for j in range(6)]
    inds = [{"key": k, "name": k.upper(), "category": "Economy"} for k in keys]
    recs = [{"country": f"C{i}", **{k: float(i * (j + 1)) for j, k in enumerate(keys)}} for i in range(50)]
    ds_id = uploaded(inds, recs, "perf")
    start = time.perf_counter()
    r = client.post("/api/analyze/correlations", json={"dataset_id": ds_id})
    assert r.status_code == 200
    assert time.perf_counter() - start < 5.0


def test_cache_primitive_roundtrip():
    """The in-memory cache (perf infra) must set/get and miss correctly."""
    main._cache_set("frozen_test_key", {"hello": "world"}, ttl=60)
    assert main._cache_get("frozen_test_key") == {"hello": "world"}
    assert main._cache_get("frozen_test_missing_key_xyz") in (None, False)


# ===========================================================================
# 4. COVERAGE RATCHET — locks current breadth; `>=` lets it grow, never shrink
# ===========================================================================

def test_indicator_coverage_floor(client):
    body = client.get("/api/worldbank/indicators").json()
    assert body["count"] >= 269


def test_builtin_dataset_floor(client):
    assert client.get("/api/datasets/builtin").json()["count"] >= 12


def test_worldbank_preset_count(client):
    assert client.get("/api/sources/list").json()["total_wb_presets"] == 9


def test_globe_country_floor():
    assert len(main.GLOBE_COUNTRIES) >= 40


def test_rss_feed_floor():
    assert len(main.RSS_FEEDS) >= 10


# ===========================================================================
# 5. FROZEN-GUARD — fast pre-check against fitness gaming (CI git-diff is the wall)
# ===========================================================================

def test_main_does_not_import_tests():
    src = inspect.getsource(main)
    assert "from tests" not in src and "import tests" not in src


def test_main_has_no_fitness_gaming_calls():
    src = inspect.getsource(main)
    for bad in ["pytest.skip", "sys.exit(0)", "os.remove(", "shutil.rmtree"]:
        assert bad not in src, f"main.py must not contain {bad!r}"
