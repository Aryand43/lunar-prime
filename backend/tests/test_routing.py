"""Route planner tests. Most use deterministic mock ephemerides so expected values are known."""

import itertools
import math

import numpy as np
import pytest
from pydantic import ValidationError

from app import config, kernels
from app.routing import (
    Context, EphemerisTable, Params, RoutingError, Schedule, build_bases, candidate_legs, eph_step_for, evaluate,
    gc_distance_km, integrate_exposure, lat_lon_of, local_search, move_offsets, run_route, search, slerp,
    unit_vector,
)
from app.routing_models import RouteRequest

R = config.MOON_RADIUS_KM
AU = 1.496e8
EARTH_KM = 384_400.0


class FuncProvider:
    """Mock provider: et == seconds after departure; body vectors from callables."""

    mode = "synthetic"

    def __init__(self, sun, earth):
        self.sun, self.earth, self.calls = sun, earth, 0

    def utc_to_et(self, dt):
        return 0.0

    def et_to_utc(self, ets):
        return [f"T+{float(e):.0f}s" for e in np.atleast_1d(ets)]

    def body_vectors(self, body, ets):
        self.calls += 1
        ets = np.atleast_1d(np.asarray(ets, float))
        return np.array([(self.sun if body == "sun" else self.earth)(t) for t in ets])


def const(vec):
    v = np.asarray(vec, float)
    return lambda t: v


LIT_EQ = FuncProvider(const([AU, 0, 0]), const([EARTH_KM, 0, 0]))  # Sun & Earth overhead near (0, 0)
DARK_EQ = FuncProvider(const([-AU, 0, 0]), const([-EARTH_KM, 0, 0]))  # both below the horizon near (0, 0)
SUN_NORTH = FuncProvider(const([0, 0, AU]), const([EARTH_KM, 0, 0]))  # Sun elevation ~= latitude


def base(i, lat, lon, label=None):
    return {"id": i, "label": label or i, "lat_deg": lat, "lon_deg": lon}


def make_req(start, dest, wps, **kw):
    body = dict(start=start, destination=dest, waypoints=wps, departure_utc="2027-02-13T00:00:00Z",
                horizon_hours=200, speed_kmh=10, max_leg_km=120, grid_minutes=30, max_wait_hours=24,
                weights={"distance": 1, "darkness": 0, "earth_invisible": 0}, mode="synthetic")
    body.update(kw)
    return RouteRequest(**body)


def make_ctx(req, provider):
    bases = build_bases(req.start, req.waypoints, req.destination)
    w = req.weights
    p = Params(req.speed_kmh, req.max_leg_km, req.grid_minutes * 60, req.max_wait_hours * 3600,
               req.horizon_hours * 3600, w.distance, w.darkness, w.earth_invisible, req.distance_scale_km,
               req.exposure_scale_hours, eph_step_for(req.grid_minutes * 60))
    ctx = Context(bases, p, None)
    n = math.ceil(p.horizon_s / p.eph_step_s) + 2
    ctx.table = EphemerisTable(provider, 0.0, p.eph_step_s, n)
    return ctx


# ------------------------------------------------------------------------------------- geometry


def test_great_circle_distance_wraparound_coincident_pole():
    assert gc_distance_km(unit_vector(0, 0), unit_vector(0, 90)) == pytest.approx(math.pi * R / 2, rel=1e-12)
    assert gc_distance_km(unit_vector(0, 179.5), unit_vector(0, -179.5)) == pytest.approx(math.radians(1) * R, rel=1e-9)
    assert gc_distance_km(unit_vector(10, 20), unit_vector(10, 20)) == 0.0
    assert gc_distance_km(unit_vector(-90, 0), unit_vector(-90, 123)) == 0.0
    assert gc_distance_km(unit_vector(-89, 0), unit_vector(-90, 77)) == pytest.approx(math.radians(1) * R, rel=1e-9)
    # tiny separations stay accurate (atan2 form)
    assert gc_distance_km(unit_vector(0, 0), unit_vector(0, 1e-7)) == pytest.approx(math.radians(1e-7) * R, rel=1e-6)


def test_pole_is_one_physical_location():
    from app.routing_models import RouteBaseInput as B
    with pytest.raises(RoutingError, match="same physical location"):
        build_bases(B(id="s", label="s", lat_deg=-85, lon_deg=0), [B(id="p2", label="p", lat_deg=-90, lon_deg=45)],
                    B(id="p", label="p", lat_deg=-90, lon_deg=0))
    lat, lon = lat_lon_of(unit_vector(-90, 33))
    assert lat == -90 and lon == 0


