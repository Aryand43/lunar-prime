"""Turn routing.run_route results into the typed RouteResponse, including the baseline
comparison and a deterministic, number-only explanation."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Optional

import numpy as np

from . import config, kernels
from .geometry import EphemerisProvider
from .models import KernelOut
from .narrative import fmt_duration
from .routing import Evaluation, run_route
from .routing_models import (
    AlternativeOut, BaseOut, ComparisonRow, DiagnosticsOut, NetworkOut, CostBreakdown, ItineraryLegOut, LegOut, LocalSearchOut,
    ObjectiveOut, RouteMetadata, RouteMetrics, RoutePlan, RouteRequest, RouteResponse, SearchOut, SegmentOut,
    StopOut, Trajectory,
)

FORMULA = (
    "cost = w_distance * total_distance_km / distance_scale_km"
    " + w_darkness * total_darkness_hours / exposure_scale_hours"
    " + w_earth_invisible * total_earth_invisible_hours / exposure_scale_hours"
)


def _r(a, nd):
    return np.round(np.asarray(a, dtype=float), nd).tolist()


def _plan(res: dict, ev: Evaluation, provider: EphemerisProvider, with_traj: bool) -> RoutePlan:
    ctx, et0 = res["ctx"], res["et0"]
    B = ctx.bases

    def utc(t: float) -> str:
        return provider.et_to_utc(np.array([et0 + t]))[0]

    segs = []
    for s in ev.segments:
        segs.append(SegmentOut(
            kind=s["kind"], base_id=B[s["base"]].id, to_id=B[s["to"]].id if s["kind"] == "move" else None,
            start_utc=utc(s["start_s"]), end_utc=utc(s["end_s"]), start_elapsed_s=round(s["start_s"], 1),
            duration_s=round(s["duration_s"], 1), alignment_wait_s=round(s["alignment_s"], 1),
            distance_km=round(s["distance_km"], 3), darkness_s=round(s["dark_s"], 1),
            earth_invisible_s=round(s["earth_s"], 1), both_visible_s=round(s["both_s"], 1),
        ))
    legs = [
        ItineraryLegOut(
            from_id=B[s["base"]].id, to_id=B[s["to"]].id, depart_utc=utc(s["start_s"]), arrive_utc=utc(s["end_s"]),
            distance_km=round(s["distance_km"], 3), movement_s=round(s["duration_s"], 1),
            darkness_s=round(s["dark_s"], 1), earth_invisible_s=round(s["earth_s"], 1),
            both_visible_s=round(s["both_s"], 1),
        )
        for s in ev.segments if s["kind"] == "move"
    ]
    # Stops with arrival/departure and dwell.
    sch = ev.schedule
    stops, t = [], 0.0
    move_segs = [s for s in ev.segments if s["kind"] == "move"]
    for i, b in enumerate(sch.stops if not ev.zero else []):
        arrive = None if i == 0 else move_segs[i - 1]["end_s"]
        if i < len(sch.waits):
            dep = move_segs[i]["start_s"]
            stops.append(StopOut(order=i, base_id=B[b].id, arrive_utc=None if arrive is None else utc(arrive),
                                 depart_utc=utc(dep), wait_s=round(sch.waits[i], 1),
                                 alignment_wait_s=round(min(sch.aligns[i], sch.waits[i]), 1)))
        else:
            stops.append(StopOut(order=i, base_id=B[b].id, arrive_utc=utc(arrive), depart_utc=None, wait_s=0.0,
                                 alignment_wait_s=0.0))
    if ev.zero:
        stops = [StopOut(order=0, base_id=B[sch.stops[0]].id, arrive_utc=None, depart_utc=utc(0.0), wait_s=0.0,
                         alignment_wait_s=0.0),
                 StopOut(order=1, base_id=B[sch.stops[1]].id, arrive_utc=utc(0.0), depart_utc=None, wait_s=0.0,
                         alignment_wait_s=0.0)]
    cb = ctx.breakdown(ev.distance_km, ev.dark_s, ev.earth_s)
    metrics = RouteMetrics(
        distance_km=round(ev.distance_km, 3), departure_utc=utc(0.0), arrival_utc=utc(ev.arrival_s),
        elapsed_s=round(ev.arrival_s, 1), movement_s=round(ev.movement_s, 1), waiting_s=round(ev.waiting_s, 1),
        alignment_wait_s=round(ev.alignment_s, 1), discretionary_wait_s=round(ev.waiting_s - ev.alignment_s, 1),
        darkness_s=round(ev.dark_s, 1), earth_invisible_s=round(ev.earth_s, 1), both_visible_s=round(ev.both_s, 1),
        longest_darkness_s=round(ev.longest_dark_s, 1), longest_earth_invisible_s=round(ev.longest_earth_s, 1),
        cost=CostBreakdown(distance=round(cb["distance"], 6), darkness=round(cb["darkness"], 6),
                           earth_invisible=round(cb["earth_invisible"], 6), total=round(ev.cost, 6)),
    )
    traj = None
    if with_traj and ev.trajectory is not None:
        tr = ev.trajectory
        traj = Trajectory(
            time_utc=provider.et_to_utc(et0 + tr["t_rel"]), elapsed_s=_r(tr["t_rel"], 1),
            lat_deg=_r(tr["lat"], 5), lon_deg=_r(tr["lon"], 5),
            sun_az_deg=_r(tr["sun_az"], 3), sun_el_deg=_r(tr["sun_el"], 4),
            earth_az_deg=_r(tr["earth_az"], 3), earth_el_deg=_r(tr["earth_el"], 4),
            status=tr["status"], segment_index=tr["segment"],
            subsolar_lat_deg=_r(tr["subsolar_lat"], 4), subsolar_lon_deg=_r(tr["subsolar_lon"], 4),
            sub_earth_lat_deg=_r(tr["sub_earth_lat"], 4), sub_earth_lon_deg=_r(tr["sub_earth_lon"], 4),
        )
    return RoutePlan(visited=[B[b].id for b in sch.stops], stops=stops, legs=legs, segments=segs, metrics=metrics,
                     trajectory=traj)


ROWS = [
    ("Distance", "km", lambda m: m.distance_km),
    ("Elapsed to arrival", "h", lambda m: m.elapsed_s / 3600),
    ("Movement time", "h", lambda m: m.movement_s / 3600),
    ("Waiting time", "h", lambda m: m.waiting_s / 3600),
    ("Darkness exposure", "h", lambda m: m.darkness_s / 3600),
    ("Earth-invisible exposure", "h", lambda m: m.earth_invisible_s / 3600),
    ("Sun and Earth both visible", "h", lambda m: m.both_visible_s / 3600),
    ("Longest darkness", "h", lambda m: m.longest_darkness_s / 3600),
    ("Longest Earth-invisible", "h", lambda m: m.longest_earth_invisible_s / 3600),
    ("Objective cost", "–", lambda m: m.cost.total),
]
HIGHER_BETTER = {"Sun and Earth both visible"}


def _comparison(opt: Optional[RoutePlan], base: Optional[RoutePlan]) -> list[ComparisonRow]:
    rows = []
    for name, unit, f in ROWS:
        o = f(opt.metrics) if opt else None
        b = f(base.metrics) if base else None
        diff = pct = None
        if o is not None and b is not None:
            diff = round(o - b, 6)
            pct = round(100.0 * (o - b) / b, 3) if abs(b) > 1e-12 else None
        rows.append(ComparisonRow(metric=name, unit=unit, optimized=None if o is None else round(o, 6),
                                  baseline=None if b is None else round(b, 6), difference=diff,
                                  percent_change=pct, lower_is_better=name not in HIGHER_BETTER))
    return rows


def _explain(status, reason, opt: Optional[RoutePlan], base: Optional[RoutePlan], direct: AlternativeOut,
             res: dict) -> list[str]:
    if status == "infeasible":
        return [reason or "No feasible route within these constraints."]
    if res.get("zero"):
        return ["The start is already at the destination: a zero-distance, zero-duration itinerary."]
    m = opt.metrics
    out = []
    inter = [v for v in opt.visited[1:-1]]
    out.append(
        f"The selected route visits {len(inter)} intermediate base{'s' if len(inter) != 1 else ''}"
        f"{' (' + ', '.join(inter) + ')' if inter else ''}, covering {m.distance_km:.1f} km in "
        f"{fmt_duration(m.elapsed_s)} ({fmt_duration(m.movement_s)} moving, {fmt_duration(m.waiting_s)} waiting)."
    )
    out.append(
        f"Along the actual track it spends {fmt_duration(m.darkness_s)} with the Sun centre at or below the ideal "
        f"horizon and {fmt_duration(m.earth_invisible_s)} with Earth's centre at or below it; the longest continuous "
        f"darkness is {fmt_duration(m.longest_darkness_s)}."
    )
    if base is not None:
        b = base.metrics
        same = opt.visited == base.visited and abs(m.elapsed_s - b.elapsed_s) < 1
        if same:
            out.append("The selected route is identical to the shortest-distance network route under these weights.")
        else:
            dd = m.distance_km - b.distance_km
            parts = [f"{abs(dd):.1f} km {'longer' if dd > 0 else 'shorter'}" if abs(dd) >= 0.05 else "the same distance"]
            for label, o, bb in (("darkness", m.darkness_s, b.darkness_s),
                                 ("Earth-invisible time", m.earth_invisible_s, b.earth_invisible_s)):
                d = o - bb
                if abs(d) >= 60:
                    parts.append(f"{fmt_duration(abs(d))} {'more' if d > 0 else 'less'} {label}")
            out.append(
                f"Compared with the shortest-distance network route ({' → '.join(base.visited)}), it is "
                + ", ".join(parts)
                + f"; objective cost {m.cost.total:.3f} vs {b.cost.total:.3f}."
            )
    else:
        out.append("No shortest-distance baseline is available under these constraints.")
    if not direct.feasible and direct.reason:
        out.append(direct.reason)
    if m.alignment_wait_s > 0:
        out.append(f"{fmt_duration(m.alignment_wait_s)} of the waiting is grid-alignment waiting from the "
                   f"{res['ctx'].p.grid_s / 60:g}-min time grid.")
    return out


def build_response(req: RouteRequest, provider: EphemerisProvider) -> RouteResponse:
    coverage = None
    if provider.mode == "spice":
        st = kernels.STATUS
        coverage = (st.coverage_start_et, st.coverage_end_et, st.coverage_start_utc, st.coverage_end_utc)
    from .route_network import COARSE_GRID_OPTIONS, prepare_request
    from .routing import RoutingError
    auto_fit = req.auto_fit
    req, net = prepare_request(req)  # pure geometry; may raise RoutingError (422) before any ephemeris work
    while True:
        try:
            res = run_route(req, provider, coverage)
            break
        except RoutingError as exc:
            # The search's label count cannot be predicted exactly beforehand. With auto-fit only, retry on the
            # next coarser time grid and report it; otherwise the limit error is returned as before.
            nxt = [g for g in COARSE_GRID_OPTIONS if g > req.grid_minutes and g <= req.horizon_hours * 60]
            if not (auto_fit and "labels" in str(exc) and nxt):
                raise
            net["adjustments"].append(
                f"Auto-fit: time grid coarsened from {req.grid_minutes:g} min to {nxt[0]:g} min because the exact "
                f"search exceeded its {config.ROUTE_MAX_LABELS:,}-label limit.")
            req = req.model_copy(update={"grid_minutes": float(nxt[0])})
            net.setdefault("effective", {})["grid_minutes"] = req.grid_minutes
    ctx = res["ctx"]
    final, baseline_ev = res["final"], res["baseline"]

    route = _plan(res, final, provider, True) if final is not None else None
    base_plan = _plan(res, baseline_ev, provider, False) if baseline_ev is not None and baseline_ev.feasible else None
    base_path_d = baseline_ev.distance_km if baseline_ev is not None else 0.0
    baseline = AlternativeOut(
        name="Shortest-distance network route", feasible=base_plan is not None,
        reason=None if base_plan is not None else (
            baseline_ev.reason if baseline_ev is not None else "destination unreachable through the candidate network"),
        distance_km=round(base_path_d, 3), plan=base_plan,
    )
    d = res["direct"]
    direct = AlternativeOut(
        name="Direct great circle", feasible=bool(d["feasible"]), reason=d["reason"],
        distance_km=round(d["distance_km"], 3),
        plan=_plan(res, d["evaluation"], provider, False) if d["evaluation"] is not None else None,
    )
    status = "feasible" if route is not None else "infeasible"

    if provider.mode == "spice":
        provenance = ("Sun/Earth geometry from NASA/JPL NAIF SPICE (CSPICE via SpiceyPy) using the kernels listed; "
                      "route on an ideal sphere. Conceptual planning aid, not mission data.")
        kl = [KernelOut(name=k.name, kind=k.kind, purpose=k.purpose, source_url=k.source_url, sha256=k.sha256)
              for k in kernels.STATUS.kernels]
        toolkit = kernels.STATUS.toolkit_version
    else:
        provenance = ("SYNTHETIC DEMO DATA - crude analytic Sun/Earth model for UI development only. "
                      "Not computed with SPICE and not NASA data; do not use for analysis.")
        kl, toolkit = [], None

    g, ls = res["graph"], res["ls"]
    p = ctx.p
    search = SearchOut(
        method=("Exact label-setting dynamic programming over a time-expanded graph (state = base, time index, "
                "dwell used at the current visit; Pareto labels on cost and dwell), followed by a bounded "
                "continuous-time local-improvement pass."),
        optimality_scope=(
            f"Graph result is optimal only over departures on the {p.grid_s / 60:g}-min grid, the "
            f"{len(ctx.bases)}-base candidate network, legs <= {p.max_leg_km:g} km, and this sampled exposure "
            "model. The final route is locally improved in continuous time; it is not a globally optimal "
            "continuous route."),
        grid_minutes=p.grid_s / 60, sampling_minutes=round(p.eph_step_s / 60, 6), n_time_steps=g.n_steps,
        n_bases=len(ctx.bases), n_candidate_legs=g.n_legs, n_states_expanded=g.n_states, n_labels=g.n_labels,
        n_edges_relaxed=g.n_edges, estimated_sample_evaluations=res["work"]["estimated_sample_evals"],
        ephemeris_epochs=res["work"]["n_ephemeris_epochs"],
        graph_status="feasible" if g.schedule is not None else "infeasible",
        graph_cost=None if g.schedule is None else round(g.cost, 6),
        local_search=LocalSearchOut(**ls), compute_time_ms=round(res["compute_ms"], 1),
    )
    conventions = dict(config.CONVENTIONS)
    conventions["route_geometry"] = (
        f"Great-circle legs (SLERP) on a sphere of radius {config.MOON_RADIUS_KM} km in MOON_ME; distance = R * "
        "atan2(|a x b|, a . b). Poles map to a single point regardless of longitude.")
    conventions["route_exposure"] = (
        f"Sun/Earth elevation evaluated at the actual position and time every {p.eph_step_s / 60:g} min along each "
        "leg and wait (plus the exact partial final sample); durations integrated over elapsed seconds with linear "
        "interpolation of elevation crossings. Body vectors between exact ephemeris epochs are linearly interpolated.")
    conventions["route_time"] = (
        f"Movement time = distance / speed. Departures in the graph search are on the {p.grid_s / 60:g}-min grid; "
        "arrival at an intermediate base is rounded up to the next grid time and the remainder is modelled as "
        "alignment waiting at that base (counted in exposure and in the waiting limit). Arrival at the destination "
        "ends the journey at the exact arrival time.")

    return RouteResponse(
        status=status,
        reason=res["reason"],
        bases=[BaseOut(id=b.id, label=b.label, lat_deg=b.lat, lon_deg=b.lon, role=b.role, kind=_kind(b.label))
               for b in ctx.bases],
        candidate_legs=[LegOut(from_id=ctx.bases[leg.a].id, to_id=ctx.bases[leg.b].id, distance_km=round(leg.dist_km, 3))
                        for leg in res["legs"]],
        route=route,
        baseline=baseline,
        direct=direct,
        comparison=_comparison(route, base_plan),
        explanation=_explain(status, res["reason"], route, base_plan, direct, res),
        objective=ObjectiveOut(formula=FORMULA, weights=req.weights, distance_scale_km=req.distance_scale_km,
                               exposure_scale_hours=req.exposure_scale_hours),
        search=search,
        metadata=RouteMetadata(
            mode=provider.mode, provenance=provenance, disclaimer=config.ROUTE_DISCLAIMER,
            computed_at_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            conventions=conventions, limitations=config.ROUTE_LIMITATIONS, kernels=kl, toolkit_version=toolkit,
        ),
        network=NetworkOut(**net),
        diagnostics=_diagnostics(res, status),
    )


def _kind(label: str) -> str:
    if label.startswith("Planning waypoint"):
        return "planning"
    if label.startswith("Catalogue site:"):
        return "catalog"
    return "user"


def _diagnostics(res: dict, status: str) -> DiagnosticsOut:
    ctx = res["ctx"]
    p = ctx.p
    gc = ctx.distance(ctx.start, ctx.dest)
    lb = gc / p.speed_kmh
    binding = suggestion = None
    if status == "infeasible":
        reason = res["reason"] or ""
        if lb > p.horizon_s / 3600 + 1e-9:
            binding = "horizon"
            suggestion = (f"Increase speed to at least {gc / (p.horizon_s / 3600):.2f} km/h, or the horizon to at least "
                          f"{min(config.ROUTE_MAX_HORIZON_HOURS, math.ceil(lb * 1.1)):g} h.")
        elif "cannot be reached" in reason:
            binding = "max_leg_km"
            suggestion = ("Enable the automatic planning network, add waypoints, or increase the maximum leg "
                          f"above {p.max_leg_km:g} km.")
        elif "shortest network route" in reason:
            binding = "horizon"
            suggestion = "Increase the horizon or speed; the network detour exceeds the time available."
        else:
            binding = "max_wait_hours"
            suggestion = (f"Increase the per-stop waiting limit above {p.max_wait_s / 3600:g} h or use a finer "
                          "time grid so grid-alignment waits fit.")
    return DiagnosticsOut(great_circle_km=round(gc, 3), min_travel_hours=round(lb, 3),
                          horizon_hours=p.horizon_s / 3600, binding_constraint=binding, suggestion=suggestion)
