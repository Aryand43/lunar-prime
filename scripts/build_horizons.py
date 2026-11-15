"""Precompute terrain skylines for the south-pole presets (UPDATE_SPEC_2, task T3).

Reads the LOLA maps fetched by scripts/fetch_terrain.sh and writes one small JSON file per preset to
backend/data/horizons/<preset key>.json. Those files are committed, so the app can use terrain on
machines that never download the maps.

Run from the repository root:
    cd backend && uv run python ../scripts/build_horizons.py [--only key1,key2]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app import config, terrain  # noqa: E402

SITES_TS = ROOT / "frontend" / "src" / "lib" / "sites.ts"
OBSERVER_HEIGHT_M = 2.0
N_AZ = 720
MAX_KM = 400.0


def presets(group: str | None = "South pole") -> list[dict]:
    """Preset key, label, lat, lon and group, read from the frontend's preset list (single source of truth)."""
    text = SITES_TS.read_text()
    out = []
    for block in re.findall(r"\{[^{}]*?key:\s*\"[^\"]+\"[^{}]*?\}", text, flags=re.S):
        get = lambda k: re.search(rf"{k}:\s*(\"(?:[^\"\\]|\\.)*\"|-?[\d.]+)", block)  # noqa: E731
        key, label, lat, lon, grp = (get(k) for k in ("key", "label", "lat", "lon", "group"))
        if not (key and lat and lon and grp):
            continue
        item = {"key": key.group(1).strip('"'), "label": label.group(1).strip('"') if label else "",
                "lat": float(lat.group(1)), "lon": float(lon.group(1)), "group": grp.group(1).strip('"')}
        if group is None or item["group"] == group:
            out.append(item)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated preset keys")
    ap.add_argument("--maps", default="LDEM_80S_80MPP_ADJ.TIF,LDEM_60S_240MPP_ADJ.TIF",
                    help="comma-separated map files in backend/terrain (default: both)")
    args = ap.parse_args()

    sites = presets()
    if args.only:
        wanted = set(args.only.split(","))
        sites = [s for s in sites if s["key"] in wanted]
    if not sites:
        sys.exit("No south-pole presets found in frontend/src/lib/sites.ts")

    print(f"Loading LOLA maps from {config.TERRAIN_DIR} ...")
    t0 = time.perf_counter()
    lola = terrain.Terrain.from_dir(config.TERRAIN_DIR, names=tuple(args.maps.split(",")), with_sha=True)
    print(f"  loaded in {time.perf_counter() - t0:.1f} s: " + ", ".join(f"{d.name} ({d.pixel_m:.0f} m/px)" for d in lola.dems))

    config.HORIZON_DIR.mkdir(parents=True, exist_ok=True)
    built = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for s in sites:
        t0 = time.perf_counter()
        try:
            p = terrain.horizon_profile(lola, s["lat"], s["lon"], OBSERVER_HEIGHT_M, N_AZ, MAX_KM)
        except ValueError as exc:
            print(f"{s['key']:<18} skipped: {exc}")
            continue
        data = {
            "key": s["key"],
            "label": s["label"],
            "lat_deg": s["lat"],
            "lon_deg": s["lon"],
            "site_height_m": round(p.site_height_m, 2),
            "observer_height_m": p.observer_height_m,
            "az_deg": [round(float(a), 2) for a in p.az_deg],
            "el_deg": [round(float(e), 4) for e in p.el_deg],
            "shortest_ray_km": round(p.shortest_ray_km, 2),
            "method": f"{N_AZ} directions, rays to {MAX_KM:.0f} km (40 m steps to 20 km, then +1.5% per step), "
                      f"observer {OBSERVER_HEIGHT_M:g} m above the surface; skyline = highest terrain elevation angle",
            "dems": [{"name": d.name, "pixel_m": d.pixel_m, "sha256": d.sha256} for d in lola.dems],
            "built_utc": built,
        }
        (config.HORIZON_DIR / f"{s['key']}.json").write_text(json.dumps(data, separators=(",", ":")))
        print(f"{s['key']:<18} height {p.site_height_m:8.1f} m   skyline {p.el_deg.min():+6.2f} to {p.el_deg.max():+6.2f} deg   "
              f"shortest ray {p.shortest_ray_km:6.1f} km   ({time.perf_counter() - t0:.2f} s)")


if __name__ == "__main__":
    main()
