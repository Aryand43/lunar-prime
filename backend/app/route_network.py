"""Deterministic, bounded candidate-network generator for arbitrary start positions.

Generates "Planning waypoint" nodes along a central great-circle corridor from start to destination
plus laterally offset corridors. Spacing keeps every along-corridor and diagonal hop below max_leg_km,
so the existing time-expanded search can connect them. Generated nodes are hypothetical planning
points: they imply nothing about terrain, power, supplies or communications.
"""

from __future__ import annotations

import math

import numpy as np

from . import config
from .routing import RoutingError, central_angle, lat_lon_of, unit_vector

R_KM = config.MOON_RADIUS_KM
ALONG_FRAC = 0.7  # along-track spacing as a fraction of max_leg_km
LATERAL_FRAC = 0.4  # lateral corridor offset; sqrt(0.7^2 + 0.4^2) = 0.81 < 1 keeps diagonals legal


def _rotate_towards(p: np.ndarray, axis: np.ndarray, ang: float) -> np.ndarray:
    v = math.cos(ang) * p + math.sin(ang) * axis
    return v / np.linalg.norm(v)


def _arc_points(a: np.ndarray, b: np.ndarray, n_inner: int) -> list[np.ndarray]:
    om = central_angle(a, b)
    s = math.sin(om)
    out = []
    for k in range(1, n_inner + 1):
        f = k / (n_inner + 1)
        p = (math.sin((1 - f) * om) * a + math.sin(f * om) * b) / s
        out.append(p / np.linalg.norm(p))
    return out


