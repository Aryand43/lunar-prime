"""Validate Lunar Prime's terrain horizons (UPDATE_SPEC_2, task T6).

1. Permanent shadow: the Shackleton crater floor preset over one year at 1-hour steps must get 0% sunlight.
2. Against NASA's maps: for each south-pole preset with a horizon file, Lunar Prime's average Sun and Earth
   visibility over the maps' own time span (2-hour steps) is compared with the LOLA PDS average-illumination
   maps (Mazarico et al. 2011; PGDA product 69) at the site's pixel and the best pixel within 240 m.

Nothing is tuned to match. Differences are reported as they are.

Run from the repository root after scripts/fetch_terrain.sh and scripts/build_horizons.py:
    cd backend && uv run python ../scripts/validate_terrain.py [--out ../backend/data/validation.json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))

from app import config, kernels, terrain  # noqa: E402
from app.geometry import SpiceProvider, enu_basis, site_vector, topocentric_az_el  # noqa: E402
from app.models import CompareRequest, SiteInput  # noqa: E402
from app.service import run_compare  # noqa: E402
from build_horizons import presets  # noqa: E402

VALID_DIR = config.TERRAIN_DIR / "validation"
MAPS = {  # (sun map, earth map), finest first
    "85S": ("AVGVISIB_85S_060M_201608", "AVGVISIB_85S_060M_201608_EARTH"),
    "65S": ("AVGVISIB_65S_240M_201608", "AVGVISIB_65S_240M_201608_EARTH"),
}


def label_info(lbl: Path) -> dict:
    """Fields of a PDS3 label that matter here: time span, scaling, units and the description text."""
    text = lbl.read_text(errors="replace")

    def field(name):
        m = re.search(rf"^\s*{name}\s*=\s*(.+?)\s*$", text, flags=re.M)
        return m.group(1).strip().strip('"') if m else None

    desc = re.findall(r'DESCRIPTION\s*=\s*"(.*?)"', text, flags=re.S)
    return {"start": field("START_TIME"), "stop": field("STOP_TIME"), "scaling": field("SCALING_FACTOR"),
            "offset": field("OFFSET"), "unit": field("UNIT"), "max_lat": field("MAXIMUM_LATITUDE"),
            "min_lat": field("MINIMUM_LATITUDE"), "scale_km": field("MAP_SCALE"),
            "description": [" ".join(d.split()) for d in desc]}


def open_map(base: str):
    """Open a PDS3 IMG through GDAL (via its detached label). Returns (dataset, info)."""
    import rasterio

    lbl = VALID_DIR / f"{base}.LBL"
    return rasterio.open(lbl), label_info(lbl)


def map_values(ds, lat: float, lon: float, radius_m: float = 240.0) -> tuple[float, float]:
    """(value at the site's pixel, best value within radius_m) with the file's scaling applied."""
    x, y = terrain.latlon_to_xy(lat, lon, ds.crs)
    row, col = ds.index(float(x[0]), float(y[0]))
    px = abs(ds.transform.a)
    k = int(np.ceil(radius_m / px))
    from rasterio.windows import Window

    win = ds.read(1, window=Window(col - k, row - k, 2 * k + 1, 2 * k + 1), masked=True).astype(float)
    scale = (ds.scales or (1.0,))[0] or 1.0
    offset = (ds.offsets or (0.0,))[0] or 0.0
    win = win * scale + offset
    yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
    near = (np.hypot(xx, yy) * px) <= radius_m
    centre = float(win[k, k])
    best = float(np.ma.max(np.ma.array(win, mask=np.ma.getmaskarray(win) | ~near)))
    return centre, best


def visible_share(lat, lon, hz, ets, provider) -> tuple[float, float]:
    """Share of samples with the body centre above the skyline (Sun, Earth). Same maths as the service."""
    radius_km = config.MOON_RADIUS_KM + (hz["site_height_m"] + hz["observer_height_m"]) / 1000.0
    r = site_vector(lat, lon, radius_km)
    basis = enu_basis(lat, lon)
    sky_az, sky_el = np.asarray(hz["az_deg"]), np.asarray(hz["el_deg"])
    out = []
    for body in ("sun", "earth"):
        vis = np.zeros(len(ets), bool)
        for i in range(0, len(ets), 20_000):  # chunks keep memory small
            az, el, _ = topocentric_az_el(provider.body_vectors(body, ets[i:i + 20_000]), r, basis)
            vis[i:i + 20_000] = el - terrain.skyline_at(az, sky_az, sky_el) > 0
        out.append(float(vis.mean()))
    return out[0], out[1]


def permanent_shadow_check() -> float:
    """Shackleton floor, 1 year at 1-hour steps, through the real API code path."""
    p = next(s for s in presets() if s["key"] == "shackleton")
    req = CompareRequest(
        sites=[SiteInput(id="A", label="floor", lat_deg=p["lat"], lon_deg=p["lon"], horizon_key="shackleton"),
               SiteInput(id="B", label="floor2", lat_deg=p["lat"], lon_deg=p["lon"], horizon_key="shackleton")],
        start_utc=datetime(2027, 1, 1, tzinfo=timezone.utc), duration_hours=365 * 24, step_minutes=60, mode="spice",
    )
    res = run_compare(req, SpiceProvider())
    a = res.sites[0]
    assert a.model == "terrain", "Shackleton floor horizon file missing: run scripts/build_horizons.py"
    return a.metrics.sun.visible_fraction


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(config.BACKEND_DIR / "data" / "validation.json"))
    ap.add_argument("--step-hours", type=float, default=2.0)
    args = ap.parse_args()

    kernels.load_kernels()
    if not kernels.STATUS.loaded:
        sys.exit(f"SPICE kernels not loaded: {kernels.STATUS.error}")
    result: dict = {"generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}

    with kernels.SPICE_LOCK:
        frac = permanent_shadow_check()
    result["permanent_shadow"] = {"site": "shackleton", "year": 2027, "step_hours": 1, "sunlit_share": frac}
    print(f"1. Shackleton crater floor, 2027, hourly: sunlit share {100 * frac:.2f}% (must be 0%)")
    if frac > 0:
        sys.exit("Permanent-shadow check failed; fix before comparing with NASA's maps.")

    if not all((VALID_DIR / f"{b}.LBL").exists() for pair in MAPS.values() for b in pair):
        result["comparison"] = None
        print("2. NASA average-illumination maps not found in backend/terrain/validation; comparison not done.")
        Path(args.out).write_text(json.dumps(result, indent=1))
        return

    maps = {k: [open_map(b) for b in pair] for k, pair in MAPS.items()}
    info = maps["85S"][0][1]
    print("\nNASA map label (Sun, 85S):")
    for k in ("start", "stop", "scaling", "offset", "unit", "max_lat", "min_lat", "scale_km"):
        print(f"  {k}: {info[k]}")
    for d in info["description"]:
        print(f"  description: {d[:600]}")
    result["nasa_maps"] = {k: {"files": list(MAPS[k]), "sun_label": v[0][1], "earth_label": v[1][1]} for k, v in maps.items()}

    # Time span: the maps' own START/STOP if the label gives them, else 18.6 years from 2009-07-01.
    try:
        t0 = datetime.fromisoformat(info["start"].replace("Z", "")).replace(tzinfo=timezone.utc)
        t1 = datetime.fromisoformat(info["stop"].replace("Z", "")).replace(tzinfo=timezone.utc)
        span_note = "the maps' START_TIME to STOP_TIME"
    except Exception:
        t0 = datetime(2009, 7, 1, tzinfo=timezone.utc)
        t1 = t0 + timedelta(days=18.6 * 365.25)
        span_note = "18.6 years from 2009-07-01 (the label gives no span)"
    provider = SpiceProvider()
    with kernels.SPICE_LOCK:
        et0 = provider.utc_to_et(t0)
        et1 = provider.utc_to_et(t1)
    ets = np.arange(et0, et1, args.step_hours * 3600.0)
    print(f"\n2. Lunar Prime vs NASA maps, {t0:%Y-%m-%d} to {t1:%Y-%m-%d} ({span_note}), {args.step_hours:g}-hour steps, "
          f"{len(ets):,} samples per body\n")

    rows = []
    for p in presets():
        hz_path = config.HORIZON_DIR / f"{p['key']}.json"
        if not hz_path.exists():
            continue
        hz = json.loads(hz_path.read_text())
        t = time.perf_counter()
        with kernels.SPICE_LOCK:
            sun, earth = visible_share(p["lat"], p["lon"], hz, ets, provider)
        which = "85S" if p["lat"] <= -85.0 else "65S"
        (sun_ds, _), (earth_ds, _) = maps[which]
        ns, ns_best = map_values(sun_ds, p["lat"], p["lon"])
        ne, ne_best = map_values(earth_ds, p["lat"], p["lon"])
        row = {"key": p["key"], "label": p["label"], "map": which, "lp_sun": sun, "nasa_sun": ns, "nasa_sun_best240": ns_best,
               "lp_earth": earth, "nasa_earth": ne, "nasa_earth_best240": ne_best}
        rows.append(row)
        print(f"{p['label']:<34} Sun LP {100 * sun:5.1f}%  NASA {100 * ns:5.1f}% (best {100 * ns_best:5.1f}%)  diff {100 * (sun - ns):+5.1f}   "
              f"Earth LP {100 * earth:5.1f}%  NASA {100 * ne:5.1f}% (best {100 * ne_best:5.1f}%)  diff {100 * (earth - ne):+5.1f}   "
              f"[{which} map, {time.perf_counter() - t:.0f} s]")
    result["comparison"] = {"t0": t0.isoformat(), "t1": t1.isoformat(), "step_hours": args.step_hours, "rows": rows}
    Path(args.out).write_text(json.dumps(result, indent=1))
    print(f"\nWritten to {args.out}")


if __name__ == "__main__":
    main()
