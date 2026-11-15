import math

import pytest

from app import config
from app.route_network import generate_network
from app.routing import RoutingError, gc_distance_km, unit_vector


def _max_hop_ok(wps, start, dest, max_leg):
    pts = [unit_vector(*start)] + [unit_vector(w["lat_deg"], w["lon_deg"]) for w in wps] + [unit_vector(*dest)]
    # every node has at least one neighbour within the leg limit
    for i, p in enumerate(pts):
        assert any(gc_distance_km(p, q) <= max_leg for j, q in enumerate(pts) if j != i)


@pytest.mark.parametrize("start", [(-86.0, 0.0), (-80.0, 179.9), (-75.0, -120.0)])
def test_generated_network_respects_leg_bounds(start):
    wps, info = generate_network(*start, -90, 0, 100)
    assert wps and all(w["label"].startswith("Planning waypoint") for w in wps)
    assert len(wps) <= config.ROUTE_MAX_BASES - 2
    _max_hop_ok(wps, start, (-90, 0), 100)


def test_within_one_leg_needs_no_waypoints():
    assert generate_network(-89.5, 10, -90, 0, 55)[0] == []
    assert generate_network(-90, 0, -90, 0, 55)[0] == []


def test_north_to_south_pole_deterministic_and_preflight():
    with pytest.raises(RoutingError, match="Preflight"):
        generate_network(90, 0, -90, 0, 55)
    a = generate_network(90, 0, -90, 0, 800)
    b = generate_network(90, 0, -90, 0, 800)
    assert a == b and a[1]["antipodal"] and all(math.isfinite(w["lat_deg"]) for w in a[0])


def test_auto_network_route_api(client):
    body = {"start": {"id": "S", "label": "Start", "lat_deg": -84.0, "lon_deg": 40.0},
            "departure_utc": "2027-02-13T00:00:00Z", "horizon_hours": 240, "speed_kmh": 3, "max_leg_km": 60,
            "grid_minutes": 60, "max_wait_hours": 12, "auto_network": True, "mode": "synthetic"}
    r = client.post("/api/route", json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "feasible"
    assert d["route"]["visited"][0] == "S" and d["route"]["visited"][-1] == "south-pole"
    assert any(b["label"].startswith("Planning waypoint") for b in d["bases"])


def test_start_at_destination_is_zero_distance_success(client):
    body = {"start": {"id": "S", "label": "Start", "lat_deg": -90.0, "lon_deg": 77.0},
            "departure_utc": "2027-02-13T00:00:00Z", "horizon_hours": 24, "speed_kmh": 3, "max_leg_km": 60,
            "grid_minutes": 60, "max_wait_hours": 12, "auto_network": True, "mode": "synthetic"}
    r = client.post("/api/route", json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "feasible"
    m = d["route"]["metrics"]
    assert m["distance_km"] == 0 and m["elapsed_s"] == 0 and m["cost"]["total"] == 0


def test_horizon_binding_constraint_explained(client):
    body = {"start": {"id": "S", "label": "Start", "lat_deg": -80.0, "lon_deg": 0.0},
            "departure_utc": "2027-02-13T00:00:00Z", "horizon_hours": 10, "speed_kmh": 3, "max_leg_km": 60,
            "grid_minutes": 60, "max_wait_hours": 5, "auto_network": True, "mode": "synthetic"}
    d = client.post("/api/route", json=body).json()
    assert d["status"] == "infeasible" and "binding constraint is the planning horizon" in d["reason"]
    assert "at least" in d["reason"]


def test_sites_catalogue_sourced(client):
    d = client.get("/api/sites").json()
    assert d["sites"]
    for s in d["sites"]:
        assert s["source_url"].startswith("https://") and s["source_title"]
        if s["category"] == "proposed_region":
            assert s["lat_deg"] is None  # no invented points for broad regions
        assert "base" not in s["name"].lower()


def test_preflight(client):
    body = {"start": {"id": "S", "label": "Start", "lat_deg": 90.0, "lon_deg": 0.0},
            "departure_utc": "2027-02-13T00:00:00Z", "horizon_hours": 240, "speed_kmh": 3, "max_leg_km": 55,
            "grid_minutes": 60, "max_wait_hours": 12, "auto_network": True, "mode": "synthetic"}
    d = client.post("/api/route/preflight", json=body).json()
    assert d["within_limits"] is False and d["min_travel_hours"] > 240 and d["suggestions"]


AUTO = {"departure_utc": "2027-02-13T00:00:00Z", "horizon_hours": 240, "speed_kmh": 3, "max_leg_km": 55,
        "grid_minutes": 30, "max_wait_hours": 24, "auto_network": True, "auto_fit": True, "mode": "synthetic"}


@pytest.mark.parametrize("lat,lon", [(90.0, 0.0), (-62.129, 2.677)])
def test_auto_fit_routes_any_start_to_pole(client, lat, lon):
    """North Pole (antipodal, speed must rise) and a mid-latitude start (label-limit retry) both reach the pole."""
    r = client.post("/api/route", json=dict(AUTO, start={"id": "S", "label": "Start", "lat_deg": lat, "lon_deg": lon}))
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "feasible" and d["route"]["visited"][-1] == "south-pole"
    net = d["network"]
    assert net["adjustments"]  # every change is reported
    eff = net["effective"]
    assert eff["horizon_hours"] <= 1440 and eff["max_leg_km"] >= 55
    # the planner used exactly the reported effective parameters
    assert d["search"]["grid_minutes"] == eff["grid_minutes"]


def test_without_auto_fit_inputs_are_never_changed(client):
    body = dict(AUTO, auto_fit=False, start={"id": "S", "label": "Start", "lat_deg": 0.0, "lon_deg": 0.0})
    r = client.post("/api/route", json=body)
    assert r.status_code == 422 and "limit" in r.json()["error"]["message"]
    pf = client.post("/api/route/preflight", json=body).json()
    assert pf["within_limits"] is False and any("auto-fit" in s for s in pf["suggestions"])
    pf2 = client.post("/api/route/preflight", json=dict(body, auto_fit=True)).json()
    assert pf2["within_limits"] is True and pf2["adjustments"]
