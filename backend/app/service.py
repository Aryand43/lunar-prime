"""Compare-request orchestration: sampling, geometry, intervals, metrics, narrative."""

from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone
from functools import lru_cache

import numpy as np

from . import analysis, config, kernels, narrative
from .geometry import EphemerisProvider, enu_basis, normalize_lon, site_vector, sub_point, topocentric_az_el
from .models import (
    AzEl, BodyMetrics, Comparison, CompareRequest, CompareResponse, GapOut, HorizonOut, IntervalOut,
    KernelOut, Metadata, SiteInput, SiteMetrics, SiteResult, SubPoints,
)
from .terrain import skyline_at


class ComputeError(ValueError):
    """User-correctable problem with a request (reported as HTTP 422)."""


def _r(a: np.ndarray, nd: int) -> list[float]:
    return np.round(np.asarray(a, dtype=float), nd).tolist()


def sample_times(et0: float, duration_s: float, step_s: float) -> np.ndarray:
    k = int(math.floor(duration_s / step_s + 1e-9))
    ets = et0 + np.arange(k + 1) * step_s
    if et0 + duration_s - ets[-1] > 1e-6:
        ets = np.append(ets, et0 + duration_s)
    return ets


@lru_cache(maxsize=64)
def _read_horizon(path: str, mtime: float) -> dict:
    with open(path) as f:
        return json.load(f)


def load_horizon(site: SiteInput, mode: str) -> dict | None:
    """The precomputed skyline for a site, or None (smooth sphere).

    None when: no key, synthetic mode, no file for the key, or the coordinates were edited away from the
    preset's (more than config.HORIZON_MATCH_DEG in latitude or longitude).
    """
    if not site.horizon_key or mode != "spice":
        return None
    path = config.HORIZON_DIR / f"{site.horizon_key}.json"
    if not path.is_file():
        return None
    hz = _read_horizon(str(path), path.stat().st_mtime)
    dlat = abs(site.lat_deg - hz["lat_deg"])
    dlon = abs(normalize_lon(site.lon_deg - hz["lon_deg"]))
    if dlat > config.HORIZON_MATCH_DEG or dlon > config.HORIZON_MATCH_DEG:
        return None
    return hz


class _Scenario:
    """Sample times, body vectors and sub-points for one window start. Shared when both sites use the same start."""

    def __init__(self, provider: EphemerisProvider, start: datetime, duration_s: float, step_s: float):
        self.start = start
        self.et0 = provider.utc_to_et(start)
        self.et1 = self.et0 + duration_s
        if provider.mode == "spice":
            if self.et0 < kernels.STATUS.coverage_start_et or self.et1 > kernels.STATUS.coverage_end_et:
                raise ComputeError(
                    f"The window must lie within the loaded kernel coverage "
                    f"({kernels.STATUS.coverage_start_utc} to {kernels.STATUS.coverage_end_utc})."
                )
        self.ets = sample_times(self.et0, duration_s, step_s)
        if len(self.ets) > config.MAX_SAMPLES:
            raise ComputeError(f"{len(self.ets):,} samples exceeds the limit of {config.MAX_SAMPLES:,}")
        self.body_vecs = {b: provider.body_vectors(b, self.ets) for b in config.BODIES}
        ss_lat, ss_lon, _ = sub_point(self.body_vecs["sun"])
        se_lat, se_lon, e_dist = sub_point(self.body_vecs["earth"])
        self.subpoints = SubPoints(
            subsolar_lat_deg=_r(ss_lat, 4), subsolar_lon_deg=_r(ss_lon, 4),
            sub_earth_lat_deg=_r(se_lat, 4), sub_earth_lon_deg=_r(se_lon, 4),
            earth_distance_km=_r(e_dist, 1),
        )
        self.timestamps = provider.et_to_utc(self.ets)


def _start_label(start: datetime, other: datetime) -> str:
    """Date for narrative labels; adds the time of day when both starts fall on the same date."""
    if start.date() == other.date():
        return start.strftime("%Y-%m-%d %H:%M UTC")
    return start.strftime("%Y-%m-%d")


