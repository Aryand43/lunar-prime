import pytest

from tests.conftest import APOLLO11, CHANGE4, SHACKLETON, site


def req(**kw):
    body = {"sites": [APOLLO11, SHACKLETON], "start_utc": "2026-12-01T00:00:00Z",
            "duration_hours": 720, "step_minutes": 30}
    body.update(kw)
    return body


def test_health(client):
    h = client.get("/api/health").json()
    assert h["synthetic_available"] is True
    assert "MOON_ME" in h["conventions"]["frame"]


@pytest.mark.parametrize("patch,field", [
    ({"sites": [dict(APOLLO11, lat_deg=91), SHACKLETON]}, "sites.0.lat_deg"),
    ({"sites": [APOLLO11, dict(SHACKLETON, lon_deg=-200)]}, "sites.1.lon_deg"),
    ({"sites": [APOLLO11, dict(APOLLO11, label="x")]}, None),  # duplicate id
    ({"sites": [APOLLO11, SHACKLETON, CHANGE4, dict(APOLLO11, id="a2"), dict(APOLLO11, id="a3")]}, "sites"),  # > 4
    ({"start_utc": "2026-12-01T00:00:00"}, "start_utc"),  # naive time
    ({"start_utc": "2026-12-01T00:00:00+05:00"}, "start_utc"),
    ({"start_utc": "not a date"}, "start_utc"),
    ({"step_minutes": 0.5}, "step_minutes"),
    ({"duration_hours": 8000, "step_minutes": 1}, None),  # too many samples
])
def test_validation_errors(client, patch, field):
    r = client.post("/api/compare", json=req(**patch))
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "invalid_request" and err["message"]
    if field:
        assert any(d["field"] == field for d in err["details"])


def test_outside_coverage(client, spice_loaded):
    r = client.post("/api/compare", json=req(start_utc="2160-01-01T00:00:00Z"))
    assert r.status_code == 422
    assert "coverage" in r.json()["error"]["message"]


def test_compare_spice_shapes_and_physics(client, spice_loaded):
    r = client.post("/api/compare", json=req())
    assert r.status_code == 200
    d = r.json()
    n = len(d["timestamps_utc"])
    assert n == d["metadata"]["n_samples"] == 1441
    assert d["timestamps_utc"][0] == "2026-12-01T00:00:00Z" and d["timestamps_utc"][-1] == "2026-12-31T00:00:00Z"
    assert d["metadata"]["mode"] == "spice" and "SPICE" in d["metadata"]["provenance"]
    assert len(d["metadata"]["kernels"]) == 5
    a, b = d["sites"]
    for s in (a, b):
        assert len(s["sun"]["el_deg"]) == len(s["earth"]["az_deg"]) == len(s["masks"]["both"]) == n
        m = s["metrics"]
        assert m["both_duration_s"] <= min(m["sun"]["visible_duration_s"], m["earth"]["visible_duration_s"]) + 1e-6
        assert 0 <= m["sun"]["visible_fraction"] <= 1
    # Near-side equatorial site: Earth is always high in the sky.
    assert a["metrics"]["earth"]["visible_fraction"] == 1.0 and a["metrics"]["earth"]["el_min_deg"] > 50
    # One lunation-ish window: Apollo 11 gets roughly half sunlight.
    assert 0.40 < a["metrics"]["sun"]["visible_fraction"] < 0.60
    assert d["comparison"]["headline"]


def test_far_side_never_sees_earth(client, spice_loaded):
    r = client.post("/api/compare", json=req(sites=[APOLLO11, CHANGE4]))
    m = r.json()["sites"][1]["metrics"]["earth"]
    assert m["visible_fraction"] == 0.0 and m["el_max_deg"] < 0
    texts = [s["text"] for s in r.json()["comparison"]["statements"]]
    assert any("never rises" in t for t in texts)


def test_refined_transition_independent_of_sampling(client, spice_loaded):
    """Sunrise at Apollo 11 should agree to a few seconds between 2-hour and 5-minute sampling."""
    coarse = client.post("/api/compare", json=req(step_minutes=120)).json()
    fine = client.post("/api/compare", json=req(step_minutes=5)).json()
    tc = coarse["sites"][0]["intervals"]["sun"][0]["start_utc"]
    tf = fine["sites"][0]["intervals"]["sun"][0]["start_utc"]
    from datetime import datetime
    dt = abs((datetime.fromisoformat(tc.replace("Z", "+00:00")) - datetime.fromisoformat(tf.replace("Z", "+00:00"))).total_seconds())
    assert dt <= 3
    dc = coarse["sites"][0]["metrics"]["sun"]["visible_duration_s"]
    df = fine["sites"][0]["metrics"]["sun"]["visible_duration_s"]
    assert abs(dc - df) <= 5


def test_synthetic_mode_is_labelled(client):
    r = client.post("/api/compare", json=req(mode="synthetic"))
    assert r.status_code == 200
    md = r.json()["metadata"]
    assert md["mode"] == "synthetic" and "SYNTHETIC" in md["provenance"] and md["kernels"] == []


def test_compare_one_to_four_sites(client):
    base = {"start_utc": "2027-02-01T00:00:00Z", "duration_hours": 48, "step_minutes": 60, "mode": "synthetic"}
    four = [site(f"s{i}", f"Site {i}", -80 + i, 10 * i) for i in range(4)]
    for n in (1, 3, 4):
        r = client.post("/api/compare", json=dict(base, sites=four[:n]))
        assert r.status_code == 200, r.text
        assert len(r.json()["sites"]) == n
    assert client.post("/api/compare", json=dict(base, sites=four + [site("s9", "x", 0, 0)])).status_code == 422
    assert client.post("/api/compare", json=dict(base, sites=[four[0], four[0]])).status_code == 422
