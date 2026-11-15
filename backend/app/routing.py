"""South Pole Route Planner: conceptual time-dependent routing on a spherical Moon.

Pipeline
  1. Candidate network: directed great-circle legs between bases no longer than max_leg_km.
  2. Ephemeris table: exact Moon-centred Sun/Earth vectors (MOON_ME, LT+S) from the provider at a
     fixed step <= 10 min covering the horizon. Off-table instants use linear interpolation of the
     vectors between exact epochs (bounded error, see tests).
  3. Exposure: Sun/Earth elevation evaluated at the *actual* position and time along every moving
     leg and wait, integrated over elapsed seconds with linear crossing interpolation.
  4. Search: exact label-setting dynamic programming over the time-expanded graph
     (base, time index, dwell used at this visit).
  5. Local refinement: remove / replace / shift moves evaluated in continuous time (departures at
     the fine sampling step, no grid alignment), accepting strict improvements only.
  6. Baselines: shortest-distance network route and direct great circle, evaluated identically.

Everything here is pure NumPy once the ephemeris table is built; the only provider calls happen
in EphemerisTable.__init__ and in UTC conversion, and the caller holds SPICE_LOCK around run_route.
"""

from __future__ import annotations

import heapq
import math
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from . import config
from .geometry import EphemerisProvider, enu_bases, topocentric_az_el_many

R_KM = config.MOON_RADIUS_KM
BODIES = ("sun", "earth")
EPS_T = 1e-6  # seconds


class RoutingError(ValueError):
    """User-correctable problem (malformed request or computational limit): HTTP 422."""


# --------------------------------------------------------------------------------------------
# Spherical geometry
# --------------------------------------------------------------------------------------------


def unit_vector(lat_deg: float, lon_deg: float) -> np.ndarray:
    """Moon-fixed unit vector; the poles map to exactly (0, 0, +/-1) regardless of longitude."""
    if abs(lat_deg) >= 90.0:
        return np.array([0.0, 0.0, math.copysign(1.0, lat_deg)])
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    return np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])


