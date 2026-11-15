"""Terrain module: projection, interpolation and horizon profiles.

The first group uses small synthetic GeoTIFFs (no downloads). The second group checks the real
LOLA maps and is skipped when backend/terrain/ does not hold them (run scripts/fetch_terrain.sh).
"""

import numpy as np
import pytest

from app import config, terrain

POLAR = "+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs"
TERRAIN_DIR = config.BACKEND_DIR / "terrain"


def write_dem(path, heights, pixel_m, half_km):
    import rasterio
    from rasterio.transform import from_origin

    n = heights.shape[0]
    transform = from_origin(-half_km * 1000.0, half_km * 1000.0, pixel_m, pixel_m)
    with rasterio.open(path, "w", driver="GTiff", height=n, width=n, count=1, dtype="float32", crs=POLAR, transform=transform) as dst:
        dst.write(heights.astype("float32"), 1)
    return path


def grid(pixel_m, half_km):
    n = int(round(2 * half_km * 1000 / pixel_m))
    c = (np.arange(n) + 0.5) * pixel_m - half_km * 1000.0
    x, y = np.meshgrid(c, -c)  # row 0 is the top (largest y)
    return n, x, y


def test_projection_pole_and_80s():
    from rasterio.crs import CRS

    crs = CRS.from_proj4(POLAR)
    x, y = terrain.latlon_to_xy(-90.0, 0.0, crs)
    assert abs(x[0]) < 1e-6 and abs(y[0]) < 1e-6
    x, y = terrain.latlon_to_xy(-80.0, 37.0, crs)
    assert np.hypot(x[0], y[0]) / 1000 == pytest.approx(304.0, abs=0.1)  # 2 R tan(5 deg)
    lat, lon = terrain.xy_to_latlon(x, y, crs)
    assert lat[0] == pytest.approx(-80.0, abs=1e-9) and lon[0] == pytest.approx(37.0, abs=1e-9)


def test_flat_ground_gives_horizon_dip(tmp_path):
    n, _, _ = grid(200.0, 100.0)
    t = terrain.Terrain([terrain.load_dem(write_dem(tmp_path / "flat.tif", np.zeros((n, n)), 200.0, 100.0))])
    assert t.height_at(-89.5, 45.0) == pytest.approx(0.0)
    p = terrain.horizon_profile(t, -89.5, 45.0, observer_height_m=2.0)
    dip = -np.degrees(np.arccos(terrain.R_M / (terrain.R_M + 2.0)))  # about -0.087 deg
    assert len(p.az_deg) == 720 and p.az_deg[1] == pytest.approx(0.5)
    assert np.allclose(p.el_deg, dip, atol=0.003)
    assert p.site_height_m == pytest.approx(0.0) and p.shortest_ray_km > 50


def test_single_peak_due_north_is_highest(tmp_path):
    from rasterio.crs import CRS

    pixel, half = 200.0, 100.0
    n, x, y = grid(pixel, half)
    lat0, lon0 = -89.5, 45.0
    px, py = terrain.latlon_to_xy(lat0 + 0.2, lon0, CRS.from_proj4(POLAR))  # 6 km due north of the site
    heights = 1500.0 * np.exp(-((x - px[0]) ** 2 + (y - py[0]) ** 2) / (2 * 1500.0**2))
    t = terrain.Terrain([terrain.load_dem(write_dem(tmp_path / "peak.tif", heights, pixel, half))])
    p = terrain.horizon_profile(t, lat0, lon0)
    peak_az = p.az_deg[np.argmax(p.el_deg)]
    assert min(peak_az, 360 - peak_az) < 1.0
    assert p.el_deg.max() > 5.0  # 1.5 km high, 6 km away: well above the horizontal
    south = p.el_deg[np.argmin(np.abs(p.az_deg - 180))]
    assert south < 0.0  # nothing to the south: the skyline dips below the horizontal


def test_finer_map_is_used_first(tmp_path):
    n1, _, _ = grid(100.0, 20.0)
    n2, _, _ = grid(400.0, 100.0)
    fine = terrain.load_dem(write_dem(tmp_path / "fine.tif", np.full((n1, n1), 10.0), 100.0, 20.0))
    coarse = terrain.load_dem(write_dem(tmp_path / "coarse.tif", np.full((n2, n2), 99.0), 400.0, 100.0))
    t = terrain.Terrain([coarse, fine])
    assert t.height_at(-89.9, 0.0) == pytest.approx(10.0)  # 3 km from the pole: inside the fine map
    assert t.height_at(-89.0, 0.0) == pytest.approx(99.0)  # 30 km: only the coarse map
    assert np.isnan(t.height_at(-85.0, 0.0))  # 152 km: outside both


def test_skyline_interpolation_wraps():
    az = np.array([0.0, 90.0, 180.0, 270.0])
    el = np.array([4.0, 0.0, 0.0, 0.0])
    assert terrain.skyline_at(np.array([355.0]), az, el)[0] == pytest.approx(4.0 * 85 / 90)
    assert terrain.skyline_at(np.array([360.0]), az, el)[0] == pytest.approx(4.0)


# ----- real LOLA maps (skipped when absent) -----

real = pytest.mark.skipif(
    not (TERRAIN_DIR / "LDEM_80S_80MPP_ADJ.TIF").exists() or not (TERRAIN_DIR / "LDEM_60S_240MPP_ADJ.TIF").exists(),
    reason="LOLA maps not downloaded; run scripts/fetch_terrain.sh",
)


@pytest.fixture(scope="module")
def lola():
    return terrain.Terrain.from_dir(TERRAIN_DIR)


@real
def test_real_maps_projection_and_range(lola):
    for d in lola.dems:
        h = d.heights[np.isfinite(d.heights)]
        assert -9_500 < h.min() and h.max() < 9_500, d.name
    assert [d.name for d in lola.dems] == ["LDEM_80S_80MPP_ADJ.TIF", "LDEM_60S_240MPP_ADJ.TIF"]


@real
def test_real_shackleton_floor_below_rim_and_mouton_high(lola):
    floor = lola.height_at(-89.67, 129.78)
    rim = lola.height_at(-89.684, -163.261)
    mouton = lola.height_at(-84.6, 31.0)
    assert rim - floor > 2_000  # the crater is about 4 km deep
    assert mouton > 3_000  # Mons Mouton is a high plateau