def test_near_antipodal_rejected():
    with pytest.raises(RoutingError, match="antipodal"):
        slerp(unit_vector(0, 0), unit_vector(0, 179.99), np.linspace(0, 1, 5))


def test_slerp_stays_on_sphere_with_constant_angular_rate():
    a, b = unit_vector(-86, 20), unit_vector(-89.5, -150)
    pts = slerp(a, b, np.linspace(0, 1, 41))
    assert np.allclose(np.linalg.norm(pts, axis=1), 1.0, atol=1e-14)
    assert np.allclose(pts[0], a) and np.allclose(pts[-1], b)
    steps = [gc_distance_km(pts[i], pts[i + 1]) for i in range(40)]
    assert max(steps) - min(steps) < 1e-9
    assert sum(steps) == pytest.approx(gc_distance_km(a, b), rel=1e-12)


# ----------------------------------------------------------------------------- time & exposure


def test_partial_final_interval_and_elapsed_seconds():
    offs = move_offsets(25 * 60, 10 * 60)
    assert offs.tolist() == [0, 600, 1200, 1500]
    t = offs[None, :]
    ex = integrate_exposure(t, -np.ones_like(t), np.ones_like(t))
    assert ex.dark[0] == 1500 and ex.earth_invisible[0] == 0 and ex.both[0] == 0
    # linear crossing inside an interval
    ex = integrate_exposure(np.array([[0.0, 100.0]]), np.array([[-1.0, 1.0]]), np.array([[1.0, 1.0]]))
    assert ex.dark[0] == pytest.approx(50.0) and ex.both[0] == pytest.approx(50.0)


def test_constant_speed_and_consistent_elapsed_time():
    req = make_req(base("A", 0, 0), base("D", 0, 3), [base("M", 0.3, 1.5)], speed_kmh=7.3)
    ctx = make_ctx(req, LIT_EQ)
    sch = Schedule([0, 1, 2], [1800.0, 600.0], [0.0, 0.0])
    ev = evaluate(ctx, sch)
    assert ev.feasible
    d = ctx.distance(0, 1) + ctx.distance(1, 2)
    assert ev.movement_s == pytest.approx(d / 7.3 * 3600, rel=1e-12)
    assert ev.arrival_s == pytest.approx(ev.movement_s + 2400, rel=1e-12)
    assert sum(s["duration_s"] for s in ev.segments) == pytest.approx(ev.arrival_s)
    for s0, s1 in zip(ev.segments[:-1], ev.segments[1:]):
        assert s1["start_s"] == pytest.approx(s0["end_s"])


def test_grid_alignment_waiting_and_dp_matches_evaluator():
    req = make_req(base("A", 0, 0), base("D", 0, 2.2), [base("M", 0, 1.1)], speed_kmh=5, max_leg_km=40,
                   weights={"distance": 1, "darkness": 1, "earth_invisible": 1})
    ctx = make_ctx(req, SUN_NORTH)
    res = search(ctx, candidate_legs(ctx))
    sch = res.schedule
    assert sch.stops == [0, 1, 2]
    tau = ctx.distance(0, 1) / 5 * 3600
    G = 1800.0
    assert sch.aligns[1] == pytest.approx(math.ceil(tau / G) * G - tau)
    assert sch.waits[1] >= sch.aligns[1]
    ev = evaluate(ctx, sch)
    assert ev.alignment_s == pytest.approx(sch.aligns[1])
    assert ev.cost == pytest.approx(res.cost, rel=1e-9, abs=1e-12)  # DP edge costs == itinerary evaluation


def test_moving_leg_exposure_differs_from_endpoint_only():
    tau = 30.0 / 10 * 3600  # 30 km at 10 km/h

    def sun(t):  # elevation +1 deg at both ends, -1 deg mid-traverse
        e = math.radians(1 - 2 * math.sin(math.pi * min(max(t, 0), tau) / tau))
        return AU * np.array([math.sin(e), 0.0, math.cos(e)])

    prov = FuncProvider(sun, const([EARTH_KM, 0, 0]))
    a_lon = -math.degrees(15 / R)
    req = make_req(base("A", 0, a_lon), base("D", 0, -a_lon), [], grid_minutes=10)
    ctx = make_ctx(req, prov)
    ev = evaluate(ctx, Schedule([0, 1], [0.0], [0.0]), with_trajectory=True)
    assert ctx.distance(0, 1) == pytest.approx(30.0, rel=1e-9)
    sel = ev.trajectory["sun_el"]
    assert sel[0] > 0 and sel[-1] > 0  # endpoint-only evaluation would report no darkness
    assert ev.dark_s == pytest.approx(2 / 3 * tau, rel=0.03)
    assert ev.longest_dark_s == pytest.approx(ev.dark_s, rel=1e-9)


