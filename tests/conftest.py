"""
Shared fixtures for the FROZEN fitness suite.

The app is imported and driven black-box via FastAPI's TestClient so the tests
survive internal refactors (a mutation may rename functions freely as long as the
HTTP contracts hold). We deliberately build the client WITHOUT the `with` context
manager: that skips the app's startup event (an 8s globe prewarm that would hit the
network), keeping the suite offline, fast, and deterministic.
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Repo root on sys.path so `import main` works when pytest runs from anywhere.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from main import app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    # No context manager -> startup/shutdown events do not fire (no network prewarm).
    return TestClient(app)


def _upload(client, indicators, records, name="fixture"):
    """Upload a dataset and return its id. Caller is responsible for shape."""
    resp = client.post(
        "/api/dataset/upload",
        json={"name": name, "indicators": indicators, "records": records},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["dataset_id"]


@pytest.fixture
def uploaded(client):
    """Factory that uploads a dataset and cleans it up afterwards."""
    created = []

    def _make(indicators, records, name="fixture"):
        ds_id = _upload(client, indicators, records, name)
        created.append(ds_id)
        return ds_id

    yield _make

    for ds_id in created:
        client.delete(f"/api/dataset/{ds_id}")
