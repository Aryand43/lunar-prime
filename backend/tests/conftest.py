import os
import tempfile

# Isolated persistence for tests; never call a paid provider or read the local .env.
os.environ["LUNAR_PRIME_NO_DOTENV"] = "1"
os.environ["LUNAR_PRIME_ALLOW_SYNTHETIC"] = "1"  # fast offline provider, tests only
os.environ["LUNAR_PRIME_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["LUNAR_PRIME_QDRANT_PATH"] = ":memory:"
for _k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "LUNAR_PRIME_EMBED_API_KEY", "LUNAR_PRIME_QDRANT_URL"):
    os.environ.pop(_k, None)

import pytest
from fastapi.testclient import TestClient

from app import kernels
from app.main import app


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def spice_loaded(client):
    if not kernels.STATUS.loaded:
        pytest.skip("SPICE kernels not available; run scripts/fetch_kernels.sh")
    return True


def site(id_, label, lat, lon):
    return {"id": id_, "label": label, "lat_deg": lat, "lon_deg": lon}


APOLLO11 = site("apollo11", "Apollo 11", 0.67408, 23.47297)
SHACKLETON = site("shackleton", "Shackleton", -89.67, 129.78)
CHANGE4 = site("change4", "Chang'e 4", -45.4446, 177.5991)