def lat_lon_of(u: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Planetocentric lat / east lon (deg) of unit vectors (..., 3). Longitude is 0 at the poles."""
    u = np.asarray(u, float)
    h = np.hypot(u[..., 0], u[..., 1])
    lat = np.degrees(np.arctan2(u[..., 2], h))
    lon = np.where(h > 1e-12, np.degrees(np.arctan2(u[..., 1], u[..., 0])), 0.0)
    return lat, lon


def central_angle(a: np.ndarray, b: np.ndarray) -> float:
    """Angle between unit vectors, robust for tiny and large separations (atan2 form)."""
    return float(math.atan2(np.linalg.norm(np.cross(a, b)), float(np.dot(a, b))))


def gc_distance_km(a: np.ndarray, b: np.ndarray) -> float:
    return R_KM * central_angle(a, b)


def slerp(a: np.ndarray, b: np.ndarray, f: np.ndarray) -> np.ndarray:
    """Points at fractions f along the minor great-circle arc a -> b, renormalised to the sphere."""
    f = np.asarray(f, float)
    om = central_angle(a, b)
    if om < 1e-12:
        return np.repeat(a[None, :], len(f), axis=0)
    if om > math.pi - config.ROUTE_ANTIPODAL_MARGIN_RAD:
        raise RoutingError(
            "Near-antipodal leg: the endpoints are almost opposite each other, so the great circle "
            "between them is not unique. Add an intermediate waypoint."
        )
    s = math.sin(om)
    p = (np.sin((1.0 - f) * om) / s)[:, None] * a + (np.sin(f * om) / s)[:, None] * b
    return p / np.linalg.norm(p, axis=1, keepdims=True)


# --------------------------------------------------------------------------------------------
# Sampling and exposure
# --------------------------------------------------------------------------------------------


def move_offsets(tau_s: float, step_s: float) -> np.ndarray:
    """Sample offsets for a moving leg: 0, step, 2*step, ... and the exact (partial) end tau."""
    n = max(1, math.ceil(tau_s / step_s - 1e-9))
    offs = step_s * np.arange(n, dtype=float)
    return np.append(offs, tau_s)


def wait_times(a: float, b: float, step_s: float) -> np.ndarray:
    """Sample times for a stationary interval [a, b]: endpoints plus every table epoch strictly inside."""
    k_lo = math.floor(a / step_s + 1e-6) + 1
    k_hi = math.ceil(b / step_s - 1e-6) - 1
    inner = step_s * np.arange(k_lo, k_hi + 1, dtype=float) if k_hi >= k_lo else np.empty(0)
    return np.concatenate([[a], inner, [b]])


class EphemerisTable:
    """Exact provider vectors at et0 + i*step; linear interpolation between them."""

    def __init__(self, provider: EphemerisProvider, et0: float, step_s: float, n: int):
        self.et0, self.step, self.n = et0, step_s, n
        ets = et0 + step_s * np.arange(n, dtype=float)
        self.vec = {b: np.asarray(provider.body_vectors(b, ets), float) for b in BODIES}

    def at(self, body: str, t_rel: np.ndarray) -> np.ndarray:
        x = np.asarray(t_rel, float) / self.step
        if x.size and (x.min() < -1e-6 or x.max() > self.n - 1 + 1e-6):
            raise RoutingError("internal: time outside ephemeris table")
        i = np.clip(np.floor(x).astype(int), 0, self.n - 2)
        f = (x - i)[..., None]
        v = self.vec[body]
        return v[i] * (1.0 - f) + v[i + 1] * f


def _positive_fracs(e0: np.ndarray, e1: np.ndarray):
    """Fractions [lo, hi] of a linear segment where elevation > 0 (lo == hi when none)."""
    both = (e0 > 0) & (e1 > 0)
    rising = (e0 <= 0) & (e1 > 0)
    setting = (e0 > 0) & (e1 <= 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        cross_up = np.where(rising, -e0 / (e1 - e0), 0.0)
        cross_dn = np.where(setting, e0 / (e0 - e1), 0.0)
    lo = np.where(rising, cross_up, 0.0)
    hi = np.where(both, 1.0, np.where(rising, 1.0, np.where(setting, cross_dn, 0.0)))
    return lo, hi


@dataclass
class Exposure:
    duration: np.ndarray
    dark: np.ndarray
    earth_invisible: np.ndarray
    both: np.ndarray


def integrate_exposure(times: np.ndarray, sun_el: np.ndarray, earth_el: np.ndarray) -> Exposure:
    """Integrate (K, M) sampled elevations over real elapsed seconds (rows are independent)."""
    dt = np.diff(times, axis=-1)
    s_lo, s_hi = _positive_fracs(sun_el[..., :-1], sun_el[..., 1:])
    e_lo, e_hi = _positive_fracs(earth_el[..., :-1], earth_el[..., 1:])
    sun_vis = (s_hi - s_lo) * dt
    earth_vis = (e_hi - e_lo) * dt
    both = np.clip(np.minimum(s_hi, e_hi) - np.maximum(s_lo, e_lo), 0.0, None) * dt
    total = dt.sum(axis=-1)
    return Exposure(total, total - sun_vis.sum(-1), total - earth_vis.sum(-1), both.sum(-1))


def longest_nonpositive_run(times: np.ndarray, el: np.ndarray) -> float:
    """Longest continuous time with elevation <= 0 along a sequence (linear interpolation)."""
    if len(times) < 2:
        return 0.0
    dt = np.diff(times)
    lo, hi = _positive_fracs(el[:-1], el[1:])
    best = run = 0.0
    for d, a, b in zip(dt, lo, hi):
        if b - a <= 0:  # whole interval non-positive
            run += d
            continue
        run += a * d  # non-positive head
        best = max(best, run)
        run = (1.0 - b) * d  # non-positive tail starts a new run
    return float(max(best, run))


# --------------------------------------------------------------------------------------------
# Problem setup
# --------------------------------------------------------------------------------------------


@dataclass
class Base:
    idx: int
    id: str
    label: str
    lat: float
    lon: float
    role: str  # start | waypoint | destination
    u: np.ndarray = field(repr=False)

    @property
    def site_km(self) -> np.ndarray:
        return self.u * R_KM


@dataclass
class Leg:
    a: int
    b: int
    dist_km: float
    tau_s: float
    offsets: np.ndarray = field(repr=False)
    pos_u: np.ndarray = field(repr=False)
    basis: np.ndarray = field(repr=False)


@dataclass
class Params:
    speed_kmh: float
    max_leg_km: float
    grid_s: float
    max_wait_s: float
    horizon_s: float
    w_dist: float
    w_dark: float
    w_earth: float
    dist_scale_km: float
    exp_scale_h: float
    eph_step_s: float


def eph_step_for(grid_s: float) -> float:
    """Largest step <= 10 min that divides the grid step exactly."""
    m = math.ceil(grid_s / (config.ROUTE_EPHEMERIS_STEP_MAX_MIN * 60.0) - 1e-9)
    return grid_s / max(1, m)


class Context:
    def __init__(self, bases: list[Base], p: Params, table: Optional[EphemerisTable]):
        self.bases, self.p, self.table = bases, p, table
        self.start = next(b.idx for b in bases if b.role == "start")
        self.dest = next(b.idx for b in bases if b.role == "destination")
        self._legs: dict[tuple[int, int], Optional[Leg]] = {}
        self._base_basis = enu_bases(np.array([b.lat for b in bases]), np.array([b.lon for b in bases]))

    def distance(self, a: int, b: int) -> float:
        return gc_distance_km(self.bases[a].u, self.bases[b].u)

    def leg(self, a: int, b: int) -> Optional[Leg]:
        """Leg geometry (cached); None when it exceeds the leg limit."""
        key = (a, b)
        if key not in self._legs:
            d = self.distance(a, b)
            if a == b or d > self.p.max_leg_km + 1e-9 or d < config.ROUTE_COINCIDENT_KM:
                self._legs[key] = None
            else:
                tau = d / self.p.speed_kmh * 3600.0
                offs = move_offsets(tau, self.p.eph_step_s)
                pos = slerp(self.bases[a].u, self.bases[b].u, offs / tau)
                lat, lon = lat_lon_of(pos)
                self._legs[key] = Leg(a, b, d, tau, offs, pos, enu_bases(lat, lon))
        return self._legs[key]

    def cost(self, dist_km, dark_s, earth_s):
        p = self.p
        return (
            p.w_dist * dist_km / p.dist_scale_km
            + p.w_dark * (dark_s / 3600.0) / p.exp_scale_h
            + p.w_earth * (earth_s / 3600.0) / p.exp_scale_h
        )

    def breakdown(self, dist_km, dark_s, earth_s) -> dict:
        p = self.p
        return {
            "distance": p.w_dist * dist_km / p.dist_scale_km,
            "darkness": p.w_dark * (dark_s / 3600.0) / p.exp_scale_h,
            "earth_invisible": p.w_earth * (earth_s / 3600.0) / p.exp_scale_h,
        }

    # -- exposure of a batch of segments sharing relative sampling ---------------------------
    def elevations(self, t_rel: np.ndarray, pos_u: np.ndarray, basis: np.ndarray):
        site = pos_u * R_KM
        out = {}
        for body in BODIES:
            vec = self.table.at(body, t_rel)
            out[body] = topocentric_az_el_many(vec, site, basis)
        return out

    def batch_exposure(self, t_rel: np.ndarray, pos_u: np.ndarray, basis: np.ndarray) -> Exposure:
        el = self.elevations(t_rel, pos_u, basis)
        return integrate_exposure(t_rel, el["sun"][1], el["earth"][1])

    def base_geom(self, b: int, m: int):
        return np.repeat(self.bases[b].u[None], m, axis=0), np.repeat(self._base_basis[b][None], m, axis=0)


# --------------------------------------------------------------------------------------------
# Itinerary evaluation (single source of truth for costs and metrics)
# --------------------------------------------------------------------------------------------


@dataclass
class Schedule:
    stops: list[int]
    waits: list[float]  # dwell before departing stops[i], len = len(stops) - 1
    aligns: list[float]  # part of waits[i] that is grid-alignment waiting (0 for continuous-time schedules)

    def key(self):
        return tuple(self.stops), tuple(round(w, 3) for w in self.waits)


@dataclass
class Evaluation:
    feasible: bool
    reason: Optional[str]
    schedule: Schedule
    cost: float = math.inf
    arrival_s: float = math.inf
    distance_km: float = 0.0
    movement_s: float = 0.0
    waiting_s: float = 0.0
    alignment_s: float = 0.0
    dark_s: float = 0.0
    earth_s: float = 0.0
    both_s: float = 0.0
    longest_dark_s: float = 0.0
    longest_earth_s: float = 0.0
    segments: list[dict] = field(default_factory=list)
    trajectory: Optional[dict] = None
    zero: bool = False


def evaluate(ctx: Context, sch: Schedule, with_trajectory: bool = False) -> Evaluation:
    p = ctx.p
    ev = Evaluation(False, None, sch)
    stops = sch.stops
    if len(stops) < 2 or stops[0] != ctx.start or stops[-1] != ctx.dest:
        ev.reason = "route must run from the start to the destination"
        return ev
    if len(sch.waits) != len(stops) - 1:
        ev.reason = "internal: waits/stops length mismatch"
        return ev
    for w in sch.waits:
        if w < -EPS_T or w > p.max_wait_s + EPS_T:
            ev.reason = f"waiting {w / 3600:.2f} h exceeds the {p.max_wait_s / 3600:.2f} h limit"
            return ev
    legs = []
    for a, b in zip(stops[:-1], stops[1:]):
        leg = ctx.leg(a, b)
        if leg is None:
            ev.reason = (f"leg {ctx.bases[a].id} -> {ctx.bases[b].id} ({ctx.distance(a, b):.1f} km) "
                         f"exceeds the {p.max_leg_km:.1f} km leg limit")
            return ev
        legs.append(leg)
    arrival = sum(sch.waits) + sum(leg.tau_s for leg in legs)
    if arrival > p.horizon_s + EPS_T:
        ev.reason = f"arrives {arrival / 3600:.1f} h after departure, beyond the {p.horizon_s / 3600:.1f} h horizon"
        return ev

    t = 0.0
    all_t, all_sun, all_earth, traj_parts = [], [], [], []
    for i, leg in enumerate(legs):
        a = stops[i]
        w = sch.waits[i]
        if w > EPS_T:
            times = wait_times(t, t + w, p.eph_step_s)
            pos, basis = ctx.base_geom(a, len(times))
            el = ctx.elevations(times[None], pos, basis)
            ex = integrate_exposure(times[None], el["sun"][1], el["earth"][1])
            align = min(sch.aligns[i], w)
            ev.segments.append(dict(kind="wait", base=a, start_s=t, end_s=t + w, duration_s=w, alignment_s=align,
                                    distance_km=0.0, dark_s=float(ex.dark[0]), earth_s=float(ex.earth_invisible[0]),
                                    both_s=float(ex.both[0])))
            ev.alignment_s += align
            all_t.append(times); all_sun.append(el["sun"][1][0]); all_earth.append(el["earth"][1][0])
            if with_trajectory:
                traj_parts.append((times, pos, el, "wait", len(ev.segments) - 1))
            t += w
        times = t + leg.offsets
        el = ctx.elevations(times[None], leg.pos_u, leg.basis)
        ex = integrate_exposure(times[None], el["sun"][1], el["earth"][1])
        ev.segments.append(dict(kind="move", base=leg.a, to=leg.b, start_s=t, end_s=t + leg.tau_s,
                                duration_s=leg.tau_s, alignment_s=0.0, distance_km=leg.dist_km,
                                dark_s=float(ex.dark[0]), earth_s=float(ex.earth_invisible[0]),
                                both_s=float(ex.both[0])))
        all_t.append(times); all_sun.append(el["sun"][1][0]); all_earth.append(el["earth"][1][0])
        if with_trajectory:
            traj_parts.append((times, leg.pos_u, el, "move", len(ev.segments) - 1))
        t += leg.tau_s

    ev.feasible = True
    ev.arrival_s = t
    for s in ev.segments:
        ev.distance_km += s["distance_km"]
        ev.dark_s += s["dark_s"]
        ev.earth_s += s["earth_s"]
        ev.both_s += s["both_s"]
        if s["kind"] == "move":
            ev.movement_s += s["duration_s"]
        else:
            ev.waiting_s += s["duration_s"]
    tt, ss, ee = np.concatenate(all_t), np.concatenate(all_sun), np.concatenate(all_earth)
    ev.longest_dark_s = longest_nonpositive_run(tt, ss)
    ev.longest_earth_s = longest_nonpositive_run(tt, ee)
    ev.cost = ctx.cost(ev.distance_km, ev.dark_s, ev.earth_s)
    if with_trajectory:
        ev.trajectory = _assemble_trajectory(ctx, traj_parts)
    return ev


def _assemble_trajectory(ctx: Context, parts) -> dict:
    t, lat, lon, saz, sel, eaz, eel, status, seg = [], [], [], [], [], [], [], [], []
    for times, pos, el, kind, si in parts:
        la, lo = lat_lon_of(pos)
        start = 1 if t and abs(times[0] - t[-1]) < 1e-6 else 0  # drop duplicated boundary sample
        sl = slice(start, None)
        t.extend(times[sl]); lat.extend(la[sl]); lon.extend(lo[sl])
        saz.extend(el["sun"][0][0][sl]); sel.extend(el["sun"][1][0][sl])
        eaz.extend(el["earth"][0][0][sl]); eel.extend(el["earth"][1][0][sl])
        status.extend([kind] * (len(times) - start)); seg.extend([si] * (len(times) - start))
    t_arr = np.array(t)
    sun_v = ctx.table.at("sun", t_arr)
    earth_v = ctx.table.at("earth", t_arr)
    ss_lat, ss_lon = lat_lon_of(sun_v / np.linalg.norm(sun_v, axis=1, keepdims=True))
    se_lat, se_lon = lat_lon_of(earth_v / np.linalg.norm(earth_v, axis=1, keepdims=True))
    return dict(t_rel=t_arr, lat=np.array(lat), lon=np.array(lon), sun_az=np.array(saz), sun_el=np.array(sel),
                earth_az=np.array(eaz), earth_el=np.array(eel), status=status, segment=seg,
                subsolar_lat=ss_lat, subsolar_lon=ss_lon, sub_earth_lat=se_lat, sub_earth_lon=se_lon)


# --------------------------------------------------------------------------------------------
# Exact search over the time-expanded graph
# --------------------------------------------------------------------------------------------


@dataclass
class SearchResult:
    schedule: Optional[Schedule]
    cost: float
    n_steps: int
    n_states: int
    n_labels: int
    n_edges: int
    n_legs: int


def candidate_legs(ctx: Context) -> list[Leg]:
    legs = []
    for a in range(len(ctx.bases)):
        if a == ctx.dest:
            continue  # the journey ends on arrival
        for b in range(len(ctx.bases)):
            if b == a or b == ctx.start:
                continue
            leg = ctx.leg(a, b)
            if leg is not None:
                legs.append(leg)
    return legs


def search(ctx: Context, legs: list[Leg]) -> SearchResult:
    p = ctx.p
    G = p.grid_s
    N = int(math.floor(p.horizon_s / G + 1e-9))
    B = len(ctx.bases)
    can_wait = p.max_wait_s + EPS_T >= G

    # Wait-edge costs at every base and grid step (exposure at the fixed base coordinates).
    wait_cost = None
    if can_wait and N > 0:
        offs = wait_times(0.0, G, p.eph_step_s)
        t_rel = (G * np.arange(N))[:, None] + offs[None, :]
        wait_cost = np.zeros((B, N))
        for b in range(B):
            if b == ctx.dest:
                continue
            pos, basis = ctx.base_geom(b, len(offs))
            ex = ctx.batch_exposure(t_rel, pos, basis)
            wait_cost[b] = ctx.cost(0.0, ex.dark, ex.earth_invisible)

    # Travel-edge costs for every feasible departure index (movement + grid-alignment dwell).
    leg_cost, leg_steps, leg_align, out = [], [], [], defaultdict(list)
    for li, leg in enumerate(legs):
        n = max(1, math.ceil(leg.tau_s / G - 1e-9))
        align = n * G - leg.tau_s
        if align < 1e-6:
            align = 0.0
        if leg.b == ctx.dest:
            k_max = int(math.floor((p.horizon_s - leg.tau_s) / G + 1e-9))
        else:
            k_max = N - n
        k_max = min(k_max, N)
        if k_max < 0 or (leg.b != ctx.dest and align > p.max_wait_s + EPS_T):
            leg_cost.append(None); leg_steps.append(n); leg_align.append(align)
            continue
        ks = G * np.arange(k_max + 1)
        mv = ctx.batch_exposure(ks[:, None] + leg.offsets[None, :], leg.pos_u, leg.basis)
        dark, earth = mv.dark.copy(), mv.earth_invisible.copy()
        if leg.b != ctx.dest and align > 0:
            offs = wait_times(leg.tau_s, n * G, p.eph_step_s)
            pos, basis = ctx.base_geom(leg.b, len(offs))
            al = ctx.batch_exposure(ks[:, None] + offs[None, :], pos, basis)
            dark += al.dark
            earth += al.earth_invisible
        leg_cost.append(ctx.cost(leg.dist_km, dark, earth))
        leg_steps.append(n); leg_align.append(align)
        out[leg.a].append(li)

    # Label-setting DP in increasing time. Labels: cost, dwell used at current visit, parent, edge, seq.
    L_cost, L_wait, L_parent, L_edge, L_seq = [], [], [], [], []
    buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    terminals: list[tuple] = []
    n_edges = 0

    def add(node, cost, wait, parent, edge, seq):
        if len(L_cost) >= config.ROUTE_MAX_LABELS:
            raise RoutingError(
                f"route search exceeded {config.ROUTE_MAX_LABELS:,} labels; use fewer waypoints, a coarser "
                "time grid, a shorter horizon or a smaller waiting limit"
            )
        L_cost.append(cost); L_wait.append(wait); L_parent.append(parent); L_edge.append(edge); L_seq.append(seq)
        lid = len(L_cost) - 1
        if node is not None:
            buckets[node].append(lid)
        return lid

    add((ctx.start, 0), 0.0, 0.0, -1, None, (ctx.start,))
    n_states = 0
    for k in range(N + 1):
        for b in range(B):
            ids = buckets.pop((b, k), None)
            if not ids:
                continue
            n_states += 1
            ids.sort(key=lambda i: (L_cost[i], L_wait[i], L_seq[i]))
            kept, best_wait = [], math.inf
            for i in ids:  # Pareto front on (cost, dwell used)
                if L_wait[i] < best_wait - 1e-9:
                    kept.append(i)
                    best_wait = L_wait[i]
            for lid in kept:
                c, w, seq = L_cost[lid], L_wait[lid], L_seq[lid]
                if can_wait and k < N and b != ctx.dest and w + G <= p.max_wait_s + EPS_T:
                    n_edges += 1
                    add((b, k + 1), c + wait_cost[b, k], w + G, lid, ("wait", b, k), seq)
                for li in out[b]:
                    lc = leg_cost[li]
                    if lc is None or k >= len(lc):
                        continue
                    leg = legs[li]
                    n_edges += 1
                    if leg.b == ctx.dest:
                        tid = add(None, c + float(lc[k]), 0.0, lid, ("move", li, k), seq + (leg.b,))
                        terminals.append((round(c + float(lc[k]), 9), k * G + leg.tau_s, seq + (leg.b,), tid))
                    else:
                        add((leg.b, k + leg_steps[li]), c + float(lc[k]), leg_align[li], lid, ("move", li, k),
                            seq + (leg.b,))

    res = SearchResult(None, math.inf, N, n_states, len(L_cost), n_edges, len(legs))
    if not terminals:
        return res
    terminals.sort()
    _, _, _, tid = terminals[0]
    edges = []
    i = tid
    while L_parent[i] >= 0:
        edges.append(L_edge[i])
        i = L_parent[i]
    edges.reverse()
    stops, waits, aligns = [ctx.start], [0.0], [0.0]
    for e in edges:
        if e[0] == "wait":
            waits[-1] += G
        else:
            li = e[1]
            stops.append(legs[li].b)
            if legs[li].b != ctx.dest:
                waits.append(leg_align[li])
                aligns.append(leg_align[li])
    res.schedule = Schedule(stops, waits, aligns)
    res.cost = L_cost[tid]
    return res


# --------------------------------------------------------------------------------------------
# Local refinement in continuous time
# --------------------------------------------------------------------------------------------


def _neighbours(ctx: Context, sch: Schedule):
    step = ctx.p.eph_step_s
    zero = [0.0] * len(sch.waits)
    for i, w in enumerate(sch.waits):
        for m in (1, 2, 4, 8, -1, -2, -4, -8):
            nw = w + m * step
            if -EPS_T <= nw <= ctx.p.max_wait_s + EPS_T:
                waits = list(sch.waits)
                waits[i] = max(0.0, nw)
                yield (f"shift departure from {ctx.bases[sch.stops[i]].id} by {m * step / 60:+.0f} min",
                       Schedule(list(sch.stops), waits, list(zero)))
    for i in range(1, len(sch.stops) - 1):
        stops = sch.stops[:i] + sch.stops[i + 1:]
        if all(a != b for a, b in zip(stops[:-1], stops[1:])):
            waits = sch.waits[:i] + sch.waits[i + 1:]
            yield (f"remove stop {ctx.bases[sch.stops[i]].id}", Schedule(stops, waits, [0.0] * len(waits)))
    for i in range(1, len(sch.stops) - 1):
        for j in range(len(ctx.bases)):
            if j in (sch.stops[i], ctx.dest, ctx.start) or j == sch.stops[i - 1] or j == sch.stops[i + 1]:
                continue
            stops = list(sch.stops)
            stops[i] = j
            yield (f"replace stop {ctx.bases[sch.stops[i]].id} with {ctx.bases[j].id}",
                   Schedule(stops, list(sch.waits), list(zero)))


def local_search(ctx: Context, seed: Schedule, budget: int) -> tuple[Evaluation, list[dict], int]:
    cur = evaluate(ctx, seed)
    log: list[dict] = []
    evals = 1
    if not cur.feasible:
        return cur, log, evals
    for _ in range(200):
        best = None
        for desc, cand in _neighbours(ctx, cur.schedule):
            if evals >= budget:
                break
            ev = evaluate(ctx, cand)
            evals += 1
            if not ev.feasible:
                continue
            if ev.cost < cur.cost - 1e-9 * (1 + abs(cur.cost)):
                if best is None or (ev.cost, ev.arrival_s) < (best[1].cost, best[1].arrival_s):
                    best = (desc, ev)
        if best is None:
            break
        log.append(dict(move=best[0], cost_before=cur.cost, cost_after=best[1].cost))
        cur = best[1]
        if evals >= budget:
            break
    return cur, log, evals


# --------------------------------------------------------------------------------------------
# Baselines
# --------------------------------------------------------------------------------------------


def shortest_distance_path(ctx: Context, legs: list[Leg]) -> Optional[list[int]]:
    """Dijkstra on distance; ties broken by hop count then lexicographic base order."""
    adj = defaultdict(list)
    for leg in legs:
        adj[leg.a].append((leg.b, leg.dist_km))
    pq = [(0.0, 0, (ctx.start,))]
    done = set()
    while pq:
        d, h, path = heapq.heappop(pq)
        u = path[-1]
        if u in done:
            continue
        done.add(u)
        if u == ctx.dest:
            return list(path)
        for v, w in adj[u]:
            if v not in done:
                heapq.heappush(pq, (d + w, h + 1, path + (v,)))
    return None


def reachable_from_start(ctx: Context, legs: list[Leg]) -> set[int]:
    adj = defaultdict(list)
    for leg in legs:
        adj[leg.a].append(leg.b)
    seen, stack = {ctx.start}, [ctx.start]
    while stack:
        u = stack.pop()
        for v in adj[u]:
            if v not in seen:
                seen.add(v)
                stack.append(v)
    return seen


# --------------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------------


def build_bases(start, waypoints, destination, allow_start_at_destination: bool = False) -> list[Base]:
    out = []
    for role, items in (("start", [start]), ("waypoint", waypoints), ("destination", [destination])):
        for it in items:
            lat = float(it.lat_deg)
            lon = 0.0 if abs(lat) >= 90.0 else float(it.lon_deg)
            out.append(Base(len(out), it.id, it.label, lat, lon, role, unit_vector(lat, lon)))
    for i in range(len(out)):
        for j in range(i + 1, len(out)):
            if gc_distance_km(out[i].u, out[j].u) < config.ROUTE_COINCIDENT_KM:
                if allow_start_at_destination and {out[i].role, out[j].role} == {"start", "destination"}:
                    continue
                raise RoutingError(f"bases '{out[i].id}' and '{out[j].id}' are at the same physical location")
    return out


def estimate_and_check(ctx: Context) -> tuple[list[Leg], dict]:
    """Enumerate candidate legs (pure geometry) and reject excessive work before any ephemeris call."""
    p = ctx.p
    N = int(math.floor(p.horizon_s / p.grid_s + 1e-9))
    B = len(ctx.bases)
    if N < 1:
        raise RoutingError("the planning horizon must contain at least one time-grid step")
    if N > config.ROUTE_MAX_TIME_STEPS:
        raise RoutingError(f"{N:,} time steps exceeds the limit of {config.ROUTE_MAX_TIME_STEPS:,}; "
                           "use a coarser grid or a shorter horizon")
    if B * (N + 1) > config.ROUTE_MAX_TIME_STATES:
        raise RoutingError(f"{B * (N + 1):,} time-expanded states exceeds the limit of "
                           f"{config.ROUTE_MAX_TIME_STATES:,}; use fewer waypoints or a coarser grid")
    n_eph = math.ceil(p.horizon_s / p.eph_step_s) + 2
    if n_eph > config.ROUTE_MAX_EPHEMERIS_EPOCHS:
        raise RoutingError(f"{n_eph:,} ephemeris epochs exceeds the limit of {config.ROUTE_MAX_EPHEMERIS_EPOCHS:,}")
    traj = math.ceil(p.horizon_s / p.eph_step_s) + 2 * B + 2
    if traj > config.ROUTE_MAX_TRAJECTORY_POINTS:
        raise RoutingError(f"up to {traj:,} trajectory samples exceeds the limit of "
                           f"{config.ROUTE_MAX_TRAJECTORY_POINTS:,}; use a coarser grid or a shorter horizon")
    legs = candidate_legs(ctx)
    m_wait = round(p.grid_s / p.eph_step_s) + 1
    evals = B * N * m_wait if p.max_wait_s + EPS_T >= p.grid_s else 0
    for leg in legs:
        evals += (N + 1) * (len(leg.offsets) + m_wait + 1)
    if evals > config.ROUTE_MAX_SAMPLE_EVALS:
        raise RoutingError(f"about {evals:,} elevation samples exceeds the limit of "
                           f"{config.ROUTE_MAX_SAMPLE_EVALS:,}; reduce the leg limit, waypoints, horizon or grid density")
    return legs, dict(n_steps=N, n_ephemeris_epochs=n_eph, estimated_sample_evals=evals)


def lower_bound_h(ctx: Context) -> float:
    return ctx.distance(ctx.start, ctx.dest) / ctx.p.speed_kmh


def infeasibility_reason(ctx: Context, legs: list[Leg]) -> str:
    p = ctx.p
    lb = lower_bound_h(ctx)
    if lb > p.horizon_s / 3600 + 1e-9:
        return (f"No feasible route within these constraints: the binding constraint is the planning horizon. "
                f"The great-circle distance is {ctx.distance(ctx.start, ctx.dest):.1f} km, so at {p.speed_kmh:g} km/h "
                f"any route needs at least {lb:.1f} h of movement, beyond the {p.horizon_s / 3600:.1f} h horizon.")
    reach = reachable_from_start(ctx, legs)
    if ctx.dest not in reach:
        nearest = min(reach, key=lambda i: ctx.distance(i, ctx.dest))
        return (f"No feasible route within these constraints: the destination cannot be reached through the "
                f"candidate network with legs of at most {p.max_leg_km:.1f} km. The closest reachable base, "
                f"'{ctx.bases[nearest].id}', is {ctx.distance(nearest, ctx.dest):.1f} km from the destination.")
    path = shortest_distance_path(ctx, legs)
    move_h = sum(ctx.distance(a, b) for a, b in zip(path[:-1], path[1:])) / p.speed_kmh
    if move_h > p.horizon_s / 3600 + 1e-9:
        return (f"No feasible route within these constraints: even the shortest network route needs "
                f"{move_h:.1f} h of movement at {p.speed_kmh:g} km/h, beyond the {p.horizon_s / 3600:.1f} h horizon.")
    return (f"No feasible route within these constraints: every network route needs intermediate stops whose "
            f"grid-alignment waiting (up to one {p.grid_s / 60:.0f}-min grid step) exceeds the "
            f"{p.max_wait_s / 3600:.2f} h waiting limit, or arrives after the horizon once aligned to the grid.")


def _zero_distance(ctx: Context) -> Evaluation:
    """Start already at the destination: a successful, zero-distance, zero-duration itinerary."""
    sch = Schedule([ctx.start, ctx.dest], [0.0], [0.0])
    ev = Evaluation(True, None, sch, cost=0.0, arrival_s=0.0)
    times = np.array([0.0])
    pos, basis = ctx.base_geom(ctx.start, 1)
    el = ctx.elevations(times[None], pos, basis)
    ev.trajectory = _assemble_trajectory(ctx, [(times, pos, el, "wait", -1)])
    ev.zero = True
    return ev


def params_from(req) -> Params:
    w = req.weights
    return Params(
        speed_kmh=req.speed_kmh, max_leg_km=req.max_leg_km, grid_s=req.grid_minutes * 60.0,
        max_wait_s=req.max_wait_hours * 3600.0, horizon_s=req.horizon_hours * 3600.0,
        w_dist=w.distance, w_dark=w.darkness, w_earth=w.earth_invisible,
        dist_scale_km=req.distance_scale_km, exp_scale_h=req.exposure_scale_hours,
        eph_step_s=eph_step_for(req.grid_minutes * 60.0),
    )


def is_start_at_destination(req) -> bool:
    a = unit_vector(float(req.start.lat_deg), 0.0 if abs(req.start.lat_deg) >= 90 else float(req.start.lon_deg))
    b = unit_vector(float(req.destination.lat_deg),
                    0.0 if abs(req.destination.lat_deg) >= 90 else float(req.destination.lon_deg))
    return gc_distance_km(a, b) < config.ROUTE_COINCIDENT_KM


def run_route(req, provider: EphemerisProvider, coverage: Optional[tuple[float, float, str, str]] = None) -> dict:
    """Plan a route. Returns plain Python structures; routing_service converts to response models."""
    t_start = time.perf_counter()
    if is_start_at_destination(req):
        bases = build_bases(req.start, [], req.destination, allow_start_at_destination=True)
        p = params_from(req)
        ctx = Context(bases, p, None)
        et0 = provider.utc_to_et(req.departure_utc)
        if coverage is not None and (et0 < coverage[0] or et0 + 2 * p.eph_step_s > coverage[1]):
            raise RoutingError(f"The planning window must lie within the loaded kernel coverage "
                               f"({coverage[2]} to {coverage[3]}).")
        ctx.table = EphemerisTable(provider, et0, p.eph_step_s, 2)
        ev = _zero_distance(ctx)
        graph = SearchResult(ev.schedule, 0.0, 0, 0, 0, 0, 0)
        return dict(
            ctx=ctx, legs=[], work=dict(n_steps=0, n_ephemeris_epochs=2, estimated_sample_evals=1), graph=graph,
            graph_eval=ev, final=ev, baseline=ev, direct=dict(distance_km=0.0, feasible=True, reason=None, evaluation=ev),
            ls=dict(performed=False, seeds=[], accepted=[], evaluations=0,
                    explanation="Start is already at the destination; no search was needed."),
            reason=None, et0=et0, zero=True, compute_ms=(time.perf_counter() - t_start) * 1000.0,
        )
    bases = build_bases(req.start, req.waypoints, req.destination)
    if len(bases) > config.ROUTE_MAX_BASES:
        raise RoutingError(f"{len(bases)} bases exceeds the limit of {config.ROUTE_MAX_BASES}")
    p = params_from(req)
    ctx = Context(bases, p, None)
    legs, work = estimate_and_check(ctx)

    et0 = provider.utc_to_et(req.departure_utc)
    n_eph = work["n_ephemeris_epochs"]
    if coverage is not None:
        c0, c1, u0, u1 = coverage
        if et0 < c0 or et0 + n_eph * p.eph_step_s > c1:
            raise RoutingError(f"The planning window must lie within the loaded kernel coverage ({u0} to {u1}).")
    ctx.table = EphemerisTable(provider, et0, p.eph_step_s, n_eph)

    graph = search(ctx, legs)
    graph_eval = evaluate(ctx, graph.schedule) if graph.schedule else None

    base_path = shortest_distance_path(ctx, legs)
    baseline = None
    if base_path is not None:
        baseline = evaluate(ctx, Schedule(base_path, [0.0] * (len(base_path) - 1), [0.0] * (len(base_path) - 1)))

    # Direct great-circle baseline (may be infeasible under the leg limit).
    d_direct = ctx.distance(ctx.start, ctx.dest)
    direct = dict(distance_km=d_direct, feasible=False, reason=None, evaluation=None)
    if central_angle(bases[ctx.start].u, bases[ctx.dest].u) > math.pi - config.ROUTE_ANTIPODAL_MARGIN_RAD:
        direct["reason"] = "Start and destination are near-antipodal: no unique great circle."
    elif d_direct > p.max_leg_km + 1e-9:
        direct["reason"] = (f"Direct great-circle distance {d_direct:.1f} km exceeds the {p.max_leg_km:.1f} km "
                            "maximum leg, so it is not a valid alternative under these constraints.")
    else:
        dev = evaluate(ctx, Schedule([ctx.start, ctx.dest], [0.0], [0.0]))
        direct.update(feasible=dev.feasible, reason=dev.reason, evaluation=dev if dev.feasible else None)

    # Local refinement: seeds are the graph optimum and the baseline (multi-start), best result kept.
    ls_info = dict(performed=False, seeds=[], accepted=[], evaluations=0, explanation="")
    final = None
    if req.local_search:
        budget = config.ROUTE_MAX_LOCAL_SEARCH_EVALS
        seeds = []
        if graph_eval is not None and graph_eval.feasible:
            seeds.append(("graph optimum", graph.schedule))
        if baseline is not None and baseline.feasible:
            seeds.append(("shortest-distance baseline", baseline.schedule))
        best_seed = None
        for name, sch in seeds:
            ev, log, n = local_search(ctx, sch, max(1, budget - ls_info["evaluations"]))
            ls_info["evaluations"] += n
            ls_info["seeds"].append(dict(seed=name, start_cost=evaluate(ctx, sch).cost, end_cost=ev.cost,
                                         accepted=len(log)))
            for entry in log:
                ls_info["accepted"].append(dict(seed=name, **entry))
            if ev.feasible and (best_seed is None or (round(ev.cost, 9), ev.arrival_s, tuple(ev.schedule.stops))
                                < (round(best_seed[1].cost, 9), best_seed[1].arrival_s, tuple(best_seed[1].schedule.stops))):
                best_seed = (name, ev)
        ls_info["performed"] = bool(seeds)
        ls_info["explanation"] = (
            "The time-expanded graph search is exact only for departures on the "
            f"{p.grid_s / 60:g}-min grid, which forces grid-alignment waiting after each intermediate leg. "
            "The local pass searches a different, finer space: continuous-time itineraries with departures "
            f"shifted in {p.eph_step_s / 60:g}-min steps and no alignment waiting, plus stop removal and "
            "replacement. It starts from the graph optimum and from the shortest-distance baseline, accepts "
            "only strict cost improvements, and is bounded at "
            f"{config.ROUTE_MAX_LOCAL_SEARCH_EVALS:,} evaluations. The result is locally improved, not globally "
            "optimal in continuous time."
        )
        if best_seed is not None:
            final = best_seed[1]
            ls_info["selected_seed"] = best_seed[0]
    else:
        ls_info["explanation"] = "Local refinement disabled by request; the graph optimum is reported as-is."
        final = graph_eval if graph_eval is not None and graph_eval.feasible else None

    if final is not None:
        final = evaluate(ctx, final.schedule, with_trajectory=True)

    reason = None if final is not None else infeasibility_reason(ctx, legs)
    return dict(
        ctx=ctx, legs=legs, work=work, graph=graph, graph_eval=graph_eval, final=final, baseline=baseline,
        direct=direct, ls=ls_info, reason=reason, et0=et0, zero=False,
        compute_ms=(time.perf_counter() - t_start) * 1000.0,
    )

