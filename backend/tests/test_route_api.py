import copy

import pytest

from app import kernels

W = lambda i, lat, lon: {"id": i, "label": f"Hypothetical waypoint {i}", "lat_deg": lat, "lon_deg": lon}  # noqa: E731

DEMO = {
    "start": {"id": "S", "label": "Hypothetical start", "lat_deg": -86.0, "lon_deg": 0.0},
    "waypoints": [W("C1", -87.3, 0), W("C2", -88.6, 0), W("E1", -86.4, 25), W("E2", -87.4, 50), W("E3", -88.7, 70),
                  W("W1", -86.4, -25), W("W2", -87.4, -50), W("W3", -88.7, -70)],
    "departure_utc": "2027-02-13T00:00:00Z",
    "horizon_hours": 240,
    "speed_kmh": 3,
    "max_leg_km": 55,
    "grid_minutes": 30,
    "max_wait_hours": 24,
    "weights": {"distance": 1, "darkness": 1, "earth_invisible": 0.5},
}


def req(**kw):
    b = copy.deepcopy(DEMO)
    b.update(kw)
    return b


def test_route_spice_demo(client, spice_loaded):
    r = client.post("/api/route", json=req())
    assert r.status_code == 200
    d = r.json()
    assert d["status"] == "feasible"
    route = d["route"]
    assert route["visited"][0] == "S" and route["visited"][-1] == "south-pole"
    assert d["bases"][-1]["lat_deg"] == -90 and d["bases"][-1]["lon_deg"] == 0
    m = route["metrics"]
    assert m["elapsed_s"] == pytest.approx(m["movement_s"] + m["waiting_s"], abs=1)
    assert m["cost"]["total"] == pytest.approx(m["cost"]["distance"] + m["cost"]["darkness"] + m["cost"]["earth_invisible"], abs=1e-5)
    # optimized never worse than the baseline it was seeded from
    assert m["cost"]["total"] <= d["baseline"]["plan"]["metrics"]["cost"]["total"] + 1e-6
    tr = route["trajectory"]
    n = len(tr["elapsed_s"])
    assert n == len(tr["lat_deg"]) == len(tr["sun_el_deg"]) == len(tr["status"])
    assert tr["elapsed_s"] == sorted(tr["elapsed_s"])
    assert all(-90 <= x <= -85 for x in tr["lat_deg"])
    assert d["direct"]["feasible"] is False and "maximum leg" in d["direct"]["reason"]
    assert d["metadata"]["mode"] == "spice" and len(d["metadata"]["kernels"]) == 5
    assert "Terrain, slopes, obstacles" in d["metadata"]["disclaimer"]
    assert d["search"]["graph_status"] == "feasible"
    for row in d["comparison"]:
        if row["baseline"] == 0:
            assert row["percent_change"] is None


def test_route_synthetic_is_labelled(client):
    r = client.post("/api/route", json=req(mode="synthetic"))
    assert r.status_code == 200
    md = r.json()["metadata"]
    assert md["mode"] == "synthetic" and "SYNTHETIC" in md["provenance"] and md["kernels"] == []


def test_route_infeasible_is_200(client):
    r = client.post("/api/route", json=req(max_leg_km=20, mode="synthetic"))
    assert r.status_code == 200
    d = r.json()
    assert d["status"] == "infeasible" and d["route"] is None and "No feasible route" in d["reason"]


@pytest.mark.parametrize("patch,field", [
    ({"weights": {"distance": 0, "darkness": 0, "earth_invisible": 0}}, "weights"),
    ({"speed_kmh": -1}, "speed_kmh"),
    ({"speed_kmh": 0}, "speed_kmh"),
    ({"departure_utc": "2027-02-13T00:00:00"}, "departure_utc"),
    ({"max_wait_hours": -1}, "max_wait_hours"),
    ({"waypoints": [W("S", -87, 0)]}, None),  # duplicate id
    ({"start": {"id": "S", "label": "x", "lat_deg": -95, "lon_deg": 0}}, "start.lat_deg"),
])
def test_route_validation(client, patch, field):
    r = client.post("/api/route", json=req(**patch, mode="synthetic"))
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "invalid_request"
    if field:
        assert any(d["field"] and d["field"].startswith(field) for d in err["details"])


def test_route_coincident_bases_rejected(client):
    r = client.post("/api/route", json=req(waypoints=[W("P2", -90, 45)], mode="synthetic"))
    assert r.status_code == 422 and "same physical location" in r.json()["error"]["message"]


def test_route_excessive_work_rejected(client):
    r = client.post("/api/route", json=req(grid_minutes=1, horizon_hours=24 * 60, mode="synthetic"))
    assert r.status_code == 422 and "limit" in r.json()["error"]["message"]


def test_route_outside_coverage(client, spice_loaded):
    r = client.post("/api/route", json=req(departure_utc="2160-01-01T00:00:00Z"))
    assert r.status_code == 422 and "coverage" in r.json()["error"]["message"]


def test_route_spice_unavailable(client, monkeypatch):
    monkeypatch.setattr(kernels.STATUS, "loaded", False)
    r = client.post("/api/route", json=req())
    assert r.status_code == 503 and r.json()["error"]["code"] == "spice_unavailable"
