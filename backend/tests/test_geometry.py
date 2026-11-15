import numpy as np
import pytest
import spiceypy as spice

from app import config
from app.geometry import SpiceProvider, enu_basis, normalize_lon, site_vector, topocentric_az_el
from app.kernels import SPICE_LOCK


@pytest.mark.parametrize("lat,lon", [(0, 0), (0.674, 23.47), (-89.67, 129.78), (90, 0), (-90, 45), (45, -170)])
def test_enu_is_right_handed_orthonormal(lat, lon):
    b = enu_basis(lat, lon)
    assert np.allclose(b @ b.T, np.eye(3), atol=1e-12)
    assert np.allclose(np.cross(b[0], b[1]), b[2], atol=1e-12)  # E x N = U
    assert np.allclose(b[2], site_vector(lat, lon) / config.MOON_RADIUS_KM, atol=1e-12)


def test_azimuth_conventions():
    # Observer at (0,0): east is +Y, north is +Z, up is +X in MOON_ME.
    r = site_vector(0, 0)
    b = enu_basis(0, 0)
    far = 1e9
    cases = {(0, 0, far): (0.0, 0.0), (0, far, 0): (90.0, 0.0), (0, 0, -far): (180.0, 0.0),
             (0, -far, 0): (270.0, 0.0), (far, 0, 0): (None, 90.0)}
    for vec, (az_exp, el_exp) in cases.items():
        az, el, _ = topocentric_az_el(np.array([vec], dtype=float) + r, r, b)
        assert el[0] == pytest.approx(el_exp, abs=1e-9)
        if az_exp is not None:
            assert az[0] == pytest.approx(az_exp, abs=1e-9)


def test_normalize_lon():
    assert normalize_lon(190) == -170
    assert normalize_lon(-180) == 180
    assert normalize_lon(360) == 0
    assert normalize_lon(23.5) == 23.5


@pytest.mark.parametrize("lat,lon", [(0.67408, 23.47297), (-89.67, 129.78), (-45.4446, 177.5991), (20.19, 30.77)])
@pytest.mark.parametrize("body", ["sun", "earth"])
def test_matches_spice_azlcpo(spice_loaded, lat, lon, body):
    """Independent check: SPICE's own constant-position az/el routine (topocentric light time,
    surface normal from the loaded sphere) must agree with our subtract-and-project pipeline."""
    p = SpiceProvider()
    pos = site_vector(lat, lon)
    with SPICE_LOCK:
        et0 = spice.str2et("2026-12-01 00:00:00 UTC")
        ets = et0 + np.arange(0, 30 * 86400, 86400 / 3)
        ours_az, ours_el, _ = topocentric_az_el(p.body_vectors(body, ets), pos, enu_basis(lat, lon))
        for et, az, el in zip(ets, ours_az, ours_el):
            ref, _ = spice.azlcpo("ELLIPSOID", config.BODIES[body], et, config.ABCORR, False, True, pos, "MOON", config.FRAME)
            ref_az, ref_el = np.degrees(ref[1]) % 360, np.degrees(ref[2])
            assert el == pytest.approx(ref_el, abs=1e-4)
            if abs(ref_el) < 89.9 and abs(lat) < 89.99:
                assert (az - ref_az + 180) % 360 - 180 == pytest.approx(0, abs=2e-3)


def test_sub_earth_point_within_libration(client, spice_loaded):
    from tests.conftest import APOLLO11, CHANGE4

    r = client.post("/api/compare", json={"sites": [APOLLO11, CHANGE4], "start_utc": "2026-01-01T00:00:00Z",
                                          "duration_hours": 24 * 60, "step_minutes": 180})
    assert r.status_code == 200
    sp = r.json()["subpoints"]
    assert max(map(abs, sp["sub_earth_lat_deg"])) < 7.5
    assert max(map(abs, sp["sub_earth_lon_deg"])) < 8.5
    d = sp["earth_distance_km"]
    assert 350_000 < min(d) and max(d) < 410_000
