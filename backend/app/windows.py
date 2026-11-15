"""Best landing-window finder: scan a period for one site and rank candidate landing dates.

For every candidate start (every `candidate_hours`) the mission window [start, start + mission_days] is
scored from Sun and Earth visibility sampled every `step_minutes` at the site, against the terrain
horizon when available. This is a screening tool: fractions are sample-based (resolution = step), not
the 1 s refined intervals of /api/compare; add a window to the comparison for refined numbers.
"""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from typing import Literal, Optional

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import config, kernels
from .geometry import EphemerisProvider, enu_basis, site_vector, topocentric_az_el
from .models import SiteInput
from .service import ComputeError, load_horizon
from .terrain import skyline_at

MAX_SAMPLES = 60_000


class WindowsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    site: SiteInput
    start_utc: datetime
    span_days: float = Field(365.0, ge=1.0, le=400.0, description="Period over which landing dates are searched")
    mission_days: float = Field(14.0, ge=0.5, le=60.0, description="Length of each candidate surface mission")
    step_minutes: float = Field(60.0, ge=10.0, le=240.0)
    candidate_hours: float = Field(6.0, ge=1.0, le=72.0, description="Spacing between candidate start times")
    priority: Literal["power", "comms", "both"] = "both"
    terrain: bool = Field(True, description="Use the precomputed LOLA skyline when site.horizon_key names one")
    top_k: int = Field(5, ge=1, le=10)
    mode: Literal["spice", "synthetic"] = "spice"

    @field_validator("start_utc")
    @classmethod
    def _utc(cls, v: datetime) -> datetime:
        if v.tzinfo is None or v.utcoffset() != timezone.utc.utcoffset(None):
            raise ValueError("start_utc must be UTC, e.g. '2027-01-01T00:00:00Z'")
        return v.astimezone(timezone.utc)

    @model_validator(mode="after")
    def _check(self) -> "WindowsRequest":
        n = (self.span_days + self.mission_days) * 1440 / self.step_minutes
        if n > MAX_SAMPLES:
            raise ValueError(f"about {n:,.0f} samples exceeds {MAX_SAMPLES:,}; use a larger step or shorter span")
        if self.candidate_hours * 60 < self.step_minutes:
            raise ValueError("candidate_hours must be at least one sampling step")
        return self


PRIORITY_TEXT = {
    "power": "most sunlight (ties broken by the shorter longest night)",
    "comms": "most Earth-in-view time (ties broken by the shorter longest blackout)",
    "both": "most time with sunlight and Earth in view together",
}


def _longest_zero_run(mask: np.ndarray, starts: np.ndarray, m: int) -> np.ndarray:
    """Longest run of False (in samples) inside each window mask[s:s+m]."""
    run = np.zeros(len(mask), dtype=np.int32)  # length of the False-run ending at i
    c = 0
    for i, v in enumerate(mask):
        c = 0 if v else c + 1
        run[i] = c
    out = np.empty(len(starts), dtype=np.int32)
    idx = np.arange(m)
    for k, s in enumerate(starts):
        out[k] = int(np.minimum(run[s:s + m], idx + 1).max()) if m else 0
    return out


