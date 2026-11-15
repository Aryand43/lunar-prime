"""Terrain horizons from the NASA LRO LOLA south-polar elevation model.

Data: LOLA gridded data record LDEM_60S_240M (PDS dataset LRO-L-LOLA-4-GDR-V1.0): polar stereographic
(spherical, true at the pole), 240 m/pixel, 60°S to the pole, 16-bit heights x 0.5 m relative to a
1737.4 km sphere, in the Mean Earth/Polar Axis (DE421) frame used for site coordinates here.

Horizon method: for each azimuth (clockwise from local north, the same convention as the Sun/Earth
azimuths), sample points along the surface great circle from the site outwards, look up their heights
(bilinear), and compute the exact elevation angle of each terrain point from the observer using 3D
position vectors (so lunar curvature is handled exactly). The horizon is the maximum angle along the ray.

Limits (reported with every result): 240 m pixels smooth out small nearby relief; rays stop at the
DEM edge (60°S) or at MAX_DISTANCE_KM; the observer stands OBSERVER_HEIGHT_M above the DEM surface.
"""

from __future__ import annotations

import hashlib
import math
import os
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Optional

import numpy as np

from . import config

TERRAIN_DIR = Path(os.environ.get("LUNAR_PRIME_TERRAIN_DIR", config.BACKEND_DIR / "terrain"))
DEM_FILE = "ldem_60s_240m.img"
N_PIX = 7760
SCALE_M = 240.0
OFFSET_PIX = 3879.5  # projection centre (the pole), zero-based pixel-centre coordinates
SCALING_FACTOR = 0.5
REF_RADIUS_M = 1_737_400.0
MIN_LAT_DEG = -60.0
AZ_STEP_DEG = 0.5
MAX_DISTANCE_KM = 300.0
OBSERVER_HEIGHT_M = 2.0
SOURCE = ("NASA LRO LOLA gridded DEM LDEM_60S_240M (PDS LRO-L-LOLA-4-GDR-V1.0), 240 m/pixel, "
          "polar stereographic, 60°S to the south pole")
SOURCE_URL = ("https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/"
              "ldem_60s_240m.lbl")


class TerrainUnavailable(RuntimeError):
    pass


_LOCK = threading.Lock()
_DEM: Optional[np.ndarray] = None


def available() -> bool:
    p = TERRAIN_DIR / DEM_FILE
    return p.is_file() and p.stat().st_size == N_PIX * N_PIX * 2


def dem() -> np.ndarray:
    """Memory-mapped DEM heights in metres relative to 1737.4 km (row 0 = top of the image)."""
    global _DEM
    with _LOCK:
        if _DEM is None:
            if not available():
                raise TerrainUnavailable(f"Terrain DEM not found in {TERRAIN_DIR}; run scripts/fetch_terrain.sh.")
            _DEM = np.memmap(TERRAIN_DIR / DEM_FILE, dtype="<i2", mode="r", shape=(N_PIX, N_PIX))
        return _DEM


def covers(lat_deg: float) -> bool:
    """The DEM spans 60°S to the pole; keep a small margin so rays have terrain to sample."""
    return lat_deg <= MIN_LAT_DEG - 0.5


