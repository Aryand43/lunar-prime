"""Terrain skylines in /api/compare, using small hand-made horizon files (no elevation maps needed)."""

import json

import pytest

from app import config

RIM = {"lat_deg": -89.684, "lon_deg": -163.261}
IM2 = {"lat_deg": -84.7906, "lon_deg": 29.1957}


def hfile(directory, key, lat, lon, el, site_h=0.0, obs_h=0.0):
    az = [i * 0.5 for i in range(720)]
    data = {"lat_deg": lat, "lon_deg": lon, "site_height_m": site_h, "observer_height_m": obs_h,
            "az_deg": az, "el_deg": [el] * 720, "dems": []}
    (directory / f"{key}.json").write_text(json.dumps(data))


@pytest.fixture
def horizons(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HORIZON_DIR", tmp_path)
    return tmp_path


def body(a, b, mode="spice"):
    return {"sites": [a, b], "start_utc": "2026-12-01T00:00:00Z", "duration_hours": 720, "step_minutes": 60, "mode": mode}


def site(id_, coords, key=None):
    s = {"id": id_, "label": id_, **coords}
    if key:
        s["horizon_key"] = key
    return s


def test_flat_zero_skyline_reproduces_sphere(client, spice_loaded, horizons):
    hfile(horizons, "zero", RIM["lat_deg"], RIM["lon_deg"], 0.0)
    sphere = client.post("/api/compare", json=body(site("A", RIM), site("B", IM2))).json()
    terr = client.post("/api/compare", json=body(site("A", RIM, "zero"), site("B", IM2))).json()
    a0, a1 = sphere["sites"][0], terr["sites"][0]
    assert a0["model"] == "sphere" and a1["model"] == "terrain"
    for k in ("sun", "earth", "masks", "intervals", "metrics", "position_me_km"):
        assert a0[k] == a1[k], k
    # Only the wording of the caveat changes for a terrain site.
    assert any(s["id"] == "A_terrain_resolution" for s in terr["comparison"]["statements"])


def test_five_degree_skyline_removes_sunlight(client, spice_loaded, horizons):
    hfile(horizons, "wall", RIM["lat_deg"], RIM["lon_deg"], 5.0)
    d = client.post("/api/compare", json=body(site("A", RIM, "wall"), site("B", IM2))).json()
    m = d["sites"][0]["metrics"]["sun"]
    assert d["sites"][0]["model"] == "terrain"
    assert m["visible_fraction"] == 0.0 and d["sites"][0]["intervals"]["sun"] == []
    assert m["el_max_deg"] < 5.0  # true elevations are still reported, not margins
    assert d["sites"][0]["horizon"]["el_deg"][0] == 5.0


def test_unknown_key_or_edited_coordinates_use_sphere(client, spice_loaded, horizons):
    hfile(horizons, "wall", RIM["lat_deg"], RIM["lon_deg"], 5.0)
    d = client.post("/api/compare", json=body(site("A", RIM, "no-such-key"), site("B", IM2))).json()
    assert d["sites"][0]["model"] == "sphere" and d["sites"][0]["horizon"] is None
    moved = {"lat_deg": RIM["lat_deg"] + 0.01, "lon_deg": RIM["lon_deg"]}
    d = client.post("/api/compare", json=body(site("A", moved, "wall"), site("B", IM2))).json()
    assert d["sites"][0]["model"] == "sphere"


def test_synthetic_mode_ignores_horizons(client, horizons):
    hfile(horizons, "wall", RIM["lat_deg"], RIM["lon_deg"], 5.0)
    d = client.post("/api/compare", json=body(site("A", RIM, "wall"), site("B", IM2), mode="synthetic")).json()
    assert d["sites"][0]["model"] == "sphere"


def test_bad_horizon_key_rejected(client):
    r = client.post("/api/compare", json=body(site("A", RIM, "../etc"), site("B", IM2)))
    assert r.status_code == 422