def find_windows(req: WindowsRequest, provider: EphemerisProvider) -> dict:
    """Caller holds SPICE_LOCK (provider calls happen here)."""
    t0 = time.perf_counter()
    step = req.step_minutes * 60.0
    total = (req.span_days + req.mission_days) * 86400.0
    et0 = provider.utc_to_et(req.start_utc)
    if provider.mode == "spice" and (et0 < kernels.STATUS.coverage_start_et or et0 + total > kernels.STATUS.coverage_end_et):
        raise ComputeError(f"The search period must lie within the loaded kernel coverage "
                           f"({kernels.STATUS.coverage_start_utc} to {kernels.STATUS.coverage_end_utc}).")
    n = int(math.floor(total / step)) + 1
    ets = et0 + step * np.arange(n)
    # Same skyline handling as /api/compare: observer on the real surface plus mast height, visibility
    # judged against the precomputed LOLA skyline; smooth sphere and 0 deg horizon otherwise.
    hz = load_horizon(req.site, provider.mode) if req.terrain else None
    if hz is None:
        r = site_vector(req.site.lat_deg, req.site.lon_deg)
        sky = None
        terrain_info = {"applied": False, "reason": (
            "Smooth sphere, ideal horizon: no precomputed LOLA skyline for this site." if req.terrain
            else "Smooth sphere, ideal horizon (terrain not requested).")}
    else:
        r = site_vector(req.site.lat_deg, req.site.lon_deg,
                        config.MOON_RADIUS_KM + (hz["site_height_m"] + hz["observer_height_m"]) / 1000.0)
        sky = (np.asarray(hz["az_deg"], float), np.asarray(hz["el_deg"], float))
        terrain_info = {"applied": True, "horizon_key": hz["key"], "label": hz["label"],
                        "dems": [d["name"] for d in hz.get("dems", [])],
                        "max_horizon_deg": round(float(np.max(sky[1])), 3)}
    basis = enu_basis(req.site.lat_deg, req.site.lon_deg)
    vis = {}
    for body in config.BODIES:
        az, el, _ = topocentric_az_el(provider.body_vectors(body, ets), r, basis)
        vis[body] = (el - skyline_at(az, *sky) if sky is not None else el) > 0
    both = vis["sun"] & vis["earth"]

    m = max(1, int(round(req.mission_days * 86400.0 / step)))
    cstep = max(1, int(round(req.candidate_hours * 3600.0 / step)))
    starts = np.arange(0, n - m, cstep)
    if not len(starts):
        raise ComputeError("the search span is too short for this mission length")

    def frac(mask):
        cs = np.concatenate([[0], np.cumsum(mask, dtype=np.int64)])
        return (cs[starts + m] - cs[starts]) / m

    f_sun, f_earth, f_both = frac(vis["sun"]), frac(vis["earth"]), frac(both)
    night = _longest_zero_run(vis["sun"], starts, m) * step
    blackout = _longest_zero_run(vis["earth"], starts, m) * step

    if req.priority == "power":
        key = np.lexsort((night, -f_sun))
    elif req.priority == "comms":
        key = np.lexsort((blackout, -f_earth))
    else:
        key = np.lexsort((night, -f_both))
    # Greedy non-overlapping pick: candidates closer than half a mission apart are treated as the same window.
    min_sep = max(1, m // 2)
    picked: list[int] = []
    for k in key:
        if all(abs(int(starts[k]) - int(starts[j])) >= min_sep for j in picked):
            picked.append(int(k))
        if len(picked) >= req.top_k:
            break

    start_utc = provider.et_to_utc(ets[starts])
    end_utc = provider.et_to_utc(ets[starts + m])
    windows = [dict(rank=i + 1, start_utc=start_utc[k], end_utc=end_utc[k],
                    sun_fraction=round(float(f_sun[k]), 4), earth_fraction=round(float(f_earth[k]), 4),
                    both_fraction=round(float(f_both[k]), 4), longest_night_s=float(night[k]),
                    longest_blackout_s=float(blackout[k]))
               for i, k in enumerate(picked)]
    worst = int(key[-1])
    return dict(
        site=req.site.model_dump(), priority=req.priority, priority_text=PRIORITY_TEXT[req.priority],
        mission_days=req.mission_days, span_days=req.span_days, step_minutes=req.step_minutes,
        candidate_hours=req.candidate_hours, windows=windows,
        worst=dict(start_utc=start_utc[worst], sun_fraction=round(float(f_sun[worst]), 4),
                   earth_fraction=round(float(f_earth[worst]), 4), both_fraction=round(float(f_both[worst]), 4)),
        series=dict(start_utc=start_utc, sun_fraction=np.round(f_sun, 4).tolist(),
                    earth_fraction=np.round(f_earth, 4).tolist(), both_fraction=np.round(f_both, 4).tolist()),
        terrain={k: v for k, v in terrain_info.items() if k not in ("az_deg", "el_deg")},
        mode=provider.mode,
        resolution_note=(f"Screening resolution: visibility sampled every {req.step_minutes:g} min and candidate "
                         f"starts every {req.candidate_hours:g} h, so fractions and gaps are approximate to about "
                         "one sample. Add a window to the comparison for 1 s refined values."),
        compute_time_ms=round((time.perf_counter() - t0) * 1000, 1),
        computed_at_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