def test_waiting_exposure_counted():
    req = make_req(base("A", 0, 0), base("D", 0, 1), [], weights={"distance": 0, "darkness": 1, "earth_invisible": 0})
    ctx = make_ctx(req, DARK_EQ)
    ev0 = evaluate(ctx, Schedule([0, 1], [0.0], [0.0]))
    ev1 = evaluate(ctx, Schedule([0, 1], [3 * 3600.0], [0.0]))
    assert ev1.dark_s - ev0.dark_s == pytest.approx(3 * 3600, rel=1e-9)
    assert ev1.waiting_s == pytest.approx(3 * 3600)


def test_waiting_limit_enforced_including_alignment():
    req = make_req(base("A", 0, 0), base("D", 0, 2.2), [base("M", 0, 1.1)], max_leg_km=40, speed_kmh=5,
                   max_wait_hours=0.1)
    ctx = make_ctx(req, LIT_EQ)
    assert evaluate(ctx, Schedule([0, 1, 2], [0.0, 0.2 * 3600], [0.0, 0.0])).feasible is False
    tau = ctx.distance(0, 1) / 5 * 3600
    assert math.ceil(tau / 1800) * 1800 - tau > 0.1 * 3600  # alignment alone exceeds the limit
    assert search(ctx, candidate_legs(ctx)).schedule is None
    # The continuous-time baseline (no alignment) is still feasible, so the planner returns it.
    res = run_route(req, LIT_EQ)
    assert res["final"] is not None and res["final"].schedule.stops == [0, 1, 2]
    assert all(w <= 0.1 * 3600 + 1e-6 for w in res["final"].schedule.waits)


# ------------------------------------------------------------------------------------- search


TOY = [base("P", 0.4, 0.8), base("Q", -0.3, 1.2), base("U", 0.1, 2.0), base("V", 0.6, 2.6), base("X", -0.5, 2.4)]


def brute_force(ctx, metric):
    best = None
    wp = list(range(1, len(ctx.bases) - 1))
    for r in range(len(wp) + 1):
        for perm in itertools.permutations(wp, r):
            stops = [ctx.start, *perm, ctx.dest]
            if any(ctx.leg(a, b) is None for a, b in zip(stops[:-1], stops[1:])):
                continue
            v = metric(stops)
            if v is not None and (best is None or v < best):
                best = v
    return best


def test_toy_graph_distance_optimum_matches_brute_force():
    req = make_req(base("A", 0, 0), base("D", 0, 3.4), TOY, max_leg_km=45)
    ctx = make_ctx(req, LIT_EQ)
    res = search(ctx, candidate_legs(ctx))
    best = brute_force(ctx, lambda s: sum(ctx.distance(a, b) for a, b in zip(s[:-1], s[1:])))
    assert res.cost * req.distance_scale_km == pytest.approx(best, rel=1e-9)


def test_toy_graph_time_optimum_matches_brute_force():
    """Constant darkness, darkness-only weight: cost = hours to arrival incl. grid alignment."""
    req = make_req(base("A", 0, 0), base("D", 0, 3.4), TOY, max_leg_km=45, speed_kmh=3,
                   weights={"distance": 0, "darkness": 1, "earth_invisible": 0})
    ctx = make_ctx(req, DARK_EQ)
    res = search(ctx, candidate_legs(ctx))
    G = 1800.0

    def arrival(stops):
        t = 0.0
        for i, (a, b) in enumerate(zip(stops[:-1], stops[1:])):
            tau = ctx.distance(a, b) / 3 * 3600
            t += tau if b == ctx.dest else math.ceil(tau / G - 1e-9) * G
        return t

    best = brute_force(ctx, arrival)
    assert res.cost * req.exposure_scale_hours * 3600 == pytest.approx(best, rel=1e-9)


def test_unreachable_destination_and_max_leg():
    req = make_req(base("A", 0, 0), base("D", 0, 6), [base("M", 0, 1)], max_leg_km=40)
    res = run_route(req, LIT_EQ)
    assert res["final"] is None and "cannot be reached" in res["reason"]
    assert res["direct"]["feasible"] is False and "maximum leg" in res["direct"]["reason"]


def test_horizon_too_short_is_infeasible():
    req = make_req(base("A", 0, 0), base("D", 0, 1), [], speed_kmh=1, horizon_hours=10, max_wait_hours=1)
    res = run_route(req, LIT_EQ)
    assert res["final"] is None and "horizon" in res["reason"]