def run_compare(req: CompareRequest, provider: EphemerisProvider) -> CompareResponse:
    t_start = time.perf_counter()
    duration_s = req.duration_hours * 3600.0
    step_s = req.step_minutes * 60.0

    # One scenario per distinct start. When both sites use the request's start (the usual case),
    # the geometry is computed once, so such requests cost the same as before scenarios existed.
    starts = [site.start_utc or req.start_utc for site in req.sites]
    scenarios: dict[datetime, _Scenario] = {}
    for st in starts:
        if st not in scenarios:
            scenarios[st] = _Scenario(provider, st, duration_s, step_s)
    starts_differ = len(scenarios) > 1

    def to_utc(et: float) -> str:
        return provider.et_to_utc(np.array([et]))[0]

    n_refined_total = 0
    site_results: list[SiteResult] = []
    terrain_dems: set[str] = set()
    for site, st in zip(req.sites, starts):
        sc = scenarios[st]
        et0, et1, ets, body_vecs = sc.et0, sc.et1, sc.ets, sc.body_vecs

        def interval_out(iv: list[tuple[float, float]], et0: float = et0, et1: float = et1) -> list[IntervalOut]:
            return [
                IntervalOut(
                    start_utc=to_utc(s), end_utc=to_utc(e), duration_s=round(e - s, 1),
                    starts_at_window_start=s <= et0, ends_at_window_end=e >= et1,
                )
                for s, e in iv
            ]

        hz = load_horizon(site, provider.mode)
        if hz is None:
            r = site_vector(site.lat_deg, site.lon_deg)
            sky_az = sky_el = None
        else:
            # Observer on the real surface plus the mast height, not on the 1737.4 km sphere.
            radius_km = config.MOON_RADIUS_KM + (hz["site_height_m"] + hz["observer_height_m"]) / 1000.0
            r = site_vector(site.lat_deg, site.lon_deg, radius_km)
            sky_az, sky_el = np.asarray(hz["az_deg"], float), np.asarray(hz["el_deg"], float)
        basis = enu_basis(site.lat_deg, site.lon_deg)
        margins: dict[str, np.ndarray] = {}
        series: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        ivs: dict[str, list[tuple[float, float]]] = {}
        body_metrics: dict[str, BodyMetrics] = {}
        for body in config.BODIES:
            az, el, _ = topocentric_az_el(body_vecs[body], r, basis)
            series[body] = (az, el)
            # margin = elevation above the horizon in that direction: the skyline at terrain sites, 0 deg otherwise.
            margin = el if sky_az is None else el - skyline_at(az, sky_az, sky_el)
            margins[body] = margin

            def margin_fn(t: float, body=body, r=r, basis=basis, sky_az=sky_az, sky_el=sky_el) -> float:
                a1, e1, _ = topocentric_az_el(provider.body_vectors(body, np.array([t])), r, basis)
                return float(e1[0] if sky_az is None else e1[0] - skyline_at(a1, sky_az, sky_el)[0])

            iv, n_ref = analysis.visible_intervals(ets, margin, margin_fn, config.REFINE_TOLERANCE_S)
            n_refined_total += n_ref
            ivs[body] = iv
            g = analysis.longest_gap(iv, et0, et1)
            longest = analysis.longest_interval(iv)
            body_metrics[body] = BodyMetrics(
                visible_duration_s=round(analysis.total_duration(iv), 1),
                visible_fraction=round(analysis.total_duration(iv) / duration_s, 6),
                longest_visible_s=round(longest[1] - longest[0], 1) if longest else 0.0,
                longest_gap=None if g is None else GapOut(
                    start_utc=to_utc(g.start), end_utc=to_utc(g.end), duration_s=round(g.duration, 1),
                    open_start=g.open_start, open_end=g.open_end,
                ),
                n_intervals=len(iv),
                el_min_deg=round(float(el.min()), 4),
                el_max_deg=round(float(el.max()), 4),
                near_horizon_fraction=round(analysis.near_horizon_fraction(ets, margin, config.NEAR_HORIZON_DEG), 4),
            )
        ivs["both"] = analysis.intersect(ivs["sun"], ivs["earth"])
        both_s = analysis.total_duration(ivs["both"])
        sun_mask = margins["sun"] > 0
        earth_mask = margins["earth"] > 0
        site_results.append(SiteResult(
            id=site.id, label=site.label, lat_deg=site.lat_deg, lon_deg=site.lon_deg,
            position_me_km=_r(r, 3),
            sun=AzEl(az_deg=_r(series["sun"][0], 3), el_deg=_r(series["sun"][1], 4)),
            earth=AzEl(az_deg=_r(series["earth"][0], 3), el_deg=_r(series["earth"][1], 4)),
            masks={"sun": sun_mask.tolist(), "earth": earth_mask.tolist(), "both": (sun_mask & earth_mask).tolist()},
            intervals={k: interval_out(v) for k, v in ivs.items()},
            metrics=SiteMetrics(
                sun=body_metrics["sun"], earth=body_metrics["earth"],
                both_duration_s=round(both_s, 1), both_fraction=round(both_s / duration_s, 6),
            ),
            start_utc=sc.timestamps[0],
            timestamps_utc=sc.timestamps,
            subpoints=sc.subpoints,
            model="sphere" if hz is None else "terrain",
            horizon=None if hz is None else HorizonOut(
                az_deg=hz["az_deg"], el_deg=hz["el_deg"], site_height_m=hz["site_height_m"],
                observer_height_m=hz["observer_height_m"],
                source="LOLA " + " and ".join(d["name"] for d in hz["dems"]),
            ),
        ))
        terrain_dems.update(d["name"] for d in (hz or {}).get("dems", []))

    a, b = site_results
    a_name, b_name = a.label, b.label
    if starts_differ:
        # Name the dates in the findings so sentences stay unambiguous (even for the same place twice).
        a_name = f"{a.label} (from {_start_label(starts[0], starts[1])})"
        b_name = f"{b.label} (from {_start_label(starts[1], starts[0])})"
    headline, statements, tol = narrative.build(
        a.id, a_name, a.metrics, b.id, b_name, b.metrics, duration_s, step_s,
        a_terrain=a.model == "terrain", b_terrain=b.model == "terrain",
    )

    if provider.mode == "spice":
        provenance = (
            "Computed with NASA/JPL NAIF SPICE (CSPICE via SpiceyPy) from the kernels listed; "
            "geometric visibility on an ideal spherical horizon."
        )
        if terrain_dems:
            provenance = provenance.replace(
                "geometric visibility on an ideal spherical horizon.",
                "geometric visibility above the LOLA terrain skyline at terrain sites (elevation maps "
                + ", ".join(sorted(terrain_dems)) + ", NASA GSFC PGDA product 90) and above an ideal spherical horizon elsewhere.",
            )
        kernel_list = [KernelOut(name=k.name, kind=k.kind, purpose=k.purpose, source_url=k.source_url, sha256=k.sha256)
                   for k in kernels.STATUS.kernels]
        toolkit = kernels.STATUS.toolkit_version
    else:
        provenance = (
            "SYNTHETIC DEMO DATA - crude analytic approximation for UI development only. "
            "Not computed with SPICE and not NASA data; do not use for analysis."
        )
        kernel_list, toolkit = [], None

    sa = scenarios[starts[0]]  # top-level fields describe scenario A
    return CompareResponse(
        timestamps_utc=sa.timestamps,
        elapsed_s=_r(sa.ets - sa.et0, 1),  # identical for both scenarios: same duration and step
        sites=site_results,
        subpoints=sa.subpoints,
        comparison=Comparison(headline=headline, statements=statements, tolerance_s=round(tol, 1)),
        metadata=Metadata(
            mode=provider.mode, provenance=provenance,
            computed_at_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            window_start_utc=sa.timestamps[0], window_end_utc=sa.timestamps[-1],
            window_duration_s=duration_s, starts_differ=starts_differ, step_s=step_s, n_samples=len(sa.ets),
            refinement_tolerance_s=config.REFINE_TOLERANCE_S, n_refined_transitions=n_refined_total,
            conventions=config.CONVENTIONS, limitations=config.LIMITATIONS,
            kernels=kernel_list, toolkit_version=toolkit,
            compute_time_ms=round((time.perf_counter() - t_start) * 1000, 1),
        ),
    )
