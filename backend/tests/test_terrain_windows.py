"""Terrain horizons (LOLA south-polar DEM) and the best-window finder."""

import math

import numpy as np
import pytest

from app import terrain

needs_dem = pytest.mark.skipif(not terrain.available(), reason="LOLA DEM not installed; run scripts/fetch_terrain.sh")
IM2 = {"id": "im2", "label": "IM-2", "lat_deg": -84.7906, "lon_deg": 29.1957}
SHACKLETON = {"id": "shk", "label": "Shackleton floor", "lat_deg": -89.67, "lon_deg": 129.78}


@needs_dem
def test_projection_orientation_shackleton_is_a_bowl():
    """Shackleton (21 km wide, ~4.2 km deep): centre must sit far below its rim with this projection."""
    lat, lon = -89.67, 129.78
    centre = float(terrain.height_m(lat, lon))
    u0 = np.array([math.cos(math.radians(lat)) * math.cos(math.radians(lon)),
                   math.cos(math.radians(lat)) * math.sin(math.radians(lon)), math.sin(math.radians(lat))])
    e = np.array([-math.sin(math.radians(lon)), math.cos(math.radians(lon)), 0.0])
    n = np.cross(u0, e)
    dl = 10_500 / terrain.REF_RADIUS_M
    rim = []
    for a in np.linspace(0, 2 * np.pi, 36, endpoint=False):
        u = math.cos(dl) * u0 + math.sin(dl) * (math.cos(a) * n + math.sin(a) * e)
        rim.append(float(terrain.height_m(math.degrees(math.asin(u[2])), math.degrees(math.atan2(u[1], u[0])))))
    assert 3_000 < np.mean(rim) - centre < 5_000


@needs_dem
def test_horizon_profiles_are_physical():
    floor = terrain.horizon(-89.67, 129.78)
    assert floor.el_deg.min() > 15  # crater walls surround the floor
    plateau = terrain.horizon(-84.7906, 29.1957)
    assert plateau.site_height_m > 4_000 and plateau.el_deg.min() < 0  # elevated: sees below 0 deg somewhere
    assert len(floor.az_deg) == 720 and np.isclose(floor.at(np.array([0.25]))[0], (floor.el_deg[0] + floor.el_deg[1]) / 2)


@needs_dem
def test_compare_with_terrain_finds_permanent_shadow(client, spice_loaded):
    body = dict(sites=[SHACKLETON, IM2, {"id": "a11", "label": "Apollo 11", "lat_deg": 0.674, "lon_deg": 23.473}],
                start_utc="2027-02-01T00:00:00Z", duration_hours=29.53 * 24, step_minutes=30, mode="spice")
    ideal = {s["id"]: s for s in client.post("/api/compare", json=body).json()["sites"]}
    terr = {s["id"]: s for s in client.post("/api/compare", json=dict(body, terrain=True)).json()["sites"]}
    assert ideal["shk"]["metrics"]["sun"]["visible_fraction"] > 0.3
    assert terr["shk"]["metrics"]["sun"]["visible_fraction"] == 0.0  # Shackleton floor: permanently shadowed
    assert terr["shk"]["terrain"]["applied"] and terr["shk"]["terrain"]["source_url"].startswith("https://pds-geo")
    assert terr["a11"]["terrain"]["applied"] is False and "Outside" in terr["a11"]["terrain"]["reason"]
    assert terr["a11"]["metrics"] == ideal["a11"]["metrics"]  # unchanged outside the DEM


def test_windows_ranked_and_non_overlapping(client):
    body = dict(site=IM2, start_utc="2027-01-01T00:00:00Z", span_days=120, mission_days=10, priority="power",
                terrain=False, mode="synthetic", top_k=4)
    r = client.post("/api/windows", json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    w = d["windows"]
    assert len(w) == 4 and [x["rank"] for x in w] == [1, 2, 3, 4]
    assert all(w[i]["sun_fraction"] >= w[i + 1]["sun_fraction"] for i in range(3))
    assert max(d["series"]["sun_fraction"]) == w[0]["sun_fraction"]
    from datetime import datetime
    t = sorted(datetime.fromisoformat(x["start_utc"].replace("Z", "+00:00")).timestamp() for x in w)
    assert all(b - a >= 5 * 86400 - 1 for a, b in zip(t, t[1:]))  # at least half a mission apart
    assert "Screening resolution" in d["resolution_note"]


def test_windows_validation(client):
    bad = dict(site=IM2, start_utc="2027-01-01T00:00:00Z", span_days=400, mission_days=60, step_minutes=10,
               mode="synthetic")
    assert client.post("/api/windows", json=bad).status_code == 422  # too many samples
    assert client.post("/api/windows", json=dict(bad, start_utc="2027-01-01T00:00:00")).status_code == 422
