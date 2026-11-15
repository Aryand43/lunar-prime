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
