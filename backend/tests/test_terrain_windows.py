"""Best landing-window finder (POST /api/windows), using the precomputed LOLA skylines shared with /api/compare."""

from datetime import datetime

IM2 = {"id": "im2", "label": "IM-2", "lat_deg": -84.7906, "lon_deg": 29.1957}
SHACKLETON_FLOOR = {"id": "shk", "label": "Shackleton floor", "lat_deg": -89.67, "lon_deg": 129.78,
                    "horizon_key": "shackleton"}


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
    t = sorted(datetime.fromisoformat(x["start_utc"].replace("Z", "+00:00")).timestamp() for x in w)
    assert all(b - a >= 5 * 86400 - 1 for a, b in zip(t, t[1:]))  # at least half a mission apart
    assert "Screening resolution" in d["resolution_note"]
    assert d["terrain"]["applied"] is False


def test_windows_validation(client):
    bad = dict(site=IM2, start_utc="2027-01-01T00:00:00Z", span_days=400, mission_days=60, step_minutes=10,
               mode="synthetic")
    assert client.post("/api/windows", json=bad).status_code == 422  # too many samples
    assert client.post("/api/windows", json=dict(bad, start_utc="2027-01-01T00:00:00")).status_code == 422


def test_windows_use_lola_skyline_permanent_shadow(client, spice_loaded):
    """With the precomputed skyline the Shackleton floor never sees the Sun; without it, it does."""
    body = dict(site=SHACKLETON_FLOOR, start_utc="2027-01-01T00:00:00Z", span_days=60, mission_days=14,
                priority="power", mode="spice", step_minutes=120)
    terr = client.post("/api/windows", json=body).json()
    assert terr["terrain"]["applied"] is True and terr["terrain"]["horizon_key"] == "shackleton"
    assert max(terr["series"]["sun_fraction"]) == 0.0
    ideal = client.post("/api/windows", json=dict(body, terrain=False)).json()
    assert ideal["terrain"]["applied"] is False and max(ideal["series"]["sun_fraction"]) > 0.3


def test_terrain_status_lists_skylines(client):
    d = client.get("/api/terrain/status").json()
    keys = {s["key"] for s in d["skylines"]}
    assert {"im2", "shackleton", "shackleton-rim"} <= keys
    assert d["source_url"].startswith("https://pgda.gsfc.nasa.gov")
