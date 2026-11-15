"""Compare-request orchestration: sampling, geometry, intervals, metrics, narrative."""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone

import numpy as np

from . import analysis, config, kernels, narrative, terrain
from .geometry import EphemerisProvider, enu_basis, site_vector, sub_point, topocentric_az_el
from .models import (
    AzEl, BodyMetrics, Comparison, CompareRequest, CompareResponse, GapOut, IntervalOut,
    KernelOut, Metadata, SiteMetrics, SiteResult, SubPoints,
)


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


def terrain_for(lat_deg: float, lon_deg: float, requested: bool):
    """(Horizon or None, summary dict) for a site; never raises."""
    if not requested:
        return None, {"applied": False, "reason": "Ideal horizon (terrain not requested)."}
    if not terrain.available():
        return None, {"applied": False, "reason": "Terrain data not installed (run scripts/fetch_terrain.sh); "
                                                  "ideal horizon used."}
    if not terrain.covers(lat_deg):
        return None, {"applied": False, "reason": "Outside the LOLA south-polar DEM (60°S to the pole); "
                                                  "ideal horizon used."}
    hz = terrain.horizon(round(lat_deg, 5), round(lon_deg, 5))
    return hz, hz.summary()


def run_compare(req: CompareRequest, provider: EphemerisProvider) -> CompareResponse:
    t_start = time.perf_counter()
    duration_s = req.duration_hours * 3600.0
    step_s = req.step_minutes * 60.0

    et0 = provider.utc_to_et(req.start_utc)
    et1 = et0 + duration_s
    if provider.mode == "spice":
        if et0 < kernels.STATUS.coverage_start_et or et1 > kernels.STATUS.coverage_end_et:
            raise ComputeError(
                f"The window must lie within the loaded kernel coverage "
                f"({kernels.STATUS.coverage_start_utc} to {kernels.STATUS.coverage_end_utc})."
            )

    ets = sample_times(et0, duration_s, step_s)
    if len(ets) > config.MAX_SAMPLES:
        raise ComputeError(f"{len(ets):,} samples exceeds the limit of {config.MAX_SAMPLES:,}")

    body_vecs = {b: provider.body_vectors(b, ets) for b in config.BODIES}
    ss_lat, ss_lon, _ = sub_point(body_vecs["sun"])
    se_lat, se_lon, e_dist = sub_point(body_vecs["earth"])

    def to_utc(et: float) -> str:
        return provider.et_to_utc(np.array([et]))[0]

    def interval_out(iv: list[tuple[float, float]]) -> list[IntervalOut]:
        return [
            IntervalOut(
                start_utc=to_utc(s), end_utc=to_utc(e), duration_s=round(e - s, 1),
                starts_at_window_start=s <= et0, ends_at_window_end=e >= et1,
            )
            for s, e in iv
        ]

    n_refined_total = 0
    site_results: list[SiteResult] = []
    for site in req.sites:
        r = site_vector(site.lat_deg, site.lon_deg)
        basis = enu_basis(site.lat_deg, site.lon_deg)
        hz, terrain_info = terrain_for(site.lat_deg, site.lon_deg, req.terrain)
        series: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        ivs: dict[str, list[tuple[float, float]]] = {}
        body_metrics: dict[str, BodyMetrics] = {}
        for body in config.BODIES:
            az, el, _ = topocentric_az_el(body_vecs[body], r, basis)
            series[body] = (az, el)
            # Visibility is judged against the local horizon: the terrain profile when applied, else 0 deg.
            clear = el - hz.at(az) if hz is not None else el

            def el_fn(t: float, body=body) -> float:
                a, e, _ = topocentric_az_el(provider.body_vectors(body, np.array([t])), r, basis)
                return float(e[0] - (hz.at(a)[0] if hz is not None else 0.0))

            iv, n_ref = analysis.visible_intervals(ets, clear, el_fn, config.REFINE_TOLERANCE_S)
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
                near_horizon_fraction=round(analysis.near_horizon_fraction(ets, clear, config.NEAR_HORIZON_DEG), 4),
            )
            series[body] = (az, el, clear)
        ivs["both"] = analysis.intersect(ivs["sun"], ivs["earth"])
        both_s = analysis.total_duration(ivs["both"])
        sun_mask = series["sun"][2] > 0
        earth_mask = series["earth"][2] > 0
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
            terrain=terrain_info,
        ))

    if len(site_results) == 2:
        a, b = site_results
        headline, statements, tol = narrative.build(
            a.id, a.label, a.metrics, b.id, b.label, b.metrics, duration_s, step_s
        )
    else:  # the pairwise narrative applies to exactly two sites; metrics are reported for every site
        headline, statements, tol = (
            "Metrics are reported for each site; compare them per criterion.", [], float(2 * step_s))

    if provider.mode == "spice":
        provenance = (
            "Computed with NASA/JPL NAIF SPICE (CSPICE via SpiceyPy) from the kernels listed; "
            "geometric visibility on an ideal spherical horizon."
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

    timestamps = provider.et_to_utc(ets)
    return CompareResponse(
        timestamps_utc=timestamps,
        elapsed_s=_r(ets - et0, 1),
        sites=site_results,
        subpoints=SubPoints(
            subsolar_lat_deg=_r(ss_lat, 4), subsolar_lon_deg=_r(ss_lon, 4),
            sub_earth_lat_deg=_r(se_lat, 4), sub_earth_lon_deg=_r(se_lon, 4),
            earth_distance_km=_r(e_dist, 1),
        ),
        comparison=Comparison(headline=headline, statements=statements, tolerance_s=round(tol, 1)),
        metadata=Metadata(
            mode=provider.mode, provenance=provenance,
            computed_at_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            window_start_utc=timestamps[0], window_end_utc=timestamps[-1],
            window_duration_s=duration_s, step_s=step_s, n_samples=len(ets),
            refinement_tolerance_s=config.REFINE_TOLERANCE_S, n_refined_transitions=n_refined_total,
            conventions=config.CONVENTIONS, limitations=config.LIMITATIONS,
            kernels=kernel_list, toolkit_version=toolkit,
            compute_time_ms=round((time.perf_counter() - t_start) * 1000, 1),
        ),
    )
