import pytest

from tests.conftest import APOLLO11, CHANGE4, SHACKLETON


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
    ({"sites": [APOLLO11]}, "sites"),
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


# ----- U4: each site may start on its own date -----

import json
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures" / "compare_synthetic_before_u4.json"
BASELINE_BODY = {
    "sites": [
        {"id": "A", "label": "Apollo 11", "lat_deg": 0.67408, "lon_deg": 23.47297},
        {"id": "B", "label": "Shackleton", "lat_deg": -89.67, "lon_deg": 129.78},
    ],
    "start_utc": "2026-12-01T00:00:00Z", "duration_hours": 720, "step_minutes": 60, "mode": "synthetic",
}


def _close(x, y, path=""):
    if isinstance(x, dict):
        for k in x:
            _close(x[k], y[k], f"{path}/{k}")
    elif isinstance(x, list):
        assert len(x) == len(y), path
        for i, (p, q) in enumerate(zip(x, y)):
            _close(p, q, f"{path}[{i}]")
    elif isinstance(x, float):
        assert y == pytest.approx(x, abs=1e-6), path
    else:
        assert x == y, path


def test_no_site_starts_matches_behaviour_before_u4(client):
    """Without sites[].start_utc the existing fields are unchanged (fixture captured before U4, synthetic provider)."""
    d = client.post("/api/compare", json=BASELINE_BODY).json()
    fx = json.loads(FIXTURE.read_text())
    # The headline wording changed on purpose in F2 (see test_narrative.py); statements and tolerance must not.
    _close(fx["comparison"]["statements"], d["comparison"]["statements"], "statements")
    _close(fx["comparison"]["tolerance_s"], d["comparison"]["tolerance_s"], "tolerance")
    assert [d["timestamps_utc"][0], d["timestamps_utc"][-1]] == fx["timestamps_first_last"]
    assert d["metadata"]["n_samples"] == fx["n_samples"]
    _close(fx["subsolar_lon_every_50"], d["subpoints"]["subsolar_lon_deg"][::50], "subsolar")
    for f, s in zip(fx["sites"], d["sites"]):
        _close(f["metrics"], s["metrics"], "metrics")
        _close(f["intervals"], s["intervals"], "intervals")
        _close(f["sun_el_every_50"], s["sun"]["el_deg"][::50], "sun.el")
        _close(f["earth_az_every_50"], s["earth"]["az_deg"][::50], "earth.az")
    # New per-site fields agree with the shared top-level ones when the starts are equal.
    assert d["metadata"]["starts_differ"] is False
    for s in d["sites"]:
        assert s["start_utc"] == d["metadata"]["window_start_utc"]
        assert s["timestamps_utc"] == d["timestamps_utc"]
        assert s["subpoints"] == d["subpoints"]


def test_same_place_two_dates(client):
    a = {"id": "A", "label": "Mons Mouton", "lat_deg": -84.7906, "lon_deg": 29.1957}
    b = dict(a, id="B", start_utc="2026-12-15T00:00:00Z")
    d = client.post("/api/compare", json=dict(BASELINE_BODY, sites=[a, b])).json()
    sa, sb = d["sites"]
    assert d["metadata"]["starts_differ"] is True
    assert sa["timestamps_utc"][0] == sa["start_utc"] == "2026-12-01T00:00:00Z"
    assert sb["timestamps_utc"][0] == sb["start_utc"] == "2026-12-15T00:00:00Z"
    assert len(sa["timestamps_utc"]) == len(sb["timestamps_utc"]) == len(d["elapsed_s"])
    assert sa["sun"]["el_deg"] != sb["sun"]["el_deg"]
    assert sa["subpoints"]["subsolar_lon_deg"] != sb["subpoints"]["subsolar_lon_deg"]
    # Top-level fields describe scenario A.
    assert d["timestamps_utc"] == sa["timestamps_utc"] and d["subpoints"] == sa["subpoints"]
    # Every interval of B lies inside B's own window.
    for iv in sb["intervals"]["sun"] + sb["intervals"]["earth"]:
        assert "2026-12-15T00:00:00Z" <= iv["start_utc"] <= iv["end_utc"] <= sb["timestamps_utc"][-1]
    # Labels stay plain; the findings name both dates.
    assert sa["label"] == sb["label"] == "Mons Mouton"
    text = d["comparison"]["headline"] + " ".join(s["text"] for s in d["comparison"]["statements"])
    assert "(from 2026-12-01)" in text and "(from 2026-12-15)" in text


@pytest.mark.parametrize("bad", ["2026-12-15T00:00:00", "2026-12-15T00:00:00+08:00", "not a date"])
def test_site_start_validation(client, bad):
    b = dict(BASELINE_BODY["sites"][1], start_utc=bad)
    r = client.post("/api/compare", json=dict(BASELINE_BODY, sites=[BASELINE_BODY["sites"][0], b]))
    assert r.status_code == 422
    assert any(det["field"] == "sites.1.start_utc" for det in r.json()["error"]["details"])


def test_site_start_outside_coverage(client, spice_loaded):
    b = dict(BASELINE_BODY["sites"][1], start_utc="2160-01-01T00:00:00Z")
    body = dict(BASELINE_BODY, mode="spice", sites=[BASELINE_BODY["sites"][0], b])
    r = client.post("/api/compare", json=body)
    assert r.status_code == 422
    assert "coverage" in r.json()["error"]["message"]