def _project(lat_rad: np.ndarray, lon_rad: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """South polar stereographic (spherical): zero-based (row, col) pixel-centre coordinates.

    Standard PDS form: X = 2R tan(pi/4 + lat/2) sin(lon), Y = 2R tan(pi/4 + lat/2) cos(lon);
    col = OFFSET + X/scale, row = OFFSET - Y/scale. Verified against Shackleton crater in the tests.
    """
    rho = 2.0 * REF_RADIUS_M * np.tan(np.pi / 4 + lat_rad / 2)
    x = rho * np.sin(lon_rad)
    y = rho * np.cos(lon_rad)
    return OFFSET_PIX - y / SCALE_M, OFFSET_PIX + x / SCALE_M


def height_m(lat_deg, lon_deg) -> np.ndarray:
    """Bilinear DEM height (m above 1737.4 km) at planetocentric lat/lon (degrees)."""
    lat = np.radians(np.asarray(lat_deg, float))
    lon = np.radians(np.asarray(lon_deg, float))
    row, col = _project(lat, lon)
    return _bilinear(dem(), row, col)


def _bilinear(d: np.ndarray, row: np.ndarray, col: np.ndarray) -> np.ndarray:
    r0 = np.clip(np.floor(row).astype(int), 0, N_PIX - 2)
    c0 = np.clip(np.floor(col).astype(int), 0, N_PIX - 2)
    fr, fc = np.clip(row - r0, 0, 1), np.clip(col - c0, 0, 1)
    h00 = d[r0, c0].astype(float)
    h01 = d[r0, c0 + 1].astype(float)
    h10 = d[r0 + 1, c0].astype(float)
    h11 = d[r0 + 1, c0 + 1].astype(float)
    return SCALING_FACTOR * ((h00 * (1 - fc) + h01 * fc) * (1 - fr) + (h10 * (1 - fc) + h11 * fc) * fr)


@dataclass
class Horizon:
    az_deg: np.ndarray  # 0, 0.5, ... 359.5
    el_deg: np.ndarray  # terrain horizon elevation at each azimuth
    reach_km: np.ndarray  # distance actually sampled along each azimuth (DEM edge may cut it short)
    site_height_m: float

    def at(self, az_deg: np.ndarray) -> np.ndarray:
        """Horizon elevation at arbitrary azimuths (linear, periodic)."""
        a = np.mod(np.asarray(az_deg, float), 360.0) / AZ_STEP_DEG
        i0 = np.floor(a).astype(int) % len(self.el_deg)
        i1 = (i0 + 1) % len(self.el_deg)
        f = a - np.floor(a)
        return self.el_deg[i0] * (1 - f) + self.el_deg[i1] * f

    def summary(self) -> dict:
        short = float(np.mean(self.reach_km < MAX_DISTANCE_KM - 1e-6))
        return dict(
            applied=True, source=SOURCE, source_url=SOURCE_URL, resolution_m=SCALE_M,
            observer_height_m=OBSERVER_HEIGHT_M, max_distance_km=MAX_DISTANCE_KM, az_step_deg=AZ_STEP_DEG,
            site_height_m=round(self.site_height_m, 1),
            max_horizon_deg=round(float(self.el_deg.max()), 3), mean_horizon_deg=round(float(self.el_deg.mean()), 3),
            truncated_fraction=round(short, 4),
            az_deg=np.round(self.az_deg, 2).tolist(), el_deg=np.round(self.el_deg, 3).tolist(),
            note=("Terrain horizon from LOLA heights at 240 m/pixel: features smaller than a few hundred metres "
                  "near the site are smoothed out." + (
                      f" On {short:.0%} of azimuths the ray reaches the edge of the DEM (60°S) before "
                      f"{MAX_DISTANCE_KM:g} km, so distant terrain there is not included." if short > 0 else "")),
        )


def _distances_m() -> np.ndarray:
    """Dense near the site (pixel scale), sparser far away (the angular effect of far terrain changes slowly)."""
    near = np.arange(SCALE_M / 2, 20_000.0, SCALE_M / 2)
    far = np.geomspace(20_000.0, MAX_DISTANCE_KM * 1000.0, 260)
    return np.concatenate([near, far])


@lru_cache(maxsize=256)
def horizon(lat_deg: float, lon_deg: float) -> Horizon:
    """Terrain horizon profile for a site (cached per site, rounded to ~1 m)."""
    if not covers(lat_deg):
        raise TerrainUnavailable("site is outside the LOLA south-polar DEM (60°S to the pole)")
    d = dem()
    lat0, lon0 = math.radians(lat_deg), math.radians(lon_deg)
    sl, cl, so, co = math.sin(lat0), math.cos(lat0), math.sin(lon0), math.cos(lon0)
    u0 = np.array([cl * co, cl * so, sl])
    east = np.array([-so, co, 0.0])
    north = np.array([-sl * co, -sl * so, cl])
    h0 = float(_bilinear(d, *_project(np.array([lat0]), np.array([lon0])))[0])
    r_obs = REF_RADIUS_M + h0 + OBSERVER_HEIGHT_M
    p0 = r_obs * u0

    az = np.arange(0.0, 360.0, AZ_STEP_DEG)
    dist = _distances_m()
    delta = dist / REF_RADIUS_M  # surface angle
    azr = np.radians(az)[:, None, None]
    t = np.cos(azr) * north + np.sin(azr) * east  # (A,1,3) unit tangent toward each azimuth
    u = np.cos(delta)[None, :, None] * u0 + np.sin(delta)[None, :, None] * t  # (A,D,3) unit vectors
    lat = np.arcsin(np.clip(u[..., 2], -1, 1))
    lon = np.arctan2(u[..., 1], u[..., 0])
    inside = lat <= math.radians(MIN_LAT_DEG)
    row, col = _project(lat, lon)
    inside &= (row >= 0) & (row <= N_PIX - 1) & (col >= 0) & (col <= N_PIX - 1)
    h = np.where(inside, _bilinear(d, np.where(inside, row, 0), np.where(inside, col, 0)), -np.inf)
    p = (REF_RADIUS_M + np.where(np.isfinite(h), h, 0.0))[..., None] * u
    v = p - p0
    el = np.degrees(np.arcsin(np.clip((v @ u0) / np.linalg.norm(v, axis=-1), -1, 1)))
    el = np.where(inside, el, -90.0)
    reach = np.where(inside, dist[None, :], 0.0).max(axis=1) / 1000.0
    # A ray that never sees terrain above the ideal horizon still has the geometric horizon (0 deg at the
    # observer's height is slightly negative; the spherical "ideal horizon" convention elsewhere is 0 deg).
    return Horizon(az, el.max(axis=1), reach, h0)


def dem_sha256() -> Optional[str]:
    if not available():
        return None
    s = TERRAIN_DIR / "SHA256SUMS.local"
    if s.is_file():
        for line in s.read_text().splitlines():
            if line.endswith(DEM_FILE):
                return line.split()[0]
    h = hashlib.sha256()
    with open(TERRAIN_DIR / DEM_FILE, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
