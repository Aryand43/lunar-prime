"""Real horizons from LOLA south-polar elevation maps.

Data: NASA GSFC PGDA product 90, "A New View of the Lunar South Pole from LOLA" (Barker et al. 2023),
https://pgda.gsfc.nasa.gov/products/90. Two cloud-optimised GeoTIFFs are used:

- LDEM_80S_80MPP_ADJ.TIF   80 m per pixel, 80 degS to the pole
- LDEM_60S_240MPP_ADJ.TIF  240 m per pixel, 60 degS to the pole

Both are south polar stereographic maps in the MOON_ME frame (DE421 realisation), on a sphere of
radius 1737.4 km, with X/Y in metres. Lunar Prime's frame is MOON_ME from DE440; the two realisations
differ by metres, which is far below one pixel here.

Checked in the files themselves (15 Nov 2026):
- CRS: +proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400, metres. `load_dem` asserts this.
- LDEM_80S_80MPP_ADJ.TIF: 7600 x 7600 pixels of 80 m, x and y from -304 to +304 km, float32 metres
  (GMT history: the km grid times 1000), NaN fill, no scale or offset; heights -7296 to +7026 m.
- Height reference: the files do not state it. They follow the LOLA LDEM convention of height above the
  1737.4 km sphere. Independent check: at IM-1 (80.13 S, 1.44 E) the 80 m map gives 2592 m; NASA's LRO
  image release gives Odysseus's elevation as 2579 m. So a surface point's radius is 1737.4 km + height.

The horizon method follows NASA's own polar illumination work (Mazarico et al. 2011): for each of 720
directions, 0.5 deg apart, walk outward over the terrain and keep the largest elevation angle seen from
the observer. That angle is the skyline in that direction. Everything is done with 3D positions, so the
Moon's curvature needs no separate correction.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import config
from .geometry import enu_basis

R_M = config.MOON_RADIUS_KM * 1000.0  # reference sphere radius, metres

# Geographic coordinates on the same 1737.4 km sphere as the maps.
GEO_CRS = f"+proj=longlat +R={R_M:.0f} +no_defs"


@dataclass
class Dem:
    """One elevation map: heights (m), affine transform (pixel -> map metres), CRS, provenance."""

    name: str
    heights: np.ndarray  # (rows, cols) float32; NaN where there is no data
    transform: object  # affine.Affine
    crs: object  # rasterio.crs.CRS
    sha256: str | None = None
    tags: dict = field(default_factory=dict)

    @property
    def pixel_m(self) -> float:
        return abs(self.transform.a)


def _check_crs(crs) -> None:
    """The maps must be south polar stereographic on a 1737.4 km sphere."""
    p = crs.to_dict()
    radius = p.get("R") or (p.get("a") if p.get("a") == p.get("b") else None)
    ok = p.get("proj") == "stere" and float(p.get("lat_0", 0)) == -90.0 and radius is not None and abs(float(radius) - R_M) < 1.0
    if not ok:
        raise ValueError(f"Unexpected map projection (need south polar stereographic, R = 1737.4 km): {crs.to_proj4()}")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_dem(path: str | Path, with_sha: bool = False) -> Dem:
    """Read a south-polar LOLA GeoTIFF: heights (m), transform and CRS, after checking the projection."""
    import rasterio

    path = Path(path)
    with rasterio.open(path) as src:
        _check_crs(src.crs)
        band = src.read(1, masked=True)
        heights = band.astype(np.float32).filled(np.nan)
        scale = (src.scales or (1.0,))[0] or 1.0
        offset = (src.offsets or (0.0,))[0] or 0.0
        if scale != 1.0 or offset != 0.0:  # apply the file's own scaling if it declares one
            heights = heights * np.float32(scale) + np.float32(offset)
        tags = {**src.tags(), **{f"band1_{k}": v for k, v in src.tags(1).items()}, "units": str(src.units[0] if src.units else "")}
        return Dem(path.name, heights, src.transform, src.crs, sha256_file(path) if with_sha else None, tags)


def latlon_to_xy(lat_deg, lon_deg, crs) -> tuple[np.ndarray, np.ndarray]:
    """Map coordinates (m) in the DEM's own projection. Axis directions come from the file's CRS."""
    from rasterio.warp import transform

    lat = np.atleast_1d(np.asarray(lat_deg, float))
    lon = np.atleast_1d(np.asarray(lon_deg, float))
    x, y = transform(GEO_CRS, crs, lon.ravel().tolist(), lat.ravel().tolist())
    return np.asarray(x).reshape(lat.shape), np.asarray(y).reshape(lat.shape)


def xy_to_latlon(x, y, crs) -> tuple[np.ndarray, np.ndarray]:
    from rasterio.warp import transform

    x = np.atleast_1d(np.asarray(x, float))
    y = np.atleast_1d(np.asarray(y, float))
    lon, lat = transform(crs, GEO_CRS, x.ravel().tolist(), y.ravel().tolist())
    return np.asarray(lat).reshape(x.shape), np.asarray(lon).reshape(x.shape)


def _bilinear(dem: Dem, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinear interpolation between pixel centres; NaN outside the map or next to missing data."""
    inv = ~dem.transform
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    col = inv.a * x + inv.b * y + inv.c - 0.5  # pixel-centre coordinates
    row = inv.d * x + inv.e * y + inv.f - 0.5
    nr, nc = dem.heights.shape
    c0 = np.floor(col).astype(np.int64)
    r0 = np.floor(row).astype(np.int64)
    inside = (c0 >= 0) & (r0 >= 0) & (c0 < nc - 1) & (r0 < nr - 1)
    out = np.full(np.shape(x), np.nan, dtype=float)
    if not inside.any():
        return out
    c0i, r0i = c0[inside], r0[inside]
    fc = col[inside] - c0i
    fr = row[inside] - r0i
    h = dem.heights
    v = (
        h[r0i, c0i] * (1 - fc) * (1 - fr)
        + h[r0i, c0i + 1] * fc * (1 - fr)
        + h[r0i + 1, c0i] * (1 - fc) * fr
        + h[r0i + 1, c0i + 1] * fc * fr
    )
    out[inside] = v
    return out