def generate_network(start_lat, start_lon, dest_lat, dest_lon, max_leg_km: float, n_corridors: int = 3,
                     max_nodes: int = config.ROUTE_MAX_BASES - 2) -> tuple[list[dict], dict]:
    """Return (waypoints, info). Raises RoutingError with a preflight explanation if oversized."""
    a, b = unit_vector(start_lat, start_lon), unit_vector(dest_lat, dest_lon)
    om = central_angle(a, b)
    dist = om * R_KM
    info = dict(distance_km=dist, corridors=n_corridors, antipodal=False, notes=[], generated_nodes=0,
                along_spacing_km=ALONG_FRAC * max_leg_km, lateral_offset_km=LATERAL_FRAC * max_leg_km)
    if dist < config.ROUTE_COINCIDENT_KM or dist <= max_leg_km:
        info["notes"].append("Destination is within one leg of the start; no planning waypoints needed.")
        return [], info

    # Spine anchors: direct great circle, or explicit meridian anchors for (near-)antipodal endpoints.
    if om > math.pi - 0.05:
        info["antipodal"] = True
        # Deterministic anchor: the reference axis (x, or y if x is nearly parallel to the start)
        # projected onto the plane orthogonal to the start vector. Never SLERP across the antipode.
        ref = np.array([1.0, 0.0, 0.0]) if abs(a[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        mid = ref - float(np.dot(ref, a)) * a
        mid = mid / np.linalg.norm(mid)
        mlat, mlon = lat_lon_of(mid)
        info["anchor"] = dict(lat_deg=float(mlat), lon_deg=float(mlon))
        info["notes"].append(
            "Start and destination are (near-)antipodal, so infinitely many equally short great-circle paths exist. "
            f"A deterministic corridor through an explicit anchor at ({float(mlat):.2f}°, {float(mlon):.2f}° E) is used; "
            "other equally short corridors are not explored.")
        spans = [(a, mid), (mid, b)]
    else:
        spans = [(a, b)]

    step_rad = ALONG_FRAC * max_leg_km / R_KM
    spine: list[np.ndarray] = []
    for i, (p, q) in enumerate(spans):
        n_inner = max(0, math.ceil(central_angle(p, q) / step_rad) - 1)
        if i > 0:
            spine.append(p)
        spine.extend(_arc_points(p, q, n_inner))

    needed = len(spine) * n_corridors
    info.update(spine_nodes=len(spine), estimated_nodes=needed)
    if needed > max_nodes:
        raise RoutingError(
            f"Preflight: the {dist:.0f} km traverse at max leg {max_leg_km:g} km needs about {needed} generated "
            f"waypoints ({n_corridors} corridors x {len(spine)}), above the {max_nodes}-waypoint exact-search limit. "
            f"Increase max_leg_km to at least {math.ceil(max_leg_km * (needed + n_corridors) / max_nodes)} km, "
            "or choose coarse planning (single corridor); no search was run.")

    lat_rad = LATERAL_FRAC * max_leg_km / R_KM
    offsets = [0.0] + [s * lat_rad * ((k + 2) // 2) for k, s in zip(range(n_corridors - 1), [1, -1] * n_corridors)]
    wps = []
    for ci, off in enumerate(offsets):
        for k, p in enumerate(spine):
            q = spine[k + 1] if k + 1 < len(spine) else b
            axis = np.cross(p, q - p) if np.linalg.norm(q - p) > 1e-12 else np.cross(p, [1.0, 0, 0])
            axis = axis / np.linalg.norm(axis)
            u = _rotate_towards(p, axis, off) if off else p
            lat, lon = lat_lon_of(u)
            wps.append(dict(id=f"G{ci}_{k + 1}", label=f"Planning waypoint {ci}-{k + 1}",
                            lat_deg=float(lat), lon_deg=float(lon)))
    info["generated_nodes"] = len(wps)
    return wps, info


# --------------------------------------------------------------------------------------------
# Request preparation (shared by /api/route and /api/route/preflight)
# --------------------------------------------------------------------------------------------

COARSE_GRID_OPTIONS = (10, 15, 30, 60, 120, 180, 240, 360)


def _fit_physical(req, report: dict):
    """Auto-fit (explicitly requested): raise horizon, then speed, then leg length just enough to reach the
    destination. Every change is recorded in report["adjustments"]; nothing is changed silently."""
    a, b = unit_vector(req.start.lat_deg, req.start.lon_deg), unit_vector(req.destination.lat_deg, req.destination.lon_deg)
    om = central_angle(a, b)
    dist = om * R_KM
    upd: dict = {}
    speed, horizon = req.speed_kmh, req.horizon_hours
    slack = min(req.max_wait_hours, 24.0)
    need_h = dist / speed * 1.3 + slack  # room for corridor detours, grid alignment and waits
    max_h = config.ROUTE_MAX_HORIZON_HOURS
    if need_h > horizon:
        if need_h <= max_h:
            upd["horizon_hours"] = float(math.ceil(need_h))
        else:
            upd["horizon_hours"] = max_h
            new_speed = math.ceil(dist * 1.3 / (max_h - slack) * 10) / 10
            upd["speed_kmh"] = max(speed, new_speed)
            report["adjustments"].append(
                f"Speed raised from {speed:g} to {upd['speed_kmh']:g} km/h: at {speed:g} km/h the {dist:.0f} km "
                f"traverse needs at least {dist / speed:.0f} h, beyond the {max_h:g} h maximum horizon.")
        report["adjustments"].append(
            f"Horizon raised from {horizon:g} h to {upd['horizon_hours']:g} h "
            f"(1.3 x the {dist / upd.get('speed_kmh', speed):.0f} h minimum travel time plus waiting room).")
    if req.auto_network and dist > req.max_leg_km:
        spine_max = max(1, (config.ROUTE_MAX_BASES - 2 - len(req.waypoints)) // 3)
        need_leg = dist / (ALONG_FRAC * (spine_max + 1)) * (1.08 if om > math.pi - 0.05 else 1.03)
        if need_leg > req.max_leg_km:
            upd["max_leg_km"] = float(min(math.ceil(need_leg), math.floor(config.ROUTE_MAX_LEG_KM)))
            report["adjustments"].append(
                f"Maximum leg raised from {req.max_leg_km:g} km to {upd['max_leg_km']:g} km so the generated "
                f"network for this {dist:.0f} km traverse fits the {config.ROUTE_MAX_BASES}-waypoint exact-search limit.")
    return req.model_copy(update=upd) if upd else req


def _expand(req, corridors: int):
    """Generate planning waypoints / catalogue candidates; returns the expanded request (may raise RoutingError)."""
    from .routing_models import RouteBaseInput

    rep = dict(generated=False, generator=None, n_generated=0, n_catalog_sites=0, corridors=0,
               along_spacing_km=None, lateral_offset_km=None, notes=[], catalog_site_ids=[])
    wps = list(req.waypoints)
    if req.auto_network:
        gen, info = generate_network(req.start.lat_deg, req.start.lon_deg, req.destination.lat_deg,
                                     req.destination.lon_deg, req.max_leg_km, n_corridors=corridors,
                                     max_nodes=config.ROUTE_MAX_BASES - 2 - len(wps))
        rep.update(generated=True, n_generated=len(gen), corridors=corridors if gen else 0,
                   along_spacing_km=round(info["along_spacing_km"], 3),
                   lateral_offset_km=round(info["lateral_offset_km"], 3) if corridors > 1 else None,
                   generator=(f"Deterministic great-circle corridor generator: central corridor"
                              f"{f' plus {corridors - 1} lateral corridors' if corridors > 1 else ''}, "
                              f"along-track spacing <= {ALONG_FRAC:g} x max leg, lateral offset "
                              f"{LATERAL_FRAC:g} x max leg."))
        rep["notes"].extend(info["notes"])
        wps += [RouteBaseInput(**w) for w in gen]
    if req.include_catalog_sites:
        from .site_catalog import sites_near_corridor
        near = sites_near_corridor(req.start.lat_deg, req.start.lon_deg, req.destination.lat_deg,
                                   req.destination.lon_deg, corridor_km=req.max_leg_km,
                                   limit=max(0, config.ROUTE_MAX_BASES - 2 - len(wps)))
        taken = {w.id for w in wps} | {req.start.id, req.destination.id}
        for site in near:
            sid = ("C_" + site.id.replace("-", "_"))[:32]
            if sid in taken:
                continue
            wps.append(RouteBaseInput(id=sid, label=f"Catalogue site: {site.name}"[:64], lat_deg=site.lat_deg,
                                      lon_deg=site.lon_deg))
            rep["catalog_site_ids"].append(site.id)
        rep["n_catalog_sites"] = len(rep["catalog_site_ids"])
        if near:
            rep["notes"].append("Catalogue sites are included only as candidate positions; they imply no "
                                "infrastructure, power, supplies or communications.")
    return req.model_copy(update={"waypoints": wps}), rep


def prepare_request(req):
    """Expand auto_network / catalogue options into explicit waypoints. Returns (request, network_report).

    Without auto_fit or coarse planning, speed, horizon, leg limit, grid, weights and mode are never changed.
    Coarse planning (explicit) may use a single corridor and a coarser time grid. Auto-fit (explicit) may
    additionally raise horizon, speed and leg length so the destination is reachable within the work limits.
    Every change is reported in network.adjustments / network.approximations.
    """
    from .routing import Context, RoutingError as _RE, build_bases, estimate_and_check, is_start_at_destination, params_from

    report = dict(generated=False, generator=None, n_generated=0, n_user_waypoints=len(req.waypoints),
                  n_catalog_sites=0, corridors=0, along_spacing_km=None, lateral_offset_km=None,
                  notes=[], approximations=[], planning_mode=req.planning_mode, catalog_site_ids=[],
                  adjustments=[], effective={})
    if is_start_at_destination(req):
        report["notes"].append("Start is already at the destination.")
        return req, report
    original = req
    if req.auto_fit:
        req = _fit_physical(req, report)

    flexible = req.auto_fit or req.planning_mode == "coarse"
    corridor_opts = [1] if req.planning_mode == "coarse" else ([3, 1] if req.auto_fit and req.auto_network else [3])
    grid_opts = sorted({float(req.grid_minutes), *[float(g) for g in COARSE_GRID_OPTIONS if g >= req.grid_minutes]}) \
        if flexible else [float(req.grid_minutes)]
    last: Exception | None = None
    for corridors in corridor_opts:
        try:
            expanded, rep = _expand(req, corridors)
        except _RE as exc:
            last = exc
            continue
        for g in grid_opts:
            if g > expanded.horizon_hours * 60:
                break
            trial = expanded.model_copy(update={"grid_minutes": g})
            try:
                estimate_and_check(Context(build_bases(trial.start, trial.waypoints, trial.destination),
                                           params_from(trial), None))
            except _RE as exc:
                last = exc
                if not flexible:
                    raise
                continue
            report.update({k: v for k, v in rep.items() if k != "notes"})
            report["notes"].extend(rep["notes"])
            label = "Auto-fit" if req.auto_fit else "Coarse planning"
            if corridors == 1 and req.auto_network:
                msg = f"{label}: a single central corridor is generated (no lateral alternatives)."
                (report["adjustments"] if req.auto_fit and req.planning_mode != "coarse" else report["approximations"]).append(msg)
            if g != original.grid_minutes:
                report["adjustments" if req.auto_fit else "approximations"].append(
                    f"{label}: time grid coarsened from {original.grid_minutes:g} min to {g:g} min to fit the "
                    "exact-search work limits.")
            report["effective"] = dict(speed_kmh=trial.speed_kmh, horizon_hours=trial.horizon_hours,
                                       max_leg_km=trial.max_leg_km, grid_minutes=trial.grid_minutes,
                                       corridors=corridors if req.auto_network else 0)
            return trial, report
    raise last if last is not None else _RE("no planning configuration fits the work limits")


def preflight(req) -> dict:
    """Pure geometry + work estimate. Never builds an ephemeris table or runs a search."""
    from .routing import (Context, RoutingError as _RE, build_bases, estimate_and_check,
                          is_start_at_destination, params_from)

    a = unit_vector(req.start.lat_deg, req.start.lon_deg)
    b = unit_vector(req.destination.lat_deg, req.destination.lon_deg)
    dist = central_angle(a, b) * R_KM
    out = dict(great_circle_km=round(dist, 3), min_travel_hours=round(dist / req.speed_kmh, 3),
               horizon_hours=req.horizon_hours, within_limits=True, start_at_destination=False,
               binding_constraints=[], suggestions=[], adjustments=[], network=None, work=None,
               coarse_available=False)
    if is_start_at_destination(req):
        out["start_at_destination"] = True
        return out
    try:
        prepared, report = prepare_request(req)
        out["network"] = report
        out["adjustments"] = report.get("adjustments", [])
        ctx = Context(build_bases(prepared.start, prepared.waypoints, prepared.destination),
                      params_from(prepared), None)
        legs, work = estimate_and_check(ctx)
        out["work"] = dict(work, n_bases=len(ctx.bases), n_candidate_legs=len(legs),
                           grid_minutes=prepared.grid_minutes,
                           time_states=len(ctx.bases) * (work["n_steps"] + 1))
    except _RE as exc:
        prepared = req
        out["within_limits"] = False
        out["binding_constraints"].append(f"Work limit: {exc}")
        out["coarse_available"] = req.planning_mode != "coarse"
        if not req.auto_fit:
            out["suggestions"].append("Turn on auto-fit to adjust horizon, speed, leg length and grid as needed "
                                      "(every change is reported).")
        if out["coarse_available"]:
            out["suggestions"].append("Try coarse planning (single corridor, coarser time grid if needed); "
                                      "the result will be labelled approximate.")
    lb = dist / prepared.speed_kmh
    out.update(min_travel_hours=round(lb, 3), horizon_hours=prepared.horizon_hours)
    if lb > prepared.horizon_hours + 1e-9:
        out["binding_constraints"].insert(0, (
            f"Horizon: at {prepared.speed_kmh:g} km/h the {dist:.1f} km great-circle distance needs at least "
            f"{lb:.1f} h, beyond the {prepared.horizon_hours:g} h horizon."))
        fix_h = math.ceil(lb * 1.1)
        out["suggestions"].insert(0, (
            f"Increase speed to at least {dist / prepared.horizon_hours:.2f} km/h"
            + (f" or the horizon to at least {fix_h} h" if fix_h <= config.ROUTE_MAX_HORIZON_HOURS
               else f" (the horizon cannot exceed {config.ROUTE_MAX_HORIZON_HOURS:g} h)")
            + ", or turn on auto-fit."))
    return out