def test_zero_exposure_weights_give_shortest_distance():
    req = make_req(base("A", 0, 0), base("D", 0, 3.4), TOY, max_leg_km=45, speed_kmh=4)
    res = run_route(req, SUN_NORTH)
    assert res["final"].distance_km == pytest.approx(res["baseline"].distance_km, rel=1e-12)


def test_environment_weights_favour_longer_sunlit_route():
    wps = [base("N", 2.0, 3.0), base("S", -0.5, 3.0)]
    short = run_route(make_req(base("A", 0.2, 0), base("D", 0.2, 6), wps), SUN_NORTH)
    assert short["final"].schedule.stops == [0, 2, 3]  # via S (dark side), shorter
    lit = run_route(make_req(base("A", 0.2, 0), base("D", 0.2, 6), wps,
                             weights={"distance": 1, "darkness": 5, "earth_invisible": 0}), SUN_NORTH)
    assert lit["final"].schedule.stops == [0, 1, 3]  # via N (sunlit), longer
    assert lit["final"].distance_km > short["final"].distance_km
    assert lit["final"].dark_s < short["final"].dark_s


def test_local_search_never_worsens():
    req = make_req(base("A", 0.2, 0), base("D", 0.2, 6), [base("N", 2.0, 3.0), base("S", -0.5, 3.0)],
                   weights={"distance": 1, "darkness": 2, "earth_invisible": 1}, speed_kmh=2)
    ctx = make_ctx(req, SUN_NORTH)
    g = search(ctx, candidate_legs(ctx))
    start = evaluate(ctx, g.schedule).cost
    ev, log, n = local_search(ctx, g.schedule, 500)
    assert ev.cost <= start + 1e-12
    for e in log:
        assert e["cost_after"] < e["cost_before"]
    assert n <= 500


def test_baseline_uses_identical_evaluation():
    req = make_req(base("A", 0.2, 0), base("D", 0.2, 6), [base("N", 2.0, 3.0), base("S", -0.5, 3.0)],
                   weights={"distance": 1, "darkness": 1, "earth_invisible": 1})
    res = run_route(req, SUN_NORTH)
    b = res["baseline"]
    again = evaluate(res["ctx"], Schedule(b.schedule.stops, [0.0] * len(b.schedule.waits), [0.0] * len(b.schedule.waits)))
    assert (b.cost, b.dark_s, b.arrival_s) == (again.cost, again.dark_s, again.arrival_s)


def test_excessive_work_rejected_before_ephemeris():
    prov = FuncProvider(const([AU, 0, 0]), const([EARTH_KM, 0, 0]))
    req = make_req(base("A", 0, 0), base("D", 0, 1), [], grid_minutes=1, horizon_hours=24 * 60, max_wait_hours=1)
    with pytest.raises(RoutingError, match="exceeds the limit"):
        run_route(req, prov)
    assert prov.calls == 0


def test_interpolated_ephemeris_error_is_small(spice_loaded):
    from app.geometry import SpiceProvider, enu_bases, topocentric_az_el_many
    import spiceypy as sp
    prov = SpiceProvider()
    with kernels.SPICE_LOCK:
        et0 = sp.str2et("2027-02-13 00:00 UTC")
        table = EphemerisTable(prov, et0, 600.0, 200)
        t_mid = 300.0 + 600.0 * np.arange(150)
        lat, lon = np.array([-88.6]), np.array([40.0])
        site = np.array([unit_vector(-88.6, 40.0)]) * R
        for body in ("sun", "earth"):
            exact = prov.body_vectors(body, et0 + t_mid)
            _, e1 = topocentric_az_el_many(exact[:, None, :], site, enu_bases(lat, lon))
            _, e2 = topocentric_az_el_many(table.at(body, t_mid)[:, None, :], site, enu_bases(lat, lon))
            assert np.abs(e1 - e2).max() < 1e-3  # degrees


def test_request_validation_models():
    with pytest.raises(ValidationError, match="at least one objective weight"):
        make_req(base("A", 0, 0), base("D", 0, 1), [], weights={"distance": 0, "darkness": 0, "earth_invisible": 0})
    with pytest.raises(ValidationError):
        make_req(base("A", float("nan"), 0), base("D", 0, 1), [])
    with pytest.raises(ValidationError):
        make_req(base("A", 0, 0), base("D", 0, 1), [], speed_kmh=float("inf"))
    with pytest.raises(ValidationError, match="unique"):
        make_req(base("A", 0, 0), base("D", 0, 1), [base("A", 0, 0.5)])