class Terrain:
    """A stack of maps, finest first. A point uses the first map that covers it."""

    def __init__(self, dems: list[Dem]):
        if not dems:
            raise ValueError("Terrain needs at least one elevation map")
        self.dems = sorted(dems, key=lambda d: d.pixel_m)
        crs0 = self.dems[0].crs
        for d in self.dems[1:]:
            if d.crs != crs0:
                raise ValueError("All elevation maps must share one projection")
        self.crs = crs0

    @classmethod
    def from_dir(cls, directory: str | Path, names=("LDEM_80S_80MPP_ADJ.TIF", "LDEM_60S_240MPP_ADJ.TIF"), with_sha=False) -> "Terrain":
        directory = Path(directory)
        missing = [n for n in names if not (directory / n).exists()]
        if missing:
            raise FileNotFoundError(f"Missing elevation maps in {directory}: {', '.join(missing)}. Run scripts/fetch_terrain.sh.")
        return cls([load_dem(directory / n, with_sha=with_sha) for n in names])

    def height_xy(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        h = np.full(np.shape(x), np.nan, dtype=float)
        for dem in self.dems:  # finest first; coarser maps fill what is still missing
            todo = np.isnan(h)
            if not todo.any():
                break
            h[todo] = _bilinear(dem, np.asarray(x)[todo], np.asarray(y)[todo])
        return h

    def height_at(self, lat_deg, lon_deg) -> np.ndarray | float:
        """Surface height (m) above the 1737.4 km sphere; NaN outside every map."""
        x, y = latlon_to_xy(lat_deg, lon_deg, self.crs)
        h = self.height_xy(x, y)
        return float(h[0]) if np.ndim(lat_deg) == 0 else h


def ray_distances_m(max_km: float) -> np.ndarray:
    """Every 40 m out to 20 km, then steps growing by 1.5% each out to max_km."""
    near = np.arange(40.0, 20_000.0 + 1e-6, 40.0)
    far = [near[-1]]
    while far[-1] < max_km * 1000.0:
        far.append(far[-1] * 1.015)
    far = np.asarray(far[1:])
    far[-1] = min(far[-1], max_km * 1000.0)
    return np.concatenate([near, far])


@dataclass
class HorizonProfile:
    az_deg: np.ndarray
    el_deg: np.ndarray  # skyline elevation angle (deg) above the observer's local horizontal
    site_height_m: float
    observer_height_m: float
    shortest_ray_km: float


def horizon_profile(
    terrain: Terrain, lat_deg: float, lon_deg: float, observer_height_m: float = 2.0, n_az: int = 720, max_km: float = 400.0
) -> HorizonProfile:
    """Skyline elevation angle in n_az directions (clockwise from local north, same convention as the app)."""
    site_h = terrain.height_at(lat_deg, lon_deg)
    if not np.isfinite(site_h):
        raise ValueError(f"No elevation data at ({lat_deg}, {lon_deg})")
    east, north, up = enu_basis(lat_deg, lon_deg)  # unit vectors in MOON_ME
    obs = up * (R_M + site_h + observer_height_m)

    az = np.arange(n_az) * (360.0 / n_az)
    a = np.radians(az)
    dirs = np.sin(a)[:, None] * east[None, :] + np.cos(a)[:, None] * north[None, :]  # (n_az, 3) tangent directions
    d = ray_distances_m(max_km)
    theta = d / R_M  # central angle along the great circle
    # Unit vectors of all sample points: up*cos(theta) + dir*sin(theta)  -> (n_az, n_d, 3)
    q = up[None, None, :] * np.cos(theta)[None, :, None] + dirs[:, None, :] * np.sin(theta)[None, :, None]
    lat = np.degrees(np.arcsin(np.clip(q[..., 2], -1, 1)))
    lon = np.degrees(np.arctan2(q[..., 1], q[..., 0]))
    x, y = latlon_to_xy(lat, lon, terrain.crs)
    h = terrain.height_xy(x, y)

    # A ray stops where it first leaves the maps (or meets missing data).
    bad = ~np.isfinite(h)
    first_bad = np.where(bad.any(axis=1), bad.argmax(axis=1), h.shape[1])
    keep = np.arange(h.shape[1])[None, :] < first_bad[:, None]

    pts = q * (R_M + np.where(keep, h, 0.0))[..., None]
    v = pts - obs[None, None, :]
    el = np.degrees(np.arcsin(np.clip((v @ up) / np.linalg.norm(v, axis=-1), -1, 1)))
    el = np.where(keep, el, -np.inf)
    sky = el.max(axis=1)
    reach = np.where(first_bad > 0, d[np.maximum(first_bad - 1, 0)], 0.0)
    return HorizonProfile(az, sky, float(site_h), float(observer_height_m), float(reach.min() / 1000.0))


def skyline_at(az_deg: np.ndarray, sky_az: np.ndarray, sky_el: np.ndarray) -> np.ndarray:
    """Skyline elevation at arbitrary azimuths, linear interpolation that wraps at 360 deg."""
    return np.interp(np.mod(az_deg, 360.0), sky_az, sky_el, period=360.0)
